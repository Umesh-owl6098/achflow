import { Injectable } from '@nestjs/common';
import {
  MerchantStatus,
  PaymentDirection,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { OutboxProcessingError } from '../outbox/outbox-processing.error';
import { WorkerPrismaService } from '../worker-prisma.service';

export type PaymentForValidation = {
  id: string;
  status: PaymentStatus;
  amountCents: bigint;
  currency: string;
  direction: PaymentDirection;
  externalReference: string | null;
  receiverAccountRef: string;
  routingNumber: string;
  merchant: {
    status: MerchantStatus;
    allowAchDebit: boolean;
    allowAchCredit: boolean;
    perPaymentLimit: bigint;
  } | null;
};

export type ValidationResult = {
  status:
    typeof PaymentStatus.VALIDATED | typeof PaymentStatus.VALIDATION_FAILED;
  code: string | null;
  message: string | null;
};

@Injectable()
export class PaymentLifecycleRepository {
  constructor(private readonly prisma: WorkerPrismaService) {}

  findForValidation(id: string): Promise<PaymentForValidation | null> {
    return this.prisma.payment.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        amountCents: true,
        currency: true,
        direction: true,
        externalReference: true,
        receiverAccountRef: true,
        routingNumber: true,
        merchant: {
          select: {
            status: true,
            allowAchDebit: true,
            allowAchCredit: true,
            perPaymentLimit: true,
          },
        },
      },
    });
  }

  async transitionFromReceived(
    paymentId: string,
    result: ValidationResult,
  ): Promise<void> {
    const update = await this.prisma.payment.updateMany({
      where: { id: paymentId, status: PaymentStatus.RECEIVED },
      data: this.transitionData(result),
    });

    if (update.count === 1) {
      return;
    }

    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: { status: true },
    });

    if (!payment) {
      throw new OutboxProcessingError('Payment not found for validation');
    }

    if (
      payment.status === PaymentStatus.VALIDATED ||
      payment.status === PaymentStatus.VALIDATION_FAILED
    ) {
      return;
    }

    throw new OutboxProcessingError('Payment is not eligible for validation');
  }

  private transitionData(
    result: ValidationResult,
  ): Prisma.PaymentUpdateManyMutationInput {
    return {
      status: result.status,
      validationCode: result.code,
      validationMessage: result.message,
      validatedAt: new Date(),
    };
  }
}
