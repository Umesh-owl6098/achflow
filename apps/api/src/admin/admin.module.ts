import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PaymentsModule } from '../payments/payments.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { LedgerModule } from '../ledger/ledger.module';
import { NachaFilesModule } from '../nacha-files/nacha-files.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { AdminApiKeyGuard } from './admin-api-key.guard';
import { AdminMerchantsController } from './admin-merchants.controller';
import { AdminMerchantsService } from './admin-merchants.service';
import { AdminSystemController } from './admin-system.controller';
import { AdminSystemService } from './admin-system.service';
import { AdminSimulatorController } from './admin-simulator.controller';
import { AdminSimulatorService } from './admin-simulator.service';
import { AdminOperationsController } from './admin-operations.controller';
@Module({
  imports: [
    AuthModule,
    RateLimitModule,
    PaymentsModule,
    DashboardModule,
    LedgerModule,
    NachaFilesModule,
    WebhooksModule,
  ],
  controllers: [
    AdminMerchantsController,
    AdminSystemController,
    AdminSimulatorController,
    AdminOperationsController,
  ],
  providers: [
    AdminMerchantsService,
    AdminSystemService,
    AdminSimulatorService,
    AdminApiKeyGuard,
  ],
})
export class AdminModule {}
