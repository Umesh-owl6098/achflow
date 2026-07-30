import { Injectable, Logger } from '@nestjs/common';
import { OutboxEvent, OutboxEventType, PaymentDirection } from '@prisma/client';
import { PaymentValidationService } from '../payments/payment-validation.service';
import { OutboxProcessingError } from './outbox-processing.error';

export { OutboxProcessingError } from './outbox-processing.error';

type PaymentReceivedPayload = {
  paymentId: string;
  merchantId: string;
  paymentStatus: string;
  direction: PaymentDirection;
  amountCents: string;
  currency: string;
  occurredAt: string;
};

@Injectable()
export class OutboxHandler {
  private readonly logger = new Logger(OutboxHandler.name);

  constructor(private readonly paymentValidation: PaymentValidationService) {}

  async handle(event: OutboxEvent): Promise<void> {
    if (event.eventType !== OutboxEventType.PAYMENT_RECEIVED) {
      if (
        [
          OutboxEventType.PAYMENT_VALIDATED,
          OutboxEventType.PAYMENT_VALIDATION_FAILED,
          OutboxEventType.PAYMENT_RESERVED,
          OutboxEventType.PAYMENT_SUBMITTED,
          OutboxEventType.PAYMENT_SETTLED,
          OutboxEventType.PAYMENT_RETURNED,
          OutboxEventType.WEBHOOK_TEST,
        ].includes(event.eventType)
      ) {
        return;
      }
      throw new OutboxProcessingError('Unsupported outbox event type');
    }

    const payload = this.parsePaymentReceivedPayload(event.payload);
    await this.paymentValidation.validate(payload.paymentId, event.id);

    this.logger.log(
      JSON.stringify({
        event: 'outbox.payment_received.handled',
        eventId: event.id,
        paymentId: payload.paymentId,
        direction: payload.direction,
        amountCents: payload.amountCents,
        currency: payload.currency,
        result: 'completed',
      }),
    );
  }

  private parsePaymentReceivedPayload(value: unknown): PaymentReceivedPayload {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new OutboxProcessingError('Invalid PAYMENT_RECEIVED payload');
    }

    const payload = value as Record<string, unknown>;

    if (
      typeof payload.paymentId !== 'string' ||
      typeof payload.merchantId !== 'string' ||
      typeof payload.paymentStatus !== 'string' ||
      (payload.direction !== PaymentDirection.DEBIT &&
        payload.direction !== PaymentDirection.CREDIT) ||
      typeof payload.amountCents !== 'string' ||
      !/^\d+$/.test(payload.amountCents) ||
      typeof payload.currency !== 'string' ||
      Number.isNaN(Date.parse(String(payload.occurredAt)))
    ) {
      throw new OutboxProcessingError('Invalid PAYMENT_RECEIVED payload');
    }

    return {
      paymentId: payload.paymentId,
      merchantId: payload.merchantId,
      paymentStatus: payload.paymentStatus,
      direction: payload.direction,
      amountCents: payload.amountCents,
      currency: payload.currency,
      occurredAt: String(payload.occurredAt),
    };
  }
}
