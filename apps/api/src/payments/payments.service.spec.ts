import {
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PaymentDirection, Prisma } from '@prisma/client';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { buildPaymentRequestFingerprint } from './payment-fingerprint.util';
import { PaymentsRepository } from './payments.repository';
import { PaymentsService } from './payments.service';
import { PaymentEngineService } from './payment-engine.service';
import { MerchantsRepository } from './merchants.repository';

const merchant = {
  id: 'merchant-1',
  merchantCode: 'TEST_BOTH',
  displayName: 'Test Both',
};

describe('buildPaymentRequestFingerprint', () => {
  const baseDto: CreatePaymentDto = {
    idempotencyKey: 'key-1',
    direction: PaymentDirection.DEBIT,
    amountCents: 1000,
    currency: 'usd',
    merchantCode: 'TEST_BOTH',
    receiverName: 'Receiver Inc',
    receiverAccountRef: 'acct-123',
    routingNumber: '021000021',
    description: 'Invoice 42',
  };

  it('produces a stable hash for the same payload', () => {
    const first = buildPaymentRequestFingerprint(baseDto, merchant.id);
    const second = buildPaymentRequestFingerprint(
      {
        ...baseDto,
        idempotencyKey: 'different-key',
      },
      merchant.id,
    );

    expect(first).toBe(second);
  });

  it('normalizes currency casing before hashing', () => {
    const lower = buildPaymentRequestFingerprint(
      {
        ...baseDto,
        currency: 'usd',
      },
      merchant.id,
    );
    const upper = buildPaymentRequestFingerprint(
      {
        ...baseDto,
        currency: 'USD',
      },
      merchant.id,
    );

    expect(lower).toBe(upper);
  });

  it('changes when a payment field changes', () => {
    const original = buildPaymentRequestFingerprint(baseDto, merchant.id);
    const changed = buildPaymentRequestFingerprint(
      {
        ...baseDto,
        amountCents: 2000,
      },
      merchant.id,
    );

    expect(changed).not.toBe(original);
  });
});

