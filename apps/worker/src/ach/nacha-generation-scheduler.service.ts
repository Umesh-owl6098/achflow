import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { NachaFileGeneratorService } from './nacha-file-generator.service';
import { WorkerConfigService } from '../worker-config.service';

export type NachaGenerationRun = {
  status: 'DISABLED' | 'SKIPPED' | 'COMPLETED';
  fileCount: number;
  paymentCount: number;
};

@Injectable()
export class NachaGenerationSchedulerService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(NachaGenerationSchedulerService.name);
  private acceptingRuns = true;
  private timer: NodeJS.Timeout | undefined;
  private activeRun: Promise<NachaGenerationRun> | undefined;

  constructor(
    private readonly generator: NachaFileGeneratorService,
    private readonly config: WorkerConfigService,
  ) {}

  onModuleInit(): void {
    if (this.config.nachaGenerationEnabled) {
      this.scheduleNextRun(0);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.acceptingRuns = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.activeRun;
  }

  async processOnce(): Promise<NachaGenerationRun> {
    if (!this.config.nachaGenerationEnabled) {
      return { status: 'DISABLED', fileCount: 0, paymentCount: 0 };
    }
    if (this.activeRun) {
      return { status: 'SKIPPED', fileCount: 0, paymentCount: 0 };
    }

    const run = this.generate();
    this.activeRun = run;
    try {
      return await run;
    } finally {
      if (this.activeRun === run) {
        this.activeRun = undefined;
      }
    }
  }

  private scheduleNextRun(delayMs: number): void {
    if (!this.acceptingRuns) return;
    this.timer = setTimeout(() => {
      void this.processOnce()
        .catch(() => {
          this.logger.error('NACHA scheduler execution failed.');
        })
        .finally(() => {
          this.scheduleNextRun(this.config.nachaGenerationIntervalMs);
        });
    }, delayMs);
  }

  private async generate(): Promise<NachaGenerationRun> {
    this.logger.log('NACHA scheduler started.');
    const files = await this.generator.generateAll(new Date());
    const paymentCount = files.reduce(
      (total, generated) => total + generated.metadata.totalEntries,
      0,
    );
    if (!files.length) {
      this.logger.log('NACHA scheduler found no eligible payments.');
      return { status: 'COMPLETED', fileCount: 0, paymentCount: 0 };
    }
    this.logger.log(
      `NACHA scheduler generated ${files.length} files and exported ${paymentCount} payments.`,
    );
    return { status: 'COMPLETED', fileCount: files.length, paymentCount };
  }
}
