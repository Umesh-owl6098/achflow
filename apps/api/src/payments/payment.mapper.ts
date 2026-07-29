import { Payment } from '@prisma/client';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { PaymentResponseDto } from './dto/payment-response.dto';
import { CreatePaymentRecord } from './payments.repository';

export type SerializedPayment = PaymentResponseDto;

export function mapCreatePaymentDtoToRecord(
  dto: CreatePaymentDto,
  requestFingerprint: string,
): CreatePaymentRecord {
  return {
    idempotencyKey: dto.idempotencyKey,
    requestFingerprint,
    externalReference: dto.externalReference,
    direction: dto.direction,
    amountCents: BigInt(dto.amountCents),
    currency: dto.currency?.toUpperCase() ?? 'USD',
    originatorName: dto.originatorName,
    receiverName: dto.receiverName,
    receiverAccountRef: dto.receiverAccountRef,
    routingNumber: dto.routingNumber,
    description: dto.description,
  };
}

export function serializePayment(payment: Payment): SerializedPayment {
  return {
    id: payment.id,
    idempotencyKey: payment.idempotencyKey,
    externalReference: payment.externalReference,
    direction: payment.direction,
    status: payment.status,
    amountCents: payment.amountCents.toString(),
    currency: payment.currency,
    originatorName: payment.originatorName,
    receiverName: payment.receiverName,
    receiverAccountRef: payment.receiverAccountRef,
    routingNumber: payment.routingNumber,
    description: payment.description,
    failureCode: payment.failureCode,
    failureReason: payment.failureReason,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
  };
}
