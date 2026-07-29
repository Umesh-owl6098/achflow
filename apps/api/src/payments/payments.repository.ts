import { Injectable } from '@nestjs/common';
import { Payment, PaymentDirection, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type CreatePaymentRecord = {
  idempotencyKey: string;
  requestFingerprint: string;
  externalReference?: string;
  direction: PaymentDirection;
  amountCents: bigint;
  currency: string;
  originatorName: string;
  receiverName: string;
  receiverAccountRef: string;
  routingNumber: string;
  description?: string;
};

@Injectable()
export class PaymentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: CreatePaymentRecord): Promise<Payment> {
    return this.prisma.payment.create({ data });
  }

  findByIdempotencyKey(idempotencyKey: string): Promise<Payment | null> {
    return this.prisma.payment.findUnique({
      where: { idempotencyKey },
    });
  }

  findById(id: string): Promise<Payment | null> {
    return this.prisma.payment.findUnique({
      where: { id },
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
}
