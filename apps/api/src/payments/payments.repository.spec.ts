import { OutboxEventType, PaymentDirection } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePaymentRecord, PaymentsRepository } from './payments.repository';

describe('PaymentsRepository', () => {
  const data: CreatePaymentRecord = {
    idempotencyKey: 'idem-1',
    requestFingerprint: 'internal-fingerprint',
    externalReference: 'external-ref-1',
    direction: PaymentDirection.DEBIT,
    amountCents: BigInt(2500),
    currency: 'USD',
    merchantId: 'merchant-1',
    receiverName: 'Receiver Inc',
    receiverAccountRef: 'acct-123',
    routingNumber: '021000021',
    description: 'Invoice 42',
  };

  const payment = {
    id: 'pay-1',
    ...data,
    externalReference: data.externalReference,
    status: 'RECEIVED' as const,
    failureCode: null,
    failureReason: null,
    validationCode: null,
    validationMessage: null,
    createdAt: new Date('2026-07-29T12:00:00.000Z'),
    updatedAt: new Date('2026-07-29T12:00:00.000Z'),
    merchant: { merchantCode: 'TEST_BOTH', displayName: 'Test Both' },
  };

  it('creates a payment and safe outbox event in one transaction', async () => {
    const transaction = {
      payment: { create: jest.fn().mockResolvedValue(payment) },
      outboxEvent: { create: jest.fn().mockResolvedValue({ id: 'evt-1' }) },
    };
    const prisma = {
      $transaction: jest.fn(
        <T>(callback: (client: typeof transaction) => Promise<T>): Promise<T> =>
          callback(transaction),
      ),
    };
    const repository = new PaymentsRepository(prisma as PrismaService);

    await expect(repository.createWithOutbox(data)).resolves.toBe(payment);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(transaction.payment.create).toHaveBeenCalledWith({
      data,
      include: {
        merchant: { select: { merchantCode: true, displayName: true } },
      },
    });
    expect(transaction.outboxEvent.create).toHaveBeenCalledWith({
      data: {
        eventKey: `payment:${payment.id}:PAYMENT_RECEIVED`,
        eventType: OutboxEventType.PAYMENT_RECEIVED,
        aggregateType: 'PAYMENT',
        aggregateId: payment.id,
        payload: {
          paymentId: payment.id,
          merchantId: payment.merchantId,
          paymentStatus: payment.status,
          direction: payment.direction,
          amountCents: '2500',
          currency: payment.currency,
          validationCode: payment.validationCode,
          returnCode: null,
          occurredAt: payment.createdAt.toISOString(),
        },
      },
    });
  });

  it('propagates an outbox write failure so the transaction can roll back', async () => {
    const transaction = {
      payment: { create: jest.fn().mockResolvedValue(payment) },
      outboxEvent: {
        create: jest.fn().mockRejectedValue(new Error('outbox write failed')),
      },
    };
    const prisma = {
      $transaction: jest.fn(
        <T>(callback: (client: typeof transaction) => Promise<T>): Promise<T> =>
          callback(transaction),
      ),
    };
    const repository = new PaymentsRepository(prisma as PrismaService);

    await expect(repository.createWithOutbox(data)).rejects.toThrow(
      'outbox write failed',
    );
  });
});
