import {
  BadRequestException,
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
import { PaymentsRepository, PaymentWithMerchant } from './payments.repository';
import { MerchantsRepository } from './merchants.repository';
import { PaymentEngineService } from './payment-engine.service';
import { AuthenticatedMerchant } from '../auth/merchant-authentication.service';
import { ListPaymentsQueryDto } from './dto/list-payments-query.dto';
import { ListAdminPaymentsQueryDto } from './dto/list-admin-payments-query.dto';
import { serializePaymentListItem } from './payment-list.mapper';
import { Prisma } from '@prisma/client';

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

  async create(
    dto: CreatePaymentDto,
    clientIdempotencyKey: string | undefined,
    authenticatedMerchant: AuthenticatedMerchant,
  ): Promise<CreatePaymentResult> {
    const idempotencyKey = clientIdempotencyKey?.trim();
    if (!idempotencyKey) {
      throw new BadRequestException('Idempotency-Key header is required.');
    }
    const merchant = await this.merchantsRepository.findByCode(
      dto.merchantCode,
    );
    if (!merchant) {
      throw new NotFoundException(
        `Merchant ${dto.merchantCode} was not found.`,
      );
    }
    if (merchant.id !== authenticatedMerchant.id) {
      throw new NotFoundException(
        `Merchant ${dto.merchantCode} was not found.`,
      );
    }
    const requestFingerprint = buildPaymentRequestFingerprint(dto, merchant.id);
    const data = mapCreatePaymentDtoToRecord(
      dto,
      requestFingerprint,
      merchant.id,
      `${merchant.id}:${idempotencyKey}`,
    );

    try {
      const payment =
        await this.paymentsRepository.createWithOutboxAndIdempotency(data, {
          merchantId: merchant.id,
          idempotencyKey,
          requestFingerprint,
        });

      return {
        payment: this.serializePaymentForIdempotency(payment, idempotencyKey),
        created: true,
      };
    } catch (error) {
      if (!this.paymentsRepository.isUniqueConstraintViolation(error)) {
        throw error;
      }

      return this.handleIdempotencyConflict(
        merchant.id,
        idempotencyKey,
        requestFingerprint,
      );
    }
  }

  async findOne(
    id: string,
    authenticatedMerchant: AuthenticatedMerchant,
  ): Promise<PaymentResponseDto> {
    const payment = await this.findOwnedPayment(id, authenticatedMerchant);

    const idempotencyRecord =
      await this.paymentsRepository.findIdempotencyRecordByPaymentId(
        payment.id,
      );
    return this.serializePaymentForIdempotency(
      payment,
      idempotencyRecord?.idempotencyKey,
    );
  }

  async list(
    query: ListPaymentsQueryDto,
    authenticatedMerchant: AuthenticatedMerchant,
  ) {
    return this.listForScope(query, authenticatedMerchant.id);
  }

  async listAdmin(query: ListAdminPaymentsQueryDto) {
    return this.listForScope(query, query.merchantId);
  }

  private async listForScope(query: ListPaymentsQueryDto, merchantId?: string) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? query.limit ?? 25;
    const { start, end } = paymentDateRange(query);
    const search = query.search?.trim();
    const where: Prisma.PaymentWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.direction ? { direction: query.direction } : {}),
      ...(start || end
        ? {
            createdAt: {
              ...(start ? { gte: start } : {}),
              ...(end ? { lt: end } : {}),
            },
          }
        : {}),
      ...(search
        ? {
            OR: [
              { id: { contains: search, mode: 'insensitive' } },
              { externalReference: { contains: search, mode: 'insensitive' } },
              { description: { contains: search, mode: 'insensitive' } },
              { receiverName: { contains: search, mode: 'insensitive' } },
              {
                merchant: {
                  is: {
                    OR: [
                      {
                        merchantCode: { contains: search, mode: 'insensitive' },
                      },
                      {
                        displayName: { contains: search, mode: 'insensitive' },
                      },
                    ],
                  },
                },
              },
            ],
          }
        : {}),
    };
    const sortBy = paymentSortBy(query.sortBy);
    const sortOrder = query.sortOrder ?? 'desc';
    const [payments, total] = merchantId
      ? await this.paymentsRepository.listForMerchant({
          merchantId,
          where,
          orderBy: { [sortBy]: sortOrder },
          skip: (page - 1) * pageSize,
          take: pageSize,
        })
      : await this.paymentsRepository.listForAdmin({
          where,
          orderBy: { [sortBy]: sortOrder },
          skip: (page - 1) * pageSize,
          take: pageSize,
        });

    return {
      data: payments.map(serializePaymentListItem),
      page,
      limit: pageSize,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async validate(id: string, authenticatedMerchant: AuthenticatedMerchant) {
    await this.findOwnedPayment(id, authenticatedMerchant);
    await this.paymentEngine.validate(id);
    return this.findOne(id, authenticatedMerchant);
  }

  async reserve(id: string, authenticatedMerchant: AuthenticatedMerchant) {
    await this.findOwnedPayment(id, authenticatedMerchant);
    return this.serializeReservation(await this.paymentEngine.reserve(id));
  }

  async settle(id: string, authenticatedMerchant: AuthenticatedMerchant) {
    await this.findOwnedPayment(id, authenticatedMerchant);
    const settlement = await this.paymentEngine.settle(id);
    return settlement
      ? this.serializeReservation(settlement)
      : this.findOne(id, authenticatedMerchant);
  }

  async returnSettlement(
    id: string,
    returnCode: string,
    authenticatedMerchant: AuthenticatedMerchant,
  ) {
    await this.findOwnedPayment(id, authenticatedMerchant);
    const returned = await this.paymentEngine.returnSettlement(id, returnCode);
    return returned
      ? this.serializeReservation(returned)
      : this.findOne(id, authenticatedMerchant);
  }

  async details(id: string, authenticatedMerchant: AuthenticatedMerchant) {
    await this.findOwnedPayment(id, authenticatedMerchant);
    return this.operationalDetails(id);
  }

  async detailsAdmin(id: string) {
    return this.operationalDetails(id);
  }

  private async operationalDetails(id: string) {
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
    merchantId: string,
    idempotencyKey: string,
    requestFingerprint: string,
  ): Promise<CreatePaymentResult> {
    const record = await findPaymentWithVisibilityRetry(() =>
      this.paymentsRepository.findIdempotencyRecord(merchantId, idempotencyKey),
    );

    if (!record) {
      throw new InternalServerErrorException(
        'Payment could not be read after a concurrent idempotency conflict.',
      );
    }

    if (record.requestFingerprint !== requestFingerprint) {
      throw new ConflictException(
        'Idempotency key reused with a different request payload.',
      );
    }

    return {
      payment: this.serializePaymentForIdempotency(
        record.payment,
        record.idempotencyKey,
      ),
      created: false,
    };
  }

  private serializePaymentForIdempotency(
    payment: PaymentWithMerchant,
    idempotencyKey?: string,
  ): PaymentResponseDto {
    return {
      ...serializePayment(payment),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };
  }

  private async findOwnedPayment(
    id: string,
    authenticatedMerchant: AuthenticatedMerchant,
  ): Promise<PaymentWithMerchant> {
    const payment = await this.paymentsRepository.findById(id);

    if (!payment || payment.merchantId !== authenticatedMerchant.id) {
      throw new NotFoundException(`Payment ${id} was not found.`);
    }

    return payment;
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

function paymentDateRange(query: ListPaymentsQueryDto): {
  start?: Date;
  end?: Date;
} {
  if (query.startDate || query.endDate) {
    const start = query.startDate
      ? startOfUtcDay(new Date(query.startDate))
      : undefined;
    const endDate = query.endDate
      ? startOfUtcDay(new Date(query.endDate))
      : undefined;
    if (start && endDate && start > endDate) {
      throw new BadRequestException('The date range is invalid.');
    }
    return { start, ...(endDate ? { end: addUtcDays(endDate, 1) } : {}) };
  }
  const dateRange = query.dateRange ?? '30d';
  if (dateRange === 'custom') {
    throw new BadRequestException(
      'Custom date filtering requires a startDate or endDate.',
    );
  }
  const today = startOfUtcDay(new Date());
  if (dateRange === 'today') return { start: today, end: addUtcDays(today, 1) };
  return {
    start: addUtcDays(today, dateRange === '7d' ? -6 : -29),
    end: addUtcDays(today, 1),
  };
}

function paymentSortBy(
  sortBy: ListPaymentsQueryDto['sortBy'],
): 'createdAt' | 'updatedAt' | 'amountCents' | 'status' {
  if (
    sortBy === 'updatedAt' ||
    sortBy === 'amountCents' ||
    sortBy === 'status'
  ) {
    return sortBy;
  }
  return 'createdAt';
}

function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function addUtcDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}
