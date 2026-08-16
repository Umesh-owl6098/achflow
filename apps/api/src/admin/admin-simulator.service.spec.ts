import {
  MerchantStatus,
  PaymentDirection,
  SimulatorRunStatus,
} from '@prisma/client';
import { AdminSimulatorService } from './admin-simulator.service';
import { SimulatorDirection } from './dto/create-simulator-run.dto';

describe('AdminSimulatorService', () => {
  const run = {
    id: 'simulator-run-1',
    status: SimulatorRunStatus.RUNNING,
    configuration: {},
    merchantIds: ['merchant-1'],
    startedAt: new Date('2026-07-30T12:00:00.000Z'),
    completedAt: null,
    generatedCount: 0,
    successfulCount: 0,
    failedCount: 0,
    returnedCount: 0,
    averageLatencyMs: 0,
    failureSummary: null,
  };

  it('creates simulator traffic through the existing payment service for active merchants', async () => {
    const prisma = {
      merchant: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'merchant-1',
            merchantCode: 'SIMULATOR',
            displayName: 'Simulator merchant',
            allowAchDebit: true,
            allowAchCredit: true,
            perPaymentLimit: 10_000n,
          },
        ]),
      },
      simulatorRun: {
        create: jest.fn().mockResolvedValue(run),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValueOnce(run)
          .mockResolvedValue({ ...run, generatedCount: 1 }),
        update: jest.fn().mockResolvedValue(run),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const payments = { create: jest.fn().mockResolvedValue({}) };
    const service = new AdminSimulatorService(
      prisma as never,
      payments as never,
    );
    const prototype = Object.getPrototypeOf(service) as {
      sleep(milliseconds: number): Promise<void>;
    };
    jest.spyOn(prototype, 'sleep').mockResolvedValue(undefined);

    await service.createRun({
      merchantIds: ['merchant-1'],
      direction: SimulatorDirection.CREDIT,
      transactionCount: 1,
      transactionsPerSecond: 25,
      minimumAmountCents: 100,
      maximumAmountCents: 100,
      secCode: 'PPD',
      descriptionPrefix: 'Simulator test',
      scenario: {
        successfulPercent: 100,
        validationFailurePercent: 0,
        insufficientFundsPercent: 0,
        returnPercent: 0,
        duplicatePercent: 0,
        delayedProcessingPercent: 0,
        webhookFailurePercent: 0,
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(prisma.merchant.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['merchant-1'] },
        status: MerchantStatus.ACTIVE,
      },
      select: {
        id: true,
        merchantCode: true,
        displayName: true,
        allowAchDebit: true,
        allowAchCredit: true,
        perPaymentLimit: true,
      },
    });
    expect(payments.create).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantCode: 'SIMULATOR',
        direction: PaymentDirection.CREDIT,
        amountCents: 100,
      }),
      expect.stringContaining('sim-simulator-run-1-0'),
      expect.objectContaining({ id: 'merchant-1' }),
    );
  });
});
