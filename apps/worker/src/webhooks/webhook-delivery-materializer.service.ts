import { Injectable } from '@nestjs/common';
import { OutboxEvent, OutboxEventType } from '@prisma/client';
import { OutboxProcessingError } from '../outbox/outbox-processing.error';
import { WorkerPrismaService } from '../worker-prisma.service';

const externalEventTypes: Partial<Record<OutboxEventType, string>> = {
  [OutboxEventType.PAYMENT_RECEIVED]: 'payment.created',
  [OutboxEventType.PAYMENT_VALIDATED]: 'payment.validated',
  [OutboxEventType.PAYMENT_VALIDATION_FAILED]: 'payment.validation_failed',
  [OutboxEventType.PAYMENT_RESERVED]: 'payment.reserved',
  [OutboxEventType.PAYMENT_SUBMITTED]: 'payment.submitted',
  [OutboxEventType.PAYMENT_SETTLED]: 'payment.settled',
  [OutboxEventType.PAYMENT_RETURNED]: 'payment.returned',
  [OutboxEventType.WEBHOOK_TEST]: 'webhook.test',
};

type LifecyclePayload = {
  paymentId: string;
  merchantId: string;
  paymentStatus: string;
  amountCents: string;
  currency: string;
  direction: string;
  validationCode: string | null;
  returnCode: string | null;
  occurredAt: string;
};

@Injectable()
export class WebhookDeliveryMaterializerService {
  constructor(private readonly prisma: WorkerPrismaService) {}

  async materialize(event: OutboxEvent) {
    const type = externalEventTypes[event.eventType];
    if (!type)
      throw new OutboxProcessingError('Outbox event is not webhook eligible');
    const source = event.payload as LifecyclePayload;
    if (event.eventType === OutboxEventType.WEBHOOK_TEST) {
      return this.prisma.webhookDelivery.findMany({
        where: { outboxEventId: event.id },
      });
    }
    if (
      !source ||
      typeof source.paymentId !== 'string' ||
      typeof source.merchantId !== 'string' ||
      typeof source.amountCents !== 'string'
    ) {
      throw new OutboxProcessingError('Invalid lifecycle outbox payload');
    }
    return this.prisma.$transaction(async (transaction) => {
      const endpoints = await transaction.merchantWebhookEndpoint.findMany({
        where: { merchantId: source.merchantId, isActive: true },
      });
      const createdAt = event.createdAt.toISOString();
      await transaction.webhookDelivery.createMany({
        data: endpoints.map((endpoint) => ({
          merchantId: source.merchantId,
          webhookEndpointId: endpoint.id,
          outboxEventId: event.id,
          eventId: `${event.id}:${endpoint.id}`,
          eventType: type,
          payload: {
            id: `${event.id}:${endpoint.id}`,
            type,
            createdAt,
            merchantId: source.merchantId,
            data: {
              paymentId: source.paymentId,
              status: source.paymentStatus,
              amountCents: source.amountCents,
              currency: source.currency,
              direction: source.direction,
              validationCode: source.validationCode ?? null,
              returnCode: source.returnCode ?? null,
            },
          },
        })),
        skipDuplicates: true,
      });
      return transaction.webhookDelivery.findMany({
        where: {
          outboxEventId: event.id,
          webhookEndpointId: { in: endpoints.map((endpoint) => endpoint.id) },
        },
      });
    });
  }
}
