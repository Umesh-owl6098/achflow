import { PaymentDirection, PaymentStatus } from '@prisma/client';
import { DashboardService } from './dashboard.service';

const merchantA = { merchantCode: 'MERCHANT_A', displayName: 'Merchant A' };
const merchantB = { merchantCode: 'MERCHANT_B', displayName: 'Merchant B' };

function payment(id: string, merchant: typeof merchantA, amountCents: bigint) {
  return {
    id,
    merchant,
    externalReference: null,
    direction: PaymentDirection.DEBIT,
    status: PaymentStatus.SETTLED,
    amountCents,
    currency: 'USD',
    createdAt: new Date('2026-08-21T12:00:00.000Z'),
  };
}

describe('DashboardService', () => {
  afterEach(() => jest.useRealTimers());

  it('uses the same UTC reporting day for today metrics and the chart range', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-22T00:01:00.000Z'));
    const paymentQueries: Array<{ where: unknown }> = [];
    const prisma = {
      payment: {
        findMany: jest.fn((query: { where: unknown }) => {
          paymentQueries.push(query);
          return Promise.resolve([]);
        }),
        groupBy: jest.fn().mockResolvedValue([]),
      },
    };
    const service = new DashboardService(prisma as never);

    await service.getAdminDashboard();

    expect(paymentQueries[0]).toEqual(
      expect.objectContaining({
        where: {
          createdAt: {
            gte: new Date('2026-08-22T00:00:00.000Z'),
            lt: new Date('2026-08-23T00:00:00.000Z'),
          },
        },
      }),
    );
    expect(paymentQueries[1]).toEqual(
      expect.objectContaining({
        where: {
          createdAt: {
            gte: new Date('2026-08-16T00:00:00.000Z'),
            lt: new Date('2026-08-23T00:00:00.000Z'),
          },
        },
      }),
    );
  });

  it('keeps the current UTC chart bucket equal to current-day card totals', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-22T12:00:00.000Z'));
    const debits = Array.from({ length: 20 }, (_, index) => ({
      ...payment(`debit-${index}`, merchantA, 5n),
      direction: PaymentDirection.DEBIT,
      status: PaymentStatus.SUBMITTED,
      createdAt: new Date('2026-08-22T00:01:00.000Z'),
    }));
    const credits = Array.from({ length: 20 }, (_, index) => ({
      ...payment(`credit-${index}`, merchantB, 6n),
      direction: PaymentDirection.CREDIT,
      status: PaymentStatus.VALIDATED,
      createdAt: new Date('2026-08-22T23:59:00.000Z'),
    }));
    const todayPayments = [...debits, ...credits];
    const prisma = {
      payment: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce(todayPayments)
          .mockResolvedValueOnce(todayPayments)
          .mockResolvedValueOnce(todayPayments),
        groupBy: jest.fn().mockResolvedValue([]),
      },
    };
    const service = new DashboardService(prisma as never);

    const dashboard = await service.getAdminDashboard();

    expect(dashboard.summary).toEqual(
      expect.objectContaining({
        paymentsToday: 40,
        totalAmountCents: '220',
        debitAmountCents: '100',
        creditAmountCents: '120',
      }),
    );
    expect(dashboard.dailyVolume.at(-1)).toEqual({
      date: '2026-08-22',
      debitCount: 20,
      creditCount: 20,
      totalCount: 40,
      debitAmountCents: '100',
      creditAmountCents: '120',
      totalAmountCents: '220',
    });
  });

  it('counts validation-failed attempts without treating their requested amount as financial volume', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-22T12:00:00.000Z'));
    const payments = [
      {
        ...payment('failed-outlier', merchantA, 1_000_000_000_000n),
        direction: PaymentDirection.CREDIT,
        status: PaymentStatus.VALIDATION_FAILED,
        createdAt: new Date('2026-08-22T00:01:00.000Z'),
      },
      {
        ...payment('debit-100', merchantA, 100n),
        direction: PaymentDirection.DEBIT,
        createdAt: new Date('2026-08-22T00:02:00.000Z'),
      },
      {
        ...payment('credit-120', merchantB, 120n),
        direction: PaymentDirection.CREDIT,
        createdAt: new Date('2026-08-22T00:03:00.000Z'),
      },
    ];
    const prisma = {
      payment: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce(payments)
          .mockResolvedValueOnce(payments)
          .mockResolvedValueOnce(payments),
        groupBy: jest.fn().mockResolvedValue([]),
      },
    };
    const service = new DashboardService(prisma as never);

    const dashboard = await service.getAdminDashboard();

    expect(dashboard.summary).toEqual(
      expect.objectContaining({
        paymentsToday: 3,
        totalAmountCents: '220',
        debitAmountCents: '100',
        creditAmountCents: '120',
      }),
    );
    expect(dashboard.dailyVolume.at(-1)).toEqual({
      date: '2026-08-22',
      debitCount: 1,
      creditCount: 2,
      totalCount: 3,
      debitAmountCents: '100',
      creditAmountCents: '120',
      totalAmountCents: '220',
    });
  });

  it('aggregates payments from multiple merchants for the admin all-merchants scope', async () => {
    const payments = [
      payment('payment-a', merchantA, 100n),
      payment('payment-b', merchantB, 250n),
    ];
    const prisma = {
      payment: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce(payments)
          .mockResolvedValueOnce(payments)
          .mockResolvedValueOnce(payments),
        groupBy: jest
          .fn()
          .mockResolvedValue([
            { status: PaymentStatus.SETTLED, _count: { _all: 2 } },
          ]),
      },
    };
    const service = new DashboardService(prisma as never);

    const dashboard = await service.getAdminDashboard();

    expect(dashboard.summary).toEqual(
      expect.objectContaining({
        paymentsToday: 2,
        totalAmountCents: '350',
        settledPayments: 2,
      }),
    );
    expect(dashboard.recentPayments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ merchant: merchantA }),
        expect.objectContaining({ merchant: merchantB }),
      ]),
    );
    expect(prisma.payment.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} }),
    );
  });

  it('applies the selected merchant scope to every admin dashboard query', async () => {
    const scopedPayment = payment('payment-a', merchantA, 100n);
    const prisma = {
      payment: {
        findMany: jest.fn().mockResolvedValue([scopedPayment]),
        groupBy: jest
          .fn()
          .mockResolvedValue([
            { status: PaymentStatus.SETTLED, _count: { _all: 1 } },
          ]),
      },
    };
    const service = new DashboardService(prisma as never);

    await service.getAdminDashboard('merchant-a');

    expect(prisma.payment.findMany).toHaveBeenCalledTimes(3);
    expect(prisma.payment.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { merchantId: 'merchant-a' } }),
    );
  });
});
