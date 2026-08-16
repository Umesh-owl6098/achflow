import {
  OutboxEvent,
  OutboxEventStatus,
  OutboxEventType,
  PaymentDirection,
} from '@prisma/client';
import { OutboxHandler } from './outbox.handler';
import { OutboxPollingService } from './outbox-polling.service';
import { OutboxRepository } from './outbox.repository';
import { WorkerConfigService } from '../worker-config.service';

const event: OutboxEvent = {
  id: 'evt-1',
  eventKey: 'payment:pay-1:PAYMENT_RECEIVED',
  eventType: OutboxEventType.PAYMENT_RECEIVED,
  aggregateType: 'PAYMENT',
  aggregateId: 'pay-1',
  payload: {
    paymentId: 'pay-1',
    externalReference: null,
    direction: PaymentDirection.DEBIT,
    amountCents: '2500',
    currency: 'USD',
    createdAt: '2026-07-29T12:00:00.000Z',
  },
  status: OutboxEventStatus.PROCESSING,
  attempts: 1,
  availableAt: new Date(),
  processedAt: null,
  claimedAt: new Date(),
  lastError: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('OutboxPollingService', () => {
  const config = new WorkerConfigService({
    DATABASE_URL: 'postgresql://worker:worker@localhost:5432/worker',
    OUTBOX_BATCH_SIZE: '10',
    OUTBOX_MAX_ATTEMPTS: '3',
  });

  function createService(events: OutboxEvent[], handlerError?: Error) {
    const repository = {
      claimPending: jest.fn().mockResolvedValue(events),
      recoverExpiredClaims: jest.fn().mockResolvedValue(undefined),
      markProcessed: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };
    const handler = {
      handle: handlerError
        ? jest.fn().mockRejectedValue(handlerError)
        : jest.fn().mockResolvedValue(undefined),
    };
    const service = new OutboxPollingService(
      repository as unknown as OutboxRepository,
      handler as unknown as OutboxHandler,
      config,
    );

    return { service, repository, handler };
  }

  it('claims and processes pending events', async () => {
    const { service, repository, handler } = createService([event]);

    await service.processOnce();

    expect(repository.recoverExpiredClaims).toHaveBeenCalledWith(3, 30_000);
    expect(repository.claimPending).toHaveBeenCalledWith(10);
    expect(handler.handle).toHaveBeenCalledWith(event);
    expect(repository.markProcessed).toHaveBeenCalledWith(event.id);
    expect(repository.markFailed).not.toHaveBeenCalled();
  });

  it('schedules a retry after a retryable handler failure', async () => {
    const { service, repository } = createService(
      [event],
      new Error('sensitive stack details'),
    );

    await service.processOnce();

    expect(repository.markFailed).toHaveBeenCalledWith(
      event,
      3,
      'Outbox event processing failed',
    );
  });

  it('does not process a future event that was not claimed', async () => {
    const { service, repository, handler } = createService([]);

    await service.processOnce();

    expect(repository.claimPending).toHaveBeenCalledWith(10);
    expect(handler.handle).not.toHaveBeenCalled();
    expect(repository.markProcessed).not.toHaveBeenCalled();
  });
});
