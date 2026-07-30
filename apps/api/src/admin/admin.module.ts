import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PaymentsModule } from '../payments/payments.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { AdminApiKeyGuard } from './admin-api-key.guard';
import { AdminMerchantsController } from './admin-merchants.controller';
import { AdminMerchantsService } from './admin-merchants.service';
import { AdminSystemController } from './admin-system.controller';
import { AdminSystemService } from './admin-system.service';
import { AdminSimulatorController } from './admin-simulator.controller';
import { AdminSimulatorService } from './admin-simulator.service';
@Module({
  imports: [AuthModule, RateLimitModule, PaymentsModule],
  controllers: [
    AdminMerchantsController,
    AdminSystemController,
    AdminSimulatorController,
  ],
  providers: [
    AdminMerchantsService,
    AdminSystemService,
    AdminSimulatorService,
    AdminApiKeyGuard,
  ],
})
export class AdminModule {}
