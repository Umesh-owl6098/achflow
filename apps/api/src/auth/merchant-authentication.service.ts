import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

export type AuthenticatedMerchant = {
  id: string;
  merchantCode: string;
  displayName: string;
};

@Injectable()
export class MerchantAuthenticationService {
  private readonly hashSecret: string;

  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.hashSecret = configService.getOrThrow<string>(
      'MERCHANT_API_KEY_HASH_SECRET',
    );
  }

  hashApiKey(apiKey: string): string {
    return createHmac('sha256', this.hashSecret).update(apiKey).digest('hex');
  }

  async authenticate(apiKey: string): Promise<AuthenticatedMerchant> {
    const record = await this.prisma.merchantApiKey.findUnique({
      where: { hashedApiKey: this.hashApiKey(apiKey) },
      include: {
        merchant: {
          select: { id: true, merchantCode: true, displayName: true },
        },
      },
    });

    if (!record) {
      throw new UnauthorizedException('Invalid merchant API key.');
    }

    return record.merchant;
  }
}
