import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OutboxEventStatus,
  Prisma,
  WebhookDeliveryStatus,
} from '@prisma/client';
import { RedisClientService } from '../rate-limit/redis-client.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminSystemService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisClientService,
  ) {}

  async getStatus() {
    const [
      database,
      redis,
      outboxBacklog,
      pendingWebhookDeliveries,
      workerHeartbeat,
    ] = await Promise.all([
      this.databaseHealthy(),
      this.redis.ping(),
      this.prisma.outboxEvent.count({
        where: { status: OutboxEventStatus.PENDING },
      }),
      this.prisma.webhookDelivery.count({
        where: { status: WebhookDeliveryStatus.PENDING },
      }),
      this.prisma.workerHeartbeat.findFirst({
        orderBy: { lastSeenAt: 'desc' },
      }),
    ]);
    const worker = this.workerHealth(workerHeartbeat?.lastSeenAt ?? null);

    return {
      general: {
        platformName: 'ACHFlow',
        environment: this.config.get<string>('NODE_ENV') ?? 'local',
        defaultTimezone: 'UTC',
        defaultDateFormat: 'YYYY-MM-DD',
        defaultCurrency: 'USD',
      },
      achProcessing: {
        defaultSecCode: 'PPD',
        processingWindow: 'On-demand outbound batch generation',
        sameDayAchEnabled: false,
        debitEnabled: true,
        creditEnabled: true,
        maximumPaymentAmount: 'Merchant-specific limits',
        retryPolicy: 'Exponential backoff, maximum 5 attempts',
        returnHandling:
          'Supported return codes transition settled payments to returned',
        nachaGeneration: workerHeartbeat
          ? {
              status: workerHeartbeat.nachaGenerationEnabled
                ? 'ENABLED'
                : 'DISABLED',
              intervalMs: workerHeartbeat.nachaGenerationIntervalMs,
            }
          : { status: 'UNKNOWN', intervalMs: null },
      },
      nacha: {
        immediateDestination: '*****6789',
        immediateOrigin: '*****4321',
        companyId: 'Merchant code per batch',
        companyName: 'Merchant legal name per batch',
        originatingDfiIdentification: '******78',
        fileIdModifier: 'A (fixed)',
        balancedFiles: false,
      },
      webhooks: {
        timeoutMs: this.positiveInteger('WEBHOOK_REQUEST_TIMEOUT_MS', 5_000),
        maxRetryAttempts: this.positiveInteger('WEBHOOK_MAX_ATTEMPTS', 5),
        retryBackoff: `Exponential ${this.positiveInteger('WEBHOOK_INITIAL_RETRY_SECONDS', 1)}s to ${this.positiveInteger('WEBHOOK_MAX_RETRY_SECONDS', 60)}s`,
        signatureAlgorithm: 'HMAC-SHA256 (v1)',
        signingSecretStorage: 'AES-256-GCM encrypted at rest',
      },
      security: {
        merchantApiKeyBehavior: 'One active hashed API key per merchant',
        adminControlPlane: this.config.get<string>('ACHFLOW_ADMIN_API_KEY')
          ? 'Configured'
          : 'Not configured',
        keyRotationGuidance:
          'Rotated merchant keys are shown once and replace the prior key immediately.',
        secretMasking: 'Raw secrets and environment values are never returned.',
        environmentHealth: [
          'DATABASE_URL',
          'REDIS_URL',
          'MERCHANT_API_KEY_HASH_SECRET',
          'ACHFLOW_ADMIN_API_KEY',
          'WEBHOOK_SECRET_ENCRYPTION_KEY',
        ].map((name) => ({ name, configured: Boolean(this.config.get(name)) })),
      },
      health: {
        api: 'HEALTHY',
        database: database ? 'HEALTHY' : 'UNHEALTHY',
        redis: redis ? 'HEALTHY' : 'UNHEALTHY',
        worker,
        lastWorkerHeartbeatAt:
          workerHeartbeat?.lastSeenAt.toISOString() ?? null,
        outboxBacklog,
        pendingWebhookDeliveries,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  private async databaseHealthy(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw(Prisma.sql`SELECT 1`);
      return true;
    } catch {
      return false;
    }
  }

  private positiveInteger(name: string, fallback: number): number {
    const value = this.config.get<string>(name);
    const parsed = value ? Number(value) : fallback;
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  private workerHealth(
    lastSeenAt: Date | null,
  ): 'HEALTHY' | 'STALE' | 'UNKNOWN' {
    if (!lastSeenAt) return 'UNKNOWN';
    const staleAfterSeconds = this.positiveInteger(
      'WORKER_HEARTBEAT_STALE_SECONDS',
      30,
    );
    return Date.now() - lastSeenAt.getTime() <= staleAfterSeconds * 1000
      ? 'HEALTHY'
      : 'STALE';
  }
}
