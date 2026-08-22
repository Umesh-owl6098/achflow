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
