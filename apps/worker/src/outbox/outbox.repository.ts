import { Injectable } from '@nestjs/common';
import { OutboxEvent, OutboxEventStatus, Prisma } from '@prisma/client';
import { WorkerPrismaService } from '../worker-prisma.service';

@Injectable()
export class OutboxRepository {
  constructor(private readonly prisma: WorkerPrismaService) {}

  claimPending(batchSize: number): Promise<OutboxEvent[]> {
    return this.prisma.$transaction((transaction) =>
      transaction.$queryRaw<OutboxEvent[]>(Prisma.sql`
        WITH claimable AS (
          SELECT "id"
          FROM "OutboxEvent"
          WHERE "status" = 'PENDING'::"OutboxEventStatus"
            AND "availableAt" <= NOW()
          ORDER BY "availableAt" ASC, "createdAt" ASC
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE "OutboxEvent" AS event
        SET
          "status" = 'PROCESSING'::"OutboxEventStatus",
          "attempts" = event."attempts" + 1,
          "claimedAt" = NOW(),
          "updatedAt" = NOW()
        FROM claimable
        WHERE event."id" = claimable."id"
        RETURNING event.*
      `),
    );
  }

  async recoverExpiredClaims(
    maxAttempts: number,
    claimLeaseMs: number,
  ): Promise<void> {
    const expiredBefore = new Date(Date.now() - claimLeaseMs);

    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "OutboxEvent"
      SET
        "status" = CASE
          WHEN "attempts" >= ${maxAttempts} THEN 'FAILED'::"OutboxEventStatus"
          ELSE 'PENDING'::"OutboxEventStatus"
        END,
        "availableAt" = CASE
          WHEN "attempts" >= ${maxAttempts} THEN "availableAt"
          ELSE NOW()
        END,
        "claimedAt" = NULL,
        "lastError" = 'Previous worker claim expired',
        "updatedAt" = NOW()
      WHERE "status" = 'PROCESSING'::"OutboxEventStatus"
        AND "claimedAt" IS NOT NULL
        AND "claimedAt" < ${expiredBefore}
    `);
  }

  markProcessed(id: string): Promise<void> {
    return this.updateClaimedEvent(id, {
      status: OutboxEventStatus.PROCESSED,
      processedAt: new Date(),
      claimedAt: null,
      lastError: null,
    });
  }

  markFailed(
    event: OutboxEvent,
    maxAttempts: number,
    lastError: string,
  ): Promise<void> {
    if (event.attempts >= maxAttempts) {
      return this.updateClaimedEvent(event.id, {
        status: OutboxEventStatus.FAILED,
        claimedAt: null,
        lastError,
      });
    }

    return this.updateClaimedEvent(event.id, {
      status: OutboxEventStatus.PENDING,
      availableAt: new Date(Date.now() + this.retryDelayMs(event.attempts)),
      claimedAt: null,
      lastError,
    });
  }

  private async updateClaimedEvent(
    id: string,
    data: Prisma.OutboxEventUpdateManyMutationInput,
  ): Promise<void> {
    await this.prisma.outboxEvent.updateMany({
      where: { id, status: OutboxEventStatus.PROCESSING },
      data,
    });
  }

  private retryDelayMs(attempts: number): number {
    return Math.min(1_000 * 2 ** Math.max(0, attempts - 1), 60_000);
  }
}
