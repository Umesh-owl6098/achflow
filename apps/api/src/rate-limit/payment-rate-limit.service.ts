import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisClientService } from './redis-client.service';

const incrementWithExpiry = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
  end
  return {count, redis.call('TTL', KEYS[1])}
`;

export type PaymentRateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

@Injectable()
export class PaymentRateLimitService {
  constructor(
    private readonly configService: ConfigService,
    private readonly redis: RedisClientService,
  ) {}

  async consume(merchantId: string): Promise<PaymentRateLimitResult> {
    const maxRequests = this.getPositiveInteger(
      'PAYMENT_API_RATE_LIMIT_MAX_REQUESTS',
      100,
    );
    const windowSeconds = this.getPositiveInteger(
      'PAYMENT_API_RATE_LIMIT_WINDOW_SECONDS',
      60,
    );
    const nowSeconds = Math.floor(Date.now() / 1000);
    const window = Math.floor(nowSeconds / windowSeconds);
    const expiresInSeconds = Math.max(
      1,
      windowSeconds - (nowSeconds % windowSeconds),
    );
    const namespace =
      this.configService.get<string>('PAYMENT_API_RATE_LIMIT_NAMESPACE') ??
      'achflow:payment-api';
    const key = `${namespace}:merchant:${merchantId}:window:${window}`;
    const result = (await this.redis.evaluate(incrementWithExpiry, key, [
      String(expiresInSeconds),
    ])) as [number, number];
    const count = Number(result[0]);
    const ttl = Number(result[1]);

    return {
      allowed: count <= maxRequests,
      retryAfterSeconds: Math.max(1, ttl),
    };
  }

  private getPositiveInteger(name: string, fallback: number): number {
    const value = this.configService.get<string>(name);
    if (value === undefined) {
      return fallback;
    }

    const parsed = Number.parseInt(value, 10);
    if (
      !Number.isSafeInteger(parsed) ||
      parsed <= 0 ||
      String(parsed) !== value
    ) {
      throw new Error(`${name} must be a positive integer.`);
    }

    return parsed;
  }
}
