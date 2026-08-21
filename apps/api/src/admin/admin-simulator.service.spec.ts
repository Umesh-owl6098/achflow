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

  const activeSimulatorPrisma = () => ({
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
  });

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

  it('returns only safe merchant eligibility metadata without credentials', async () => {
    process.env.NODE_ENV = 'test';
    const prisma = {
      merchant: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'merchant-1',
            merchantCode: 'SIMULATOR',
            displayName: 'Simulator merchant',
            status: MerchantStatus.ACTIVE,
            allowAchDebit: true,
            allowAchCredit: true,
            perPaymentLimit: 1_000n,
            dailyAmountLimit: 10_000n,
            dailyUsage: [{ utilizedAmount: 250n }],
            fundingAccounts: [{ currency: 'usd' }],
          },
        ]),
      },
    };
    const service = new AdminSimulatorService(prisma as never, {} as never);

    await expect(service.listMerchants()).resolves.toEqual({
      data: [
        {
          id: 'merchant-1',
          merchantCode: 'SIMULATOR',
          displayName: 'Simulator merchant',
          status: MerchantStatus.ACTIVE,
          allowAchDebit: true,
          allowAchCredit: true,
          perPaymentLimit: '1000',
          dailyAmountLimit: '10000',
          dailyUtilizedAmountCents: '250',
          activeFundingCurrencies: ['USD'],
        },
      ],
    });
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

  it('accepts one-cent simulator amounts and rejects zero cents', async () => {
    const accepted = await validate(
      plainToInstance(CreateSimulatorRunDto, {
        ...simulatorRunDto(),
        minimumAmountCents: 1,
        maximumAmountCents: 10_000,
      }),
    );
    const rejected = await validate(
      plainToInstance(CreateSimulatorRunDto, {
        ...simulatorRunDto(),
        minimumAmountCents: 0,
      }),
    );

    expect(accepted).toHaveLength(0);
    expect(rejected).not.toHaveLength(0);
  });

  it('accepts scenario percentages totaling 100 including duplicate requests', async () => {
    process.env.NODE_ENV = 'test';
    const prisma = activeSimulatorPrisma();
    const payments = { create: jest.fn().mockResolvedValue({}) };
    const service = new AdminSimulatorService(
      prisma as never,
      payments as never,
    );
    const prototype = Object.getPrototypeOf(service) as {
      sleep(milliseconds: number): Promise<void>;
    };
    jest.spyOn(prototype, 'sleep').mockResolvedValue(undefined);

    await expect(
      service.createRun(
        simulatorRunDto({
          successfulPercent: 80,
          validationFailurePercent: 10,
          duplicatePercent: 10,
        }),
      ),
    ).resolves.toEqual(expect.objectContaining({ id: run.id }));
  });

  it.each([
    [
      '99',
      {
        successfulPercent: 79,
        validationFailurePercent: 10,
        duplicatePercent: 10,
      },
    ],
    [
      '101',
      {
        successfulPercent: 81,
        validationFailurePercent: 10,
        duplicatePercent: 10,
      },
    ],
  ])('rejects a scenario total of %s', async (_total, scenario) => {
    process.env.NODE_ENV = 'test';
    const service = new AdminSimulatorService({} as never, {} as never);

    await expect(service.createRun(simulatorRunDto(scenario))).rejects.toThrow(
      'Scenario percentages must total 100.',
    );
  });

  it.each([
    'successfulPercent',
    'validationFailurePercent',
    'duplicatePercent',
    'insufficientFundsPercent',
    'returnPercent',
    'delayedProcessingPercent',
    'webhookFailurePercent',
  ] as const)('includes %s in the scenario total', async (field) => {
    process.env.NODE_ENV = 'test';
    const dto = simulatorRunDto();
    if (field === 'successfulPercent') {
      dto.scenario.successfulPercent = 99;
    } else {
      dto.scenario[field] = 1;
    }
    const service = new AdminSimulatorService({} as never, {} as never);

    await expect(service.createRun(dto)).rejects.toThrow(
      'Scenario percentages must total 100.',
    );
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

  it('keeps successful simulator amounts within the selected merchant limit', () => {
    const service = new AdminSimulatorService({} as never, {} as never);
    const amountFor = simulatorAmountFor(service);
    const dto = simulatorRunDto();
    dto.minimumAmountCents = 500;
    dto.maximumAmountCents = 1_000;

    for (const index of [0, 150, 151, 301]) {
      expect(
        amountFor(dto, { perPaymentLimit: 650n }, index, false),
      ).toBeLessThanOrEqual(650);
    }
    expect(amountFor(dto, { perPaymentLimit: 650n }, 150, false)).toBe(650);
    expect(amountFor(dto, { perPaymentLimit: 650n }, 151, false)).toBe(500);
  });

  it('uses the safe amount range for each merchant limit', () => {
    const service = new AdminSimulatorService({} as never, {} as never);
    const amountFor = simulatorAmountFor(service);
    const dto = simulatorRunDto();
    dto.minimumAmountCents = 500;
    dto.maximumAmountCents = 1_000;

    expect(amountFor(dto, { perPaymentLimit: 650n }, 150, false)).toBe(650);
    expect(amountFor(dto, { perPaymentLimit: 750n }, 250, false)).toBe(750);
  });

  it('keeps validation-failure amounts above the merchant limit', () => {
    const service = new AdminSimulatorService({} as never, {} as never);
    const amountFor = simulatorAmountFor(service);

    expect(
      amountFor(simulatorRunDto(), { perPaymentLimit: 250n }, 0, true),
    ).toBe(251);
  });

  it('rejects an impossible successful amount range before creating a run', async () => {
    process.env.NODE_ENV = 'test';
    const prisma = activeSimulatorPrisma();
    prisma.merchant.findMany.mockResolvedValue([
      {
        id: 'merchant-1',
        merchantCode: 'LOW_LIMIT',
        displayName: 'Low limit merchant',
        allowAchDebit: true,
        allowAchCredit: true,
        perPaymentLimit: 250n,
      },
    ]);
    const payments = { create: jest.fn() };
    const service = new AdminSimulatorService(
      prisma as never,
      payments as never,
    );
    const dto = simulatorRunDto();
    dto.minimumAmountCents = 300;
    dto.maximumAmountCents = 500;

    await expect(service.createRun(dto)).rejects.toThrow(
      'No valid successful payment amount exists for merchant LOW_LIMIT.',
    );
    expect(prisma.simulatorRun.create).not.toHaveBeenCalled();
    expect(payments.create).not.toHaveBeenCalled();
  });
});

function simulatorAmountFor(service: AdminSimulatorService) {
  return (
    service as unknown as {
      amountFor(
        dto: CreateSimulatorRunDto,
        merchant: { perPaymentLimit: bigint },
        index: number,
        validationFailure: boolean,
      ): number;
    }
  ).amountFor.bind(service);
}

function simulatorRunDto(
  scenario: Partial<CreateSimulatorRunDto['scenario']> = {},
): CreateSimulatorRunDto {
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
      ...scenario,
    },
  };
}
