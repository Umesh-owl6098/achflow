import { Injectable } from '@nestjs/common';
import {
  MerchantStatus,
  PaymentDirection,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { OutboxProcessingError } from '../outbox/outbox-processing.error';
import { WorkerPrismaService } from '../worker-prisma.service';

export type PaymentForValidation = {
  id: string;
  merchantId: string;
  status: PaymentStatus;
  amountCents: bigint;
  currency: string;
  direction: PaymentDirection;
  externalReference: string | null;
  createdAt: Date;
  receiverAccountRef: string;
  routingNumber: string;
  merchant: {
    status: MerchantStatus;
    allowAchDebit: boolean;
    allowAchCredit: boolean;
    perPaymentLimit: bigint;
    dailyAmountLimit: bigint;
  } | null;
};

export type ValidationResult = {
  status:
    typeof PaymentStatus.VALIDATED | typeof PaymentStatus.VALIDATION_FAILED;
  code: string | null;
  message: string | null;
};

@Injectable()
export class PaymentLifecycleRepository {
  constructor(private readonly prisma: WorkerPrismaService) {}

  findForValidation(id: string): Promise<PaymentForValidation | null> {
    return this.prisma.payment.findUnique({
      where: { id },
      select: {
        id: true,
        merchantId: true,
        status: true,
        amountCents: true,
        currency: true,
        direction: true,
        externalReference: true,
        createdAt: true,
        receiverAccountRef: true,
        routingNumber: true,
        merchant: {
          select: {
            status: true,
            allowAchDebit: true,
            allowAchCredit: true,
            perPaymentLimit: true,
            dailyAmountLimit: true,
          },
        },
      },
    });
  }

  async transitionFromReceived(
    paymentId: string,
    result: ValidationResult,
  ): Promise<void> {
    const update = await this.prisma.payment.updateMany({
      where: { id: paymentId, status: PaymentStatus.RECEIVED },
      data: this.transitionData(result),
    });

    if (update.count === 1) {
      return;
    }

    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: { status: true },
    });

    if (!payment) {
      throw new OutboxProcessingError('Payment not found for validation');
    }

    if (
      payment.status === PaymentStatus.VALIDATED ||
      payment.status === PaymentStatus.VALIDATION_FAILED
    ) {
      return;
    }

    throw new OutboxProcessingError('Payment is not eligible for validation');
  }

  async reserveDailyUsageAndTransition(
    payment: PaymentForValidation,
    outboxEventId: string,
  ): Promise<ValidationResult> {
    const businessDate = this.utcBusinessDate(payment.createdAt);
    const lockKey = `${payment.merchantId ?? ''}:${businessDate.toISOString()}`;

    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
      );

      const current = await transaction.payment.findUnique({
        where: { id: payment.id },
        select: { status: true },
      });
      if (!current) {
        throw new OutboxProcessingError('Payment not found for validation');
      }
      if (
        current.status === PaymentStatus.VALIDATED ||
        current.status === PaymentStatus.VALIDATION_FAILED
      ) {
        await this.completeOutbox(transaction, outboxEventId);
        return { status: current.status, code: null, message: null };
      }
      if (current.status !== PaymentStatus.RECEIVED || !payment.merchant) {
        throw new OutboxProcessingError(
          'Payment is not eligible for validation',
        );
      }

      const usage = await transaction.merchantDailyUsage.findUnique({
        where: {
          merchantId_businessDate: {
            merchantId: payment.merchantId,
            businessDate,
          },
        },
      });
      const utilizedAmount = usage?.utilizedAmount ?? BigInt(0);
      const nextAmount = utilizedAmount + payment.amountCents;
      const result =
        nextAmount > payment.merchant.dailyAmountLimit
          ? this.dailyLimitFailure(
              payment.merchant.dailyAmountLimit,
              utilizedAmount,
              payment.amountCents,
            )
          : { status: PaymentStatus.VALIDATED, code: null, message: null };

      if (result.status === PaymentStatus.VALIDATED) {
        if (usage) {
          await transaction.merchantDailyUsage.update({
            where: { id: usage.id },
            data: { utilizedAmount: nextAmount },
          });
        } else {
          await transaction.merchantDailyUsage.create({
            data: {
              merchantId: payment.merchantId,
              businessDate,
              utilizedAmount: nextAmount,
            },
          });
        }
      }

      await transaction.payment.updateMany({
        where: { id: payment.id, status: PaymentStatus.RECEIVED },
        data: this.transitionData(result),
      });
      await this.completeOutbox(transaction, outboxEventId);
      return result;
    });
  }

  private async completeOutbox(
    transaction: Prisma.TransactionClient,
    outboxEventId: string,
  ): Promise<void> {
    const updated = await transaction.outboxEvent.updateMany({
      where: { id: outboxEventId, status: 'PROCESSING' },
      data: {
        status: 'PROCESSED',
        processedAt: new Date(),
        claimedAt: null,
        lastError: null,
      },
    });
    if (updated.count !== 1)
      throw new OutboxProcessingError('Outbox event is not claimed');
  }

  private utcBusinessDate(createdAt: Date): Date {
    return new Date(
      Date.UTC(
        createdAt.getUTCFullYear(),
        createdAt.getUTCMonth(),
        createdAt.getUTCDate(),
      ),
    );
  }

  private dailyLimitFailure(
    limit: bigint,
    utilized: bigint,
    requested: bigint,
  ): ValidationResult {
    return {
      status: PaymentStatus.VALIDATION_FAILED,
      code: 'EXCEEDS_DAILY_AMOUNT_LIMIT',
      message: `Daily limit ${limit} exceeded: utilized ${utilized}, requested ${requested}`,
    };
  }

  private transitionData(
    result: ValidationResult,
  ): Prisma.PaymentUpdateManyMutationInput {
    return {
      status: result.status,
      validationCode: result.code,
      validationMessage: result.message,
      failureCode: result.code,
      failureReason: result.message,
      validatedAt: new Date(),
    };
  }
}
