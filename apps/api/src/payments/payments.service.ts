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
import { MerchantsRepository } from './merchants.repository';
import { PaymentEngineService } from './payment-engine.service';

export type CreatePaymentResult = {
  payment: PaymentResponseDto;
  created: boolean;
};

@Injectable()
export class PaymentsService {
  constructor(
    private readonly paymentsRepository: PaymentsRepository,
    private readonly merchantsRepository: MerchantsRepository,
    private readonly paymentEngine: PaymentEngineService,
  ) {}

  async create(dto: CreatePaymentDto): Promise<CreatePaymentResult> {
    const merchant = await this.merchantsRepository.findByCode(
      dto.merchantCode,
    );
    if (!merchant) {
      throw new NotFoundException(
        `Merchant ${dto.merchantCode} was not found.`,
      );
    }
    const requestFingerprint = buildPaymentRequestFingerprint(dto, merchant.id);
    const data = mapCreatePaymentDtoToRecord(
      dto,
      requestFingerprint,
      merchant.id,
    );

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

  async validate(id: string) {
    await this.paymentEngine.validate(id);
    return this.findOne(id);
  }

  async reserve(id: string) {
    return this.serializeReservation(await this.paymentEngine.reserve(id));
  }

  async settle(id: string) {
    return this.serializeReservation(await this.paymentEngine.settle(id));
  }

  async returnSettlement(id: string, returnCode: string) {
    return this.serializeReservation(
      await this.paymentEngine.returnSettlement(id, returnCode),
    );
  }

  async details(id: string) {
    const details = await this.paymentEngine.details(id);
    const payment = serializePayment(details.payment);
    return {
      ...details,
      ...payment,
      payment,
      reservation: this.serializeReservation(details.reservation),
    };
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

  private serializeReservation(
    reservation: {
      id: string;
      paymentId: string;
      fundingAccountId: string;
      amount: bigint;
      status: string;
      createdAt: Date;
      releasedAt: Date | null;
      settledAt: Date | null;
      returnedAt: Date | null;
      returnCode: string | null;
    } | null,
  ) {
    if (!reservation) {
      return null;
    }

    return {
      ...reservation,
      amount: reservation.amount.toString(),
    };
  }
}
