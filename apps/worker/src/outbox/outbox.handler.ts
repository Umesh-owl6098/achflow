import { Injectable, Logger } from '@nestjs/common';
import { OutboxEvent, OutboxEventType, PaymentDirection } from '@prisma/client';

type PaymentReceivedPayload = {
  paymentId: string;
  externalReference: string | null;
  direction: PaymentDirection;
  amountCents: string;
  currency: string;
  createdAt: string;
};

export class OutboxProcessingError extends Error {
  constructor(readonly safeMessage: string) {
    super(safeMessage);
  }
}

@Injectable()
export class OutboxHandler {
  private readonly logger = new Logger(OutboxHandler.name);

  handle(event: OutboxEvent): Promise<void> {
    return Promise.resolve().then(() => {
      if (event.eventType !== OutboxEventType.PAYMENT_RECEIVED) {
        throw new OutboxProcessingError('Unsupported outbox event type');
      }

      const payload = this.parsePaymentReceivedPayload(event.payload);

      this.logger.log(
        JSON.stringify({
          event: 'outbox.payment_received.handled',
          eventId: event.id,
          paymentId: payload.paymentId,
          direction: payload.direction,
          amountCents: payload.amountCents,
          currency: payload.currency,
        }),
      );
    });
  }

  private parsePaymentReceivedPayload(value: unknown): PaymentReceivedPayload {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new OutboxProcessingError('Invalid PAYMENT_RECEIVED payload');
    }

    const payload = value as Record<string, unknown>;

    if (
      typeof payload.paymentId !== 'string' ||
      (payload.externalReference !== null &&
        typeof payload.externalReference !== 'string') ||
      (payload.direction !== PaymentDirection.DEBIT &&
        payload.direction !== PaymentDirection.CREDIT) ||
      typeof payload.amountCents !== 'string' ||
      !/^\d+$/.test(payload.amountCents) ||
      typeof payload.currency !== 'string' ||
      Number.isNaN(Date.parse(String(payload.createdAt)))
    ) {
      throw new OutboxProcessingError('Invalid PAYMENT_RECEIVED payload');
    }

    return {
      paymentId: payload.paymentId,
      externalReference: payload.externalReference,
      direction: payload.direction,
      amountCents: payload.amountCents,
      currency: payload.currency,
      createdAt: String(payload.createdAt),
    };
  }
}
