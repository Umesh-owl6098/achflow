import { Module } from '@nestjs/common';
import { MerchantApiKeyGuard } from './merchant-api-key.guard';
import { MerchantAuthenticationService } from './merchant-authentication.service';

@Module({
  providers: [MerchantAuthenticationService, MerchantApiKeyGuard],
  exports: [MerchantAuthenticationService, MerchantApiKeyGuard],
})
export class AuthModule {}
