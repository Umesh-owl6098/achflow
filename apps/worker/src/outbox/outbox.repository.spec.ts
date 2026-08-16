import {
  OutboxEvent,
  OutboxEventStatus,
  OutboxEventType,
} from '@prisma/client';
import { WorkerPrismaService } from '../worker-prisma.service';
import { OutboxRepository } from './outbox.repository';

const event: OutboxEvent = {
  id: 'evt-1',
  eventKey: 'payment:pay-1:PAYMENT_RECEIVED',
  eventType: OutboxEventType.PAYMENT_RECEIVED,
  aggregateType: 'PAYMENT',
  aggregateId: 'pay-1',
  payload: {},
  status: OutboxEventStatus.PROCESSING,
  attempts: 1,
  availableAt: new Date(),
  claimedAt: new Date(),
  processedAt: null,
  lastError: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('OutboxRepository', () => {
  it('schedules bounded exponential retry backoff', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const repository = new OutboxRepository({
      outboxEvent: { updateMany },
    } as unknown as WorkerPrismaService);
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);

    await repository.markFailed(event, 5, 'Outbox event processing failed');

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: event.id, status: OutboxEventStatus.PROCESSING },
      data: {
        status: OutboxEventStatus.PENDING,
        availableAt: new Date(now + 1_000),
        claimedAt: null,
        lastError: 'Outbox event processing failed',
      },
    });

    jest.restoreAllMocks();
  });

  it('marks an event FAILED once the maximum attempts are exhausted', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const repository = new OutboxRepository({
      outboxEvent: { updateMany },
    } as unknown as WorkerPrismaService);

    await repository.markFailed(
      { ...event, attempts: 5 },
      5,
      'Outbox event processing failed',
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: event.id, status: OutboxEventStatus.PROCESSING },
      data: {
        status: OutboxEventStatus.FAILED,
        claimedAt: null,
        lastError: 'Outbox event processing failed',
      },
    });
  });
});
