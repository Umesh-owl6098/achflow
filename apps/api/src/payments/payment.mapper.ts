import { CreatePaymentDto } from './dto/create-payment.dto';
import { PaymentResponseDto } from './dto/payment-response.dto';
import {
  CreatePaymentRecord,
  PaymentWithMerchant,
} from './payments.repository';

export type SerializedPayment = PaymentResponseDto;

export function mapCreatePaymentDtoToRecord(
  dto: CreatePaymentDto,
  requestFingerprint: string,
  merchantId: string,
): CreatePaymentRecord {
  return {
    idempotencyKey: dto.idempotencyKey,
    requestFingerprint,
    externalReference: dto.externalReference,
    direction: dto.direction,
    amountCents: BigInt(dto.amountCents),
    currency: dto.currency?.toUpperCase() ?? 'USD',
    merchantId,
    receiverName: dto.receiverName,
    receiverAccountRef: dto.receiverAccountRef,
    routingNumber: dto.routingNumber,
    description: dto.description,
  };
}

export function serializePayment(
  payment: PaymentWithMerchant,
): SerializedPayment {
  return {
    id: payment.id,
    idempotencyKey: payment.idempotencyKey,
    externalReference: payment.externalReference,
    direction: payment.direction,
    status: payment.status,
    amountCents: payment.amountCents.toString(),
    currency: payment.currency,
    merchant: {
      merchantCode: payment.merchant.merchantCode,
      displayName: payment.merchant.displayName,
    },
    receiverName: payment.receiverName,
    receiverAccountRef: payment.receiverAccountRef,
    routingNumber: payment.routingNumber,
    description: payment.description,
    failureCode: payment.failureCode,
    failureReason: payment.failureReason,
    validationCode: payment.validationCode,
    validationMessage: payment.validationMessage,
    validatedAt: payment.validatedAt,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
  };
}
