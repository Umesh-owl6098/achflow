import { Injectable } from '@nestjs/common';
import { PaymentDirection, PaymentStatus } from '@prisma/client';
import { AuthenticatedMerchant } from '../auth/merchant-authentication.service';
import { PrismaService } from '../prisma/prisma.service';

type DashboardPayment = {
  id: string;
  externalReference: string | null;
  direction: PaymentDirection;
  status: PaymentStatus;
  amountCents: bigint;
  currency: string;
  createdAt: Date;
  merchant: { merchantCode: string; displayName: string };
};

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getDashboard(merchant: AuthenticatedMerchant) {
    return this.getDashboardForMerchant(merchant.id);
  }

  async getAdminDashboard(merchantId?: string) {
    return this.getDashboardForMerchant(merchantId);
  }

  private async getDashboardForMerchant(merchantId?: string) {
    const now = new Date();
    const todayStart = startOfUtcDay(now);
    const tomorrowStart = addUtcDays(todayStart, 1);
    const sevenDaysStart = addUtcDays(todayStart, -6);

    const [todayPayments, weeklyPayments, statusGroups, recentPayments] =
      await Promise.all([
        this.paymentsBetween(merchantId, todayStart, tomorrowStart),
        this.paymentsBetween(merchantId, sevenDaysStart, tomorrowStart),
        this.prisma.payment.groupBy({
          by: ['status'],
          where: merchantId ? { merchantId } : {},
          _count: { _all: true },
        }),
        this.prisma.payment.findMany({
          where: merchantId ? { merchantId } : {},
          include: {
            merchant: { select: { merchantCode: true, displayName: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 10,
        }),
      ]);

    return {
      summary: buildSummary(todayPayments),
      dailyVolume: buildDailyVolume(weeklyPayments, sevenDaysStart),
      statusDistribution: buildStatusDistribution(statusGroups),
      recentPayments: recentPayments.map(serializePayment),
      generatedAt: now.toISOString(),
    };
  }

  private paymentsBetween(
    merchantId: string | undefined,
    start: Date,
    end: Date,
  ): Promise<DashboardPayment[]> {
    return this.prisma.payment.findMany({
      where: {
        ...(merchantId ? { merchantId } : {}),
        createdAt: { gte: start, lt: end },
      },
      include: {
        merchant: { select: { merchantCode: true, displayName: true } },
      },
    });
  }
}

function buildSummary(payments: DashboardPayment[]) {
  const debitPayments = payments.filter(
    (payment) => payment.direction === PaymentDirection.DEBIT,
  );
  const creditPayments = payments.filter(
    (payment) => payment.direction === PaymentDirection.CREDIT,
  );

  return {
    paymentsToday: payments.length,
    totalAmountCents: sumAmounts(payments).toString(),
    debitAmountCents: sumAmounts(debitPayments).toString(),
    creditAmountCents: sumAmounts(creditPayments).toString(),
    submittedPayments: payments.filter(
      (payment) => payment.status === PaymentStatus.SUBMITTED,
    ).length,
    settledPayments: payments.filter(
      (payment) => payment.status === PaymentStatus.SETTLED,
    ).length,
    returnedPayments: payments.filter(
      (payment) => payment.status === PaymentStatus.RETURNED,
    ).length,
  };
}

function buildDailyVolume(payments: DashboardPayment[], start: Date) {
  const records = new Map<
    string,
    {
      debit: bigint;
      credit: bigint;
      debitCount: number;
      creditCount: number;
    }
  >();
  for (let index = 0; index < 7; index += 1) {
    records.set(formatUtcDate(addUtcDays(start, index)), {
      debit: BigInt(0),
      credit: BigInt(0),
      debitCount: 0,
      creditCount: 0,
    });
  }

  for (const payment of payments) {
    const key = formatUtcDate(payment.createdAt);
    const record = records.get(key);
    if (!record) continue;
    if (payment.direction === PaymentDirection.DEBIT) {
      record.debit += payment.amountCents;
      record.debitCount += 1;
    } else {
      record.credit += payment.amountCents;
      record.creditCount += 1;
    }
  }

  return [...records.entries()].map(([date, amount]) => ({
    date,
    debitCount: amount.debitCount,
    creditCount: amount.creditCount,
    totalCount: amount.debitCount + amount.creditCount,
    debitAmountCents: amount.debit.toString(),
    creditAmountCents: amount.credit.toString(),
    totalAmountCents: (amount.debit + amount.credit).toString(),
  }));
}

function buildStatusDistribution(
  groups: { status: PaymentStatus; _count: { _all: number } }[],
) {
  const requestedStatuses = [
    PaymentStatus.RECEIVED,
    PaymentStatus.VALIDATED,
    PaymentStatus.SUBMITTED,
    PaymentStatus.SETTLED,
    PaymentStatus.RETURNED,
    PaymentStatus.VALIDATION_FAILED,
  ];
  const counts = new Map(
    groups.map((group) => [group.status, group._count._all]),
  );
  return requestedStatuses.map((status) => ({
    status,
    count: counts.get(status) ?? 0,
  }));
}

function serializePayment(payment: DashboardPayment) {
  return {
    id: payment.id,
    merchant: payment.merchant,
    externalReference: payment.externalReference,
    direction: payment.direction,
    status: payment.status,
    amountCents: payment.amountCents.toString(),
    currency: payment.currency,
    createdAt: payment.createdAt.toISOString(),
  };
}

function sumAmounts(payments: DashboardPayment[]): bigint {
  return payments.reduce(
    (sum, payment) => sum + payment.amountCents,
    BigInt(0),
  );
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

function formatUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
