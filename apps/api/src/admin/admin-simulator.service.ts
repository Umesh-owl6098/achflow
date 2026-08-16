import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  FundingAccountStatus,
  LedgerEntryType,
  MerchantStatus,
  PaymentDirection,
  Prisma,
  SimulatorRunStatus,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { AuthenticatedMerchant } from '../auth/merchant-authentication.service';
import { CreatePaymentDto } from '../payments/dto/create-payment.dto';
import { PaymentsService } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateSimulatorRunDto,
  SimulatorDirection,
} from './dto/create-simulator-run.dto';
import { ProvisionSimulatorFundingDto } from './dto/provision-simulator-funding.dto';

type SimulatorMerchant = {
  id: string;
  merchantCode: string;
  displayName: string;
  allowAchDebit: boolean;
  allowAchCredit: boolean;
  perPaymentLimit: bigint;
};

@Injectable()
export class AdminSimulatorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
  ) {}

  async listRuns() {
    this.assertSimulatorEnabled();
    const runs = await this.prisma.simulatorRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: 20,
    });
    return { data: runs.map((run) => this.serializeRun(run)) };
  }

  async getRun(id: string) {
    this.assertSimulatorEnabled();
    const run = await this.prisma.simulatorRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException('Simulator run was not found.');
    const payments = await this.prisma.payment.findMany({
      where: { externalReference: { startsWith: `sim:${run.id}:` } },
      select: {
        id: true,
        merchantId: true,
        direction: true,
        amountCents: true,
        status: true,
        createdAt: true,
        failureReason: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return {
      ...this.serializeRun(run),
      recentPayments: payments.map((payment) => ({
        ...payment,
        amountCents: payment.amountCents.toString(),
      })),
    };
  }

  async createRun(dto: CreateSimulatorRunDto) {
    this.assertSimulatorEnabled();
    this.validate(dto);
    const merchants = await this.prisma.merchant.findMany({
      where: {
        id: { in: dto.merchantIds },
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
    if (merchants.length !== new Set(dto.merchantIds).size) {
      throw new BadRequestException(
        'Every selected merchant must exist and be active.',
      );
    }
    this.validateSuccessfulAmountRanges(dto, merchants);
    const run = await this.prisma.simulatorRun.create({
      data: {
        configuration: dto as unknown as Prisma.InputJsonValue,
        merchantIds: dto.merchantIds,
      },
    });
    void this.execute(run.id, dto, merchants);
    return this.serializeRun(run);
  }

  async provisionDemoFunding(
    merchantId: string,
    dto: ProvisionSimulatorFundingDto,
  ) {
    this.assertSimulatorEnabled();
    const amount = BigInt(dto.amountCents);
    if (amount <= 0n) {
      throw new BadRequestException('Demo funding amount must be positive.');
    }
    const currency = dto.currency.toUpperCase();
    return this.prisma.$transaction(async (transaction) => {
      const merchant = await transaction.merchant.findUnique({
        where: { id: merchantId },
        select: { id: true },
      });
      if (!merchant) throw new NotFoundException('Merchant was not found.');
      const account = await transaction.fundingAccount.upsert({
        where: { merchantId_currency: { merchantId, currency } },
        create: { merchantId, currency, status: FundingAccountStatus.ACTIVE },
        update: {},
      });
      if (account.status !== FundingAccountStatus.ACTIVE) {
        throw new BadRequestException('Funding account is not active.');
      }
      const entryKey = `demo-funding:${merchantId}:${currency}`;
      const existing = await transaction.ledgerEntry.findUnique({
        where: { entryKey },
      });
      if (!existing) {
        await transaction.ledgerEntry.create({
          data: {
            entryKey,
            fundingAccountId: account.id,
            entryType: LedgerEntryType.INITIAL_CREDIT,
            amount,
          },
        });
      }
      return {
        fundingAccountId: account.id,
        currency,
        amountCents: (existing?.amount ?? amount).toString(),
        provisioned: !existing,
      };
    });
  }

  async pause(id: string) {
    this.assertSimulatorEnabled();
    return this.serializeRun(
      await this.transition(id, SimulatorRunStatus.PAUSED, [
        SimulatorRunStatus.RUNNING,
      ]),
    );
  }

  async resume(id: string) {
    this.assertSimulatorEnabled();
    const existingRun = await this.prisma.simulatorRun.findUnique({
      where: { id },
    });
    if (!existingRun) {
      throw new NotFoundException('Simulator run was not found.');
    }
    const config =
      existingRun.configuration as unknown as CreateSimulatorRunDto;
    const merchants = await this.prisma.merchant.findMany({
      where: { id: { in: config.merchantIds }, status: MerchantStatus.ACTIVE },
      select: {
        id: true,
        merchantCode: true,
        displayName: true,
        allowAchDebit: true,
        allowAchCredit: true,
        perPaymentLimit: true,
      },
    });
    this.validateSuccessfulAmountRanges(config, merchants);
    const run = await this.transition(id, SimulatorRunStatus.RUNNING, [
      SimulatorRunStatus.PAUSED,
    ]);
    void this.execute(id, config, merchants);
    return this.serializeRun(run);
  }

  async stop(id: string) {
    this.assertSimulatorEnabled();
    return this.serializeRun(
      await this.transition(id, SimulatorRunStatus.STOPPED, [
        SimulatorRunStatus.RUNNING,
        SimulatorRunStatus.PAUSED,
      ]),
    );
  }

  private async execute(
    runId: string,
    dto: CreateSimulatorRunDto,
    merchants: SimulatorMerchant[],
  ) {
    let latencyTotal = 0;
    try {
      for (let index = 0; index < dto.transactionCount; index += 1) {
        const run = await this.prisma.simulatorRun.findUniqueOrThrow({
          where: { id: runId },
        });
        if (run.status === SimulatorRunStatus.STOPPED) return;
        if (run.status === SimulatorRunStatus.PAUSED) return;
        if (run.generatedCount >= dto.transactionCount) break;

        const merchant = merchants[index % merchants.length];
        const started = Date.now();
        try {
          const direction = this.directionFor(dto.direction, merchant, index);
          const validationFailure = this.percent(
            dto.scenario.validationFailurePercent,
            index,
          );
          const amountCents = this.amountFor(
            dto,
            merchant,
            index,
            validationFailure,
          );
          const key = `${dto.idempotencyKeyPrefix?.trim() || `sim-${runId}`}-${index}`;
          const paymentDto: CreatePaymentDto = {
            merchantCode: merchant.merchantCode,
            direction,
            amountCents,
            currency: 'USD',
            externalReference: `sim:${runId}:${index}`,
            receiverName: `Simulator customer ${String(index + 1).padStart(4, '0')}`,
            receiverAccountRef: `sim-acct-${randomUUID().slice(0, 12)}`,
            routingNumber: '021000021',
            description: `${dto.descriptionPrefix} ${index + 1}`.trim(),
          };
          const authenticatedMerchant: AuthenticatedMerchant = {
            id: merchant.id,
            merchantCode: merchant.merchantCode,
            displayName: merchant.displayName,
          };
          await this.payments.create(paymentDto, key, authenticatedMerchant);
          if (this.percent(dto.scenario.duplicatePercent, index)) {
            await this.payments.create(paymentDto, key, authenticatedMerchant);
          }
          latencyTotal += Date.now() - started;
          const generated = run.generatedCount + 1;
          await this.prisma.simulatorRun.update({
            where: { id: runId },
            data: {
              generatedCount: generated,
              ...(validationFailure
                ? { failedCount: { increment: 1 } }
                : { successfulCount: { increment: 1 } }),
              averageLatencyMs: Math.round(latencyTotal / generated),
            },
          });
        } catch (error) {
          await this.prisma.simulatorRun.update({
            where: { id: runId },
            data: {
              generatedCount: { increment: 1 },
              failedCount: { increment: 1 },
              failureSummary: {
                lastError:
                  error instanceof Error ? error.message : 'Unknown error',
              },
            },
          });
        }
        await this.sleep(Math.ceil(1_000 / dto.transactionsPerSecond));
      }
      await this.prisma.simulatorRun.updateMany({
        where: { id: runId, status: SimulatorRunStatus.RUNNING },
        data: { status: SimulatorRunStatus.COMPLETED, completedAt: new Date() },
      });
    } catch (error) {
      await this.prisma.simulatorRun.update({
        where: { id: runId },
        data: {
          status: SimulatorRunStatus.FAILED,
          completedAt: new Date(),
          failureSummary: {
            fatalError:
              error instanceof Error ? error.message : 'Unknown error',
          },
        },
      });
    }
  }

  private directionFor(
    mode: SimulatorDirection,
    merchant: { allowAchDebit: boolean; allowAchCredit: boolean },
    index: number,
  ): PaymentDirection {
    const requested =
      mode === SimulatorDirection.MIXED
        ? index % 2 === 0
          ? PaymentDirection.DEBIT
          : PaymentDirection.CREDIT
        : mode;
    if (requested === PaymentDirection.DEBIT && merchant.allowAchDebit)
      return PaymentDirection.DEBIT;
    if (requested === PaymentDirection.CREDIT && merchant.allowAchCredit)
      return PaymentDirection.CREDIT;
    if (merchant.allowAchDebit) return PaymentDirection.DEBIT;
    if (merchant.allowAchCredit) return PaymentDirection.CREDIT;
    throw new BadRequestException(
      'Selected merchant has no ACH direction enabled.',
    );
  }

  private amountFor(
    dto: CreateSimulatorRunDto,
    merchant: { perPaymentLimit: bigint },
    index: number,
    validationFailure: boolean,
  ): number {
    if (!validationFailure) {
      const maximumAmountCents =
        merchant.perPaymentLimit < BigInt(dto.maximumAmountCents)
          ? Number(merchant.perPaymentLimit)
          : dto.maximumAmountCents;
      const span = maximumAmountCents - dto.minimumAmountCents + 1;
      return dto.minimumAmountCents + (index % span);
    }
    const invalid = merchant.perPaymentLimit + BigInt(1);
    if (invalid > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new BadRequestException(
        'Merchant limit is too large for simulator input.',
      );
    }
    return Number(invalid);
  }

  private validate(dto: CreateSimulatorRunDto) {
    if (dto.minimumAmountCents > dto.maximumAmountCents) {
      throw new BadRequestException(
        'Minimum amount cannot exceed maximum amount.',
      );
    }
    if (
      dto.scenario.successfulPercent +
        dto.scenario.validationFailurePercent +
        dto.scenario.duplicatePercent +
        dto.scenario.insufficientFundsPercent +
        dto.scenario.returnPercent +
        dto.scenario.delayedProcessingPercent +
        dto.scenario.webhookFailurePercent !==
      100
    ) {
      throw new BadRequestException('Scenario percentages must total 100.');
    }
    if (dto.scenario.returnPercent > 0) {
      throw new BadRequestException(
        'Return simulation requires submitted-bank callbacks and is not available yet.',
      );
    }
    if (dto.scenario.insufficientFundsPercent > 0) {
      throw new BadRequestException(
        'Insufficient-funds simulation is not available until funding-balance scenario hooks are added.',
      );
    }
    if (
      dto.scenario.delayedProcessingPercent > 0 ||
      dto.scenario.webhookFailurePercent > 0
    ) {
      throw new BadRequestException(
        'Delayed processing and webhook failure injection are not available in the simulator.',
      );
    }
  }

  private validateSuccessfulAmountRanges(
    dto: CreateSimulatorRunDto,
    merchants: SimulatorMerchant[],
  ) {
    if (dto.scenario.validationFailurePercent === 100) return;

    const minimumAmountCents = BigInt(dto.minimumAmountCents);
    for (const merchant of merchants) {
      if (minimumAmountCents > merchant.perPaymentLimit) {
        throw new BadRequestException(
          `No valid successful payment amount exists for merchant ${merchant.merchantCode}.`,
        );
      }
    }
  }

  private async transition(
    id: string,
    status: SimulatorRunStatus,
    expected: SimulatorRunStatus[],
  ) {
    const run = await this.prisma.simulatorRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException('Simulator run was not found.');
    if (!expected.includes(run.status)) {
      throw new BadRequestException(
        `Run cannot transition from ${run.status}.`,
      );
    }
    const updated = await this.prisma.simulatorRun.update({
      where: { id },
      data: {
        status,
        ...(status === SimulatorRunStatus.STOPPED
          ? { completedAt: new Date() }
          : {}),
      },
    });
    return updated;
  }

  private assertSimulatorEnabled() {
    const environment = process.env.NODE_ENV ?? 'local';
    const explicitlyEnabled = process.env.SIMULATOR_ENABLED === 'true';
    if (
      !explicitlyEnabled &&
      !['local', 'development', 'test'].includes(environment)
    ) {
      throw new NotFoundException('Simulator is unavailable.');
    }
  }

  private percent(percent: number, index: number) {
    return (index * 37 + 17) % 100 < percent;
  }

  private sleep(milliseconds: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  }

  private serializeRun(run: {
    id: string;
    status: SimulatorRunStatus;
    configuration: unknown;
    merchantIds: unknown;
    startedAt: Date;
    completedAt: Date | null;
    generatedCount: number;
    successfulCount: number;
    failedCount: number;
    returnedCount: number;
    averageLatencyMs: number;
    failureSummary: unknown;
  }) {
    return {
      ...run,
      startedAt: run.startedAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
    };
  }
}
