import { Logger } from '@nestjs/common';
import { PaymentDirection, PaymentStatus } from '@prisma/client';
import {
  PaymentForValidation,
  PaymentLifecycleRepository,
} from './payment-lifecycle.repository';
import { PaymentValidationService } from './payment-validation.service';

const payment: PaymentForValidation = {
  id: 'pay-1',
  status: PaymentStatus.RECEIVED,
  amountCents: BigInt(2500),
  currency: 'USD',
  direction: PaymentDirection.DEBIT,
  externalReference: 'reference-1',
  originatorName: 'Originator LLC',
  receiverAccountRef: 'account-token',
  routingNumber: '021000021',
};

describe('PaymentValidationService', () => {
  function createService(paymentResult: PaymentForValidation | null = payment) {
    const repository = {
      findForValidation: jest.fn().mockResolvedValue(paymentResult),
      transitionFromReceived: jest.fn().mockResolvedValue(undefined),
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

      await service.validate(payment.id);

      expect(repository.transitionFromReceived).toHaveBeenCalledWith(
        payment.id,
        {
          status: PaymentStatus.VALIDATED,
          code: null,
          message: null,
        },
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

      await service.validate(payment.id);

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

    await service.validate(payment.id);

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

    await service.validate(payment.id);

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

    await expect(service.validate(payment.id)).rejects.toThrow(
      'database unavailable',
    );
  });
});
