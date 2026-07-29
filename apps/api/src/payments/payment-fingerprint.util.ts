import { createHash } from 'crypto';
import { CreatePaymentDto } from './dto/create-payment.dto';

export function buildPaymentRequestFingerprint(dto: CreatePaymentDto): string {
  const canonical = {
    amountCents: dto.amountCents,
    currency: (dto.currency ?? 'USD').toUpperCase(),
    description: dto.description ?? null,
    direction: dto.direction,
    externalReference: dto.externalReference ?? null,
    originatorName: dto.originatorName,
    receiverAccountRef: dto.receiverAccountRef,
    receiverName: dto.receiverName,
    routingNumber: dto.routingNumber,
  };

  const payload = JSON.stringify(canonical);

  return createHash('sha256').update(payload, 'utf8').digest('hex');
}
