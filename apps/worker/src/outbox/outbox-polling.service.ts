import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { OutboxEvent } from '@prisma/client';
import { OutboxHandler, OutboxProcessingError } from './outbox.handler';
import { OutboxRepository } from './outbox.repository';
import { WorkerConfigService } from '../worker-config.service';

@Injectable()
export class OutboxPollingService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(OutboxPollingService.name);
  private acceptingPolls = true;
  private timer: NodeJS.Timeout | undefined;
  private activeBatch: Promise<void> | undefined;

  constructor(
    private readonly repository: OutboxRepository,
    private readonly handler: OutboxHandler,
    private readonly config: WorkerConfigService,
  ) {}

  onModuleInit(): void {
    this.scheduleNextPoll(0);
  }

  async onApplicationShutdown(): Promise<void> {
    this.acceptingPolls = false;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    await this.activeBatch;
  }

  async processOnce(): Promise<void> {
    await this.repository.recoverExpiredClaims(
      this.config.maxAttempts,
      this.config.claimLeaseMs,
    );
    const events = await this.repository.claimPending(this.config.batchSize);

    for (const event of events) {
      await this.processClaimedEvent(event);
    }
  }

  private scheduleNextPoll(delayMs: number): void {
    if (!this.acceptingPolls) {
      return;
    }

    this.timer = setTimeout(() => {
      this.activeBatch = this.processOnce()
        .catch((error: unknown) => {
          this.logger.error(this.safeErrorMessage(error));
        })
        .finally(() => {
          this.activeBatch = undefined;
          this.scheduleNextPoll(this.config.pollIntervalMs);
        });
    }, delayMs);
  }

  private async processClaimedEvent(event: OutboxEvent): Promise<void> {
    try {
      await this.handler.handle(event);
      // Daily-limit validation commits payment state, usage, and this claimed event together.
      // Existing terminal validation paths remain completed here.
      await this.repository.markProcessed(event.id);
    } catch (error) {
      await this.repository.markFailed(
        event,
        this.config.maxAttempts,
        this.safeErrorMessage(error),
      );
    }
  }

  private safeErrorMessage(error: unknown): string {
    if (error instanceof OutboxProcessingError) {
      return error.safeMessage;
    }

    return 'Outbox event processing failed';
  }
}
