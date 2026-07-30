import { Injectable, Logger } from '@nestjs/common';
import {
  MerchantStatus,
  FundingAccountStatus,
  LedgerEntryType,
  OutboxEventType,
  PaymentDirection,
  PaymentStatus,
  Prisma,
  ReservationStatus,
} from '@prisma/client';
import { OutboxProcessingError } from '../outbox/outbox-processing.error';
import { WorkerPrismaService } from '../worker-prisma.service';
import { paymentLifecycleOutboxEvent } from '../../../api/prisma/payment-lifecycle-event.factory';

export type PaymentForValidation = {
  id: string;
  merchantId: string;
  status: PaymentStatus;
  amountCents: bigint;
  currency: string;
  direction: PaymentDirection;
  externalReference: string | null;
  validationCode: string | null;
  validationMessage: string | null;
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

export type BankSettlementEvent = {
  bankEventId: string;
  paymentId: string;
  eventType: 'SETTLED';
  eventTimestamp: Date;
};

@Injectable()
export class PaymentLifecycleRepository {
  private readonly logger = new Logger(PaymentLifecycleRepository.name);
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
        validationCode: true,
        validationMessage: true,
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
    const update = await this.prisma.$transaction(async (transaction) => {
      const transitioned = await transaction.payment.updateMany({
        where: { id: paymentId, status: PaymentStatus.RECEIVED },
        data: this.transitionData(result),
      });
      if (transitioned.count !== 1) return transitioned;
      const payment = await transaction.payment.findUniqueOrThrow({
        where: { id: paymentId },
      });
      await transaction.outboxEvent.create({
        data: paymentLifecycleOutboxEvent(
          payment,
          result.status === PaymentStatus.VALIDATED
            ? OutboxEventType.PAYMENT_VALIDATED
            : OutboxEventType.PAYMENT_VALIDATION_FAILED,
          payment.updatedAt,
        ),
      });
      return transitioned;
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

  async releaseReservationForPayment(paymentId: string) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${paymentId}, 0))`,
      );

      const reservation = await transaction.reservation.findUnique({
        where: { paymentId },
      });
      if (!reservation) {
        throw new OutboxProcessingError('Reservation not found for payment');
      }

      if (reservation.status === ReservationStatus.RELEASED) {
        return reservation;
      }

      const released = await transaction.reservation.update({
        where: { id: reservation.id },
        data: {
          status: ReservationStatus.RELEASED,
          releasedAt: new Date(),
        },
      });
      await transaction.ledgerEntry.create({
        data: {
          entryKey: `reservation-release:${paymentId}`,
          fundingAccountId: released.fundingAccountId,
          paymentId: released.paymentId,
          entryType: LedgerEntryType.RESERVATION_RELEASE,
          amount: released.amount,
        },
      });

      return released;
    });
  }

  async settleReservationForPayment(paymentId: string) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${paymentId}, 0))`,
      );

      const reservation = await transaction.reservation.findUnique({
        where: { paymentId },
      });
      if (!reservation) {
        throw new OutboxProcessingError('Reservation not found for payment');
      }
      if (reservation.status === ReservationStatus.SETTLED) {
        return reservation;
      }
      if (reservation.status !== ReservationStatus.ACTIVE) {
        throw new OutboxProcessingError(
          'Reservation is not active for settlement',
        );
      }

      const settled = await transaction.reservation.update({
        where: { id: reservation.id },
        data: {
          status: ReservationStatus.SETTLED,
          settledAt: new Date(),
        },
      });
      const paymentUpdate = await transaction.payment.updateMany({
        where: { id: paymentId, status: PaymentStatus.SUBMITTED },
        data: { status: PaymentStatus.SETTLED },
      });
      if (paymentUpdate.count !== 1) {
        throw new OutboxProcessingError(
          'Payment is not submitted for settlement',
        );
      }
      await transaction.ledgerEntry.create({
        data: {
          entryKey: `settlement:${paymentId}`,
          fundingAccountId: settled.fundingAccountId,
          paymentId: settled.paymentId,
          entryType: LedgerEntryType.SETTLEMENT,
          amount: settled.amount,
        },
      });
      const payment = await transaction.payment.findUniqueOrThrow({
        where: { id: paymentId },
      });
      await transaction.outboxEvent.create({
        data: paymentLifecycleOutboxEvent(
          payment,
          OutboxEventType.PAYMENT_SETTLED,
          payment.updatedAt,
        ),
      });

      return settled;
    });
  }

  async returnSettlementForPayment(paymentId: string, returnCode: string) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${paymentId}, 0))`,
      );

      const reservation = await transaction.reservation.findUnique({
        where: { paymentId },
      });
      if (!reservation) {
        throw new OutboxProcessingError('Reservation not found for payment');
      }
      if (reservation.status === ReservationStatus.RETURNED) {
        return reservation;
      }
      if (reservation.status !== ReservationStatus.SETTLED) {
        throw new OutboxProcessingError(
          'Reservation is not settled for return',
        );
      }

      const returned = await transaction.reservation.update({
        where: { id: reservation.id },
        data: {
          status: ReservationStatus.RETURNED,
          returnedAt: new Date(),
          returnCode,
        },
      });
      const paymentUpdate = await transaction.payment.updateMany({
        where: {
          id: paymentId,
          status: { in: [PaymentStatus.SETTLED, PaymentStatus.VALIDATED] },
        },
        data: { status: PaymentStatus.RETURNED },
      });
      if (paymentUpdate.count !== 1) {
        throw new OutboxProcessingError('Payment is not settled for return');
      }
      await transaction.ledgerEntry.create({
        data: {
          entryKey: `return:${paymentId}`,
          fundingAccountId: returned.fundingAccountId,
          paymentId: returned.paymentId,
          entryType: LedgerEntryType.RETURN,
          amount: returned.amount,
        },
      });
      const payment = await transaction.payment.findUniqueOrThrow({
        where: { id: paymentId },
      });
      await transaction.outboxEvent.create({
        data: paymentLifecycleOutboxEvent(
          payment,
          OutboxEventType.PAYMENT_RETURNED,
          payment.updatedAt,
          returned.returnCode,
        ),
      });

      return returned;
    });
  }

  async processBankSettlementEvent(event: BankSettlementEvent) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${event.bankEventId}, 0))`,
      );
      const existing = await transaction.processedBankEvent.findUnique({
        where: { bankEventId: event.bankEventId },
      });
      if (existing) {
        return existing;
      }
      const payment = await transaction.payment.findUnique({
        where: { id: event.paymentId },
        select: { id: true, status: true },
      });
      if (!payment) {
        throw new OutboxProcessingError(
          'Payment not found for bank settlement event',
        );
      }
      if (
        event.eventType !== 'SETTLED' ||
        (payment.status !== PaymentStatus.SETTLED &&
          payment.status !== PaymentStatus.RETURNED)
      ) {
        throw new OutboxProcessingError(
          'Payment is not settled for bank settlement event',
        );
      }
      const processedEvent = await transaction.processedBankEvent.create({
        data: event,
      });
      await this.afterBankSettlementEventPersisted();
      return processedEvent;
    });
  }

  async reserveDailyUsageAndTransition(
    payment: PaymentForValidation,
    outboxEventId: string,
  ): Promise<ValidationResult> {
    const businessDate = this.utcBusinessDate(payment.createdAt);
    const lockKey = `${payment.merchantId ?? ''}:${businessDate.toISOString()}`;

    return this.prisma.$transaction(async (transaction) => {
      this.developmentLog('transaction.started', payment.id);
      await transaction.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
      );
      this.developmentLog('daily_lock.acquired', payment.id);

      const current = await transaction.payment.findUnique({
        where: { id: payment.id },
        select: { status: true },
      });
      if (!current) {
        throw new OutboxProcessingError('Payment not found for validation');
      }
      if (current.status !== PaymentStatus.RECEIVED) {
        await this.completeOutbox(transaction, outboxEventId);
        return current.status === PaymentStatus.VALIDATION_FAILED
          ? {
              status: PaymentStatus.VALIDATION_FAILED,
              code: payment.validationCode,
              message: payment.validationMessage,
            }
          : {
              status: PaymentStatus.VALIDATED,
              code: null,
              message: null,
            };
      }
      if (!payment.merchant) {
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
      this.developmentLog('daily_usage.loaded', payment.id);
      const utilizedAmount = usage?.utilizedAmount ?? BigInt(0);
      const nextAmount = utilizedAmount + payment.amountCents;
      let result =
        nextAmount > payment.merchant.dailyAmountLimit
          ? this.dailyLimitFailure(
              payment.merchant.dailyAmountLimit,
              utilizedAmount,
              payment.amountCents,
            )
          : { status: PaymentStatus.VALIDATED, code: null, message: null };

      if (
        result.status === PaymentStatus.VALIDATED &&
        payment.direction === PaymentDirection.CREDIT
      ) {
        const account = await transaction.fundingAccount.findUnique({
          where: {
            merchantId_currency: {
              merchantId: payment.merchantId,
              currency: payment.currency,
            },
          },
        });
        this.developmentLog('funding_account.loaded', payment.id, {
          found: Boolean(account),
        });
        if (!account || account.status !== FundingAccountStatus.ACTIVE) {
          result = this.failed(
            'FUNDING_ACCOUNT_UNAVAILABLE',
            `No active ${payment.currency} funding account exists for merchant`,
          );
        } else {
          await transaction.$executeRaw(
            Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${account.id}, 0))`,
          );
          this.developmentLog('funding_lock.acquired', payment.id);
          const entries = await transaction.$queryRaw<
            { total: bigint | null }[]
          >(
            Prisma.sql`SELECT COALESCE(SUM(CASE WHEN "entryType" IN ('INITIAL_CREDIT'::"LedgerEntryType", 'CREDIT_POSTED'::"LedgerEntryType", 'RETURN'::"LedgerEntryType", 'REVERSAL'::"LedgerEntryType", 'ADJUSTMENT'::"LedgerEntryType") THEN "amount" WHEN "entryType" = 'DEBIT_POSTED'::"LedgerEntryType" THEN -"amount" ELSE 0 END), 0) AS total FROM "LedgerEntry" WHERE "fundingAccountId" = ${account.id}`,
          );
          const reserved = await transaction.reservation.aggregate({
            where: { fundingAccountId: account.id, status: 'ACTIVE' },
            _sum: { amount: true },
          });
          const postedBalance = BigInt(entries[0]?.total ?? 0);
          const available = postedBalance - (reserved._sum.amount ?? BigInt(0));
          this.developmentLog('funding.balance.calculated', payment.id, {
            postedBalance: postedBalance.toString(),
            activeReservations: (reserved._sum.amount ?? BigInt(0)).toString(),
            available: available.toString(),
          });
          if (available < payment.amountCents)
            result = this.failed(
              'INSUFFICIENT_FUNDS',
              `Available ${available}, requested ${payment.amountCents}, currency ${payment.currency}`,
            );
          else {
            await transaction.reservation.create({
              data: {
                paymentId: payment.id,
                fundingAccountId: account.id,
                amount: payment.amountCents,
              },
            });
            this.developmentLog('reservation.inserted', payment.id);
            await transaction.ledgerEntry.create({
              data: {
                entryKey: `reservation:${payment.id}`,
                fundingAccountId: account.id,
                paymentId: payment.id,
                entryType: LedgerEntryType.RESERVATION,
                amount: payment.amountCents,
              },
            });
            this.developmentLog('ledger_entry.inserted', payment.id);
          }
        }
      }

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

      if (result.status === PaymentStatus.VALIDATED) {
        await this.afterFinancialWrites();
      }

      await transaction.payment.updateMany({
        where: { id: payment.id, status: PaymentStatus.RECEIVED },
        data: this.transitionData(result),
      });
      const transitionedPayment = await transaction.payment.findUniqueOrThrow({
        where: { id: payment.id },
      });
      await transaction.outboxEvent.create({
        data: paymentLifecycleOutboxEvent(
          transitionedPayment,
          result.status === PaymentStatus.VALIDATED
            ? OutboxEventType.PAYMENT_VALIDATED
            : OutboxEventType.PAYMENT_VALIDATION_FAILED,
          transitionedPayment.updatedAt,
        ),
      });
      if (
        result.status === PaymentStatus.VALIDATED &&
        payment.direction === PaymentDirection.CREDIT
      ) {
        await transaction.outboxEvent.create({
          data: paymentLifecycleOutboxEvent(
            transitionedPayment,
            OutboxEventType.PAYMENT_RESERVED,
            transitionedPayment.updatedAt,
          ),
        });
      }
      await this.completeOutbox(transaction, outboxEventId);
      this.developmentLog('outbox.completed', payment.id);
      return result;
    });
  }

  private developmentLog(
    checkpoint: string,
    paymentId: string,
    details: Record<string, unknown> = {},
  ): void {
    if (process.env.NODE_ENV !== 'production')
      this.logger.debug(
        JSON.stringify({
          event: 'ledger.reservation',
          checkpoint,
          paymentId,
          ...details,
        }),
      );
  }

  // Deliberate no-op seam used only by rollback integration tests. It runs
  // inside the transaction so a test can verify PostgreSQL atomicity.
  protected async afterFinancialWrites(): Promise<void> {}

  // Deliberate no-op seam used only by reconciliation rollback integration
  // tests. It runs after insertion and before the transaction commits.
  protected async afterBankSettlementEventPersisted(): Promise<void> {}

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

  private failed(code: string, message: string): ValidationResult {
    return { status: PaymentStatus.VALIDATION_FAILED, code, message };
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
      validatedAt:
        result.status === PaymentStatus.VALIDATED ? new Date() : null,
    };
  }
}
