import { Injectable } from '@nestjs/common';
import {
  OutboxEventType,
  Payment,
  PaymentDirection,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { paymentLifecycleOutboxEvent } from '../../prisma/payment-lifecycle-event.factory';

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

export type CreatePaymentIdempotencyRecord = {
  merchantId: string;
  idempotencyKey: string;
  requestFingerprint: string;
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
        data: paymentLifecycleOutboxEvent(
          payment,
          OutboxEventType.PAYMENT_RECEIVED,
          payment.createdAt,
        ),
      });

      return payment;
    });
  }

  createWithOutboxAndIdempotency(
    data: CreatePaymentRecord,
    idempotency: CreatePaymentIdempotencyRecord,
  ): Promise<PaymentWithMerchant> {
    return this.prisma.$transaction(async (transaction) => {
      const payment = await transaction.payment.create({
        data,
        include: {
          merchant: { select: { merchantCode: true, displayName: true } },
        },
      });
      await transaction.outboxEvent.create({
        data: paymentLifecycleOutboxEvent(
          payment,
          OutboxEventType.PAYMENT_RECEIVED,
          payment.createdAt,
        ),
      });
      await transaction.paymentIdempotencyRecord.create({
        data: { ...idempotency, paymentId: payment.id },
      });
      return payment;
    });
  }

  findIdempotencyRecord(merchantId: string, idempotencyKey: string) {
    return this.prisma.paymentIdempotencyRecord.findUnique({
      where: { merchantId_idempotencyKey: { merchantId, idempotencyKey } },
      include: {
        payment: {
          include: {
            merchant: { select: { merchantCode: true, displayName: true } },
          },
        },
      },
    });
  }

  findIdempotencyRecordByPaymentId(paymentId: string) {
    return this.prisma.paymentIdempotencyRecord.findUnique({
      where: { paymentId },
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

  listForMerchant({
    merchantId,
    where,
    orderBy,
    skip,
    take,
  }: {
    merchantId: string;
    where: Prisma.PaymentWhereInput;
    orderBy: Prisma.PaymentOrderByWithRelationInput;
    skip: number;
    take: number;
  }) {
    const scopedWhere: Prisma.PaymentWhereInput = { merchantId, ...where };
    return this.prisma.$transaction([
      this.prisma.payment.findMany({
        where: scopedWhere,
        include: {
          merchant: { select: { merchantCode: true, displayName: true } },
        },
        orderBy,
        skip,
        take,
      }),
      this.prisma.payment.count({ where: scopedWhere }),
    ]);
  }

  isUniqueConstraintViolation(
    error: unknown,
  ): error is Prisma.PrismaClientKnownRequestError {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }
}
