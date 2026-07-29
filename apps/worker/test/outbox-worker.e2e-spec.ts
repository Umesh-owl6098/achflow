import {
  OutboxEventStatus,
  OutboxEventType,
  PaymentDirection,
} from '@prisma/client';
import { OutboxHandler } from '../src/outbox/outbox.handler';
import { OutboxPollingService } from '../src/outbox/outbox-polling.service';
import { OutboxRepository } from '../src/outbox/outbox.repository';
import { WorkerConfigService } from '../src/worker-config.service';
import { WorkerPrismaService } from '../src/worker-prisma.service';

describe('Outbox worker (integration)', () => {
  let prismaOne: WorkerPrismaService;
  let prismaTwo: WorkerPrismaService;
  let workerOne: OutboxPollingService;
  let workerTwo: OutboxPollingService;
  let repositoryOne: OutboxRepository;
  let repositoryTwo: OutboxRepository;

  beforeAll(async () => {
    const config = new WorkerConfigService({
      ...process.env,
      OUTBOX_BATCH_SIZE: '2',
      OUTBOX_MAX_ATTEMPTS: '3',
      OUTBOX_CLAIM_LEASE_MS: '30000',
    });
    prismaOne = new WorkerPrismaService(config);
    prismaTwo = new WorkerPrismaService(config);
    await Promise.all([prismaOne.onModuleInit(), prismaTwo.onModuleInit()]);

    repositoryOne = new OutboxRepository(prismaOne);
    repositoryTwo = new OutboxRepository(prismaTwo);
    workerOne = new OutboxPollingService(
      repositoryOne,
      new OutboxHandler(),
      config,
    );
    workerTwo = new OutboxPollingService(
      repositoryTwo,
      new OutboxHandler(),
      config,
    );
  });

  beforeEach(async () => {
    await prismaOne.outboxEvent.deleteMany();
  });

  afterAll(async () => {
    await Promise.all([
      prismaOne.onModuleDestroy(),
      prismaTwo.onModuleDestroy(),
    ]);
  });

  it('processes multiple events once across concurrent worker instances', async () => {
    await prismaOne.outboxEvent.createMany({
      data: Array.from({ length: 3 }, (_, index) => ({
        eventType: OutboxEventType.PAYMENT_RECEIVED,
        aggregateType: 'PAYMENT',
        aggregateId: `pay-${index}`,
        payload: {
          paymentId: `pay-${index}`,
          externalReference: null,
          direction: PaymentDirection.DEBIT,
          amountCents: '2500',
          currency: 'USD',
          createdAt: '2026-07-29T12:00:00.000Z',
        },
      })),
    });

    await Promise.all([workerOne.processOnce(), workerTwo.processOnce()]);

    const events = await prismaOne.outboxEvent.findMany({
      orderBy: { aggregateId: 'asc' },
    });

    expect(events).toHaveLength(3);
    expect(
      events.every((event) => event.status === OutboxEventStatus.PROCESSED),
    ).toBe(true);
    expect(events.every((event) => event.attempts === 1)).toBe(true);
    expect(events.every((event) => event.processedAt instanceof Date)).toBe(
      true,
    );
    expect(events.every((event) => event.claimedAt === null)).toBe(true);
    expect(events.every((event) => event.lastError === null)).toBe(true);
  });

  it('recovers stale claims safely across concurrent workers', async () => {
    const staleClaimedAt = new Date(Date.now() - 31_000);
    const freshClaimedAt = new Date(Date.now() - 1_000);
    await prismaOne.outboxEvent.createMany({
      data: [
        {
          eventType: OutboxEventType.PAYMENT_RECEIVED,
          aggregateType: 'PAYMENT',
          aggregateId: 'stale-retry',
          payload: {},
          status: OutboxEventStatus.PROCESSING,
          attempts: 1,
          claimedAt: staleClaimedAt,
        },
        {
          eventType: OutboxEventType.PAYMENT_RECEIVED,
          aggregateType: 'PAYMENT',
          aggregateId: 'stale-failed',
          payload: {},
          status: OutboxEventStatus.PROCESSING,
          attempts: 3,
          claimedAt: staleClaimedAt,
        },
        {
          eventType: OutboxEventType.PAYMENT_RECEIVED,
          aggregateType: 'PAYMENT',
          aggregateId: 'fresh',
          payload: {},
          status: OutboxEventStatus.PROCESSING,
          attempts: 1,
          claimedAt: freshClaimedAt,
        },
      ],
    });

    await Promise.all([
      repositoryOne.recoverExpiredClaims(3, 30_000),
      repositoryTwo.recoverExpiredClaims(3, 30_000),
    ]);

    const events = await prismaOne.outboxEvent.findMany({
      orderBy: { aggregateId: 'asc' },
    });

    expect(events[0]).toMatchObject({
      aggregateId: 'fresh',
      status: OutboxEventStatus.PROCESSING,
      attempts: 1,
      claimedAt: freshClaimedAt,
      lastError: null,
    });
    expect(events[1]).toMatchObject({
      aggregateId: 'stale-failed',
      status: OutboxEventStatus.FAILED,
      attempts: 3,
      claimedAt: null,
      lastError: 'Previous worker claim expired',
    });
    expect(events[2]).toMatchObject({
      aggregateId: 'stale-retry',
      status: OutboxEventStatus.PENDING,
      attempts: 1,
      claimedAt: null,
      lastError: 'Previous worker claim expired',
    });
  });
});
