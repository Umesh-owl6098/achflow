import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  OutboxEventType,
  PaymentDirection,
  PaymentStatus,
} from '@prisma/client';
import { WorkerPrismaService } from '../worker-prisma.service';
import { paymentLifecycleOutboxEvent } from '../../../api/prisma/payment-lifecycle-event.factory';

const field = (value: string, length: number, fill = ' ', right = false) =>
  right
    ? value.slice(-length).padStart(length, fill)
    : value.slice(0, length).padEnd(length, fill);
const cents = (value: bigint) => field(value.toString(), 10, '0', true);
@Injectable()
export class NachaFileGeneratorService {
  constructor(private readonly prisma: WorkerPrismaService) {}
  async generate(effectiveDate = new Date()): Promise<{
    file: string;
    metadata: {
      id: string;
      totalEntries: number;
      debitTotalCents: bigint;
      creditTotalCents: bigint;
      entryHash: string;
    };
  } | null> {
    const day = new Date(
      Date.UTC(
        effectiveDate.getUTCFullYear(),
        effectiveDate.getUTCMonth(),
        effectiveDate.getUTCDate(),
      ),
    );
    return this.prisma.$transaction(async (tx) => {
      const payments = await tx.payment.findMany({
        where: {
          status: PaymentStatus.VALIDATED,
          exportedAt: null,
          direction: { in: [PaymentDirection.DEBIT, PaymentDirection.CREDIT] },
        },
        include: { merchant: true },
        orderBy: { id: 'asc' },
      });
      const eligible = payments.filter(
        (payment) => payment.direction === PaymentDirection.DEBIT || true,
      );
      if (!eligible.length) return null;
      const debit = eligible
        .filter((p) => p.direction === PaymentDirection.DEBIT)
        .reduce((sum, p) => sum + p.amountCents, BigInt(0));
      const credit = eligible
        .filter((p) => p.direction === PaymentDirection.CREDIT)
        .reduce((sum, p) => sum + p.amountCents, BigInt(0));
      const hash =
        eligible.reduce(
          (sum, p) => sum + BigInt(p.routingNumber.slice(0, 8)),
          BigInt(0),
        ) % BigInt(10_000_000_000);
      const yymmdd = `${String(day.getUTCFullYear()).slice(-2)}${String(day.getUTCMonth() + 1).padStart(2, '0')}${String(day.getUTCDate()).padStart(2, '0')}`;
      const fileName = `ach-${yymmdd}-${createHash('sha256')
        .update(eligible.map((p) => p.id).join('|'))
        .digest('hex')
        .slice(0, 12)}.ach`;
      const lines: string[] = [
        `101 123456789 987654321${yymmdd}0000A094101DESTINATION            ORIGIN                  `,
      ];
      for (const direction of [
        PaymentDirection.DEBIT,
        PaymentDirection.CREDIT,
      ]) {
        const group = eligible.filter((p) => p.direction === direction);
        if (!group.length) continue;
        const company = group[0].merchant;
        lines.push(
          `5${field(direction === PaymentDirection.DEBIT ? '225' : '220', 3, '0', true)}${field(company.legalName, 16)}${field('', 20)}${field(company.merchantCode, 10)}PPD${field('', 10)}${yymmdd}${field('', 3)}1${field('12345678', 8, '0', true)}0000001`,
        );
        group.forEach((p, i) =>
          lines.push(
            `6${field(direction === PaymentDirection.DEBIT ? '27' : '22', 2, '0', true)}${field(p.routingNumber.slice(0, 8), 8, '0', true)}${p.routingNumber[8] ?? '0'}${field(p.receiverAccountRef, 17)}${cents(p.amountCents)}${field('', 15)}${field(p.receiverName, 22)} 0${field(String(i + 1), 15, '0', true)}`,
          ),
        );
        const gh =
          group.reduce(
            (sum, p) => sum + BigInt(p.routingNumber.slice(0, 8)),
            BigInt(0),
          ) % BigInt(10_000_000_000);
        const gd = group
          .filter((p) => p.direction === PaymentDirection.DEBIT)
          .reduce((s, p) => s + p.amountCents, BigInt(0));
        const gc = group
          .filter((p) => p.direction === PaymentDirection.CREDIT)
          .reduce((s, p) => s + p.amountCents, BigInt(0));
        lines.push(
          `8${field('200', 3, '0', true)}${field(String(group.length), 6, '0', true)}${field(gh.toString(), 10, '0', true)}${cents(gd)}${cents(gc)}${field(company.merchantCode, 10)}${field('', 19)}${field('', 6)}${field('12345678', 8, '0', true)}0000001`,
        );
      }
      const batchCount = lines.filter((line) => line.startsWith('5')).length;
      lines.push(
        `9${field(String(batchCount), 6, '0', true)}000000${field(String(eligible.length), 8, '0', true)}${field(hash.toString(), 10, '0', true)}${cents(debit)}${cents(credit)}${field('', 39)}`,
      );
      while (lines.length % 10) lines.push('9'.repeat(94));
      lines[lines.findIndex((line) => line.startsWith('9'))] =
        `9${field(String(batchCount), 6, '0', true)}${field(String(lines.length / 10), 6, '0', true)}${field(String(eligible.length), 8, '0', true)}${field(hash.toString(), 10, '0', true)}${cents(debit)}${cents(credit)}${field('', 39)}`;
      const file = lines.map((line) => field(line, 94)).join('\n');
      const metadata = await tx.achFile.create({
        data: {
          fileName,
          companyId: eligible[0].merchantId,
          effectiveEntryDate: day,
          status: 'GENERATED',
          totalEntries: eligible.length,
          debitTotalCents: debit,
          creditTotalCents: credit,
          entryHash: hash.toString(),
          sha256: createHash('sha256').update(file).digest('hex'),
        },
      });
      const submittedAt = new Date();
      const submitted = await tx.payment.updateMany({
        where: {
          id: { in: eligible.map((p) => p.id) },
          status: PaymentStatus.VALIDATED,
          exportedAt: null,
        },
        data: {
          status: PaymentStatus.SUBMITTED,
          exportedAt: submittedAt,
          achFileId: metadata.id,
        },
      });
      if (submitted.count !== eligible.length) {
        throw new Error('Eligible payments changed during NACHA generation');
      }
      const submittedPayments = await tx.payment.findMany({
        where: { id: { in: eligible.map((payment) => payment.id) } },
      });
      for (const payment of submittedPayments) {
        await tx.outboxEvent.create({
          data: paymentLifecycleOutboxEvent(
            payment,
            OutboxEventType.PAYMENT_SUBMITTED,
            submittedAt,
          ),
        });
      }
      return { file, metadata };
    });
  }
}
