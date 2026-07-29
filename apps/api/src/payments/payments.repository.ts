import { Injectable } from '@nestjs/common';
import {
  OutboxEventType,
  Payment,
  PaymentDirection,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type CreatePaymentRecord = {
  idempotencyKey: string;
  requestFingerprint: string;
  externalReference?: string;
  direction: PaymentDirection;
  amountCents: bigint;
  currency: string;
  merchantId: string;
  receiverName: string;
  receiverAccountRef: string;
  routingNumber: string;
  description?: string;
};

export type PaymentWithMerchant = Payment & {
  merchant: { merchantCode: string; displayName: string };
};

export type PaymentReceivedOutboxPayload = {
  paymentId: string;
  externalReference: string | null;
  direction: PaymentDirection;
  amountCents: string;
  currency: string;
  createdAt: string;
};

@Injectable()
export class PaymentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  createWithOutbox(data: CreatePaymentRecord): Promise<PaymentWithMerchant> {
    return this.prisma.$transaction(async (transaction) => {
      const payment = await transaction.payment.create({
        data,
        include: {
          merchant: { select: { merchantCode: true, displayName: true } },
        },
      });

      await transaction.outboxEvent.create({
        data: {
          eventType: OutboxEventType.PAYMENT_RECEIVED,
          aggregateType: 'PAYMENT',
          aggregateId: payment.id,
          payload: this.buildPaymentReceivedPayload(payment),
        },
      });

      return payment;
    });
  }

  findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<PaymentWithMerchant | null> {
    return this.prisma.payment.findUnique({
      where: { idempotencyKey },
      include: {
        merchant: { select: { merchantCode: true, displayName: true } },
      },
    });
  }

  findById(id: string): Promise<PaymentWithMerchant | null> {
    return this.prisma.payment.findUnique({
      where: { id },
      include: {
        merchant: { select: { merchantCode: true, displayName: true } },
      },
    });
  }

  isUniqueConstraintViolation(
    error: unknown,
  ): error is Prisma.PrismaClientKnownRequestError {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }

  private buildPaymentReceivedPayload(
    payment: Payment,
  ): PaymentReceivedOutboxPayload {
    return {
      paymentId: payment.id,
      externalReference: payment.externalReference,
      direction: payment.direction,
      amountCents: payment.amountCents.toString(),
      currency: payment.currency,
      createdAt: payment.createdAt.toISOString(),
    };
  }
}
