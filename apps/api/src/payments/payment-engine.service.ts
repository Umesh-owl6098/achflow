import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  FundingAccountStatus,
  LedgerEntryType,
  PaymentDirection,
  PaymentStatus,
  Prisma,
  ReservationStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PaymentEngineService {
  constructor(private readonly prisma: PrismaService) {}

  async validate(paymentId: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { merchant: true },
    });
    if (!payment) throw new NotFoundException(`Payment ${paymentId} was not found.`);
    if (payment.status !== PaymentStatus.RECEIVED) return payment;
    if (
      payment.amountCents <= BigInt(0) ||
      payment.currency !== 'USD' ||
      !payment.externalReference?.trim() ||
      !payment.receiverAccountRef.trim() ||
      !payment.routingNumber.trim() ||
      payment.merchant.status !== 'ACTIVE' ||
      (payment.direction === PaymentDirection.DEBIT && !payment.merchant.allowAchDebit) ||
      (payment.direction === PaymentDirection.CREDIT && !payment.merchant.allowAchCredit) ||
      payment.amountCents > payment.merchant.perPaymentLimit
    ) {
      throw new BadRequestException('Payment does not satisfy validation requirements.');
    }
    return this.prisma.payment.update({
      where: { id: paymentId },
      data: { status: PaymentStatus.VALIDATED, validatedAt: new Date(), validationCode: null, validationMessage: null, failureCode: null, failureReason: null },
    });
  }

  async reserve(paymentId: string) {
    return this.prisma.$transaction(async (transaction) => {
      const payment = await transaction.payment.findUnique({ where: { id: paymentId }, include: { merchant: true } });
      if (!payment) throw new NotFoundException(`Payment ${paymentId} was not found.`);
      const existing = await transaction.reservation.findUnique({ where: { paymentId } });
      if (existing) return existing;
      if (payment.status !== PaymentStatus.VALIDATED) throw new BadRequestException('Payment must be validated before reservation.');
      if (payment.direction !== PaymentDirection.CREDIT) return null;

      const businessDate = new Date(Date.UTC(payment.createdAt.getUTCFullYear(), payment.createdAt.getUTCMonth(), payment.createdAt.getUTCDate()));
      await transaction.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${payment.merchantId}:${businessDate.toISOString()}`}, 0))`);
      const usage = await transaction.merchantDailyUsage.findUnique({ where: { merchantId_businessDate: { merchantId: payment.merchantId, businessDate } } });
      const utilized = usage?.utilizedAmount ?? BigInt(0);
      if (utilized + payment.amountCents > payment.merchant.dailyAmountLimit) throw new BadRequestException('Payment exceeds the merchant daily limit.');
      const account = await transaction.fundingAccount.findUnique({ where: { merchantId_currency: { merchantId: payment.merchantId, currency: payment.currency } } });
      if (!account || account.status !== FundingAccountStatus.ACTIVE) throw new BadRequestException(`No active ${payment.currency} funding account exists for merchant.`);
      await transaction.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${account.id}, 0))`);
      const postedRows = await transaction.$queryRaw<{ total: bigint | null }[]>(Prisma.sql`SELECT COALESCE(SUM(CASE WHEN "entryType" IN ('INITIAL_CREDIT'::"LedgerEntryType", 'CREDIT_POSTED'::"LedgerEntryType", 'RETURN'::"LedgerEntryType", 'REVERSAL'::"LedgerEntryType", 'ADJUSTMENT'::"LedgerEntryType") THEN "amount" WHEN "entryType" = 'DEBIT_POSTED'::"LedgerEntryType" THEN -"amount" ELSE 0 END), 0) AS total FROM "LedgerEntry" WHERE "fundingAccountId" = ${account.id}`);
      const active = await transaction.reservation.aggregate({ where: { fundingAccountId: account.id, status: ReservationStatus.ACTIVE }, _sum: { amount: true } });
      const available = BigInt(postedRows[0]?.total ?? 0) - BigInt(active._sum.amount ?? 0);
      if (available < payment.amountCents) throw new BadRequestException('Insufficient funding balance.');
      const reservation = await transaction.reservation.create({ data: { paymentId, fundingAccountId: account.id, amount: payment.amountCents } });
      await transaction.ledgerEntry.create({ data: { entryKey: `reservation:${paymentId}`, fundingAccountId: account.id, paymentId, entryType: LedgerEntryType.RESERVATION, amount: payment.amountCents } });
      if (usage) await transaction.merchantDailyUsage.update({ where: { id: usage.id }, data: { utilizedAmount: utilized + payment.amountCents } });
      else await transaction.merchantDailyUsage.create({ data: { merchantId: payment.merchantId, businessDate, utilizedAmount: payment.amountCents } });
      return reservation;
    });
  }

  async settle(paymentId: string) {
    return this.prisma.$transaction(async (transaction) => {
      const reservation = await transaction.reservation.findUnique({ where: { paymentId } });
      if (!reservation) throw new NotFoundException(`Reservation for payment ${paymentId} was not found.`);
      if (reservation.status === ReservationStatus.SETTLED) return reservation;
      if (reservation.status !== ReservationStatus.ACTIVE) throw new BadRequestException('Reservation is not active for settlement.');
      const settled = await transaction.reservation.update({ where: { id: reservation.id }, data: { status: ReservationStatus.SETTLED, settledAt: new Date() } });
      await transaction.payment.update({ where: { id: paymentId }, data: { status: PaymentStatus.SETTLED } });
      await transaction.ledgerEntry.create({ data: { entryKey: `settlement:${paymentId}`, fundingAccountId: settled.fundingAccountId, paymentId, entryType: LedgerEntryType.SETTLEMENT, amount: settled.amount } });
      return settled;
    });
  }

  async returnSettlement(paymentId: string, returnCode: string) {
    return this.prisma.$transaction(async (transaction) => {
      const reservation = await transaction.reservation.findUnique({ where: { paymentId } });
      if (!reservation) throw new NotFoundException(`Reservation for payment ${paymentId} was not found.`);
      if (reservation.status === ReservationStatus.RETURNED) return reservation;
      if (reservation.status !== ReservationStatus.SETTLED) throw new BadRequestException('Reservation is not settled for return.');
      const returned = await transaction.reservation.update({ where: { id: reservation.id }, data: { status: ReservationStatus.RETURNED, returnedAt: new Date(), returnCode } });
      await transaction.payment.update({ where: { id: paymentId }, data: { status: PaymentStatus.RETURNED } });
      await transaction.ledgerEntry.create({ data: { entryKey: `return:${paymentId}`, fundingAccountId: returned.fundingAccountId, paymentId, entryType: LedgerEntryType.RETURN, amount: returned.amount } });
      return returned;
    });
  }

  async details(paymentId: string) {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId }, include: { merchant: { select: { merchantCode: true, displayName: true } } } });
    if (!payment) throw new NotFoundException(`Payment ${paymentId} was not found.`);
    const reservation = await this.prisma.reservation.findUnique({ where: { paymentId }, include: { fundingAccount: true } });
    const entries = reservation ? await this.prisma.ledgerEntry.findMany({ where: { paymentId }, orderBy: { createdAt: 'asc' } }) : [];
    const postedRows = reservation ? await this.prisma.$queryRaw<{ total: bigint | null }[]>(Prisma.sql`SELECT COALESCE(SUM(CASE WHEN "entryType" IN ('INITIAL_CREDIT'::"LedgerEntryType", 'CREDIT_POSTED'::"LedgerEntryType", 'RETURN'::"LedgerEntryType", 'REVERSAL'::"LedgerEntryType", 'ADJUSTMENT'::"LedgerEntryType") THEN "amount" WHEN "entryType" = 'DEBIT_POSTED'::"LedgerEntryType" THEN -"amount" ELSE 0 END), 0) AS total FROM "LedgerEntry" WHERE "fundingAccountId" = ${reservation.fundingAccountId}`) : [];
    const active = reservation ? await this.prisma.reservation.aggregate({ where: { fundingAccountId: reservation.fundingAccountId, status: ReservationStatus.ACTIVE }, _sum: { amount: true } }) : null;
    const postedBalance = BigInt(postedRows[0]?.total ?? 0);
    const activeReservedAmount = BigInt(active?._sum.amount ?? 0);
    return { payment, reservation, fundingAccount: reservation?.fundingAccount ?? null, ledgerSummary: { entries: entries.map((entry) => ({ id: entry.id, entryKey: entry.entryKey, entryType: entry.entryType, amount: entry.amount.toString(), createdAt: entry.createdAt })), postedBalance: postedBalance.toString(), activeReservedAmount: activeReservedAmount.toString(), availableBalance: (postedBalance - activeReservedAmount).toString() } };
  }
}
