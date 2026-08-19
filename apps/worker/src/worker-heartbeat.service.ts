import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { WorkerConfigService } from './worker-config.service';
import { WorkerPrismaService } from './worker-prisma.service';

@Injectable()
export class WorkerHeartbeatService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(WorkerHeartbeatService.name);
  private acceptingHeartbeats = true;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: WorkerPrismaService,
    private readonly config: WorkerConfigService,
  ) {}

  onModuleInit(): void {
    this.scheduleNextHeartbeat(0);
  }

  onApplicationShutdown(): void {
    this.acceptingHeartbeats = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  async heartbeat(): Promise<void> {
    const lastSeenAt = new Date();
    await this.prisma.workerHeartbeat.upsert({
      where: { workerId: this.config.workerHeartbeatId },
      create: {
        workerId: this.config.workerHeartbeatId,
        lastSeenAt,
        nachaGenerationEnabled: this.config.nachaGenerationEnabled,
        nachaGenerationIntervalMs: this.config.nachaGenerationIntervalMs,
      },
      update: {
        lastSeenAt,
        nachaGenerationEnabled: this.config.nachaGenerationEnabled,
        nachaGenerationIntervalMs: this.config.nachaGenerationIntervalMs,
      },
    });
  }

  private scheduleNextHeartbeat(delayMs: number): void {
    if (!this.acceptingHeartbeats) return;
    this.timer = setTimeout(() => {
      void this.heartbeat()
        .catch(() => {
          this.logger.error('Worker heartbeat persistence failed.');
        })
        .finally(() => {
          this.scheduleNextHeartbeat(this.config.workerHeartbeatIntervalMs);
        });
    }, delayMs);
  }
}
