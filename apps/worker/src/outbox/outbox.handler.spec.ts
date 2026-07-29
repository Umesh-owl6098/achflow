import { OutboxEventStatus, OutboxEventType } from '@prisma/client';
import { OutboxHandler, OutboxProcessingError } from './outbox.handler';

describe('OutboxHandler', () => {
  it('fails unsupported event types with a safe error', async () => {
    const handler = new OutboxHandler();

    await expect(
      handler.handle({
        id: 'evt-1',
        eventType: 'UNKNOWN' as OutboxEventType,
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
      }),
    ).rejects.toEqual(
      new OutboxProcessingError('Unsupported outbox event type'),
    );
  });
});
