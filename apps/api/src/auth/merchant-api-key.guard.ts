import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { MerchantAuthenticationService } from './merchant-authentication.service';

export type AuthenticatedRequest = Request & {
  merchant?: Awaited<ReturnType<MerchantAuthenticationService['authenticate']>>;
};

@Injectable()
export class MerchantApiKeyGuard implements CanActivate {
  constructor(private readonly authentication: MerchantAuthenticationService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    const match = authorization?.match(/^Bearer\s+(.+)$/i);
    const apiKey = match?.[1]?.trim();

    if (!apiKey) {
      throw new UnauthorizedException('Bearer merchant API key is required.');
    }

    request.merchant = await this.authentication.authenticate(apiKey);
    return true;
  }
}
