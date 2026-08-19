import { Inject, Injectable, Optional } from '@nestjs/common';

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_CLAIM_LEASE_MS = 30_000;
const DEFAULT_NACHA_GENERATION_INTERVAL_MS = 300_000;
const DEFAULT_WEBHOOK_DELIVERY_POLL_INTERVAL_MS = 1_000;

@Injectable()
export class WorkerConfigService {
  readonly databaseUrl: string;
  readonly pollIntervalMs: number;
  readonly batchSize: number;
  readonly maxAttempts: number;
  readonly claimLeaseMs: number;
  readonly webhookMaxAttempts: number;
  readonly webhookInitialRetrySeconds: number;
  readonly webhookMaxRetrySeconds: number;
  readonly webhookRequestTimeoutMs: number;
  readonly webhookBatchSize: number;
  readonly webhookClaimTimeoutSeconds: number;
  readonly webhookWorkerId: string;
  readonly webhookDeliveryPollIntervalMs: number;
  readonly nachaGenerationEnabled: boolean;
  readonly nachaGenerationIntervalMs: number;

  constructor(
    @Optional()
    @Inject('WORKER_ENV')
    suppliedEnv?: NodeJS.ProcessEnv,
  ) {
    const env = suppliedEnv ?? process.env;
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
    this.webhookMaxAttempts = this.parsePositiveInteger(
      'WEBHOOK_MAX_ATTEMPTS',
      env.WEBHOOK_MAX_ATTEMPTS,
      5,
    );
    this.webhookInitialRetrySeconds = this.parsePositiveInteger(
      'WEBHOOK_INITIAL_RETRY_SECONDS',
      env.WEBHOOK_INITIAL_RETRY_SECONDS,
      1,
    );
    this.webhookMaxRetrySeconds = this.parsePositiveInteger(
      'WEBHOOK_MAX_RETRY_SECONDS',
      env.WEBHOOK_MAX_RETRY_SECONDS,
      60,
    );
    this.webhookRequestTimeoutMs = this.parsePositiveInteger(
      'WEBHOOK_REQUEST_TIMEOUT_MS',
      env.WEBHOOK_REQUEST_TIMEOUT_MS,
      5_000,
    );
    this.webhookBatchSize = this.parsePositiveInteger(
      'WEBHOOK_BATCH_SIZE',
      env.WEBHOOK_BATCH_SIZE,
      10,
    );
    this.webhookClaimTimeoutSeconds = this.parsePositiveInteger(
      'WEBHOOK_CLAIM_TIMEOUT_SECONDS',
      env.WEBHOOK_CLAIM_TIMEOUT_SECONDS,
      30,
    );
    this.webhookWorkerId =
      env.WEBHOOK_WORKER_ID?.trim() || 'achflow-webhook-worker';
    this.webhookDeliveryPollIntervalMs = this.parsePositiveInteger(
      'WEBHOOK_DELIVERY_POLL_INTERVAL_MS',
      env.WEBHOOK_DELIVERY_POLL_INTERVAL_MS,
      DEFAULT_WEBHOOK_DELIVERY_POLL_INTERVAL_MS,
    );
    this.nachaGenerationEnabled = env.NACHA_GENERATION_ENABLED === 'true';
    this.nachaGenerationIntervalMs = this.parsePositiveInteger(
      'NACHA_GENERATION_INTERVAL_MS',
      env.NACHA_GENERATION_INTERVAL_MS,
      DEFAULT_NACHA_GENERATION_INTERVAL_MS,
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
