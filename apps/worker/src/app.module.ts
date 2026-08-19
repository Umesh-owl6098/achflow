import { Module } from '@nestjs/common';
import { OutboxHandler } from './outbox/outbox.handler';
import { OutboxPollingService } from './outbox/outbox-polling.service';
import { OutboxRepository } from './outbox/outbox.repository';
import { PaymentLifecycleRepository } from './payments/payment-lifecycle.repository';
import { PaymentValidationService } from './payments/payment-validation.service';
import { WorkerConfigService } from './worker-config.service';
import { WorkerPrismaService } from './worker-prisma.service';
import { WebhookDeliveryMaterializerService } from './webhooks/webhook-delivery-materializer.service';
import { WebhookDeliveryProcessorService } from './webhooks/webhook-delivery-processor.service';
import { NachaFileGeneratorService } from './ach/nacha-file-generator.service';
import { NachaGenerationSchedulerService } from './ach/nacha-generation-scheduler.service';
import { WorkerHeartbeatService } from './worker-heartbeat.service';

@Module({
  providers: [
    WorkerConfigService,
    WorkerPrismaService,
    OutboxRepository,
    PaymentLifecycleRepository,
    PaymentValidationService,
    OutboxHandler,
    OutboxPollingService,
    WebhookDeliveryMaterializerService,
    WebhookDeliveryProcessorService,
    NachaFileGeneratorService,
    NachaGenerationSchedulerService,
    WorkerHeartbeatService,
  ],
})
export class AppModule {}
