import {
  MerchantStatus,
  PaymentDirection,
  SimulatorRunStatus,
} from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { NotFoundException } from '@nestjs/common';
import { AdminSimulatorService } from './admin-simulator.service';
import {
  CreateSimulatorRunDto,
  SimulatorDirection,
} from './dto/create-simulator-run.dto';

describe('AdminSimulatorService', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalSimulatorEnabled = process.env.SIMULATOR_ENABLED;

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

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (originalSimulatorEnabled === undefined) {
      delete process.env.SIMULATOR_ENABLED;
    } else {
      process.env.SIMULATOR_ENABLED = originalSimulatorEnabled;
    }
  });

  it('denies simulator operations in production when the flag is absent or false', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.SIMULATOR_ENABLED;
    const prisma = { simulatorRun: { findMany: jest.fn() } };
    const service = new AdminSimulatorService(prisma as never, {} as never);

    await expect(service.listRuns()).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.simulatorRun.findMany).not.toHaveBeenCalled();

    process.env.SIMULATOR_ENABLED = 'false';
    await expect(service.listRuns()).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.simulatorRun.findMany).not.toHaveBeenCalled();
  });

  it('allows simulator operations in production only when explicitly enabled', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SIMULATOR_ENABLED = 'true';
    const prisma = {
      simulatorRun: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new AdminSimulatorService(prisma as never, {} as never);

    await expect(service.listRuns()).resolves.toEqual({ data: [] });
  });

  it('keeps simulator available in non-production environments without the flag', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.SIMULATOR_ENABLED;
    const prisma = {
      simulatorRun: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new AdminSimulatorService(prisma as never, {} as never);

    await expect(service.listRuns()).resolves.toEqual({ data: [] });
  });

  it('rejects inactive merchants even when simulator access is explicitly enabled', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SIMULATOR_ENABLED = 'true';
    const prisma = {
      merchant: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new AdminSimulatorService(prisma as never, {} as never);

    await expect(service.createRun(simulatorRunDto())).rejects.toThrow(
      'Every selected merchant must exist and be active.',
    );
  });

  it('retains the transaction and TPS input limits', async () => {
    const transactionErrors = await validate(
      plainToInstance(CreateSimulatorRunDto, {
        ...simulatorRunDto(),
        transactionCount: 501,
      }),
    );
    const tpsErrors = await validate(
      plainToInstance(CreateSimulatorRunDto, {
        ...simulatorRunDto(),
        transactionsPerSecond: 26,
      }),
    );

    expect(transactionErrors).not.toHaveLength(0);
    expect(tpsErrors).not.toHaveLength(0);
  });

  it('creates simulator traffic through the existing payment service for active merchants', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.SIMULATOR_ENABLED;
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

    await service.createRun(simulatorRunDto());
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

function simulatorRunDto(): CreateSimulatorRunDto {
  return {
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
  };
}
