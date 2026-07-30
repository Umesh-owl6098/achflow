import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { ReturnPaymentDto } from './dto/return-payment.dto';
import { PaymentsService } from './payments.service';

@Controller('api/v1/payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post()
  async create(
    @Body() dto: CreatePaymentDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { payment, created } = await this.paymentsService.create(dto);

    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);

    return payment;
  }

  @Post(':paymentId/validate')
  validate(@Param('paymentId') paymentId: string) {
    return this.paymentsService.validate(paymentId);
  }

  @Post(':paymentId/reserve')
  reserve(@Param('paymentId') paymentId: string) {
    return this.paymentsService.reserve(paymentId);
  }

  @Post(':paymentId/settle')
  settle(@Param('paymentId') paymentId: string) {
    return this.paymentsService.settle(paymentId);
  }

  @Post(':paymentId/return')
  returnSettlement(
    @Param('paymentId') paymentId: string,
    @Body() dto: ReturnPaymentDto,
  ) {
    return this.paymentsService.returnSettlement(paymentId, dto.returnCode);
  }

  @Get(':paymentId')
  findOne(@Param('paymentId') paymentId: string) {
    return this.paymentsService.details(paymentId);
  }
}
