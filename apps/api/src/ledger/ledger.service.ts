import { BadRequestException, Injectable } from '@nestjs/common';
import { LedgerEntryType, ReservationStatus } from '@prisma/client';
import type { AuthenticatedMerchant } from '../auth/merchant-authentication.service';
import { PrismaService } from '../prisma/prisma.service';
import { ListLedgerQueryDto } from './dto/list-ledger-query.dto';

const creditEntryTypes = new Set<LedgerEntryType>([
  LedgerEntryType.INITIAL_CREDIT,
  LedgerEntryType.CREDIT_POSTED,
  LedgerEntryType.RETURN,
  LedgerEntryType.REVERSAL,
  LedgerEntryType.ADJUSTMENT,
]);

@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListLedgerQueryDto, merchant: AuthenticatedMerchant) {
    return this.listForScope(query, merchant.id, {
      merchantCode: merchant.merchantCode,
      displayName: merchant.displayName,
    });
  }

  async listAdmin(query: ListLedgerQueryDto, merchantId?: string) {
    return this.listForScope(query, merchantId, null);
  }

  private async listForScope(
    query: ListLedgerQueryDto,
    merchantId: string | undefined,
    merchant: { merchantCode: string; displayName: string } | null,
  ) {
    const [entries, fundingAccounts] = await Promise.all([
      this.prisma.ledgerEntry.findMany({
        where: merchantId ? { fundingAccount: { merchantId } } : {},
        include: {
          fundingAccount: {
            include: {
              merchant: { select: { merchantCode: true, displayName: true } },
            },
          },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.fundingAccount.findMany({
        where: merchantId ? { merchantId } : {},
        select: { id: true },
      }),
    ]);

    const paymentIds = entries.flatMap((entry) =>
      entry.paymentId ? [entry.paymentId] : [],
    );
    const [payments, reservations, activeReservations] = await Promise.all([
      this.prisma.payment.findMany({
        where: {
          ...(merchantId ? { merchantId } : {}),
          id: { in: paymentIds },
        },
        select: {
          id: true,
          externalReference: true,
          direction: true,
          amountCents: true,
          currency: true,
          status: true,
        },
      }),
      this.prisma.reservation.findMany({
        where: { paymentId: { in: paymentIds } },
        select: {
          paymentId: true,
          amount: true,
          status: true,
          createdAt: true,
          releasedAt: true,
          settledAt: true,
          returnedAt: true,
          returnCode: true,
        },
      }),
      this.prisma.reservation.aggregate({
        where: {
          fundingAccountId: {
            in: fundingAccounts.map((account) => account.id),
          },
          status: ReservationStatus.ACTIVE,
        },
        _sum: { amount: true },
      }),
    ]);

    const paymentsById = new Map(
      payments.map((payment) => [payment.id, payment]),
    );
    const reservationsByPaymentId = new Map(
      reservations.map((reservation) => [reservation.paymentId, reservation]),
    );
    const balancesByFundingAccount = new Map<string, bigint>();
    const rows = entries.map((entry) => {
      const impact = entryImpact(entry.entryType, entry.amount);
      const runningBalance =
        (balancesByFundingAccount.get(entry.fundingAccountId) ?? BigInt(0)) +
        impact;
      balancesByFundingAccount.set(entry.fundingAccountId, runningBalance);

      const payment = entry.paymentId
        ? (paymentsById.get(entry.paymentId) ?? null)
        : null;
      const reservation = entry.paymentId
        ? (reservationsByPaymentId.get(entry.paymentId) ?? null)
        : null;

      return {
        id: entry.id,
        entryKey: entry.entryKey,
        entryType: entry.entryType,
        amountCents: entry.amount.toString(),
        debitAmountCents:
          entry.entryType === LedgerEntryType.DEBIT_POSTED
            ? entry.amount.toString()
            : '0',
        creditAmountCents: creditEntryTypes.has(entry.entryType)
          ? entry.amount.toString()
          : '0',
        balanceImpactCents: impact.toString(),
        runningBalanceCents: runningBalance.toString(),
        createdAt: entry.createdAt.toISOString(),
        fundingAccountId: entry.fundingAccountId,
        currency: entry.fundingAccount.currency,
        merchant: entry.fundingAccount.merchant,
        payment: payment
          ? {
              id: payment.id,
              externalReference: payment.externalReference,
              direction: payment.direction,
              amountCents: payment.amountCents.toString(),
              currency: payment.currency,
              status: payment.status,
            }
          : null,
        reservation: reservation
          ? {
              amountCents: reservation.amount.toString(),
              status: reservation.status,
              createdAt: reservation.createdAt.toISOString(),
              releasedAt: reservation.releasedAt?.toISOString() ?? null,
              settledAt: reservation.settledAt?.toISOString() ?? null,
              returnedAt: reservation.returnedAt?.toISOString() ?? null,
              returnCode: reservation.returnCode,
            }
          : null,
        status: payment?.status ?? 'POSTED',
      };
    });

    const { start, end } = ledgerDateRange(query);
    const minimum = query.minAmountCents ? BigInt(query.minAmountCents) : null;
    const maximum = query.maxAmountCents ? BigInt(query.maxAmountCents) : null;
    if (minimum !== null && maximum !== null && minimum > maximum) {
      throw new BadRequestException('The amount range is invalid.');
    }
    const search = query.search?.trim().toLowerCase();
    const filteredRows = rows
      .filter((row) => {
        const timestamp = new Date(row.createdAt);
        const amount = BigInt(row.amountCents);
        if (query.entryType && row.entryType !== query.entryType) return false;
        if (start && end && (timestamp < start || timestamp >= end))
          return false;
        if (minimum !== null && amount < minimum) return false;
        if (maximum !== null && amount > maximum) return false;
        if (!search) return true;
        return [
          row.payment?.id,
          row.payment?.externalReference,
          row.merchant.merchantCode,
          row.merchant.displayName,
        ].some((value) => value?.toLowerCase().includes(search));
      })
      .reverse();

    const summary = filteredRows.reduce(
      (totals, row) => ({
        creditTotalCents:
          totals.creditTotalCents + BigInt(row.creditAmountCents),
        debitTotalCents: totals.debitTotalCents + BigInt(row.debitAmountCents),
      }),
      { creditTotalCents: BigInt(0), debitTotalCents: BigInt(0) },
    );

    return {
      merchant,
      data: filteredRows,
      summary: {
        totalCreditsCents: summary.creditTotalCents.toString(),
        totalDebitsCents: summary.debitTotalCents.toString(),
        netPositionCents: (
          summary.creditTotalCents - summary.debitTotalCents
        ).toString(),
        outstandingReservedAmountCents: BigInt(
          activeReservations._sum.amount ?? 0,
        ).toString(),
      },
    };
  }
}

function entryImpact(entryType: LedgerEntryType, amount: bigint): bigint {
  if (creditEntryTypes.has(entryType)) return amount;
  if (entryType === LedgerEntryType.DEBIT_POSTED) return -amount;
  return BigInt(0);
}

function ledgerDateRange(query: ListLedgerQueryDto): {
  start?: Date;
  end?: Date;
} {
  const dateRange = query.dateRange ?? 'all';
  if (dateRange === 'all') return {};
  if (dateRange === 'custom') {
    if (!query.startDate || !query.endDate) {
      throw new BadRequestException(
        'Custom date filtering requires both startDate and endDate.',
      );
    }
    const start = startOfUtcDay(new Date(query.startDate));
    const end = addUtcDays(startOfUtcDay(new Date(query.endDate)), 1);
    if (start >= end)
      throw new BadRequestException('The date range is invalid.');
    return { start, end };
  }
  const today = startOfUtcDay(new Date());
  if (dateRange === 'today') return { start: today, end: addUtcDays(today, 1) };
  return {
    start: addUtcDays(today, dateRange === '7d' ? -6 : -29),
    end: addUtcDays(today, 1),
  };
}

function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function addUtcDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}
