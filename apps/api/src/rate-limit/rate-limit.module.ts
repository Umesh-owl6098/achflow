import { Module } from '@nestjs/common';
import { PaymentRateLimitGuard } from './payment-rate-limit.guard';
import { PaymentRateLimitService } from './payment-rate-limit.service';
import { RedisClientService } from './redis-client.service';

@Module({
  providers: [
    RedisClientService,
    PaymentRateLimitService,
    PaymentRateLimitGuard,
  ],
  exports: [PaymentRateLimitGuard, PaymentRateLimitService, RedisClientService],
})
export class RateLimitModule {}
