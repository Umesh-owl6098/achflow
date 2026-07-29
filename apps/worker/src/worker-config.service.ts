import { Injectable } from '@nestjs/common';

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_CLAIM_LEASE_MS = 30_000;

@Injectable()
export class WorkerConfigService {
  readonly databaseUrl: string;
  readonly pollIntervalMs: number;
  readonly batchSize: number;
  readonly maxAttempts: number;
  readonly claimLeaseMs: number;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.databaseUrl = this.requireUrl(env.DATABASE_URL);
    this.pollIntervalMs = this.parsePositiveInteger(
      'OUTBOX_POLL_INTERVAL_MS',
      env.OUTBOX_POLL_INTERVAL_MS,
      DEFAULT_POLL_INTERVAL_MS,
    );
    this.batchSize = this.parsePositiveInteger(
      'OUTBOX_BATCH_SIZE',
      env.OUTBOX_BATCH_SIZE,
      DEFAULT_BATCH_SIZE,
    );
    this.maxAttempts = this.parsePositiveInteger(
      'OUTBOX_MAX_ATTEMPTS',
      env.OUTBOX_MAX_ATTEMPTS,
      DEFAULT_MAX_ATTEMPTS,
    );
    this.claimLeaseMs = this.parsePositiveInteger(
      'OUTBOX_CLAIM_LEASE_MS',
      env.OUTBOX_CLAIM_LEASE_MS,
      DEFAULT_CLAIM_LEASE_MS,
    );
  }

  private requireUrl(value: string | undefined): string {
    if (!value) {
      throw new Error('DATABASE_URL is required');
    }

    try {
      new URL(value);
    } catch {
      throw new Error('DATABASE_URL must be a valid URL');
    }

    return value;
  }

  private parsePositiveInteger(
    name: string,
    value: string | undefined,
    fallback: number,
  ): number {
    if (value === undefined) {
      return fallback;
    }

    const parsed = Number(value);

    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(`${name} must be a positive integer`);
    }

    return parsed;
  }
}
