import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MerchantStatus, PaymentStatus } from '@prisma/client';
import { randomBytes } from 'crypto';
import { MerchantAuthenticationService } from '../auth/merchant-authentication.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMerchantDto } from './dto/create-merchant.dto';

@Injectable()
export class AdminMerchantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly merchantAuth: MerchantAuthenticationService,
  ) {}
  async list() {
    const merchants = await this.prisma.merchant.findMany({
      include: {
        _count: { select: { payments: true, webhookEndpoints: true } },
        payments: { select: { amountCents: true, status: true } },
        fundingAccounts: { include: { reservations: true, entries: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return { data: merchants.map((m) => this.row(m)) };
  }
  async details(id: string) {
    const merchant = await this.prisma.merchant.findUnique({
      where: { id },
      include: {
        apiKey: { select: { id: true, createdAt: true } },
        _count: { select: { payments: true, webhookEndpoints: true } },
        payments: { orderBy: { createdAt: 'desc' }, take: 10 },
        webhookEndpoints: {
          select: { id: true, url: true, isActive: true, createdAt: true },
        },
        fundingAccounts: { include: { reservations: true, entries: true } },
      },
    });
    if (!merchant) throw new NotFoundException('Merchant was not found.');
    return this.detail(merchant);
  }
  async create(dto: CreateMerchantDto) {
    const apiKey = this.newKey();
    try {
      const merchant = await this.prisma.$transaction(async (tx) => {
        const created = await tx.merchant.create({
          data: {
            merchantCode: dto.merchantCode,
            legalName: dto.legalName,
            displayName: dto.displayName,
            status: dto.status,
            perPaymentLimit: BigInt(dto.perPaymentLimit),
            dailyAmountLimit: BigInt(dto.dailyAmountLimit),
            allowAchDebit: dto.allowAchDebit ?? false,
            allowAchCredit: dto.allowAchCredit ?? false,
          },
        });
        await tx.merchantApiKey.create({
          data: {
            merchantId: created.id,
            hashedApiKey: this.merchantAuth.hashApiKey(apiKey),
          },
        });
        return created;
      });
      this.audit('merchant.created', merchant.id);
      return {
        merchant: {
          id: merchant.id,
          merchantCode: merchant.merchantCode,
          displayName: merchant.displayName,
          status: merchant.status,
        },
        apiKey,
      };
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002')
        throw new ConflictException('Merchant code already exists.');
      throw error;
    }
  }
  async updateStatus(id: string, status: MerchantStatus) {
    const merchant = await this.prisma.merchant
      .update({ where: { id }, data: { status } })
      .catch(() => null);
    if (!merchant) throw new NotFoundException('Merchant was not found.');
    this.audit('merchant.status_updated', id, { status });
    return { id: merchant.id, status: merchant.status };
  }
  async rotate(id: string) {
    await this.ensure(id);
    const apiKey = this.newKey();
    await this.prisma.merchantApiKey.update({
      where: { merchantId: id },
      data: { hashedApiKey: this.merchantAuth.hashApiKey(apiKey) },
    });
    this.audit('merchant.api_key_rotated', id);
    return { merchantId: id, apiKey };
  }
  private async ensure(id: string) {
    const merchant = await this.prisma.merchant.findUnique({ where: { id } });
    if (!merchant) throw new NotFoundException('Merchant was not found.');
    return merchant;
  }
  private newKey() {
    return `achflow_mk_${randomBytes(24).toString('base64url')}`;
  }
  private audit(action: string, merchantId: string, metadata?: object) {
    console.log(
      JSON.stringify({ event: 'admin.audit', action, merchantId, ...metadata }),
    );
  }
  private row(m: any) {
    const volume = m.payments.reduce(
      (sum: bigint, p: { amountCents: bigint; status: PaymentStatus }) =>
        sum + (p.status === PaymentStatus.SETTLED ? p.amountCents : 0n),
      0n,
    );
    const reserved = m.fundingAccounts
      .flatMap((account: any) => account.reservations)
      .filter((reservation: any) => reservation.status === 'ACTIVE')
      .reduce((sum: bigint, reservation: any) => sum + reservation.amount, 0n);
    const posted = m.fundingAccounts
      .flatMap((account: any) => account.entries)
      .reduce(
        (sum: bigint, entry: any) =>
          sum +
          (entry.entryType === 'DEBIT_POSTED'
            ? -entry.amount
            : entry.entryType === 'INITIAL_CREDIT' ||
                entry.entryType === 'CREDIT_POSTED'
              ? entry.amount
              : 0n),
        0n,
      );
    return {
      id: m.id,
      merchantCode: m.merchantCode,
      displayName: m.displayName,
      status: m.status,
      createdAt: m.createdAt.toISOString(),
      paymentCount: m._count.payments,
      totalProcessedVolumeCents: volume.toString(),
      webhookEndpointCount: m._count.webhookEndpoints,
      postedBalanceCents: posted.toString(),
      reservedBalanceCents: reserved.toString(),
      availableBalanceCents: (posted - reserved).toString(),
    };
  }
  private detail(m: any) {
    const volume = m.payments.reduce(
      (sum: bigint, p: { amountCents: bigint; status: PaymentStatus }) =>
        sum + (p.status === PaymentStatus.SETTLED ? p.amountCents : 0n),
      0n,
    );
    const reserved = m.fundingAccounts
      .flatMap((a: any) => a.reservations)
      .filter((r: any) => r.status === 'ACTIVE')
      .reduce((sum: bigint, r: any) => sum + r.amount, 0n);
    const posted = m.fundingAccounts
      .flatMap((a: any) => a.entries)
      .reduce(
        (sum: bigint, e: any) =>
          sum +
          (e.entryType === 'DEBIT_POSTED'
            ? -e.amount
            : e.entryType === 'INITIAL_CREDIT' ||
                e.entryType === 'CREDIT_POSTED'
              ? e.amount
              : 0n),
        0n,
      );
    return {
      id: m.id,
      merchantCode: m.merchantCode,
      legalName: m.legalName,
      displayName: m.displayName,
      status: m.status,
      allowAchDebit: m.allowAchDebit,
      allowAchCredit: m.allowAchCredit,
      perPaymentLimit: m.perPaymentLimit.toString(),
      dailyAmountLimit: m.dailyAmountLimit.toString(),
      createdAt: m.createdAt.toISOString(),
      updatedAt: m.updatedAt.toISOString(),
      apiKey: m.apiKey
        ? { id: m.apiKey.id, createdAt: m.apiKey.createdAt.toISOString() }
        : null,
      funding: {
        accountCount: m.fundingAccounts.length,
        postedBalanceCents: posted.toString(),
        reservedBalanceCents: reserved.toString(),
        availableBalanceCents: (posted - reserved).toString(),
      },
      totalProcessedVolumeCents: volume.toString(),
      paymentStatusBreakdown: countStatuses(m.payments),
      recentPayments: m.payments.map((p: any) => ({
        ...p,
        amountCents: p.amountCents.toString(),
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
      })),
      webhookEndpoints: m.webhookEndpoints,
    };
  }
}
function countStatuses(payments: Array<{ status: PaymentStatus }>) {
  return payments.reduce<Record<string, number>>((counts, p) => {
    counts[p.status] = (counts[p.status] ?? 0) + 1;
    return counts;
  }, {});
}
