import { OutboxEventType, Payment, Prisma } from '@prisma/client';

type LifecyclePayment = Pick<
  Payment,
  | 'id'
  | 'merchantId'
  | 'status'
  | 'amountCents'
  | 'currency'
  | 'direction'
  | 'validationCode'
>;

export function paymentLifecycleOutboxEvent(
  payment: LifecyclePayment,
  eventType: OutboxEventType,
  occurredAt: Date = new Date(),
  returnCode: string | null = null,
): Prisma.OutboxEventCreateInput {
  return {
    eventKey: `payment:${payment.id}:${eventType}`,
    eventType,
    aggregateType: 'PAYMENT',
    aggregateId: payment.id,
    payload: {
      paymentId: payment.id,
      merchantId: payment.merchantId,
      paymentStatus: payment.status,
      amountCents: payment.amountCents.toString(),
      currency: payment.currency,
      direction: payment.direction,
      validationCode: payment.validationCode,
      returnCode,
      occurredAt: occurredAt.toISOString(),
    },
  };
}
