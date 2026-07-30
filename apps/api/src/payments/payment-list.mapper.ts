import type { PaymentWithMerchant } from './payments.repository';

export function serializePaymentListItem(payment: PaymentWithMerchant) {
  return {
    id: payment.id,
    merchant: payment.merchant,
    externalReference: payment.externalReference,
    direction: payment.direction,
    amountCents: payment.amountCents.toString(),
    currency: payment.currency,
    status: payment.status,
    createdAt: payment.createdAt.toISOString(),
    updatedAt: payment.updatedAt.toISOString(),
  };
}
