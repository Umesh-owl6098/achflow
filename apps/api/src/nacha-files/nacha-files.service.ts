import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PaymentDirection, PaymentStatus } from '@prisma/client';
import type { AuthenticatedMerchant } from '../auth/merchant-authentication.service';
import { PrismaService } from '../prisma/prisma.service';
import { ListNachaFilesQueryDto } from './dto/list-nacha-files-query.dto';

const field = (value: string, length: number, fill = ' ', right = false) =>
  right
    ? value.slice(-length).padStart(length, fill)
    : value.slice(0, length).padEnd(length, fill);
const cents = (value: bigint) => field(value.toString(), 10, '0', true);

@Injectable()
export class NachaFilesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListNachaFilesQueryDto, merchant: AuthenticatedMerchant) {
    return this.listForScope(query, merchant.id, {
      merchantCode: merchant.merchantCode,
      displayName: merchant.displayName,
    });
  }

  async listAdmin(query: ListNachaFilesQueryDto, merchantId?: string) {
    return this.listForScope(query, merchantId, null);
  }

  private async listForScope(
    query: ListNachaFilesQueryDto,
    merchantId: string | undefined,
    merchant: { merchantCode: string; displayName: string } | null,
  ) {
    const { start, end } = dateRange(query);
    const files = await this.prisma.achFile.findMany({
      where: {
        ...(merchantId ? { companyId: merchantId } : {}),
        ...(start && end ? { createdAt: { gte: start, lt: end } } : {}),
        ...(query.search?.trim()
          ? {
              OR: [
                { id: { contains: query.search.trim(), mode: 'insensitive' } },
                {
                  fileName: {
                    contains: query.search.trim(),
                    mode: 'insensitive',
                  },
                },
              ],
            }
          : {}),
      },
      include: {
        payments: {
          where: merchantId ? { merchantId } : {},
          orderBy: { id: 'asc' },
          select: {
            id: true,
            externalReference: true,
            direction: true,
            amountCents: true,
            currency: true,
            status: true,
            exportedAt: true,
            createdAt: true,
            receiverName: true,
            receiverAccountRef: true,
            routingNumber: true,
            merchant: { select: { merchantCode: true, displayName: true } },
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const data = files.map((file) => toFileRow(file));
    const filtered = query.status
      ? data.filter((file) => file.submissionStatus === query.status)
      : data;
    const today = startOfUtcDay(new Date());
    const summary = filtered.reduce(
      (totals, file) => ({
        paymentsExported: totals.paymentsExported + file.totalPayments,
        totalExportAmountCents:
          totals.totalExportAmountCents + BigInt(file.totalAmountCents),
        pendingSubmissionFiles:
          totals.pendingSubmissionFiles +
          (file.submissionStatus === 'PENDING' ? 1 : 0),
        filesGeneratedToday:
          totals.filesGeneratedToday +
          (file.createdAt >= today.toISOString() ? 1 : 0),
      }),
      {
        filesGeneratedToday: 0,
        paymentsExported: 0,
        totalExportAmountCents: BigInt(0),
        pendingSubmissionFiles: 0,
      },
    );
    return {
      merchant,
      data: filtered,
      summary: {
        filesGeneratedToday: summary.filesGeneratedToday,
        paymentsExported: summary.paymentsExported,
        totalExportAmountCents: summary.totalExportAmountCents.toString(),
        pendingSubmissionFiles: summary.pendingSubmissionFiles,
      },
    };
  }

  async download(fileId: string, merchant: AuthenticatedMerchant) {
    return this.downloadForScope(fileId, merchant.id);
  }

  async downloadAdmin(fileId: string) {
    return this.downloadForScope(fileId);
  }

  private async downloadForScope(fileId: string, merchantId?: string) {
    const file = await this.prisma.achFile.findFirst({
      where: { id: fileId, ...(merchantId ? { companyId: merchantId } : {}) },
      include: {
        payments: {
          where: merchantId ? { merchantId } : {},
          include: { merchant: true },
          orderBy: { id: 'asc' },
        },
      },
    });
    if (!file) throw new NotFoundException('NACHA file was not found.');
    if (!file.payments.length) {
      throw new NotFoundException('NACHA file payments were not found.');
    }
    return {
      fileName: file.fileName,
      contents: renderNacha(file.payments, file.effectiveEntryDate),
    };
  }
}

function toFileRow(file: {
  id: string;
  fileName: string;
  status: string;
  createdAt: Date;
  effectiveEntryDate: Date;
  entryHash: string;
  sha256: string;
  payments: Array<{
    id: string;
    externalReference: string | null;
    direction: PaymentDirection;
    amountCents: bigint;
    currency: string;
    status: PaymentStatus;
    exportedAt: Date | null;
    createdAt: Date;
    receiverName: string;
    receiverAccountRef: string;
    routingNumber: string;
    merchant: { merchantCode: string; displayName: string };
  }>;
}) {
  const debitPayments = file.payments.filter(
    (payment) => payment.direction === PaymentDirection.DEBIT,
  );
  const creditPayments = file.payments.filter(
    (payment) => payment.direction === PaymentDirection.CREDIT,
  );
  const debitTotal = debitPayments.reduce(
    (sum, payment) => sum + payment.amountCents,
    BigInt(0),
  );
  const creditTotal = creditPayments.reduce(
    (sum, payment) => sum + payment.amountCents,
    BigInt(0),
  );
  const totalAmount = debitTotal + creditTotal;
  const submissionStatus =
    file.status === 'FAILED'
      ? 'FAILED'
      : file.payments.some(
            (payment) => payment.status === PaymentStatus.VALIDATED,
          )
        ? 'PENDING'
        : 'SUBMITTED';
  return {
    id: file.id,
    fileName: file.fileName,
    createdAt: file.createdAt.toISOString(),
    effectiveEntryDate: file.effectiveEntryDate.toISOString(),
    submissionStatus,
    totalPayments: file.payments.length,
    totalAmountCents: totalAmount.toString(),
    debitCount: debitPayments.length,
    creditCount: creditPayments.length,
    debitTotalCents: debitTotal.toString(),
    creditTotalCents: creditTotal.toString(),
    entryHash: file.entryHash,
    sha256: file.sha256,
    exportedBy: 'ACHFlow worker',
    payments: file.payments.map((payment) => ({
      id: payment.id,
      externalReference: payment.externalReference,
      direction: payment.direction,
      amountCents: payment.amountCents.toString(),
      currency: payment.currency,
      status: payment.status,
      exportedAt: payment.exportedAt?.toISOString() ?? null,
      createdAt: payment.createdAt.toISOString(),
      merchant: payment.merchant,
    })),
  };
}

function renderNacha(
  payments: Array<{
    id: string;
    direction: PaymentDirection;
    amountCents: bigint;
    routingNumber: string;
    receiverAccountRef: string;
    receiverName: string;
    merchant: { legalName: string; merchantCode: string };
  }>,
  effectiveDate: Date,
): string {
  const day = startOfUtcDay(effectiveDate);
  const yymmdd = `${String(day.getUTCFullYear()).slice(-2)}${String(day.getUTCMonth() + 1).padStart(2, '0')}${String(day.getUTCDate()).padStart(2, '0')}`;
  const debit = payments
    .filter((payment) => payment.direction === PaymentDirection.DEBIT)
    .reduce((sum, payment) => sum + payment.amountCents, BigInt(0));
  const credit = payments
    .filter((payment) => payment.direction === PaymentDirection.CREDIT)
    .reduce((sum, payment) => sum + payment.amountCents, BigInt(0));
  const hash =
    payments.reduce(
      (sum, payment) => sum + BigInt(payment.routingNumber.slice(0, 8)),
      BigInt(0),
    ) % BigInt(10_000_000_000);
  const lines = [
    `101 123456789 987654321${yymmdd}0000A094101DESTINATION            ORIGIN                  `,
  ];
  for (const direction of [PaymentDirection.DEBIT, PaymentDirection.CREDIT]) {
    const group = payments.filter((payment) => payment.direction === direction);
    if (!group.length) continue;
    const company = group[0].merchant;
    lines.push(
      `5${field(direction === PaymentDirection.DEBIT ? '225' : '220', 3, '0', true)}${field(company.legalName, 16)}${field('', 20)}${field(company.merchantCode, 10)}PPD${field('', 10)}${yymmdd}${field('', 3)}1${field('12345678', 8, '0', true)}0000001`,
    );
    group.forEach((payment, index) =>
      lines.push(
        `6${field(direction === PaymentDirection.DEBIT ? '27' : '22', 2, '0', true)}${field(payment.routingNumber.slice(0, 8), 8, '0', true)}${payment.routingNumber[8] ?? '0'}${field(payment.receiverAccountRef, 17)}${cents(payment.amountCents)}${field('', 15)}${field(payment.receiverName, 22)} 0${field(String(index + 1), 15, '0', true)}`,
      ),
    );
    const groupHash =
      group.reduce(
        (sum, payment) => sum + BigInt(payment.routingNumber.slice(0, 8)),
        BigInt(0),
      ) % BigInt(10_000_000_000);
    const groupDebit = group
      .filter((payment) => payment.direction === PaymentDirection.DEBIT)
      .reduce((sum, payment) => sum + payment.amountCents, BigInt(0));
    const groupCredit = group
      .filter((payment) => payment.direction === PaymentDirection.CREDIT)
      .reduce((sum, payment) => sum + payment.amountCents, BigInt(0));
    lines.push(
      `8${field('200', 3, '0', true)}${field(String(group.length), 6, '0', true)}${field(groupHash.toString(), 10, '0', true)}${cents(groupDebit)}${cents(groupCredit)}${field(company.merchantCode, 10)}${field('', 19)}${field('', 6)}${field('12345678', 8, '0', true)}0000001`,
    );
  }
  const batchCount = lines.filter((line) => line.startsWith('5')).length;
  lines.push(
    `9${field(String(batchCount), 6, '0', true)}000000${field(String(payments.length), 8, '0', true)}${field(hash.toString(), 10, '0', true)}${cents(debit)}${cents(credit)}${field('', 39)}`,
  );
  while (lines.length % 10) lines.push('9'.repeat(94));
  lines[lines.findIndex((line) => line.startsWith('9'))] =
    `9${field(String(batchCount), 6, '0', true)}${field(String(lines.length / 10), 6, '0', true)}${field(String(payments.length), 8, '0', true)}${field(hash.toString(), 10, '0', true)}${cents(debit)}${cents(credit)}${field('', 39)}`;
  return lines.map((line) => field(line, 94)).join('\n');
}

function dateRange(query: ListNachaFilesQueryDto): {
  start?: Date;
  end?: Date;
} {
  const range = query.dateRange ?? 'all';
  if (range === 'all') return {};
  if (range === 'custom') {
    if (!query.startDate || !query.endDate) {
      throw new BadRequestException(
        'Custom date filtering requires both startDate and endDate.',
      );
    }
    const start = startOfUtcDay(new Date(query.startDate));
    const end = addUtcDays(startOfUtcDay(new Date(query.endDate)), 1);
    if (start >= end)
      throw new BadRequestException('The date range is invalid.');
    return { start, end };
  }
  const today = startOfUtcDay(new Date());
  return range === 'today'
    ? { start: today, end: addUtcDays(today, 1) }
    : {
        start: addUtcDays(today, range === '7d' ? -6 : -29),
        end: addUtcDays(today, 1),
      };
}

function startOfUtcDay(value: Date): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
  );
}

function addUtcDays(value: Date, days: number): Date {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}
