import { AdminSystemService } from './admin-system.service';

describe('AdminSystemService', () => {
  it('returns health indicators and masked configuration metadata without environment values', async () => {
    const config = {
      get: jest.fn(
        (name: string) =>
          (
            ({
              NODE_ENV: 'test',
              ACHFLOW_ADMIN_API_KEY: 'secret-admin-key',
              WEBHOOK_REQUEST_TIMEOUT_MS: '4500',
              WEBHOOK_MAX_ATTEMPTS: '4',
              WEBHOOK_INITIAL_RETRY_SECONDS: '2',
              WEBHOOK_MAX_RETRY_SECONDS: '30',
              DATABASE_URL: 'postgresql://private',
              REDIS_URL: 'redis://private',
              MERCHANT_API_KEY_HASH_SECRET: 'private',
              WEBHOOK_SECRET_ENCRYPTION_KEY: 'private',
            }) as Record<string, string>
          )[name],
      ),
    };
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
      outboxEvent: { count: jest.fn().mockResolvedValue(3) },
      webhookDelivery: { count: jest.fn().mockResolvedValue(2) },
    };
    const redis = { ping: jest.fn().mockResolvedValue(true) };
    const service = new AdminSystemService(
      config as never,
      prisma as never,
      redis as never,
    );

    const result = await service.getStatus();

    expect(result.health).toMatchObject({
      api: 'HEALTHY',
      database: 'HEALTHY',
      redis: 'HEALTHY',
      worker: 'UNKNOWN',
      outboxBacklog: 3,
      pendingWebhookDeliveries: 2,
    });
    expect(result.webhooks).toMatchObject({
      timeoutMs: 4500,
      maxRetryAttempts: 4,
      retryBackoff: 'Exponential 2s to 30s',
    });
    expect(result.nacha.immediateDestination).toBe('*****6789');
    expect(JSON.stringify(result)).not.toContain('secret-admin-key');
    expect(JSON.stringify(result)).not.toContain('postgresql://private');
    expect(JSON.stringify(result)).not.toContain('redis://private');
  });
});
