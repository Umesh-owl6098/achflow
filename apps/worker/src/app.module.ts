import { Module } from '@nestjs/common';
import { OutboxHandler } from './outbox/outbox.handler';
import { OutboxPollingService } from './outbox/outbox-polling.service';
import { OutboxRepository } from './outbox/outbox.repository';
import { WorkerConfigService } from './worker-config.service';
import { WorkerPrismaService } from './worker-prisma.service';

@Module({
  providers: [
    WorkerConfigService,
    WorkerPrismaService,
    OutboxRepository,
    OutboxHandler,
    OutboxPollingService,
  ],
})
export class AppModule {}
