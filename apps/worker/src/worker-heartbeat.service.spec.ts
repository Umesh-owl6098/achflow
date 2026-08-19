import { WorkerHeartbeatService } from './worker-heartbeat.service';
import { WorkerConfigService } from './worker-config.service';
import { WorkerPrismaService } from './worker-prisma.service';

describe('WorkerHeartbeatService', () => {
  const config = new WorkerConfigService({
    DATABASE_URL: 'postgresql://worker:worker@localhost:5432/worker',
    WORKER_HEARTBEAT_ID: 'test-worker',
    NACHA_GENERATION_ENABLED: 'true',
    NACHA_GENERATION_INTERVAL_MS: '300000',
  });

  it('persists safe worker health and NACHA scheduling metadata', async () => {
    const upsert: jest.MockedFunction<(args: unknown) => Promise<void>> = jest
      .fn()
      .mockResolvedValue(undefined);
    const service = new WorkerHeartbeatService(
      { workerHeartbeat: { upsert } } as unknown as WorkerPrismaService,
      config,
    );

    await service.heartbeat();

    const [call] = upsert.mock.calls;
    expect(call?.[0]).toMatchObject({
      where: { workerId: 'test-worker' },
      create: {
        workerId: 'test-worker',
        nachaGenerationEnabled: true,
        nachaGenerationIntervalMs: 300_000,
      },
      update: {
        nachaGenerationEnabled: true,
        nachaGenerationIntervalMs: 300_000,
      },
    });
  });
});
