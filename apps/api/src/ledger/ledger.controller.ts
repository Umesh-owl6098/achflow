import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentMerchant } from '../auth/current-merchant.decorator';
import type { AuthenticatedMerchant } from '../auth/merchant-authentication.service';
import { MerchantApiKeyGuard } from '../auth/merchant-api-key.guard';
import { PaymentRateLimitGuard } from '../rate-limit/payment-rate-limit.guard';
import { ListLedgerQueryDto } from './dto/list-ledger-query.dto';
import { LedgerService } from './ledger.service';

@Controller('api/v1/ledger')
@UseGuards(MerchantApiKeyGuard, PaymentRateLimitGuard)
export class LedgerController {
  constructor(private readonly ledgerService: LedgerService) {}

  @Get()
  list(
    @Query() query: ListLedgerQueryDto,
    @CurrentMerchant() merchant: AuthenticatedMerchant,
  ) {
    return this.ledgerService.list(query, merchant);
  }
}
