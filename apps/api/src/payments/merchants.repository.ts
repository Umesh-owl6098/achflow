import { Injectable } from '@nestjs/common';
import { Merchant } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class MerchantsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByCode(merchantCode: string): Promise<Merchant | null> {
    return this.prisma.merchant.findUnique({ where: { merchantCode } });
  }
}
