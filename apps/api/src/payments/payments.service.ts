import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { buildPaymentRequestFingerprint } from './payment-fingerprint.util';
import {
  mapCreatePaymentDtoToRecord,
  serializePayment,
} from './payment.mapper';
import { PaymentResponseDto } from './dto/payment-response.dto';
import { findPaymentWithVisibilityRetry } from './payment-visibility-retry.util';
import { PaymentsRepository } from './payments.repository';

export type CreatePaymentResult = {
  payment: PaymentResponseDto;
  created: boolean;
};

@Injectable()
export class PaymentsService {
  constructor(private readonly paymentsRepository: PaymentsRepository) {}

  async create(dto: CreatePaymentDto): Promise<CreatePaymentResult> {
    const requestFingerprint = buildPaymentRequestFingerprint(dto);
    const data = mapCreatePaymentDtoToRecord(dto, requestFingerprint);

    try {
      const payment = await this.paymentsRepository.createWithOutbox(data);

      return {
        payment: serializePayment(payment),
        created: true,
      };
    } catch (error) {
      if (!this.paymentsRepository.isUniqueConstraintViolation(error)) {
        throw error;
      }

      return this.handleIdempotencyConflict(
        dto.idempotencyKey,
        requestFingerprint,
      );
    }
  }

  async findOne(id: string): Promise<PaymentResponseDto> {
    const payment = await this.paymentsRepository.findById(id);

    if (!payment) {
      throw new NotFoundException(`Payment ${id} was not found.`);
    }

    return serializePayment(payment);
  }

  private async handleIdempotencyConflict(
    idempotencyKey: string,
    requestFingerprint: string,
  ): Promise<CreatePaymentResult> {
    const existingPayment = await findPaymentWithVisibilityRetry(() =>
      this.paymentsRepository.findByIdempotencyKey(idempotencyKey),
    );

    if (!existingPayment) {
      throw new InternalServerErrorException(
        'Payment could not be read after a concurrent idempotency conflict.',
      );
    }

    if (existingPayment.requestFingerprint !== requestFingerprint) {
      throw new ConflictException(
        'Idempotency key reused with a different request payload.',
      );
    }

    return {
      payment: serializePayment(existingPayment),
      created: false,
    };
  }
}
