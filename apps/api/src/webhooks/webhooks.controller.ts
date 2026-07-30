import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentMerchant } from '../auth/current-merchant.decorator';
import type { AuthenticatedMerchant } from '../auth/merchant-authentication.service';
import { MerchantApiKeyGuard } from '../auth/merchant-api-key.guard';
import { PaymentRateLimitGuard } from '../rate-limit/payment-rate-limit.guard';
import { CreateWebhookEndpointDto } from './dto/create-webhook-endpoint.dto';
import { ListWebhookDeliveriesQueryDto } from './dto/list-webhook-deliveries-query.dto';
import { ListWebhooksQueryDto } from './dto/list-webhooks-query.dto';
import { UpdateWebhookEndpointDto } from './dto/update-webhook-endpoint.dto';
import { MerchantWebhookEndpointsService } from './merchant-webhook-endpoints.service';

@Controller('api/v1/webhooks')
@UseGuards(MerchantApiKeyGuard, PaymentRateLimitGuard)
export class WebhooksController {
  constructor(private readonly endpoints: MerchantWebhookEndpointsService) {}
  @Get() list(
    @Query() query: ListWebhooksQueryDto,
    @CurrentMerchant() merchant: AuthenticatedMerchant,
  ) {
    return this.endpoints.list(query, merchant);
  }
  @Post() create(
    @Body() dto: CreateWebhookEndpointDto,
    @CurrentMerchant() merchant: AuthenticatedMerchant,
  ) {
    return this.endpoints.create(merchant.id, dto.url, dto.signingSecret);
  }
  @Get('deliveries')
  listDeliveries(
    @Query() query: ListWebhookDeliveriesQueryDto,
    @CurrentMerchant() merchant: AuthenticatedMerchant,
  ) {
    return this.endpoints.listDeliveries(query, merchant);
  }
  @Patch(':endpointId') update(
    @Param('endpointId') endpointId: string,
    @Body() dto: UpdateWebhookEndpointDto,
    @CurrentMerchant() merchant: AuthenticatedMerchant,
  ) {
    return this.endpoints.update(endpointId, dto, merchant);
  }
  @Delete(':endpointId') remove(
    @Param('endpointId') endpointId: string,
    @CurrentMerchant() merchant: AuthenticatedMerchant,
  ) {
    return this.endpoints.remove(endpointId, merchant);
  }
  @Get(':endpointId/deliveries') deliveries(
    @Param('endpointId') endpointId: string,
    @Query() query: ListWebhookDeliveriesQueryDto,
    @CurrentMerchant() merchant: AuthenticatedMerchant,
  ) {
    return this.endpoints.deliveries(endpointId, query, merchant);
  }
  @Post(':endpointId/test') test(
    @Param('endpointId') endpointId: string,
    @CurrentMerchant() merchant: AuthenticatedMerchant,
  ) {
    return this.endpoints.enqueueTest(endpointId, merchant);
  }
}
