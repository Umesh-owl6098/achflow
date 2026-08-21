import { Logger } from '@nestjs/common';
import {
  MerchantStatus,
  PaymentDirection,
  PaymentStatus,
} from '@prisma/client';
import {
  PaymentForValidation,
  PaymentLifecycleRepository,
} from './payment-lifecycle.repository';
import { PaymentValidationService } from './payment-validation.service';

const payment: PaymentForValidation = {
  id: 'pay-1',
  merchantId: 'merchant-1',
  status: PaymentStatus.RECEIVED,
  amountCents: BigInt(2500),
  currency: 'USD',
  direction: PaymentDirection.DEBIT,
  externalReference: 'reference-1',
  validationCode: null,
  validationMessage: null,
  createdAt: new Date('2026-07-29T12:00:00.000Z'),
  receiverAccountRef: 'account-token',
  routingNumber: '021000021',
  merchant: {
    status: MerchantStatus.ACTIVE,
    allowAchDebit: true,
    allowAchCredit: true,
    perPaymentLimit: BigInt(10000),
    dailyAmountLimit: BigInt(50000),
  },
};

describe('PaymentValidationService', () => {
  function createService(paymentResult: PaymentForValidation | null = payment) {
    const repository = {
      findForValidation: jest.fn().mockResolvedValue(paymentResult),
      transitionFromReceived: jest.fn().mockResolvedValue(undefined),
      reserveDailyUsageAndTransition: jest.fn().mockResolvedValue({
        status: PaymentStatus.VALIDATED,
        code: null,
        message: null,
      }),
    };

    return {
      service: new PaymentValidationService(
        repository as unknown as PaymentLifecycleRepository,
      ),
      repository,
    };
  }

  it.each([PaymentDirection.DEBIT, PaymentDirection.CREDIT])(
    'transitions a valid %s payment to VALIDATED',
    async (direction) => {
      const { service, repository } = createService({ ...payment, direction });

      await service.validate(payment.id, 'event-1');

      expect(repository.reserveDailyUsageAndTransition).toHaveBeenCalledWith(
        expect.objectContaining({ id: payment.id, direction }),
        'event-1',
      );
    },
  );

  it.each([BigInt(1), BigInt(10_000)])(
    'accepts the valid %s-cent payment boundary',
    async (amountCents) => {
      const { service, repository } = createService({
        ...payment,
        amountCents,
      });

      await service.validate(payment.id, 'event-1');

      expect(repository.reserveDailyUsageAndTransition).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents }),
        'event-1',
      );
    },
  );

  it.each([BigInt(0), BigInt(-1)])(
    'transitions a non-positive amount to VALIDATION_FAILED',
    async (amountCents) => {
      const { service, repository } = createService({
        ...payment,
        amountCents,
      });

      await service.validate(payment.id, 'event-1');

      expect(repository.transitionFromReceived).toHaveBeenCalledWith(
        payment.id,
        {
          status: PaymentStatus.VALIDATION_FAILED,
          code: 'INVALID_AMOUNT',
          message: 'Payment amount must be greater than zero',
        },
      );
    },
  );

  it('transitions an unsupported currency to VALIDATION_FAILED', async () => {
    const { service, repository } = createService({
      ...payment,
      currency: 'CAD',
    });

    await service.validate(payment.id, 'event-1');

    expect(repository.transitionFromReceived).toHaveBeenCalledWith(payment.id, {
      status: PaymentStatus.VALIDATION_FAILED,
      code: 'UNSUPPORTED_CURRENCY',
      message: 'Payment currency must be USD',
    });
  });

  it('transitions a missing external reference to VALIDATION_FAILED safely', async () => {
    const { service, repository } = createService({
      ...payment,
      externalReference: null,
    });
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();

    await service.validate(payment.id, 'event-1');

    expect(repository.transitionFromReceived).toHaveBeenCalledWith(payment.id, {
      status: PaymentStatus.VALIDATION_FAILED,
      code: 'MISSING_EXTERNAL_REFERENCE',
      message: 'Payment external reference is required',
    });
    expect(
      JSON.stringify(repository.transitionFromReceived.mock.calls),
    ).not.toContain(payment.receiverAccountRef);
    expect(JSON.stringify(log.mock.calls)).not.toContain(payment.routingNumber);
    jest.restoreAllMocks();
  });

  it('propagates infrastructure failures for outbox retry', async () => {
    const { service, repository } = createService();
    repository.findForValidation.mockRejectedValue(
      new Error('database unavailable'),
    );

    await expect(service.validate(payment.id, 'event-1')).rejects.toThrow(
      'database unavailable',
    );
  });

  it('fails a suspended merchant as a business outcome', async () => {
    const { service, repository } = createService({
      ...payment,
      merchant: { ...payment.merchant!, status: MerchantStatus.SUSPENDED },
    });
    await service.validate(payment.id, 'event-1');
    expect(repository.transitionFromReceived).toHaveBeenCalledWith(payment.id, {
      status: PaymentStatus.VALIDATION_FAILED,
      code: 'MERCHANT_NOT_ACTIVE',
      message: 'Payment merchant is not active',
    });
  });

  it.each([
    [PaymentDirection.DEBIT, 'allowAchDebit', 'ACH_DEBIT_NOT_ALLOWED'],
    [PaymentDirection.CREDIT, 'allowAchCredit', 'ACH_CREDIT_NOT_ALLOWED'],
  ])('fails disallowed %s direction', async (direction, permission, code) => {
    const { service, repository } = createService({
      ...payment,
      direction,
      merchant: { ...payment.merchant!, [permission]: false },
    });
    await service.validate(payment.id, 'event-1');
    expect(repository.transitionFromReceived).toHaveBeenCalledWith(
      payment.id,
      expect.objectContaining({
        status: PaymentStatus.VALIDATION_FAILED,
        code,
      }),
    );
  });

  it('fails an amount above the merchant limit', async () => {
    const { service, repository } = createService({
      ...payment,
      amountCents: BigInt(10001),
    });
    await service.validate(payment.id, 'event-1');
    expect(repository.transitionFromReceived).toHaveBeenCalledWith(
      payment.id,
      expect.objectContaining({ code: 'PER_PAYMENT_LIMIT_EXCEEDED' }),
    );
  });

  it('returns the daily-limit business failure without retrying', async () => {
    const { service, repository } = createService();
    repository.reserveDailyUsageAndTransition.mockResolvedValue({
      status: PaymentStatus.VALIDATION_FAILED,
      code: 'EXCEEDS_DAILY_AMOUNT_LIMIT',
      message: 'Daily limit 5000 exceeded: utilized 4000, requested 1500',
    });

    await service.validate(payment.id, 'event-1');

    expect(repository.reserveDailyUsageAndTransition).toHaveBeenCalledWith(
      payment,
      'event-1',
    );
  });
});
