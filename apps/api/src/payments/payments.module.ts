import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsRepository } from './payments.repository';
import { PaymentsService } from './payments.service';
import { MerchantsRepository } from './merchants.repository';
import { PaymentEngineService } from './payment-engine.service';
import { AuthModule } from '../auth/auth.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';

@Module({
  imports: [AuthModule, RateLimitModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    PaymentsRepository,
    MerchantsRepository,
    PaymentEngineService,
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
