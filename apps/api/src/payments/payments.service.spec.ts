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

describe('buildPaymentRequestFingerprint', () => {
  const baseDto: CreatePaymentDto = {
    idempotencyKey: 'key-1',
    direction: PaymentDirection.DEBIT,
    amountCents: 1000,
    currency: 'usd',
    originatorName: 'Originator LLC',
    receiverName: 'Receiver Inc',
    receiverAccountRef: 'acct-123',
    routingNumber: '021000021',
    description: 'Invoice 42',
  };

  it('produces a stable hash for the same payload', () => {
    const first = buildPaymentRequestFingerprint(baseDto);
    const second = buildPaymentRequestFingerprint({
      ...baseDto,
      idempotencyKey: 'different-key',
    });

    expect(first).toBe(second);
  });

  it('normalizes currency casing before hashing', () => {
    const lower = buildPaymentRequestFingerprint({
      ...baseDto,
      currency: 'usd',
    });
    const upper = buildPaymentRequestFingerprint({
      ...baseDto,
      currency: 'USD',
    });

    expect(lower).toBe(upper);
  });

  it('changes when a payment field changes', () => {
    const original = buildPaymentRequestFingerprint(baseDto);
    const changed = buildPaymentRequestFingerprint({
      ...baseDto,
      amountCents: 2000,
    });

    expect(changed).not.toBe(original);
  });
});

describe('PaymentsService', () => {
  let service: PaymentsService;
  let repository: {
    createWithOutbox: jest.Mock;
    findByIdempotencyKey: jest.Mock;
    findById: jest.Mock;
    isUniqueConstraintViolation: jest.Mock;
  };

  const dto: CreatePaymentDto = {
    idempotencyKey: 'idem-1',
    direction: PaymentDirection.DEBIT,
    amountCents: 2500,
    currency: 'USD',
    originatorName: 'Originator LLC',
    receiverName: 'Receiver Inc',
    receiverAccountRef: 'acct-123',
    routingNumber: '021000021',
  };

  const fingerprint = buildPaymentRequestFingerprint(dto);

  const paymentRecord = {
    id: 'pay-1',
    idempotencyKey: dto.idempotencyKey,
    requestFingerprint: fingerprint,
    externalReference: null,
    direction: PaymentDirection.DEBIT,
    status: 'RECEIVED' as const,
    amountCents: BigInt(2500),
    currency: 'USD',
    originatorName: dto.originatorName,
    receiverName: dto.receiverName,
    receiverAccountRef: dto.receiverAccountRef,
    routingNumber: dto.routingNumber,
    description: null,
    failureCode: null,
    failureReason: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  beforeEach(async () => {
    repository = {
      createWithOutbox: jest.fn(),
      findByIdempotencyKey: jest.fn(),
      findById: jest.fn(),
      isUniqueConstraintViolation: jest.fn(
        (error: unknown) =>
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002',
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        {
          provide: PaymentsRepository,
          useValue: repository,
        },
      ],
    }).compile();

    service = module.get(PaymentsService);
  });

  it('creates a payment on the first request', async () => {
    repository.createWithOutbox.mockResolvedValue(paymentRecord);

    const result = await service.create(dto);

    expect(repository.createWithOutbox).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: dto.idempotencyKey,
        requestFingerprint: fingerprint,
        amountCents: BigInt(2500),
      }),
    );
    expect(result.created).toBe(true);
    expect(result.payment.id).toBe('pay-1');
    expect(result.payment.amountCents).toBe('2500');
    expect(result.payment).not.toHaveProperty('requestFingerprint');
  });

  it('returns the original payment for a repeated identical request', async () => {
    repository.createWithOutbox.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '7.9.1',
      }),
    );
    repository.findByIdempotencyKey.mockResolvedValue(paymentRecord);

    const result = await service.create(dto);

    expect(repository.findByIdempotencyKey).toHaveBeenCalledWith(
      dto.idempotencyKey,
    );
    expect(result.created).toBe(false);
    expect(result.payment.id).toBe('pay-1');
    expect(result.payment).not.toHaveProperty('requestFingerprint');
  });

  it('returns the original payment when it becomes visible after retries', async () => {
    repository.createWithOutbox.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '7.9.1',
      }),
    );
    repository.findByIdempotencyKey
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(paymentRecord);

    const result = await service.create(dto);

    expect(repository.findByIdempotencyKey).toHaveBeenCalledTimes(2);
    expect(result.created).toBe(false);
    expect(result.payment.id).toBe('pay-1');
    expect(result.payment).not.toHaveProperty('requestFingerprint');
  });

  it('does not expose the request fingerprint when retrieving a payment', async () => {
    repository.findById.mockResolvedValue(paymentRecord);

    const payment = await service.findOne('pay-1');

    expect(payment.id).toBe('pay-1');
    expect(payment.amountCents).toBe('2500');
    expect(payment).not.toHaveProperty('requestFingerprint');
  });

  it('returns 409 when the same key is reused with a different payload', async () => {
    repository.createWithOutbox.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '7.9.1',
      }),
    );
    repository.findByIdempotencyKey.mockResolvedValue({
      ...paymentRecord,
      requestFingerprint: 'different-fingerprint',
    });

    await expect(
      service.create({
        ...dto,
        amountCents: 9999,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('returns an internal error when a payment never becomes visible after P2002', async () => {
    repository.createWithOutbox.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '7.9.1',
      }),
    );
    repository.findByIdempotencyKey.mockResolvedValue(null);

    await expect(service.create(dto)).rejects.toMatchObject({
      status: 500,
      message:
        'Payment could not be read after a concurrent idempotency conflict.',
    } satisfies Partial<InternalServerErrorException>);

    expect(repository.findByIdempotencyKey).toHaveBeenCalledTimes(4);
  });
});
