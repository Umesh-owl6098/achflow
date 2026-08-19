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
      workerHeartbeat: { findFirst: jest.fn().mockResolvedValue(null) },
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

  it('reports recent worker heartbeats and scheduled NACHA generation', async () => {
    const now = new Date('2026-08-19T12:00:00.000Z');
    jest.spyOn(Date, 'now').mockReturnValue(now.getTime());
    const service = new AdminSystemService(
      {
        get: jest.fn(
          (name: string) =>
            (
              ({
                WORKER_HEARTBEAT_STALE_SECONDS: '30',
              }) as Record<string, string>
            )[name],
        ),
      } as never,
      {
        $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
        outboxEvent: { count: jest.fn().mockResolvedValue(0) },
        webhookDelivery: { count: jest.fn().mockResolvedValue(0) },
        workerHeartbeat: {
          findFirst: jest.fn().mockResolvedValue({
            lastSeenAt: new Date('2026-08-19T11:59:45.000Z'),
            nachaGenerationEnabled: true,
            nachaGenerationIntervalMs: 300_000,
          }),
        },
      } as never,
      { ping: jest.fn().mockResolvedValue(true) } as never,
    );

    const result = await service.getStatus();

    expect(result.health).toMatchObject({
      worker: 'HEALTHY',
      lastWorkerHeartbeatAt: '2026-08-19T11:59:45.000Z',
    });
    expect(result.achProcessing.nachaGeneration).toEqual({
      status: 'ENABLED',
      intervalMs: 300_000,
    });
    jest.restoreAllMocks();
  });

  it('reports a stale worker heartbeat after its configured expiry', async () => {
    const now = new Date('2026-08-19T12:00:00.000Z');
    jest.spyOn(Date, 'now').mockReturnValue(now.getTime());
    const service = new AdminSystemService(
      { get: jest.fn(() => '30') } as never,
      {
        $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
        outboxEvent: { count: jest.fn().mockResolvedValue(0) },
        webhookDelivery: { count: jest.fn().mockResolvedValue(0) },
        workerHeartbeat: {
          findFirst: jest.fn().mockResolvedValue({
            lastSeenAt: new Date('2026-08-19T11:59:29.000Z'),
            nachaGenerationEnabled: false,
            nachaGenerationIntervalMs: 300_000,
          }),
        },
      } as never,
      { ping: jest.fn().mockResolvedValue(true) } as never,
    );

    await expect(service.getStatus()).resolves.toMatchObject({
      health: { worker: 'STALE' },
      achProcessing: {
        nachaGeneration: { status: 'DISABLED', intervalMs: 300_000 },
      },
    });
    jest.restoreAllMocks();
  });
});
