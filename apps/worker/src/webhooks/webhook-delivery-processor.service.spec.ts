import { WebhookDeliveryProcessorService } from './webhook-delivery-processor.service';
import { WorkerConfigService } from '../worker-config.service';
import { WorkerPrismaService } from '../worker-prisma.service';

describe('WebhookDeliveryProcessorService', () => {
  const config = new WorkerConfigService({
    DATABASE_URL: 'postgresql://worker:worker@localhost:5432/worker',
    WEBHOOK_DELIVERY_POLL_INTERVAL_MS: '1000',
  });

  beforeEach(() => {
    process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString(
      'base64',
    );
    process.env.WEBHOOK_SECRET_ENCRYPTION_KEY_VERSION = 'test-v1';
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function createService() {
    const queryRaw = jest.fn().mockResolvedValue([]);
    const prisma = {
      $transaction: jest.fn(
        (callback: (transaction: { $queryRaw: typeof queryRaw }) => unknown) =>
          callback({ $queryRaw: queryRaw }),
      ),
    };
    const service = new WebhookDeliveryProcessorService(
      prisma as unknown as WorkerPrismaService,
      config,
    );
    return { service, prisma, queryRaw };
  }

  it('starts delivery processing from the normal worker lifecycle hook', async () => {
    jest.useFakeTimers();
    const { service, prisma } = createService();

    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    await service.onApplicationShutdown();
  });

  it('does not overlap delivery claims within one worker instance', async () => {
    let resolveClaim: ((value: []) => void) | undefined;
    const queryRaw = jest.fn(
      () =>
        new Promise<[]>((resolve) => {
          resolveClaim = resolve;
        }),
    );
    const prisma = {
      $transaction: jest.fn(
        (callback: (transaction: { $queryRaw: typeof queryRaw }) => unknown) =>
          callback({ $queryRaw: queryRaw }),
      ),
    };
    const service = new WebhookDeliveryProcessorService(
      prisma as unknown as WorkerPrismaService,
      config,
    );

    const first = service.processOnce();
    const second = service.processOnce();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);

    resolveClaim?.([]);
    await Promise.all([first, second]);
  });
});
