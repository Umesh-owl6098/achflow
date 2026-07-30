import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentMerchant } from '../auth/current-merchant.decorator';
import type { AuthenticatedMerchant } from '../auth/merchant-authentication.service';
import { MerchantApiKeyGuard } from '../auth/merchant-api-key.guard';
import { PaymentRateLimitGuard } from '../rate-limit/payment-rate-limit.guard';
import { DashboardService } from './dashboard.service';

@Controller('api/v1/dashboard')
@UseGuards(MerchantApiKeyGuard, PaymentRateLimitGuard)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get()
  getDashboard(@CurrentMerchant() merchant: AuthenticatedMerchant) {
    return this.dashboardService.getDashboard(merchant);
  }
}
