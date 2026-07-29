import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsRepository } from './payments.repository';
import { PaymentsService } from './payments.service';
import { MerchantsRepository } from './merchants.repository';

@Module({
  controllers: [PaymentsController],
  providers: [PaymentsService, PaymentsRepository, MerchantsRepository],
})
export class PaymentsModule {}
