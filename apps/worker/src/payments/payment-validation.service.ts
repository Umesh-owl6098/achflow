import { Injectable, Logger } from '@nestjs/common';
import {
  MerchantStatus,
  PaymentDirection,
  PaymentStatus,
} from '@prisma/client';
import {
  PaymentForValidation,
  PaymentLifecycleRepository,
  ValidationResult,
} from './payment-lifecycle.repository';
import { OutboxProcessingError } from '../outbox/outbox-processing.error';

@Injectable()
export class PaymentValidationService {
  private readonly logger = new Logger(PaymentValidationService.name);

  constructor(private readonly payments: PaymentLifecycleRepository) {}

  async validate(paymentId: string, outboxEventId: string): Promise<void> {
    const payment = await this.payments.findForValidation(paymentId);

    if (!payment) {
      throw new OutboxProcessingError('Payment not found for validation');
    }

    const basicResult = this.validatePayment(payment);
    const result =
      basicResult.status === PaymentStatus.VALIDATED
        ? await this.payments.reserveDailyUsageAndTransition(
            payment,
            outboxEventId,
          )
        : await this.transitionAndComplete(payment.id, basicResult);

    this.logger.log(
      JSON.stringify({
        event: 'payment.validation.completed',
        paymentId: payment.id,
        direction: payment.direction,
        amountCents: payment.amountCents.toString(),
        currency: payment.currency,
        result: result.status,
        validationCode: result.code,
      }),
    );
  }

  private async transitionAndComplete(
    paymentId: string,
    result: ValidationResult,
  ): Promise<ValidationResult> {
    await this.payments.transitionFromReceived(paymentId, result);
    // Non-daily terminal results retain the existing lifecycle transition path.
    // The outbox polling service completes their claimed event immediately after this returns.
    return result;
  }

  private validatePayment(payment: PaymentForValidation): ValidationResult {
    if (payment.amountCents <= BigInt(0)) {
      return this.failed(
        'INVALID_AMOUNT',
        'Payment amount must be greater than zero',
      );
    }

    if (payment.currency !== 'USD') {
      return this.failed(
        'UNSUPPORTED_CURRENCY',
        'Payment currency must be USD',
      );
    }

    if (
      payment.direction !== PaymentDirection.DEBIT &&
      payment.direction !== PaymentDirection.CREDIT
    ) {
      return this.failed(
        'UNSUPPORTED_DIRECTION',
        'Payment direction is unsupported',
      );
    }

    if (!payment.externalReference?.trim()) {
      return this.failed(
        'MISSING_EXTERNAL_REFERENCE',
        'Payment external reference is required',
      );
    }

    if (!payment.merchant) {
      return this.failed(
        'MERCHANT_NOT_FOUND',
        'Payment merchant was not found',
      );
    }

    if (payment.merchant.status !== MerchantStatus.ACTIVE) {
      return this.failed(
        'MERCHANT_NOT_ACTIVE',
        'Payment merchant is not active',
      );
    }

    if (
      payment.direction === PaymentDirection.DEBIT &&
      !payment.merchant.allowAchDebit
    ) {
      return this.failed(
        'ACH_DEBIT_NOT_ALLOWED',
        'Merchant is not allowed to initiate ACH debits',
      );
    }

    if (
      payment.direction === PaymentDirection.CREDIT &&
      !payment.merchant.allowAchCredit
    ) {
      return this.failed(
        'ACH_CREDIT_NOT_ALLOWED',
        'Merchant is not allowed to initiate ACH credits',
      );
    }

    if (payment.amountCents > payment.merchant.perPaymentLimit) {
      return this.failed(
        'PER_PAYMENT_LIMIT_EXCEEDED',
        'Payment amount exceeds the merchant per-payment limit',
      );
    }

    if (!payment.receiverAccountRef.trim() || !payment.routingNumber.trim()) {
      return this.failed(
        'MISSING_ACCOUNT_REFERENCE',
        'Payment account reference is required',
      );
    }

    return {
      status: PaymentStatus.VALIDATED,
      code: null,
      message: null,
    };
  }

  private failed(code: string, message: string): ValidationResult {
    return {
      status: PaymentStatus.VALIDATION_FAILED,
      code,
      message,
    };
  }
}
