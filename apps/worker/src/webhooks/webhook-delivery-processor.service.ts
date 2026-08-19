import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { createHmac } from 'crypto';
import { Prisma, WebhookDelivery, WebhookDeliveryStatus } from '@prisma/client';
import { WebhookSecretCryptoService } from '../../../api/src/webhooks/webhook-secret-crypto.service';
import { WorkerConfigService } from '../worker-config.service';
import { WorkerPrismaService } from '../worker-prisma.service';

@Injectable()
export class WebhookDeliveryProcessorService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(WebhookDeliveryProcessorService.name);
  private readonly crypto: WebhookSecretCryptoService;
  private acceptingPolls = true;
  private timer: NodeJS.Timeout | undefined;
  private activeBatch: Promise<void> | undefined;
  constructor(
    private readonly prisma: WorkerPrismaService,
    private readonly config: WorkerConfigService,
  ) {
    this.crypto = new WebhookSecretCryptoService({
      get: (name: string) => process.env[name],
    } as never);
  }

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
    if (this.activeBatch) {
      return this.activeBatch;
    }
    const batch = this.processClaimedDeliveries();
    this.activeBatch = batch;
    try {
      await batch;
    } finally {
      if (this.activeBatch === batch) {
        this.activeBatch = undefined;
      }
    }
  }

  private async processClaimedDeliveries(): Promise<void> {
    const deliveries = await this.claim();
    await Promise.all(deliveries.map((delivery) => this.process(delivery)));
  }

  private scheduleNextPoll(delayMs: number): void {
    if (!this.acceptingPolls) return;
    this.timer = setTimeout(() => {
      void this.processOnce()
        .catch(() => {
          this.logger.error('Webhook delivery processor execution failed.');
        })
        .finally(() => {
          this.scheduleNextPoll(this.config.webhookDeliveryPollIntervalMs);
        });
    }, delayMs);
  }

  private claim(): Promise<WebhookDelivery[]> {
    const stale = new Date(
      Date.now() - this.config.webhookClaimTimeoutSeconds * 1000,
    );
    return this.prisma.$transaction((tx) =>
      tx.$queryRaw<WebhookDelivery[]>(Prisma.sql`
      WITH claimable AS (SELECT "id" FROM "WebhookDelivery" WHERE ("status" = 'PENDING'::"WebhookDeliveryStatus" AND "nextAttemptAt" <= NOW()) OR ("status" = 'PROCESSING'::"WebhookDeliveryStatus" AND ("claimedAt" IS NULL OR "claimedAt" < ${stale})) ORDER BY "nextAttemptAt", "createdAt" LIMIT ${this.config.webhookBatchSize} FOR UPDATE SKIP LOCKED)
      UPDATE "WebhookDelivery" d SET "status" = 'PROCESSING'::"WebhookDeliveryStatus", "claimedAt" = NOW(), "claimedBy" = ${this.config.webhookWorkerId}, "updatedAt" = NOW() FROM claimable WHERE d."id" = claimable."id" RETURNING d.*
    `),
    );
  }
  private async process(delivery: WebhookDelivery): Promise<void> {
    let responseStatus: number | null = null;
    let code = 'NETWORK_ERROR';
    let retryable = true;
    try {
      const endpoint =
        await this.prisma.merchantWebhookEndpoint.findUniqueOrThrow({
          where: { id: delivery.webhookEndpointId },
        });
      if (!endpoint.isActive) throw new Error('Endpoint unavailable');
      const secret = this.crypto.decrypt({
        ciphertext: endpoint.encryptedSigningSecret,
        iv: endpoint.signingSecretIv,
        authTag: endpoint.signingSecretAuthTag,
        keyVersion: endpoint.signingSecretKeyVersion,
      });
      const body = JSON.stringify(delivery.payload);
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = createHmac('sha256', secret)
        .update(`${timestamp}.${body}`)
        .digest('hex');
      const response = await fetch(endpoint.url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(this.config.webhookRequestTimeoutMs),
        headers: {
          'Content-Type': 'application/json',
          'X-ACHFlow-Event-Id': delivery.eventId,
          'X-ACHFlow-Timestamp': timestamp,
          'X-ACHFlow-Signature': `v1=${signature}`,
        },
        body,
      });
      responseStatus = response.status;
      if (response.ok) {
        await this.complete(delivery, responseStatus);
        return;
      }
      retryable =
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500;
      code = `HTTP_${response.status}`;
    } catch (error) {
      code =
        error instanceof Error && error.name === 'TimeoutError'
          ? 'TIMEOUT'
          : 'NETWORK_ERROR';
    }
    await this.fail(delivery, responseStatus, code, retryable);
  }
  private complete(delivery: WebhookDelivery, responseStatus: number) {
    return this.prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: WebhookDeliveryStatus.DELIVERED,
        attemptCount: { increment: 1 },
        lastAttemptAt: new Date(),
        deliveredAt: new Date(),
        nextAttemptAt: null,
        responseStatus,
        lastErrorCode: null,
        claimedAt: null,
        claimedBy: null,
      },
    });
  }
  private fail(
    delivery: WebhookDelivery,
    responseStatus: number | null,
    code: string,
    retryable: boolean,
  ) {
    const attempts = delivery.attemptCount + 1;
    const exhausted = attempts >= this.config.webhookMaxAttempts;
    return this.prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status:
          retryable && !exhausted
            ? WebhookDeliveryStatus.PENDING
            : WebhookDeliveryStatus.FAILED,
        attemptCount: { increment: 1 },
        lastAttemptAt: new Date(),
        nextAttemptAt:
          retryable && !exhausted
            ? new Date(
                Date.now() +
                  Math.min(
                    this.config.webhookInitialRetrySeconds *
                      1000 *
                      2 ** (attempts - 1),
                    this.config.webhookMaxRetrySeconds * 1000,
                  ),
              )
            : null,
        responseStatus,
        lastErrorCode: code,
        claimedAt: null,
        claimedBy: null,
      },
    });
  }
}
