import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OutboxEventType } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import type { AuthenticatedMerchant } from '../auth/merchant-authentication.service';
import { PrismaService } from '../prisma/prisma.service';
import { ListWebhookDeliveriesQueryDto } from './dto/list-webhook-deliveries-query.dto';
import { ListWebhooksQueryDto } from './dto/list-webhooks-query.dto';
import { UpdateWebhookEndpointDto } from './dto/update-webhook-endpoint.dto';
import { WebhookSecretCryptoService } from './webhook-secret-crypto.service';

@Injectable()
export class MerchantWebhookEndpointsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: WebhookSecretCryptoService,
    private readonly config: ConfigService,
  ) {}
  async create(merchantId: string, url: string, signingSecret: string) {
    this.validateUrl(url);
    const secret = this.crypto.encrypt(signingSecret);
    return this.prisma.merchantWebhookEndpoint.create({
      data: {
        merchantId,
        url,
        encryptedSigningSecret: secret.ciphertext,
        signingSecretIv: secret.iv,
        signingSecretAuthTag: secret.authTag,
        signingSecretKeyVersion: secret.keyVersion,
      },
    });
  }
  async list(query: ListWebhooksQueryDto, merchant: AuthenticatedMerchant) {
    const endpoints = await this.prisma.merchantWebhookEndpoint.findMany({
      where: {
        merchantId: merchant.id,
        ...(query.status === 'active' ? { isActive: true } : {}),
        ...(query.status === 'disabled' ? { isActive: false } : {}),
        ...(query.search?.trim()
          ? { url: { contains: query.search.trim(), mode: 'insensitive' } }
          : {}),
      },
      include: { deliveries: { orderBy: { createdAt: 'desc' } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const data = endpoints.map((endpoint) => this.endpointView(endpoint));
    return {
      data:
        query.deliveryStatus && query.deliveryStatus !== 'all'
          ? data.filter((endpoint) =>
              endpoint.deliveries.some(
                (delivery) => delivery.status === query.deliveryStatus,
              ),
            )
          : data,
      summary: {
        active: data.filter((endpoint) => endpoint.isActive).length,
        disabled: data.filter((endpoint) => !endpoint.isActive).length,
        failedDeliveries: data.reduce(
          (sum, endpoint) =>
            sum +
            endpoint.deliveries.filter(
              (delivery) => delivery.status === 'FAILED',
            ).length,
          0,
        ),
      },
    };
  }

  async update(
    endpointId: string,
    dto: UpdateWebhookEndpointDto,
    merchant: AuthenticatedMerchant,
  ) {
    const endpoint = await this.scopedEndpoint(endpointId, merchant.id);
    if (dto.url) this.validateUrl(dto.url);
    const secret = dto.signingSecret
      ? this.crypto.encrypt(dto.signingSecret)
      : null;
    const updated = await this.prisma.merchantWebhookEndpoint.update({
      where: { id: endpoint.id },
      data: {
        ...(dto.url ? { url: dto.url } : {}),
        ...(typeof dto.isActive === 'boolean'
          ? { isActive: dto.isActive }
          : {}),
        ...(secret
          ? {
              encryptedSigningSecret: secret.ciphertext,
              signingSecretIv: secret.iv,
              signingSecretAuthTag: secret.authTag,
              signingSecretKeyVersion: secret.keyVersion,
            }
          : {}),
      },
      include: { deliveries: { orderBy: { createdAt: 'desc' } } },
    });
    return this.endpointView(updated);
  }

  async remove(endpointId: string, merchant: AuthenticatedMerchant) {
    const endpoint = await this.scopedEndpoint(endpointId, merchant.id);
    const deliveryCount = await this.prisma.webhookDelivery.count({
      where: { webhookEndpointId: endpoint.id },
    });
    if (deliveryCount) {
      await this.prisma.merchantWebhookEndpoint.update({
        where: { id: endpoint.id },
        data: { isActive: false },
      });
      return { id: endpoint.id, deleted: false, disabled: true };
    }
    await this.prisma.merchantWebhookEndpoint.delete({
      where: { id: endpoint.id },
    });
    return { id: endpoint.id, deleted: true, disabled: false };
  }

  async deliveries(
    endpointId: string,
    query: ListWebhookDeliveriesQueryDto,
    merchant: AuthenticatedMerchant,
  ) {
    const endpoint = await this.scopedEndpoint(endpointId, merchant.id);
    const data = await this.prisma.webhookDelivery.findMany({
      where: {
        webhookEndpointId: endpoint.id,
        ...(query.status && query.status !== 'all'
          ? { status: query.status }
          : {}),
        ...(query.search?.trim()
          ? {
              OR: [
                {
                  eventId: {
                    contains: query.search.trim(),
                    mode: 'insensitive',
                  },
                },
                {
                  eventType: {
                    contains: query.search.trim(),
                    mode: 'insensitive',
                  },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return {
      data: data.map((delivery) => ({
        ...delivery,
        payload: delivery.payload,
      })),
    };
  }

  async listDeliveries(
    query: ListWebhookDeliveriesQueryDto,
    merchant: AuthenticatedMerchant,
  ) {
    const start = deliveryStart(query.dateRange);
    const deliveries = await this.prisma.webhookDelivery.findMany({
      where: {
        merchantId: merchant.id,
        ...(query.status && query.status !== 'all'
          ? { status: query.status }
          : {}),
        ...(query.eventType?.trim()
          ? { eventType: query.eventType.trim() }
          : {}),
        ...(start ? { createdAt: { gte: start } } : {}),
      },
      include: {
        webhookEndpoint: { select: { id: true, url: true } },
        merchant: { select: { merchantCode: true, displayName: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const search = query.search?.trim().toLowerCase();
    const data = deliveries
      .filter((delivery) => {
        if (!search) return true;
        const payload = delivery.payload as { data?: { paymentId?: unknown } };
        return (
          delivery.eventId.toLowerCase().includes(search) ||
          delivery.eventType.toLowerCase().includes(search) ||
          (typeof payload.data?.paymentId === 'string' &&
            payload.data.paymentId.toLowerCase().includes(search))
        );
      })
      .map((delivery) => {
        const payload = delivery.payload as { data?: { paymentId?: unknown } };
        return {
          id: delivery.id,
          eventId: delivery.eventId,
          eventType: delivery.eventType,
          paymentId:
            typeof payload.data?.paymentId === 'string'
              ? payload.data.paymentId
              : null,
          status: delivery.status,
          attemptCount: delivery.attemptCount,
          responseStatus: delivery.responseStatus,
          lastErrorCode: delivery.lastErrorCode,
          nextAttemptAt: delivery.nextAttemptAt?.toISOString() ?? null,
          deliveredAt: delivery.deliveredAt?.toISOString() ?? null,
          createdAt: delivery.createdAt.toISOString(),
          lastAttemptAt: delivery.lastAttemptAt?.toISOString() ?? null,
          endpoint: delivery.webhookEndpoint,
          merchant: delivery.merchant,
          payload: delivery.payload,
        };
      });
    return { data };
  }

  async enqueueTest(endpointId: string, merchant: AuthenticatedMerchant) {
    const endpoint = await this.scopedEndpoint(endpointId, merchant.id);
    if (!endpoint.isActive)
      throw new BadRequestException('Webhook endpoint is disabled.');
    const now = new Date();
    const event = await this.prisma.$transaction(async (tx) => {
      const outbox = await tx.outboxEvent.create({
        data: {
          eventKey: `webhook-test:${endpoint.id}:${now.getTime()}`,
          eventType: OutboxEventType.WEBHOOK_TEST,
          aggregateType: 'WEBHOOK_ENDPOINT',
          aggregateId: endpoint.id,
          payload: {
            endpointId: endpoint.id,
            merchantId: merchant.id,
            occurredAt: now.toISOString(),
          },
        },
      });
      return tx.webhookDelivery.create({
        data: {
          merchantId: merchant.id,
          webhookEndpointId: endpoint.id,
          outboxEventId: outbox.id,
          eventId: `${outbox.id}:${endpoint.id}`,
          eventType: 'webhook.test',
          payload: {
            id: `${outbox.id}:${endpoint.id}`,
            type: 'webhook.test',
            createdAt: now.toISOString(),
            merchantId: merchant.id,
            data: { endpointId: endpoint.id, message: 'ACHFlow webhook test' },
          },
        },
      });
    });
    return { id: event.id, status: event.status, eventType: event.eventType };
  }

  private async scopedEndpoint(id: string, merchantId: string) {
    const endpoint = await this.prisma.merchantWebhookEndpoint.findFirst({
      where: { id, merchantId },
    });
    if (!endpoint)
      throw new NotFoundException('Webhook endpoint was not found.');
    return endpoint;
  }

  private endpointView(endpoint: {
    id: string;
    url: string;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
    deliveries: Array<{
      id: string;
      status: string;
      attemptCount: number;
      responseStatus: number | null;
      lastErrorCode: string | null;
      nextAttemptAt: Date | null;
      deliveredAt: Date | null;
      createdAt: Date;
      eventType: string;
    }>;
  }) {
    return {
      id: endpoint.id,
      url: endpoint.url,
      isActive: endpoint.isActive,
      createdAt: endpoint.createdAt.toISOString(),
      updatedAt: endpoint.updatedAt.toISOString(),
      deliveries: endpoint.deliveries.map((delivery) => ({
        ...delivery,
        createdAt: delivery.createdAt.toISOString(),
        nextAttemptAt: delivery.nextAttemptAt?.toISOString() ?? null,
        deliveredAt: delivery.deliveredAt?.toISOString() ?? null,
      })),
    };
  }
  private validateUrl(value: string) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new BadRequestException('Webhook endpoint URL is invalid.');
    }
    if (
      url.username ||
      url.password ||
      !['http:', 'https:'].includes(url.protocol)
    )
      throw new BadRequestException('Webhook endpoint URL is invalid.');
    const local = this.config.get<string>('NODE_ENV') !== 'production';
    if (!local && url.protocol !== 'https:')
      throw new BadRequestException('Webhook endpoint URL must use HTTPS.');
  }
}

function deliveryStart(range: ListWebhookDeliveriesQueryDto['dateRange']) {
  if (!range || range === 'all') return undefined;
  const now = new Date();
  if (range === 'today')
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
  const days = range === '7d' ? 7 : 30;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}
