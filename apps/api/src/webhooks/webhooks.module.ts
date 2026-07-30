import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { MerchantWebhookEndpointsService } from './merchant-webhook-endpoints.service';
import { WebhookSecretCryptoService } from './webhook-secret-crypto.service';
import { WebhooksController } from './webhooks.controller';
@Module({
  imports: [AuthModule, RateLimitModule],
  controllers: [WebhooksController],
  providers: [WebhookSecretCryptoService, MerchantWebhookEndpointsService],
  exports: [WebhookSecretCryptoService, MerchantWebhookEndpointsService],
})
export class WebhooksModule {}
