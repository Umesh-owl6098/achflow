import { PaymentDirection, PaymentStatus } from '@prisma/client';

export class PaymentResponseDto {
  id!: string;
  idempotencyKey!: string;
  externalReference!: string | null;
  direction!: PaymentDirection;
  status!: PaymentStatus;
  amountCents!: string;
  currency!: string;
  merchant!: {
    merchantCode: string;
    displayName: string;
  };
  receiverName!: string;
  receiverAccountRef!: string;
  routingNumber!: string;
  description!: string | null;
  failureCode!: string | null;
  failureReason!: string | null;
  createdAt!: Date;
  updatedAt!: Date;
}
