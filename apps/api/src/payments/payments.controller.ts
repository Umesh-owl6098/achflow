import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Headers,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentMerchant } from '../auth/current-merchant.decorator';
import { MerchantApiKeyGuard } from '../auth/merchant-api-key.guard';
import { PaymentRateLimitGuard } from '../rate-limit/payment-rate-limit.guard';
import type { AuthenticatedMerchant } from '../auth/merchant-authentication.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { ListPaymentsQueryDto } from './dto/list-payments-query.dto';
import { ReturnPaymentDto } from './dto/return-payment.dto';
import { PaymentsService } from './payments.service';

@Controller('api/v1/payments')
@UseGuards(MerchantApiKeyGuard, PaymentRateLimitGuard)
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post()
  async create(
    @Body() dto: CreatePaymentDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentMerchant() merchant: AuthenticatedMerchant,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { payment, created } = await this.paymentsService.create(
      dto,
      idempotencyKey,
      merchant,
    );

    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);

    return payment;
  }

  @Post(':paymentId/validate')
  validate(
    @Param('paymentId') paymentId: string,
    @CurrentMerchant() merchant: AuthenticatedMerchant,
  ) {
    return this.paymentsService.validate(paymentId, merchant);
  }

  @Post(':paymentId/reserve')
  reserve(
    @Param('paymentId') paymentId: string,
    @CurrentMerchant() merchant: AuthenticatedMerchant,
  ) {
    return this.paymentsService.reserve(paymentId, merchant);
  }

  @Post(':paymentId/settle')
  settle(
    @Param('paymentId') paymentId: string,
    @CurrentMerchant() merchant: AuthenticatedMerchant,
  ) {
    return this.paymentsService.settle(paymentId, merchant);
  }

  @Post(':paymentId/return')
  returnSettlement(
    @Param('paymentId') paymentId: string,
    @Body() dto: ReturnPaymentDto,
    @CurrentMerchant() merchant: AuthenticatedMerchant,
  ) {
    return this.paymentsService.returnSettlement(
      paymentId,
      dto.returnCode,
      merchant,
    );
  }

  @Get()
  list(
    @Query() query: ListPaymentsQueryDto,
    @CurrentMerchant() merchant: AuthenticatedMerchant,
  ) {
    return this.paymentsService.list(query, merchant);
  }

  @Get(':paymentId')
  findOne(
    @Param('paymentId') paymentId: string,
    @CurrentMerchant() merchant: AuthenticatedMerchant,
  ) {
    return this.paymentsService.details(paymentId, merchant);
  }
}
