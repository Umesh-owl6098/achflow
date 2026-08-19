import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  FundingAccountStatus,
  LedgerEntryType,
  OutboxEventType,
  PaymentDirection,
  PaymentStatus,
  Prisma,
  ReservationStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { paymentLifecycleOutboxEvent } from '../../prisma/payment-lifecycle-event.factory';

@Injectable()
export class PaymentEngineService {
  constructor(private readonly prisma: PrismaService) {}

  async validate(paymentId: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { merchant: true },
    });
    if (!payment)
      throw new NotFoundException(`Payment ${paymentId} was not found.`);
    if (payment.status !== PaymentStatus.RECEIVED) return payment;
    if (
      payment.amountCents <= BigInt(0) ||
      payment.currency !== 'USD' ||
      !payment.externalReference?.trim() ||
      !payment.receiverAccountRef.trim() ||
      !payment.routingNumber.trim() ||
      payment.merchant.status !== 'ACTIVE' ||
      (payment.direction === PaymentDirection.DEBIT &&
        !payment.merchant.allowAchDebit) ||
      (payment.direction === PaymentDirection.CREDIT &&
        !payment.merchant.allowAchCredit) ||
      payment.amountCents > payment.merchant.perPaymentLimit
    ) {
      throw new BadRequestException(
        'Payment does not satisfy validation requirements.',
      );
    }
    return this.prisma.$transaction(async (transaction) => {
      const validated = await transaction.payment.update({
        where: { id: paymentId },
        data: {
          status: PaymentStatus.VALIDATED,
          validatedAt: new Date(),
          validationCode: null,
          validationMessage: null,
          failureCode: null,
          failureReason: null,
        },
      });
      await transaction.outboxEvent.create({
        data: paymentLifecycleOutboxEvent(
          validated,
          OutboxEventType.PAYMENT_VALIDATED,
          validated.updatedAt,
        ),
      });
      return validated;
    });
  }

  async reserve(paymentId: string) {
    return this.prisma.$transaction(async (transaction) => {
      const payment = await transaction.payment.findUnique({
        where: { id: paymentId },
        include: { merchant: true },
      });
      if (!payment)
        throw new NotFoundException(`Payment ${paymentId} was not found.`);
      const existing = await transaction.reservation.findUnique({
        where: { paymentId },
      });
      if (existing) return existing;
      if (payment.status !== PaymentStatus.VALIDATED)
        throw new BadRequestException(
          'Payment must be validated before reservation.',
        );
      if (payment.direction !== PaymentDirection.CREDIT) return null;

      const businessDate = new Date(
        Date.UTC(
          payment.createdAt.getUTCFullYear(),
          payment.createdAt.getUTCMonth(),
          payment.createdAt.getUTCDate(),
        ),
      );
      await transaction.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${payment.merchantId}:${businessDate.toISOString()}`}, 0))`,
      );
      const usage = await transaction.merchantDailyUsage.findUnique({
        where: {
          merchantId_businessDate: {
            merchantId: payment.merchantId,
            businessDate,
          },
        },
      });
      const utilized = usage?.utilizedAmount ?? BigInt(0);
      if (utilized + payment.amountCents > payment.merchant.dailyAmountLimit)
        throw new BadRequestException(
          'Payment exceeds the merchant daily limit.',
        );
      const account = await transaction.fundingAccount.findUnique({
        where: {
          merchantId_currency: {
            merchantId: payment.merchantId,
            currency: payment.currency,
          },
        },
      });
      if (!account || account.status !== FundingAccountStatus.ACTIVE)
        throw new BadRequestException(
          `No active ${payment.currency} funding account exists for merchant.`,
        );
      await transaction.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${account.id}, 0))`,
      );
      const postedRows = await transaction.$queryRaw<
        { total: bigint | null }[]
      >(
        Prisma.sql`SELECT COALESCE(SUM(CASE WHEN "entryType" IN ('INITIAL_CREDIT'::"LedgerEntryType", 'CREDIT_POSTED'::"LedgerEntryType", 'RETURN'::"LedgerEntryType", 'REVERSAL'::"LedgerEntryType", 'ADJUSTMENT'::"LedgerEntryType") THEN "amount" WHEN "entryType" = 'DEBIT_POSTED'::"LedgerEntryType" THEN -"amount" ELSE 0 END), 0) AS total FROM "LedgerEntry" WHERE "fundingAccountId" = ${account.id}`,
      );
      const active = await transaction.reservation.aggregate({
        where: {
          fundingAccountId: account.id,
          status: ReservationStatus.ACTIVE,
        },
        _sum: { amount: true },
      });
      const available =
        BigInt(postedRows[0]?.total ?? 0) - BigInt(active._sum.amount ?? 0);
      if (available < payment.amountCents)
        throw new BadRequestException('Insufficient funding balance.');
      const reservation = await transaction.reservation.create({
        data: {
          paymentId,
          fundingAccountId: account.id,
          amount: payment.amountCents,
        },
      });
      await transaction.ledgerEntry.create({
        data: {
          entryKey: `reservation:${paymentId}`,
          fundingAccountId: account.id,
          paymentId,
          entryType: LedgerEntryType.RESERVATION,
          amount: payment.amountCents,
        },
      });
      if (usage)
        await transaction.merchantDailyUsage.update({
          where: { id: usage.id },
          data: { utilizedAmount: utilized + payment.amountCents },
        });
      else
        await transaction.merchantDailyUsage.create({
          data: {
            merchantId: payment.merchantId,
            businessDate,
            utilizedAmount: payment.amountCents,
          },
        });
      await transaction.outboxEvent.create({
        data: paymentLifecycleOutboxEvent(
          payment,
          OutboxEventType.PAYMENT_RESERVED,
        ),
      });
      return reservation;
    });
  }

  async settle(paymentId: string) {
    return this.prisma.$transaction(async (transaction) => {
      const reservation = await transaction.reservation.findUnique({
        where: { paymentId },
      });
      if (!reservation) {
        return this.settleDebitPayment(transaction, paymentId);
      }
      if (reservation.status === ReservationStatus.SETTLED) return reservation;
      if (reservation.status !== ReservationStatus.ACTIVE)
        throw new BadRequestException(
          'Reservation is not active for settlement.',
        );
      const payment = await transaction.payment.findUniqueOrThrow({
        where: { id: paymentId },
      });
      if (payment.status !== PaymentStatus.SUBMITTED) {
        throw new BadRequestException(
          'Payment is not submitted for settlement.',
        );
      }
      const settled = await transaction.reservation.update({
        where: { id: reservation.id },
        data: { status: ReservationStatus.SETTLED, settledAt: new Date() },
      });
      await transaction.payment.update({
        where: { id: paymentId },
        data: { status: PaymentStatus.SETTLED },
      });
      await transaction.ledgerEntry.create({
        data: {
          entryKey: `settlement:${paymentId}`,
          fundingAccountId: settled.fundingAccountId,
          paymentId,
          entryType: LedgerEntryType.SETTLEMENT,
          amount: settled.amount,
        },
      });
      const settledPayment = await transaction.payment.findUniqueOrThrow({
        where: { id: paymentId },
      });
      await transaction.outboxEvent.create({
        data: paymentLifecycleOutboxEvent(
          settledPayment,
          OutboxEventType.PAYMENT_SETTLED,
          settledPayment.updatedAt,
        ),
      });
      return settled;
    });
  }

  private async settleDebitPayment(
    transaction: Prisma.TransactionClient,
    paymentId: string,
  ) {
    await transaction.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${paymentId}, 0))`,
    );
    const payment = await transaction.payment.findUnique({
      where: { id: paymentId },
      select: {
        id: true,
        merchantId: true,
        direction: true,
        amountCents: true,
        currency: true,
        status: true,
      },
    });
    if (!payment) {
      throw new NotFoundException(
        `Reservation for payment ${paymentId} was not found.`,
      );
    }
    if (payment.direction !== PaymentDirection.DEBIT) {
      throw new NotFoundException(
        `Reservation for payment ${paymentId} was not found.`,
      );
    }
    if (payment.status === PaymentStatus.SETTLED) return null;
    if (payment.status !== PaymentStatus.SUBMITTED) {
      throw new BadRequestException('Payment is not submitted for settlement.');
    }
    const account = await transaction.fundingAccount.findUnique({
      where: {
        merchantId_currency: {
          merchantId: payment.merchantId,
          currency: payment.currency,
        },
      },
    });
    if (!account || account.status !== FundingAccountStatus.ACTIVE) {
      throw new BadRequestException(
        `No active ${payment.currency} funding account exists for merchant.`,
      );
    }
    await transaction.payment.update({
      where: { id: paymentId },
      data: { status: PaymentStatus.SETTLED },
    });
    await transaction.ledgerEntry.create({
      data: {
        entryKey: `debit-posted:${paymentId}`,
        fundingAccountId: account.id,
        paymentId,
        entryType: LedgerEntryType.DEBIT_POSTED,
        amount: payment.amountCents,
      },
    });
    const settledPayment = await transaction.payment.findUniqueOrThrow({
      where: { id: paymentId },
    });
    await transaction.outboxEvent.create({
      data: paymentLifecycleOutboxEvent(
        settledPayment,
        OutboxEventType.PAYMENT_SETTLED,
        settledPayment.updatedAt,
      ),
    });
    return null;
  }

  async returnSettlement(paymentId: string, returnCode: string) {
    return this.prisma.$transaction(async (transaction) => {
      const reservation = await transaction.reservation.findUnique({
        where: { paymentId },
      });
      if (!reservation) {
        return this.returnDebitPayment(transaction, paymentId, returnCode);
      }
      if (reservation.status === ReservationStatus.RETURNED) return reservation;
      if (reservation.status !== ReservationStatus.SETTLED)
        throw new BadRequestException('Reservation is not settled for return.');
      const returned = await transaction.reservation.update({
        where: { id: reservation.id },
        data: {
          status: ReservationStatus.RETURNED,
          returnedAt: new Date(),
          returnCode,
        },
      });
      await transaction.payment.update({
        where: { id: paymentId },
        data: { status: PaymentStatus.RETURNED },
      });
      await transaction.ledgerEntry.create({
        data: {
          entryKey: `return:${paymentId}`,
          fundingAccountId: returned.fundingAccountId,
          paymentId,
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

  private async returnDebitPayment(
    transaction: Prisma.TransactionClient,
    paymentId: string,
    returnCode: string,
  ): Promise<null> {
    await transaction.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${paymentId}, 0))`,
    );
    const payment = await transaction.payment.findUnique({
      where: { id: paymentId },
      select: {
        id: true,
        direction: true,
        amountCents: true,
        status: true,
      },
    });
    if (!payment || payment.direction !== PaymentDirection.DEBIT) {
      throw new NotFoundException(
        `Reservation for payment ${paymentId} was not found.`,
      );
    }
    if (payment.status === PaymentStatus.RETURNED) return null;
    if (payment.status !== PaymentStatus.SETTLED) {
      throw new BadRequestException('Payment is not settled for return.');
    }

    const debitPosted = await transaction.ledgerEntry.findUnique({
      where: { entryKey: `debit-posted:${paymentId}` },
    });
    if (
      !debitPosted ||
      debitPosted.paymentId !== paymentId ||
      debitPosted.entryType !== LedgerEntryType.DEBIT_POSTED ||
      debitPosted.amount !== payment.amountCents
    ) {
      throw new BadRequestException(
        'Posted debit ledger entry is invalid for return.',
      );
    }

    const returned = await transaction.payment.updateMany({
      where: { id: paymentId, status: PaymentStatus.SETTLED },
      data: {
        status: PaymentStatus.RETURNED,
        failureCode: returnCode,
        failureReason: 'ACH debit return',
      },
    });
    if (returned.count !== 1) {
      throw new BadRequestException('Payment is not settled for return.');
    }
    await transaction.ledgerEntry.create({
      data: {
        entryKey: `debit-return:${paymentId}`,
        fundingAccountId: debitPosted.fundingAccountId,
        paymentId,
        entryType: LedgerEntryType.RETURN,
        amount: debitPosted.amount,
      },
    });
    const returnedPayment = await transaction.payment.findUniqueOrThrow({
      where: { id: paymentId },
    });
    await transaction.outboxEvent.create({
      data: paymentLifecycleOutboxEvent(
        returnedPayment,
        OutboxEventType.PAYMENT_RETURNED,
        returnedPayment.updatedAt,
        returnCode,
      ),
    });
    return null;
  }

  async details(paymentId: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        merchant: { select: { merchantCode: true, displayName: true } },
      },
    });
    if (!payment)
      throw new NotFoundException(`Payment ${paymentId} was not found.`);
    const reservation = await this.prisma.reservation.findUnique({
      where: { paymentId },
      include: { fundingAccount: true },
    });
    const [entries, outboxEvents] = await Promise.all([
      this.prisma.ledgerEntry.findMany({
        where: { paymentId },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.outboxEvent.findMany({
        where: { aggregateId: paymentId, aggregateType: 'PAYMENT' },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const fundingAccountId =
      reservation?.fundingAccountId ?? entries[0]?.fundingAccountId;
    const fundingAccount =
      reservation?.fundingAccount ??
      (fundingAccountId
        ? await this.prisma.fundingAccount.findUnique({
            where: { id: fundingAccountId },
          })
        : null);
    const postedRows = fundingAccountId
      ? await this.prisma.$queryRaw<{ total: bigint | null }[]>(
          Prisma.sql`SELECT COALESCE(SUM(CASE WHEN "entryType" IN ('INITIAL_CREDIT'::"LedgerEntryType", 'CREDIT_POSTED'::"LedgerEntryType", 'RETURN'::"LedgerEntryType", 'REVERSAL'::"LedgerEntryType", 'ADJUSTMENT'::"LedgerEntryType") THEN "amount" WHEN "entryType" = 'DEBIT_POSTED'::"LedgerEntryType" THEN -"amount" ELSE 0 END), 0) AS total FROM "LedgerEntry" WHERE "fundingAccountId" = ${fundingAccountId}`,
        )
      : [];
    const active = fundingAccountId
      ? await this.prisma.reservation.aggregate({
          where: {
            fundingAccountId,
            status: ReservationStatus.ACTIVE,
          },
          _sum: { amount: true },
        })
      : null;
    const postedBalance = BigInt(postedRows[0]?.total ?? 0);
    const activeReservedAmount = BigInt(active?._sum.amount ?? 0);
    return {
      payment,
      reservation,
      fundingAccount,
      ledgerSummary: {
        entries: entries.map((entry) => ({
          id: entry.id,
          entryKey: entry.entryKey,
          entryType: entry.entryType,
          amount: entry.amount.toString(),
          createdAt: entry.createdAt,
        })),
        postedBalance: postedBalance.toString(),
        activeReservedAmount: activeReservedAmount.toString(),
        availableBalance: (postedBalance - activeReservedAmount).toString(),
      },
      outboxEvents: outboxEvents.map((event) => ({
        id: event.id,
        eventType: event.eventType,
        status: event.status,
        attempts: event.attempts,
        createdAt: event.createdAt,
        processedAt: event.processedAt,
      })),
    };
  }
}