describe('PaymentsService', () => {
  let service: PaymentsService;
  let repository: {
    createWithOutboxAndIdempotency: jest.Mock;
    findIdempotencyRecord: jest.Mock;
    findIdempotencyRecordByPaymentId: jest.Mock;
    findById: jest.Mock;
    isUniqueConstraintViolation: jest.Mock;
  };
  let merchantsRepository: { findByCode: jest.Mock };

  const dto: CreatePaymentDto = {
    idempotencyKey: 'idem-1',
    direction: PaymentDirection.DEBIT,
    amountCents: 2500,
    currency: 'USD',
    merchantCode: 'TEST_BOTH',
    receiverName: 'Receiver Inc',
    receiverAccountRef: 'acct-123',
    routingNumber: '021000021',
  };

  const fingerprint = buildPaymentRequestFingerprint(dto, merchant.id);

  const paymentRecord = {
    id: 'pay-1',
    idempotencyKey: dto.idempotencyKey,
    requestFingerprint: fingerprint,
    externalReference: null,
    direction: PaymentDirection.DEBIT,
    status: 'RECEIVED' as const,
    amountCents: BigInt(2500),
    currency: 'USD',
    merchantId: merchant.id,
    receiverName: dto.receiverName,
    receiverAccountRef: dto.receiverAccountRef,
    routingNumber: dto.routingNumber,
    description: null,
    failureCode: null,
    failureReason: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    merchant: { merchantCode: 'TEST_BOTH', displayName: 'Test Both' },
  };

  beforeEach(async () => {
    repository = {
      createWithOutboxAndIdempotency: jest.fn(),
      findIdempotencyRecord: jest.fn(),
      findIdempotencyRecordByPaymentId: jest.fn().mockResolvedValue(null),
      findById: jest.fn(),
      isUniqueConstraintViolation: jest.fn(
        (error: unknown) =>
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002',
      ),
    };
    merchantsRepository = { findByCode: jest.fn().mockResolvedValue(merchant) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        {
          provide: PaymentsRepository,
          useValue: repository,
        },
        { provide: MerchantsRepository, useValue: merchantsRepository },
        {
          provide: PaymentEngineService,
          useValue: {
            validate: jest.fn(),
            reserve: jest.fn(),
            settle: jest.fn(),
            returnSettlement: jest.fn(),
            details: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(PaymentsService);
  });

  it('creates a payment on the first request', async () => {
    repository.createWithOutboxAndIdempotency.mockResolvedValue(paymentRecord);

    const result = await service.create(dto, dto.idempotencyKey, merchant);

    expect(repository.createWithOutboxAndIdempotency).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `${merchant.id}:${dto.idempotencyKey}`,
        requestFingerprint: fingerprint,
        merchantId: merchant.id,
        amountCents: BigInt(2500),
      }),
      {
        merchantId: merchant.id,
        idempotencyKey: dto.idempotencyKey,
        requestFingerprint: fingerprint,
      },
    );
    expect(result.created).toBe(true);
    expect(result.payment.id).toBe('pay-1');
    expect(result.payment.amountCents).toBe('2500');
    expect(result.payment).not.toHaveProperty('requestFingerprint');
  });

  it('returns the original payment for a repeated identical request', async () => {
    repository.createWithOutboxAndIdempotency.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '7.9.1',
      }),
    );
    repository.findIdempotencyRecord.mockResolvedValue({
      merchantId: merchant.id,
      idempotencyKey: dto.idempotencyKey,
      requestFingerprint: fingerprint,
      payment: paymentRecord,
    });

    const result = await service.create(dto, dto.idempotencyKey, merchant);

    expect(repository.findIdempotencyRecord).toHaveBeenCalledWith(
      merchant.id,
      dto.idempotencyKey,
    );
    expect(result.created).toBe(false);
    expect(result.payment.id).toBe('pay-1');
    expect(result.payment).not.toHaveProperty('requestFingerprint');
  });

  it('returns the original payment when it becomes visible after retries', async () => {
    repository.createWithOutboxAndIdempotency.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '7.9.1',
      }),
    );
    repository.findIdempotencyRecord
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        merchantId: merchant.id,
        idempotencyKey: dto.idempotencyKey,
        requestFingerprint: fingerprint,
        payment: paymentRecord,
      });

    const result = await service.create(dto, dto.idempotencyKey, merchant);

    expect(repository.findIdempotencyRecord).toHaveBeenCalledTimes(2);
    expect(result.created).toBe(false);
    expect(result.payment.id).toBe('pay-1');
    expect(result.payment).not.toHaveProperty('requestFingerprint');
  });

  it('does not expose the request fingerprint when retrieving a payment', async () => {
    repository.findById.mockResolvedValue(paymentRecord);

    const payment = await service.findOne('pay-1', merchant);

    expect(payment.id).toBe('pay-1');
    expect(payment.amountCents).toBe('2500');
    expect(payment).not.toHaveProperty('requestFingerprint');
  });

  it('returns 409 when the same key is reused with a different payload', async () => {
    repository.createWithOutboxAndIdempotency.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '7.9.1',
      }),
    );
    repository.findIdempotencyRecord.mockResolvedValue({
      merchantId: merchant.id,
      idempotencyKey: dto.idempotencyKey,
      requestFingerprint: 'different-fingerprint',
      payment: paymentRecord,
    });

    await expect(
      service.create(
        {
          ...dto,
          amountCents: 9999,
        },
        dto.idempotencyKey,
        merchant,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('returns an internal error when a payment never becomes visible after P2002', async () => {
    repository.createWithOutboxAndIdempotency.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '7.9.1',
      }),
    );
    repository.findIdempotencyRecord.mockResolvedValue(null);

    let error: unknown;
    try {
      await service.create(dto, dto.idempotencyKey, merchant);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(InternalServerErrorException);
    if (!(error instanceof InternalServerErrorException)) {
      throw error;
    }
    expect(error.getStatus()).toBe(500);
    expect(error.message).toBe(
      'Payment could not be read after a concurrent idempotency conflict.',
    );

    expect(repository.findIdempotencyRecord).toHaveBeenCalledTimes(4);
  });
});
