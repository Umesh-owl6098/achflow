import { Payment } from '@prisma/client';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { CreatePaymentRecord } from './payments.repository';

export type SerializedPayment = Omit<Payment, 'amountCents'> & {
  amountCents: string;
};

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
    ...payment,
    amountCents: payment.amountCents.toString(),
  };
}
