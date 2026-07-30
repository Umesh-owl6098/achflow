import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Response } from 'express';
import { AuthenticatedRequest } from '../auth/merchant-api-key.guard';
import { PaymentRateLimitService } from './payment-rate-limit.service';

@Injectable()
export class PaymentRateLimitGuard implements CanActivate {
  constructor(private readonly rateLimit: PaymentRateLimitService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const response = context.switchToHttp().getResponse<Response>();

    try {
      const result = await this.rateLimit.consume(request.merchant!.id);
      if (result.allowed) {
        return true;
      }

      response.setHeader('Retry-After', String(result.retryAfterSeconds));
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Payment API rate limit exceeded.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      throw new HttpException(
        {
          statusCode: HttpStatus.SERVICE_UNAVAILABLE,
          code: 'RATE_LIMIT_SERVICE_UNAVAILABLE',
          message: 'Payment API rate limit service is unavailable.',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }
}
