import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OutboxEventType, Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import type { AuthenticatedMerchant } from '../auth/merchant-authentication.service';
import { PrismaService } from '../prisma/prisma.service';
import { ListAdminWebhookDeliveriesQueryDto } from './dto/list-admin-webhook-deliveries-query.dto';
import { ListAdminWebhooksQueryDto } from './dto/list-admin-webhooks-query.dto';
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
    return this.listForMerchantScope(query, merchant.id, false);
  }

  async listAdmin(query: ListAdminWebhooksQueryDto) {
    return this.listForMerchantScope(query, query.merchantId, true);
  }

  private async listForMerchantScope(
    query: ListWebhooksQueryDto,
    merchantId: string | undefined,
    includeMerchant = false,
  ) {
    const endpoints = await this.prisma.merchantWebhookEndpoint.findMany({
      where: {
        ...(merchantId ? { merchantId } : {}),
        ...(query.status === 'active' ? { isActive: true } : {}),
        ...(query.status === 'disabled' ? { isActive: false } : {}),
        ...(query.search?.trim()
          ? { url: { contains: query.search.trim(), mode: 'insensitive' } }
          : {}),
      },
      include: {
        deliveries: { orderBy: { createdAt: 'desc' } },
        merchant: {
          select: { id: true, merchantCode: true, displayName: true },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const data = endpoints.map((endpoint) =>
      this.endpointView(endpoint, includeMerchant),
    );
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
    return this.deliveriesForEndpoint(endpoint.id, query);
  }

  async deliveriesAdmin(
    endpointId: string,
    query: ListWebhookDeliveriesQueryDto,
  ) {
    const endpoint = await this.prisma.merchantWebhookEndpoint.findUnique({
      where: { id: endpointId },
    });
    if (!endpoint)
      throw new NotFoundException('Webhook endpoint was not found.');
    return this.deliveriesForEndpoint(endpoint.id, query);
  }

  private async deliveriesForEndpoint(
    endpointId: string,
    query: ListWebhookDeliveriesQueryDto,
  ) {
    const { start, end } = deliveryDateRange(query);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const where: Prisma.WebhookDeliveryWhereInput = {
      webhookEndpointId: endpointId,
      ...(query.status && query.status !== 'all'
        ? { status: query.status }
        : {}),
      ...(query.eventType?.trim() ? { eventType: query.eventType.trim() } : {}),
      ...(start || end
        ? {
            createdAt: {
              ...(start ? { gte: start } : {}),
              ...(end ? { lt: end } : {}),
            },
          }
        : {}),
      ...deliverySearchWhere(query.search),
    };
    const [deliveries, total] = await this.prisma.$transaction([
      this.prisma.webhookDelivery.findMany({
        where,
        orderBy: deliveryOrderBy(query.sortBy, query.sortOrder ?? 'desc'),
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.webhookDelivery.count({ where }),
    ]);
    return {
      data: deliveries.map((delivery) => ({
        ...delivery,
        payload: delivery.payload,
      })),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async listDeliveries(
    query: ListWebhookDeliveriesQueryDto,
    merchant: AuthenticatedMerchant,
  ) {
    return this.listDeliveriesForMerchantScope(query, merchant.id);
  }

  async listDeliveriesAdmin(query: ListAdminWebhookDeliveriesQueryDto) {
    return this.listDeliveriesForMerchantScope(query, query.merchantId);
  }

  private async listDeliveriesForMerchantScope(
    query: ListWebhookDeliveriesQueryDto,
    merchantId?: string,
  ) {
    const { start, end } = deliveryDateRange(query);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const where: Prisma.WebhookDeliveryWhereInput = {
      ...(merchantId ? { merchantId } : {}),
      ...(query.status && query.status !== 'all'
        ? { status: query.status }
        : {}),
      ...(query.eventType?.trim() ? { eventType: query.eventType.trim() } : {}),
      ...(start || end
        ? {
            createdAt: {
              ...(start ? { gte: start } : {}),
              ...(end ? { lt: end } : {}),
            },
          }
        : {}),
      ...deliverySearchWhere(query.search),
    };
    const [deliveries, total] = await this.prisma.$transaction([
      this.prisma.webhookDelivery.findMany({
        where,
        include: {
          webhookEndpoint: { select: { id: true, url: true } },
          merchant: { select: { merchantCode: true, displayName: true } },
        },
        orderBy: deliveryOrderBy(query.sortBy, query.sortOrder ?? 'desc'),
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.webhookDelivery.count({ where }),
    ]);
    const data = deliveries.map((delivery) => {
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
    return {
      data,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
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

  private endpointView(
    endpoint: {
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
      merchant?: { id: string; merchantCode: string; displayName: string };
    },
    includeMerchant = false,
  ) {
    return {
      id: endpoint.id,
      url: endpoint.url,
      isActive: endpoint.isActive,
      createdAt: endpoint.createdAt.toISOString(),
      updatedAt: endpoint.updatedAt.toISOString(),
      ...(includeMerchant && endpoint.merchant
        ? { merchant: endpoint.merchant }
        : {}),
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

function deliveryDateRange(query: ListWebhookDeliveriesQueryDto): {
  start?: Date;
  end?: Date;
} {
  if (query.startDate || query.endDate) {
    const start = query.startDate
      ? startOfUtcDay(new Date(query.startDate))
      : undefined;
    const endDate = query.endDate
      ? startOfUtcDay(new Date(query.endDate))
      : undefined;
    if (start && endDate && start > endDate)
      throw new BadRequestException('The date range is invalid.');
    return { start, ...(endDate ? { end: addUtcDays(endDate, 1) } : {}) };
  }
  const range = query.dateRange;
  if (!range || range === 'all') return {};
  if (range === 'custom')
    throw new BadRequestException(
      'Custom date filtering requires a startDate or endDate.',
    );
  const now = new Date();
  if (range === 'today')
    return {
      start: startOfUtcDay(now),
      end: addUtcDays(startOfUtcDay(now), 1),
    };
  const days = range === '7d' ? 7 : 30;
  return {
    start: new Date(now.getTime() - days * 24 * 60 * 60 * 1000),
    end: now,
  };
}

function deliverySearchWhere(
  search: string | undefined,
): Prisma.WebhookDeliveryWhereInput {
  const value = search?.trim();
  if (!value) return {};
  return {
    OR: [
      { eventId: { contains: value, mode: 'insensitive' } },
      { eventType: { contains: value, mode: 'insensitive' } },
      {
        payload: {
          path: ['data', 'paymentId'],
          string_contains: value,
        },
      },
      {
        webhookEndpoint: {
          is: { url: { contains: value, mode: 'insensitive' } },
        },
      },
      {
        merchant: {
          is: {
            OR: [
              { merchantCode: { contains: value, mode: 'insensitive' } },
              { displayName: { contains: value, mode: 'insensitive' } },
            ],
          },
        },
      },
    ],
  };
}

function deliveryOrderBy(
  sortBy: ListWebhookDeliveriesQueryDto['sortBy'],
  sortOrder: 'asc' | 'desc',
): Prisma.WebhookDeliveryOrderByWithRelationInput[] {
  if (sortBy === 'deliveredAt')
    return [{ deliveredAt: sortOrder }, { id: 'desc' }];
  if (sortBy === 'attemptCount')
    return [{ attemptCount: sortOrder }, { id: 'desc' }];
  if (sortBy === 'status') return [{ status: sortOrder }, { id: 'desc' }];
  return [{ createdAt: sortOrder }, { id: 'desc' }];
}

function startOfUtcDay(value: Date): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
  );
}

function addUtcDays(value: Date, days: number): Date {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}
