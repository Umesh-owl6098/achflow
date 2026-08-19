import { OutboxEventStatus, OutboxEventType } from '@prisma/client';
import { OutboxHandler, OutboxProcessingError } from './outbox.handler';
import { PaymentValidationService } from '../payments/payment-validation.service';
import { WebhookDeliveryMaterializerService } from '../webhooks/webhook-delivery-materializer.service';

describe('OutboxHandler', () => {
  it('fails unsupported event types with a safe error', async () => {
    const handler = new OutboxHandler(
      {
        validate: jest.fn(),
      } as unknown as PaymentValidationService,
      {
        materialize: jest.fn(),
      } as unknown as WebhookDeliveryMaterializerService,
    );

    await expect(
      handler.handle({
        id: 'evt-1',
        eventKey: 'payment:pay-1:UNKNOWN',
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

  it('materializes an eligible lifecycle event for webhook delivery', async () => {
    const materialize = jest.fn().mockResolvedValue(undefined);
    const handler = new OutboxHandler(
      { validate: jest.fn() } as unknown as PaymentValidationService,
      { materialize } as unknown as WebhookDeliveryMaterializerService,
    );
    const event = {
      id: 'evt-validated',
      eventKey: 'payment:pay-1:PAYMENT_VALIDATED',
      eventType: OutboxEventType.PAYMENT_VALIDATED,
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

    await handler.handle(event);

    expect(materialize).toHaveBeenCalledWith(event);
  });
});
