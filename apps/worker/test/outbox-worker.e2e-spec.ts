import {
  FundingAccountStatus,
  LedgerEntryType,
  MerchantStatus,
  OutboxEventStatus,
  OutboxEventType,
  PaymentDirection,
  PaymentStatus,
  Prisma,
  ReservationStatus,
} from '@prisma/client';
import { OutboxHandler } from '../src/outbox/outbox.handler';
import { OutboxProcessingError } from '../src/outbox/outbox-processing.error';
import { OutboxPollingService } from '../src/outbox/outbox-polling.service';
import { OutboxRepository } from '../src/outbox/outbox.repository';
import { PaymentLifecycleRepository } from '../src/payments/payment-lifecycle.repository';
import { PaymentValidationService } from '../src/payments/payment-validation.service';
import { WorkerConfigService } from '../src/worker-config.service';
import { WorkerPrismaService } from '../src/worker-prisma.service';
import { WebhookDeliveryMaterializerService } from '../src/webhooks/webhook-delivery-materializer.service';
import { WebhookDeliveryProcessorService } from '../src/webhooks/webhook-delivery-processor.service';
import { MerchantWebhookEndpointsService } from '../../api/src/webhooks/merchant-webhook-endpoints.service';
import { WebhookSecretCryptoService } from '../../api/src/webhooks/webhook-secret-crypto.service';
import { createHash, createHmac } from 'crypto';
import { createServer } from 'http';
import { NachaFileGeneratorService } from '../src/ach/nacha-file-generator.service';
import { NachaGenerationSchedulerService } from '../src/ach/nacha-generation-scheduler.service';

function paymentPayload(paymentId: string) {
  return {
    paymentId,
    merchantId: 'merchant-1',
    paymentStatus: PaymentStatus.RECEIVED,
    direction: PaymentDirection.DEBIT,
    amountCents: '2500',
    currency: 'USD',
    occurredAt: '2026-07-29T12:00:00.000Z',
  };
}

describe('Outbox worker (integration)', () => {
  let prismaOne: WorkerPrismaService;
  let prismaTwo: WorkerPrismaService;
  let workerOne: OutboxPollingService;
  let workerTwo: OutboxPollingService;
  let repositoryOne: OutboxRepository;
  let repositoryTwo: OutboxRepository;

  beforeAll(async () => {
    const config = new WorkerConfigService({
      ...process.env,
      OUTBOX_BATCH_SIZE: '2',
      OUTBOX_MAX_ATTEMPTS: '3',
      OUTBOX_CLAIM_LEASE_MS: '30000',
    });
    prismaOne = new WorkerPrismaService(config);
    prismaTwo = new WorkerPrismaService(config);
    await Promise.all([prismaOne.onModuleInit(), prismaTwo.onModuleInit()]);

    repositoryOne = new OutboxRepository(prismaOne);
    repositoryTwo = new OutboxRepository(prismaTwo);
    workerOne = new OutboxPollingService(
      repositoryOne,
      new OutboxHandler(
        new PaymentValidationService(new PaymentLifecycleRepository(prismaOne)),
      ),
      config,
    );
    workerTwo = new OutboxPollingService(
      repositoryTwo,
      new OutboxHandler(
        new PaymentValidationService(new PaymentLifecycleRepository(prismaTwo)),
      ),
      config,
    );
  });

  beforeEach(async () => {
    await prismaOne.$transaction(async (transaction) => {
      await transaction.webhookDelivery.deleteMany();
      await transaction.outboxEvent.deleteMany();
      await transaction.processedBankEvent.deleteMany();
      await transaction.reservation.deleteMany();
      await transaction.ledgerEntry.deleteMany();
      await transaction.merchantDailyUsage.deleteMany();
      await transaction.paymentIdempotencyRecord.deleteMany();
      await transaction.payment.deleteMany();
      await transaction.achFile.deleteMany();
      await transaction.fundingAccount.deleteMany();
      await transaction.merchantApiKey.deleteMany();
      await transaction.merchantWebhookEndpoint.deleteMany();
      await transaction.merchant.deleteMany();
      await transaction.merchant.create({
        data: {
          id: 'merchant-1',
          merchantCode: 'WORKER_TEST',
          legalName: 'Worker Test LLC',
          displayName: 'Worker Test',
          status: MerchantStatus.ACTIVE,
          allowAchDebit: true,
          allowAchCredit: true,
          perPaymentLimit: BigInt(10000),
          dailyAmountLimit: BigInt(100000),
        },
      });
      const fundingAccount = await transaction.fundingAccount.create({
        data: {
          id: 'funding-account-1',
          merchantId: 'merchant-1',
          currency: 'USD',
        },
      });
      await transaction.ledgerEntry.create({
        data: {
          entryKey: 'initial-credit:merchant-1',
          fundingAccountId: fundingAccount.id,
          entryType: 'INITIAL_CREDIT',
          amount: BigInt(100_000),
        },
      });
    });
  });

  afterAll(async () => {
    await Promise.all([
      prismaOne.onModuleDestroy(),
      prismaTwo.onModuleDestroy(),
    ]);
  });

  it('rejects a second funding account for the same merchant and currency', async () => {
    let error: unknown;

    try {
      await prismaOne.fundingAccount.create({
        data: {
          id: 'funding-account-duplicate-usd',
          merchantId: 'merchant-1',
          currency: 'USD',
          status: FundingAccountStatus.ACTIVE,
        },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    const prismaError = error as Prisma.PrismaClientKnownRequestError;
    expect(prismaError.code).toBe('P2002');
    expect(prismaError.meta?.target).toBeUndefined();

    const accounts = await prismaOne.fundingAccount.findMany({
      where: { merchantId: 'merchant-1', currency: 'USD' },
    });
    const initialCredit = await prismaOne.ledgerEntry.findUniqueOrThrow({
      where: { entryKey: 'initial-credit:merchant-1' },
    });
    expect(accounts).toEqual([
      expect.objectContaining({
        id: 'funding-account-1',
        status: FundingAccountStatus.ACTIVE,
        currency: 'USD',
      }),
    ]);
    expect(initialCredit).toMatchObject({
      fundingAccountId: 'funding-account-1',
      amount: BigInt(100_000),
    });
    expect(await prismaOne.reservation.count()).toBe(0);
    expect(await prismaOne.ledgerEntry.count()).toBe(1);
  });

  it('processes multiple events once across concurrent worker instances', async () => {
    await prismaOne.payment.createMany({
      data: Array.from({ length: 3 }, (_, index) => ({
        id: `pay-${index}`,
        idempotencyKey: `idem-${index}`,
        requestFingerprint: `fingerprint-${index}`,
        externalReference: `reference-${index}`,
        direction: PaymentDirection.DEBIT,
        amountCents: BigInt(2500),
        currency: 'USD',
        merchantId: 'merchant-1',
        receiverName: 'Receiver Inc',
        receiverAccountRef: `account-${index}`,
        routingNumber: '021000021',
      })),
    });
    await prismaOne.outboxEvent.createMany({
      data: Array.from({ length: 3 }, (_, index) => ({
        eventType: OutboxEventType.PAYMENT_RECEIVED,
        aggregateType: 'PAYMENT',
        aggregateId: `pay-${index}`,
        payload: {
          paymentId: `pay-${index}`,
          merchantId: 'merchant-1',
          paymentStatus: PaymentStatus.RECEIVED,
          direction: PaymentDirection.DEBIT,
          amountCents: '2500',
          currency: 'USD',
          occurredAt: '2026-07-29T12:00:00.000Z',
        },
        availableAt: new Date(0),
      })),
    });

    await Promise.all([workerOne.processOnce(), workerTwo.processOnce()]);

    const events = await prismaOne.outboxEvent.findMany({
      where: { eventType: OutboxEventType.PAYMENT_RECEIVED },
      orderBy: { aggregateId: 'asc' },
    });

    expect(events).toHaveLength(3);
    expect(
      events.every((event) => event.status === OutboxEventStatus.PROCESSED),
    ).toBe(true);
    expect(events.every((event) => event.attempts === 1)).toBe(true);
    expect(events.every((event) => event.processedAt instanceof Date)).toBe(
      true,
    );
    expect(events.every((event) => event.claimedAt === null)).toBe(true);
    expect(events.every((event) => event.lastError === null)).toBe(true);

    const payments = await prismaOne.payment.findMany();
    expect(
      payments.every((payment) => payment.status === PaymentStatus.VALIDATED),
    ).toBe(true);
  });

  it('processes validation failures without retrying and handles duplicate events idempotently', async () => {
    await prismaOne.payment.createMany({
      data: [
        {
          id: 'valid-payment',
          idempotencyKey: 'valid-idem',
          requestFingerprint: 'valid-fingerprint',
          externalReference: 'valid-reference',
          direction: PaymentDirection.CREDIT,
          amountCents: BigInt(2500),
          currency: 'USD',
          merchantId: 'merchant-1',
          receiverName: 'Receiver Inc',
          receiverAccountRef: 'valid-account',
          routingNumber: '021000021',
        },
        {
          id: 'invalid-payment',
          idempotencyKey: 'invalid-idem',
          requestFingerprint: 'invalid-fingerprint',
          externalReference: 'invalid-reference',
          direction: PaymentDirection.DEBIT,
          amountCents: BigInt(0),
          currency: 'USD',
          merchantId: 'merchant-1',
          receiverName: 'Receiver Inc',
          receiverAccountRef: 'invalid-account',
          routingNumber: '021000021',
        },
      ],
    });
    await prismaOne.outboxEvent.createMany({
      data: ['valid-payment', 'invalid-payment'].map((paymentId) => ({
        eventType: OutboxEventType.PAYMENT_RECEIVED,
        aggregateType: 'PAYMENT',
        aggregateId: paymentId,
        payload: paymentPayload(paymentId),
        availableAt: new Date(0),
      })),
    });

    await workerOne.processOnce();

    const valid = await prismaOne.payment.findUniqueOrThrow({
      where: { id: 'valid-payment' },
    });
    const invalid = await prismaOne.payment.findUniqueOrThrow({
      where: { id: 'invalid-payment' },
    });
    expect(valid.status).toBe(PaymentStatus.VALIDATED);
    expect(invalid).toMatchObject({
      status: PaymentStatus.VALIDATION_FAILED,
      validationCode: 'INVALID_AMOUNT',
      validationMessage: 'Payment amount must be greater than zero',
    });
    expect(
      await prismaOne.outboxEvent.count({
        where: { status: OutboxEventStatus.PROCESSED },
      }),
    ).toBe(2);

    const validatedAt = valid.validatedAt;
    await prismaOne.outboxEvent.create({
      data: {
        eventType: OutboxEventType.PAYMENT_RECEIVED,
        aggregateType: 'PAYMENT',
        aggregateId: valid.id,
        payload: paymentPayload(valid.id),
        availableAt: new Date(Date.now() - 1_000),
      },
    });

    await workerTwo.processOnce();

    const replayed = await prismaOne.payment.findUniqueOrThrow({
      where: { id: valid.id },
    });
    expect(replayed.status).toBe(PaymentStatus.VALIDATED);
    expect(replayed.validatedAt).toEqual(validatedAt);
    expect(
      await prismaOne.outboxEvent.count({
        where: { status: OutboxEventStatus.PROCESSED },
      }),
    ).toBe(4);
    expect(await prismaOne.outboxEvent.count({ where: { attempts: 1 } })).toBe(
      4,
    );
  });

  it('processes merchant business-rule failures without retrying', async () => {
    await prismaOne.merchant.createMany({
      data: [
        {
          id: 'merchant-suspended',
          merchantCode: 'SUSPENDED',
          legalName: 'Suspended Test LLC',
          displayName: 'Suspended Test',
          status: MerchantStatus.SUSPENDED,
          allowAchDebit: true,
          allowAchCredit: true,
          perPaymentLimit: BigInt(10000),
          dailyAmountLimit: BigInt(100000),
        },
        {
          id: 'merchant-credit-only',
          merchantCode: 'CREDIT_ONLY',
          legalName: 'Credit Test LLC',
          displayName: 'Credit Test',
          status: MerchantStatus.ACTIVE,
          allowAchDebit: false,
          allowAchCredit: true,
          perPaymentLimit: BigInt(10000),
          dailyAmountLimit: BigInt(100000),
        },
        {
          id: 'merchant-limited',
          merchantCode: 'LIMITED',
          legalName: 'Limited Test LLC',
          displayName: 'Limited Test',
          status: MerchantStatus.ACTIVE,
          allowAchDebit: true,
          allowAchCredit: true,
          perPaymentLimit: BigInt(1000),
          dailyAmountLimit: BigInt(100000),
        },
      ],
    });
    const rows = [
      ['merchant-suspended', 'merchant-suspended-payment', BigInt(500)],
      ['merchant-credit-only', 'merchant-debit-payment', BigInt(500)],
      ['merchant-limited', 'merchant-limit-payment', BigInt(1001)],
    ] as const;
    await prismaOne.payment.createMany({
      data: rows.map(([merchantId, id, amountCents]) => ({
        id,
        merchantId,
        idempotencyKey: `${id}-idem`,
        requestFingerprint: `${id}-fingerprint`,
        externalReference: `${id}-reference`,
        direction: PaymentDirection.DEBIT,
        amountCents,
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: `${id}-account`,
        routingNumber: '021000021',
      })),
    });
    await prismaOne.outboxEvent.createMany({
      data: rows.map(([, id]) => ({
        eventType: OutboxEventType.PAYMENT_RECEIVED,
        aggregateType: 'PAYMENT',
        aggregateId: id,
        payload: paymentPayload(id),
        availableAt: new Date(0),
      })),
    });
    await workerOne.processOnce();
    await workerOne.processOnce();
    const payments = await prismaOne.payment.findMany({
      where: { id: { in: rows.map(([, id]) => id) } },
      orderBy: { id: 'asc' },
    });
    expect(payments.map((payment) => payment.validationCode).sort()).toEqual([
      'ACH_DEBIT_NOT_ALLOWED',
      'MERCHANT_NOT_ACTIVE',
      'PER_PAYMENT_LIMIT_EXCEEDED',
    ]);
    expect(
      await prismaOne.outboxEvent.count({
        where: { status: OutboxEventStatus.PROCESSED },
      }),
    ).toBe(4);
    expect(await prismaOne.outboxEvent.count({ where: { attempts: 1 } })).toBe(
      4,
    );
  });

  it('marks an unfunded ACH CREDIT as terminal without reserving funds', async () => {
    await prismaOne.merchant.update({
      where: { id: 'merchant-1' },
      data: {
        perPaymentLimit: BigInt(20_000),
        dailyAmountLimit: BigInt(20_000),
      },
    });
    await prismaOne.ledgerEntry.update({
      where: { entryKey: 'initial-credit:merchant-1' },
      data: { amount: BigInt(10_000) },
    });
    await prismaOne.payment.create({
      data: {
        id: 'insufficient-credit',
        merchantId: 'merchant-1',
        idempotencyKey: 'insufficient-credit-idem',
        requestFingerprint: 'insufficient-credit-fingerprint',
        externalReference: 'insufficient-credit-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(10_001),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'insufficient-credit-account',
        routingNumber: '021000021',
      },
    });
    await prismaOne.outboxEvent.create({
      data: {
        eventType: OutboxEventType.PAYMENT_RECEIVED,
        aggregateType: 'PAYMENT',
        aggregateId: 'insufficient-credit',
        payload: {
          ...paymentPayload('insufficient-credit'),
          direction: PaymentDirection.CREDIT,
          amountCents: '10001',
        },
        availableAt: new Date(0),
      },
    });

    await workerOne.processOnce();

    const payment = await prismaOne.payment.findUniqueOrThrow({
      where: { id: 'insufficient-credit' },
    });
    const event = await prismaOne.outboxEvent.findFirstOrThrow({
      where: {
        aggregateId: payment.id,
        eventType: OutboxEventType.PAYMENT_RECEIVED,
      },
    });
    expect(payment).toMatchObject({
      status: PaymentStatus.VALIDATION_FAILED,
      failureCode: 'INSUFFICIENT_FUNDS',
      validationCode: 'INSUFFICIENT_FUNDS',
    });
    expect(payment.failureReason).toContain(
      'Available 10000, requested 10001, currency USD',
    );
    expect(event).toMatchObject({
      status: OutboxEventStatus.PROCESSED,
      lastError: null,
    });
    expect(
      await prismaOne.reservation.count({ where: { paymentId: payment.id } }),
    ).toBe(0);
    expect(
      await prismaOne.ledgerEntry.count({
        where: { paymentId: payment.id, entryType: 'RESERVATION' },
      }),
    ).toBe(0);
    expect(
      await prismaOne.merchantDailyUsage.count({
        where: { merchantId: 'merchant-1' },
      }),
    ).toBe(0);
  });

  it('validates an ACH CREDIT equal to the exact available funding balance', async () => {
    await prismaOne.merchant.update({
      where: { id: 'merchant-1' },
      data: {
        perPaymentLimit: BigInt(10_000),
        dailyAmountLimit: BigInt(10_000),
      },
    });
    await prismaOne.ledgerEntry.update({
      where: { entryKey: 'initial-credit:merchant-1' },
      data: { amount: BigInt(10_000) },
    });
    await prismaOne.payment.create({
      data: {
        id: 'exact-credit',
        merchantId: 'merchant-1',
        idempotencyKey: 'exact-credit-idem',
        requestFingerprint: 'exact-credit-fingerprint',
        externalReference: 'exact-credit-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(10_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'exact-credit-account',
        routingNumber: '021000021',
      },
    });
    await prismaOne.outboxEvent.create({
      data: {
        eventType: OutboxEventType.PAYMENT_RECEIVED,
        aggregateType: 'PAYMENT',
        aggregateId: 'exact-credit',
        payload: {
          ...paymentPayload('exact-credit'),
          direction: PaymentDirection.CREDIT,
          amountCents: '10000',
        },
        availableAt: new Date(0),
      },
    });

    await workerOne.processOnce();

    const payment = await prismaOne.payment.findUniqueOrThrow({
      where: { id: 'exact-credit' },
    });
    const event = await prismaOne.outboxEvent.findFirstOrThrow({
      where: {
        aggregateId: payment.id,
        eventType: OutboxEventType.PAYMENT_RECEIVED,
      },
    });
    const reservation = await prismaOne.reservation.findUniqueOrThrow({
      where: { paymentId: payment.id },
    });
    const entry = await prismaOne.ledgerEntry.findUniqueOrThrow({
      where: { entryKey: `reservation:${payment.id}` },
    });
    const usage = await prismaOne.merchantDailyUsage.findFirstOrThrow({
      where: { merchantId: 'merchant-1' },
    });
    const posted = await prismaOne.ledgerEntry.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        entryType: 'INITIAL_CREDIT',
      },
      _sum: { amount: true },
    });
    const reserved = await prismaOne.reservation.aggregate({
      where: { fundingAccountId: 'funding-account-1', status: 'ACTIVE' },
      _sum: { amount: true },
    });
    const postedBalance = BigInt(posted._sum.amount ?? 0);
    const activeReservedAmount = BigInt(reserved._sum.amount ?? 0);
    expect(payment.status).toBe(PaymentStatus.VALIDATED);
    expect(payment.validatedAt).toBeInstanceOf(Date);
    expect(event).toMatchObject({
      status: OutboxEventStatus.PROCESSED,
      lastError: null,
    });
    expect(reservation).toMatchObject({
      status: 'ACTIVE',
      amount: BigInt(10_000),
    });
    expect(entry).toMatchObject({
      entryType: 'RESERVATION',
      amount: BigInt(10_000),
      entryKey: 'reservation:exact-credit',
    });
    expect(usage.utilizedAmount).toBe(BigInt(10_000));
    expect(postedBalance).toBe(BigInt(10_000));
    expect(activeReservedAmount).toBe(BigInt(10_000));
    expect(postedBalance - activeReservedAmount).toBe(BigInt(0));
  });

  it('serializes concurrent ACH CREDIT reservations without overspending', async () => {
    await prismaOne.merchant.update({
      where: { id: 'merchant-1' },
      data: {
        perPaymentLimit: BigInt(20_000),
        dailyAmountLimit: BigInt(20_000),
      },
    });
    await prismaOne.ledgerEntry.update({
      where: { entryKey: 'initial-credit:merchant-1' },
      data: { amount: BigInt(10_000) },
    });
    const rows = [
      ['credit-a', BigInt(7_000)],
      ['credit-b', BigInt(5_000)],
    ] as const;
    await prismaOne.payment.createMany({
      data: rows.map(([id, amountCents]) => ({
        id,
        merchantId: 'merchant-1',
        idempotencyKey: `${id}-idem`,
        requestFingerprint: `${id}-fingerprint`,
        externalReference: `${id}-reference`,
        direction: PaymentDirection.CREDIT,
        amountCents,
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: `${id}-account`,
        routingNumber: '021000021',
      })),
    });
    await prismaOne.outboxEvent.createMany({
      data: rows.map(([id, amountCents]) => ({
        eventType: OutboxEventType.PAYMENT_RECEIVED,
        aggregateType: 'PAYMENT',
        aggregateId: id,
        payload: {
          ...paymentPayload(id),
          direction: PaymentDirection.CREDIT,
          amountCents: amountCents.toString(),
        },
        availableAt: new Date(0),
      })),
    });

    await Promise.all([workerOne.processOnce(), workerTwo.processOnce()]);

    const payments = await prismaOne.payment.findMany({
      where: { id: { in: rows.map(([id]) => id) } },
    });
    expect(
      payments.filter((payment) => payment.status === PaymentStatus.VALIDATED),
    ).toHaveLength(1);
    expect(
      payments.filter(
        (payment) => payment.status === PaymentStatus.VALIDATION_FAILED,
      ),
    ).toHaveLength(1);
    const winner = payments.find(
      (payment) => payment.status === PaymentStatus.VALIDATED,
    )!;
    const loser = payments.find(
      (payment) => payment.status === PaymentStatus.VALIDATION_FAILED,
    )!;
    const reservations = await prismaOne.reservation.findMany({
      where: { fundingAccountId: 'funding-account-1', status: 'ACTIVE' },
    });
    const entries = await prismaOne.ledgerEntry.findMany({
      where: {
        fundingAccountId: 'funding-account-1',
        entryType: 'RESERVATION',
      },
    });
    const usage = await prismaOne.merchantDailyUsage.findFirstOrThrow({
      where: { merchantId: 'merchant-1' },
    });
    const events = await prismaOne.outboxEvent.findMany({
      where: {
        aggregateId: { in: rows.map(([id]) => id) },
        eventType: OutboxEventType.PAYMENT_RECEIVED,
      },
    });
    const activeReservedAmount = reservations.reduce(
      (total, reservation) => total + reservation.amount,
      BigInt(0),
    );
    expect(winner).toBeDefined();
    expect(loser).toMatchObject({
      failureCode: 'INSUFFICIENT_FUNDS',
      validationCode: 'INSUFFICIENT_FUNDS',
    });
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({
      paymentId: winner.id,
      amount: winner.amountCents,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].paymentId).toBe(winner.id);
    expect(
      await prismaOne.reservation.count({ where: { paymentId: loser.id } }),
    ).toBe(0);
    expect(
      await prismaOne.ledgerEntry.count({
        where: { paymentId: loser.id, entryType: 'RESERVATION' },
      }),
    ).toBe(0);
    expect(usage.utilizedAmount).toBe(winner.amountCents);
    expect(activeReservedAmount).toBe(winner.amountCents);
    expect(activeReservedAmount).toBeLessThanOrEqual(BigInt(10_000));
    expect(BigInt(10_000) - activeReservedAmount).toBeGreaterThanOrEqual(
      BigInt(0),
    );
    expect(events).toHaveLength(2);
    expect(
      events.every(
        (event) =>
          event.status === OutboxEventStatus.PROCESSED &&
          event.lastError === null,
      ),
    ).toBe(true);
  });

  it('allows concurrent ACH CREDIT reservations when both fit', async () => {
    await prismaOne.merchant.update({
      where: { id: 'merchant-1' },
      data: {
        perPaymentLimit: BigInt(10_000),
        dailyAmountLimit: BigInt(20_000),
      },
    });
    await prismaOne.ledgerEntry.update({
      where: { entryKey: 'initial-credit:merchant-1' },
      data: { amount: BigInt(10_000) },
    });
    const rows = [
      ['fit-a', BigInt(4_000)],
      ['fit-b', BigInt(5_000)],
    ] as const;
    await prismaOne.payment.createMany({
      data: rows.map(([id, amountCents]) => ({
        id,
        merchantId: 'merchant-1',
        idempotencyKey: `${id}-idem`,
        requestFingerprint: `${id}-fingerprint`,
        externalReference: `${id}-reference`,
        direction: PaymentDirection.CREDIT,
        amountCents,
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: `${id}-account`,
        routingNumber: '021000021',
      })),
    });
    await prismaOne.outboxEvent.createMany({
      data: rows.map(([id, amountCents]) => ({
        eventType: OutboxEventType.PAYMENT_RECEIVED,
        aggregateType: 'PAYMENT',
        aggregateId: id,
        payload: {
          ...paymentPayload(id),
          direction: PaymentDirection.CREDIT,
          amountCents: amountCents.toString(),
        },
        availableAt: new Date(0),
      })),
    });
    await Promise.all([workerOne.processOnce(), workerTwo.processOnce()]);
    const payments = await prismaOne.payment.findMany({
      where: { id: { in: rows.map(([id]) => id) } },
    });
    const reservations = await prismaOne.reservation.findMany({
      where: { fundingAccountId: 'funding-account-1', status: 'ACTIVE' },
      orderBy: { amount: 'asc' },
    });
    const entries = await prismaOne.ledgerEntry.findMany({
      where: {
        fundingAccountId: 'funding-account-1',
        entryType: 'RESERVATION',
      },
    });
    const usage = await prismaOne.merchantDailyUsage.findFirstOrThrow({
      where: { merchantId: 'merchant-1' },
    });
    const events = await prismaOne.outboxEvent.findMany({
      where: {
        aggregateId: { in: rows.map(([id]) => id) },
        eventType: OutboxEventType.PAYMENT_RECEIVED,
      },
    });
    const reserved = reservations.reduce(
      (total, item) => total + item.amount,
      BigInt(0),
    );
    expect(payments).toHaveLength(2);
    expect(
      payments.every(
        (payment) =>
          payment.status === PaymentStatus.VALIDATED && payment.validatedAt,
      ),
    ).toBe(true);
    expect(reservations.map((item) => item.amount)).toEqual([
      BigInt(4_000),
      BigInt(5_000),
    ]);
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((item) => item.entryKey))).toEqual(
      new Set(['reservation:fit-a', 'reservation:fit-b']),
    );
    expect(usage.utilizedAmount).toBe(BigInt(9_000));
    expect(reserved).toBe(BigInt(9_000));
    expect(BigInt(10_000) - reserved).toBe(BigInt(1_000));
    expect(
      events.every(
        (event) =>
          event.status === OutboxEventStatus.PROCESSED &&
          event.lastError === null,
      ),
    ).toBe(true);
  });

  it('processes concurrent replay of the same ACH CREDIT exactly once', async () => {
    await prismaOne.merchant.update({
      where: { id: 'merchant-1' },
      data: {
        perPaymentLimit: BigInt(10_000),
        dailyAmountLimit: BigInt(20_000),
      },
    });
    await prismaOne.ledgerEntry.update({
      where: { entryKey: 'initial-credit:merchant-1' },
      data: { amount: BigInt(10_000) },
    });
    await prismaOne.payment.create({
      data: {
        id: 'replay-credit',
        merchantId: 'merchant-1',
        idempotencyKey: 'replay-credit-idem',
        requestFingerprint: 'replay-credit-fingerprint',
        externalReference: 'replay-credit-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(4_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'replay-credit-account',
        routingNumber: '021000021',
      },
    });
    await prismaOne.outboxEvent.createMany({
      data: ['replay-event-a', 'replay-event-b'].map((id) => ({
        id,
        eventType: OutboxEventType.PAYMENT_RECEIVED,
        aggregateType: 'PAYMENT',
        aggregateId: 'replay-credit',
        payload: {
          ...paymentPayload('replay-credit'),
          direction: PaymentDirection.CREDIT,
          amountCents: '4000',
        },
        availableAt: new Date(0),
      })),
    });
    await Promise.all([workerOne.processOnce(), workerTwo.processOnce()]);
    const payment = await prismaOne.payment.findUniqueOrThrow({
      where: { id: 'replay-credit' },
    });
    const reservations = await prismaOne.reservation.findMany({
      where: { paymentId: payment.id },
    });
    const entries = await prismaOne.ledgerEntry.findMany({
      where: { paymentId: payment.id, entryType: 'RESERVATION' },
    });
    const usage = await prismaOne.merchantDailyUsage.findFirstOrThrow({
      where: { merchantId: 'merchant-1' },
    });
    const events = await prismaOne.outboxEvent.findMany({
      where: {
        aggregateId: payment.id,
        eventType: OutboxEventType.PAYMENT_RECEIVED,
      },
      orderBy: { id: 'asc' },
    });
    const reserved = reservations.reduce(
      (total, item) => total + item.amount,
      BigInt(0),
    );
    expect(payment).toMatchObject({
      status: PaymentStatus.VALIDATED,
      failureCode: null,
      validationCode: null,
    });
    expect(payment.validatedAt).toBeInstanceOf(Date);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({
      status: 'ACTIVE',
      amount: BigInt(4_000),
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].entryKey).toBe('reservation:replay-credit');
    expect(usage.utilizedAmount).toBe(BigInt(4_000));
    expect(reserved).toBe(BigInt(4_000));
    expect(BigInt(10_000) - reserved).toBe(BigInt(6_000));
    expect(events).toHaveLength(2);
    expect(
      events.every(
        (event) =>
          event.status === OutboxEventStatus.PROCESSED &&
          event.lastError === null &&
          event.claimedAt === null &&
          event.attempts === 1,
      ),
    ).toBe(true);
  });

  it('rolls back reservation state when credit validation fails inside the transaction', async () => {
    await prismaOne.merchant.update({
      where: { id: 'merchant-1' },
      data: {
        perPaymentLimit: BigInt(10_000),
        dailyAmountLimit: BigInt(10_000),
      },
    });
    await prismaOne.ledgerEntry.update({
      where: { entryKey: 'initial-credit:merchant-1' },
      data: { amount: BigInt(10_000) },
    });
    await prismaOne.payment.create({
      data: {
        id: 'rollback-credit',
        merchantId: 'merchant-1',
        idempotencyKey: 'rollback-credit-idem',
        requestFingerprint: 'rollback-credit-fingerprint',
        externalReference: 'rollback-credit-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(4_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'rollback-credit-account',
        routingNumber: '021000021',
      },
    });
    await prismaOne.outboxEvent.create({
      data: {
        eventType: OutboxEventType.PAYMENT_RECEIVED,
        aggregateType: 'PAYMENT',
        aggregateId: 'rollback-credit',
        payload: {
          ...paymentPayload('rollback-credit'),
          direction: PaymentDirection.CREDIT,
          amountCents: '4000',
        },
        availableAt: new Date(0),
      },
    });
    const spy = jest
      .spyOn(
        PaymentLifecycleRepository.prototype as unknown as {
          afterFinancialWrites: () => Promise<void>;
        },
        'afterFinancialWrites',
      )
      .mockRejectedValueOnce(new Error('controlled transaction failure'));
    try {
      await workerOne.processOnce();
    } finally {
      spy.mockRestore();
    }
    const payment = await prismaOne.payment.findUniqueOrThrow({
      where: { id: 'rollback-credit' },
    });
    const event = await prismaOne.outboxEvent.findFirstOrThrow({
      where: {
        aggregateId: payment.id,
        eventType: OutboxEventType.PAYMENT_RECEIVED,
      },
    });
    const posted = await prismaOne.ledgerEntry.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        entryType: 'INITIAL_CREDIT',
      },
      _sum: { amount: true },
    });
    const reserved = await prismaOne.reservation.aggregate({
      where: { fundingAccountId: 'funding-account-1', status: 'ACTIVE' },
      _sum: { amount: true },
    });
    const postedBalance = BigInt(posted._sum.amount ?? 0);
    const activeReservedAmount = BigInt(reserved._sum.amount ?? 0);
    expect(payment).toMatchObject({
      status: PaymentStatus.RECEIVED,
      validatedAt: null,
    });
    expect(
      await prismaOne.reservation.count({ where: { paymentId: payment.id } }),
    ).toBe(0);
    expect(
      await prismaOne.ledgerEntry.count({
        where: { paymentId: payment.id, entryType: 'RESERVATION' },
      }),
    ).toBe(0);
    expect(
      await prismaOne.merchantDailyUsage.count({
        where: { merchantId: 'merchant-1' },
      }),
    ).toBe(0);
    expect(postedBalance).toBe(BigInt(10_000));
    expect(activeReservedAmount).toBe(BigInt(0));
    expect(postedBalance - activeReservedAmount).toBe(BigInt(10_000));
    expect(event).toMatchObject({
      status: OutboxEventStatus.PENDING,
      attempts: 1,
      claimedAt: null,
      lastError: 'Outbox event processing failed',
    });
    expect(event.availableAt.getTime()).toBeGreaterThan(Date.now() - 1_000);
  });

  it('validates ACH DEBIT without reserving prefunded balance', async () => {
    await prismaOne.merchant.update({
      where: { id: 'merchant-1' },
      data: {
        perPaymentLimit: BigInt(10_000),
        dailyAmountLimit: BigInt(10_000),
      },
    });
    await prismaOne.ledgerEntry.update({
      where: { entryKey: 'initial-credit:merchant-1' },
      data: { amount: BigInt(10_000) },
    });
    await prismaOne.payment.create({
      data: {
        id: 'debit-no-reservation',
        merchantId: 'merchant-1',
        idempotencyKey: 'debit-no-reservation-idem',
        requestFingerprint: 'debit-no-reservation-fingerprint',
        externalReference: 'debit-no-reservation-reference',
        direction: PaymentDirection.DEBIT,
        amountCents: BigInt(4_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'debit-no-reservation-account',
        routingNumber: '021000021',
      },
    });
    await prismaOne.outboxEvent.create({
      data: {
        eventType: OutboxEventType.PAYMENT_RECEIVED,
        aggregateType: 'PAYMENT',
        aggregateId: 'debit-no-reservation',
        payload: {
          ...paymentPayload('debit-no-reservation'),
          amountCents: '4000',
        },
        availableAt: new Date(0),
      },
    });

    await workerOne.processOnce();

    const payment = await prismaOne.payment.findUniqueOrThrow({
      where: { id: 'debit-no-reservation' },
    });
    const businessDate = new Date(
      Date.UTC(
        payment.createdAt.getUTCFullYear(),
        payment.createdAt.getUTCMonth(),
        payment.createdAt.getUTCDate(),
      ),
    );
    const event = await prismaOne.outboxEvent.findFirstOrThrow({
      where: {
        aggregateId: payment.id,
        eventType: OutboxEventType.PAYMENT_RECEIVED,
      },
    });
    const usage = await prismaOne.merchantDailyUsage.findUniqueOrThrow({
      where: {
        merchantId_businessDate: {
          merchantId: payment.merchantId,
          businessDate,
        },
      },
    });
    const posted = await prismaOne.ledgerEntry.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        entryType: 'INITIAL_CREDIT',
      },
      _sum: { amount: true },
    });
    const reserved = await prismaOne.reservation.aggregate({
      where: { fundingAccountId: 'funding-account-1', status: 'ACTIVE' },
      _sum: { amount: true },
    });
    const postedBalance = BigInt(posted._sum.amount ?? 0);
    const activeReservedAmount = BigInt(reserved._sum.amount ?? 0);

    expect(payment).toMatchObject({
      status: PaymentStatus.VALIDATED,
      failureCode: null,
      validationCode: null,
    });
    expect(payment.validatedAt).toBeInstanceOf(Date);
    expect(
      await prismaOne.reservation.count({ where: { paymentId: payment.id } }),
    ).toBe(0);
    expect(
      await prismaOne.ledgerEntry.count({
        where: { paymentId: payment.id, entryType: 'RESERVATION' },
      }),
    ).toBe(0);
    expect(activeReservedAmount).toBe(BigInt(0));
    expect(usage.utilizedAmount).toBe(BigInt(4_000));
    expect(postedBalance).toBe(BigInt(10_000));
    expect(postedBalance - activeReservedAmount).toBe(BigInt(10_000));
    expect(event).toMatchObject({
      status: OutboxEventStatus.PROCESSED,
      lastError: null,
      attempts: 1,
      claimedAt: null,
    });
  });

  it('validates ACH DEBIT when no funding account exists', async () => {
    await prismaOne.merchant.update({
      where: { id: 'merchant-1' },
      data: {
        perPaymentLimit: BigInt(10_000),
        dailyAmountLimit: BigInt(10_000),
      },
    });
    await prismaOne.ledgerEntry.deleteMany({
      where: { fundingAccountId: 'funding-account-1' },
    });
    await prismaOne.fundingAccount.delete({
      where: { id: 'funding-account-1' },
    });
    await prismaOne.payment.create({
      data: {
        id: 'debit-no-funding-account',
        merchantId: 'merchant-1',
        idempotencyKey: 'debit-no-funding-account-idem',
        requestFingerprint: 'debit-no-funding-account-fingerprint',
        externalReference: 'debit-no-funding-account-reference',
        direction: PaymentDirection.DEBIT,
        amountCents: BigInt(4_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'debit-no-funding-account-reference',
        routingNumber: '021000021',
      },
    });
    await prismaOne.outboxEvent.create({
      data: {
        eventType: OutboxEventType.PAYMENT_RECEIVED,
        aggregateType: 'PAYMENT',
        aggregateId: 'debit-no-funding-account',
        payload: {
          ...paymentPayload('debit-no-funding-account'),
          amountCents: '4000',
        },
        availableAt: new Date(0),
      },
    });

    await workerOne.processOnce();

    const payment = await prismaOne.payment.findUniqueOrThrow({
      where: { id: 'debit-no-funding-account' },
    });
    const businessDate = new Date(
      Date.UTC(
        payment.createdAt.getUTCFullYear(),
        payment.createdAt.getUTCMonth(),
        payment.createdAt.getUTCDate(),
      ),
    );
    const usage = await prismaOne.merchantDailyUsage.findMany({
      where: {
        merchantId: payment.merchantId,
        businessDate,
      },
    });
    const event = await prismaOne.outboxEvent.findFirstOrThrow({
      where: {
        aggregateId: payment.id,
        eventType: OutboxEventType.PAYMENT_RECEIVED,
      },
    });

    expect(payment).toMatchObject({
      status: PaymentStatus.VALIDATED,
      failureCode: null,
      validationCode: null,
      validationMessage: null,
    });
    expect(payment.validatedAt).toBeInstanceOf(Date);
    expect(
      await prismaOne.fundingAccount.count({
        where: { merchantId: 'merchant-1' },
      }),
    ).toBe(0);
    expect(
      await prismaOne.reservation.count({ where: { paymentId: payment.id } }),
    ).toBe(0);
    expect(
      await prismaOne.ledgerEntry.count({
        where: { paymentId: payment.id, entryType: 'RESERVATION' },
      }),
    ).toBe(0);
    expect(usage).toHaveLength(1);
    expect(usage[0].utilizedAmount).toBe(BigInt(4_000));
    expect(event).toMatchObject({
      status: OutboxEventStatus.PROCESSED,
      attempts: 1,
      lastError: null,
      claimedAt: null,
    });
    expect(event.processedAt).toBeInstanceOf(Date);
  });

  it('fails ACH CREDIT when no funding account exists', async () => {
    await prismaOne.merchant.update({
      where: { id: 'merchant-1' },
      data: {
        perPaymentLimit: BigInt(10_000),
        dailyAmountLimit: BigInt(10_000),
      },
    });
    await prismaOne.ledgerEntry.deleteMany({
      where: { fundingAccountId: 'funding-account-1' },
    });
    await prismaOne.fundingAccount.delete({
      where: { id: 'funding-account-1' },
    });
    await prismaOne.payment.create({
      data: {
        id: 'credit-no-funding-account',
        merchantId: 'merchant-1',
        idempotencyKey: 'credit-no-funding-account-idem',
        requestFingerprint: 'credit-no-funding-account-fingerprint',
        externalReference: 'credit-no-funding-account-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(4_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'credit-no-funding-account-reference',
        routingNumber: '021000021',
      },
    });
    await prismaOne.outboxEvent.create({
      data: {
        eventType: OutboxEventType.PAYMENT_RECEIVED,
        aggregateType: 'PAYMENT',
        aggregateId: 'credit-no-funding-account',
        payload: {
          ...paymentPayload('credit-no-funding-account'),
          direction: PaymentDirection.CREDIT,
          amountCents: '4000',
        },
        availableAt: new Date(0),
      },
    });

    await workerOne.processOnce();

    const payment = await prismaOne.payment.findUniqueOrThrow({
      where: { id: 'credit-no-funding-account' },
    });
    const event = await prismaOne.outboxEvent.findFirstOrThrow({
      where: {
        aggregateId: payment.id,
        eventType: OutboxEventType.PAYMENT_RECEIVED,
      },
    });

    expect(payment).toMatchObject({
      status: PaymentStatus.VALIDATION_FAILED,
      validatedAt: null,
      failureCode: 'FUNDING_ACCOUNT_UNAVAILABLE',
      validationCode: 'FUNDING_ACCOUNT_UNAVAILABLE',
      failureReason: 'No active USD funding account exists for merchant',
      validationMessage: 'No active USD funding account exists for merchant',
    });
    expect(
      await prismaOne.fundingAccount.count({
        where: { merchantId: 'merchant-1' },
      }),
    ).toBe(0);
    expect(
      await prismaOne.reservation.count({ where: { paymentId: payment.id } }),
    ).toBe(0);
    expect(
      await prismaOne.ledgerEntry.count({
        where: { paymentId: payment.id, entryType: 'RESERVATION' },
      }),
    ).toBe(0);
    expect(
      await prismaOne.merchantDailyUsage.count({
        where: { merchantId: payment.merchantId },
      }),
    ).toBe(0);
    expect(event).toMatchObject({
      status: OutboxEventStatus.PROCESSED,
      attempts: 1,
      lastError: null,
      claimedAt: null,
    });
    expect(event.processedAt).toBeInstanceOf(Date);
  });

  it('fails ACH CREDIT when the funding account is inactive', async () => {
    await prismaOne.merchant.update({
      where: { id: 'merchant-1' },
      data: {
        perPaymentLimit: BigInt(10_000),
        dailyAmountLimit: BigInt(10_000),
      },
    });
    await prismaOne.fundingAccount.update({
      where: { id: 'funding-account-1' },
      data: { status: FundingAccountStatus.CLOSED },
    });
    await prismaOne.ledgerEntry.update({
      where: { entryKey: 'initial-credit:merchant-1' },
      data: { amount: BigInt(10_000) },
    });
    await prismaOne.payment.create({
      data: {
        id: 'credit-inactive-funding-account',
        merchantId: 'merchant-1',
        idempotencyKey: 'credit-inactive-funding-account-idem',
        requestFingerprint: 'credit-inactive-funding-account-fingerprint',
        externalReference: 'credit-inactive-funding-account-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(4_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'credit-inactive-funding-account-reference',
        routingNumber: '021000021',
      },
    });
    await prismaOne.outboxEvent.create({
      data: {
        eventType: OutboxEventType.PAYMENT_RECEIVED,
        aggregateType: 'PAYMENT',
        aggregateId: 'credit-inactive-funding-account',
        payload: {
          ...paymentPayload('credit-inactive-funding-account'),
          direction: PaymentDirection.CREDIT,
          amountCents: '4000',
        },
        availableAt: new Date(0),
      },
    });

    await workerOne.processOnce();

    const payment = await prismaOne.payment.findUniqueOrThrow({
      where: { id: 'credit-inactive-funding-account' },
    });
    const fundingAccount = await prismaOne.fundingAccount.findUniqueOrThrow({
      where: { id: 'funding-account-1' },
    });
    const initialCredit = await prismaOne.ledgerEntry.findUniqueOrThrow({
      where: { entryKey: 'initial-credit:merchant-1' },
    });
    const posted = await prismaOne.ledgerEntry.aggregate({
      where: {
        fundingAccountId: fundingAccount.id,
        entryType: 'INITIAL_CREDIT',
      },
      _sum: { amount: true },
    });
    const reserved = await prismaOne.reservation.aggregate({
      where: { fundingAccountId: fundingAccount.id, status: 'ACTIVE' },
      _sum: { amount: true },
    });
    const event = await prismaOne.outboxEvent.findFirstOrThrow({
      where: {
        aggregateId: payment.id,
        eventType: OutboxEventType.PAYMENT_RECEIVED,
      },
    });

    expect(payment).toMatchObject({
      status: PaymentStatus.VALIDATION_FAILED,
      validatedAt: null,
      failureCode: 'FUNDING_ACCOUNT_UNAVAILABLE',
      validationCode: 'FUNDING_ACCOUNT_UNAVAILABLE',
      failureReason: 'No active USD funding account exists for merchant',
      validationMessage: 'No active USD funding account exists for merchant',
    });
    expect(
      await prismaOne.fundingAccount.count({
        where: { merchantId: 'merchant-1' },
      }),
    ).toBe(1);
    expect(fundingAccount.status).toBe(FundingAccountStatus.CLOSED);
    expect(initialCredit.amount).toBe(BigInt(10_000));
    expect(
      await prismaOne.reservation.count({ where: { paymentId: payment.id } }),
    ).toBe(0);
    expect(
      await prismaOne.ledgerEntry.count({
        where: { paymentId: payment.id, entryType: 'RESERVATION' },
      }),
    ).toBe(0);
    expect(
      await prismaOne.merchantDailyUsage.count({
        where: { merchantId: payment.merchantId },
      }),
    ).toBe(0);
    expect(BigInt(posted._sum.amount ?? 0)).toBe(BigInt(10_000));
    expect(BigInt(reserved._sum.amount ?? 0)).toBe(BigInt(0));
    expect(event).toMatchObject({
      status: OutboxEventStatus.PROCESSED,
      attempts: 1,
      lastError: null,
      claimedAt: null,
    });
    expect(event.processedAt).toBeInstanceOf(Date);
  });

  it('fails USD ACH CREDIT when only a non-USD funding account exists', async () => {
    await prismaOne.merchant.update({
      where: { id: 'merchant-1' },
      data: {
        perPaymentLimit: BigInt(10_000),
        dailyAmountLimit: BigInt(10_000),
      },
    });
    await prismaOne.fundingAccount.update({
      where: { id: 'funding-account-1' },
      data: { currency: 'CAD', status: FundingAccountStatus.ACTIVE },
    });
    await prismaOne.ledgerEntry.update({
      where: { entryKey: 'initial-credit:merchant-1' },
      data: { amount: BigInt(10_000) },
    });
    await prismaOne.payment.create({
      data: {
        id: 'credit-currency-mismatch',
        merchantId: 'merchant-1',
        idempotencyKey: 'credit-currency-mismatch-idem',
        requestFingerprint: 'credit-currency-mismatch-fingerprint',
        externalReference: 'credit-currency-mismatch-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(4_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'credit-currency-mismatch-account',
        routingNumber: '021000021',
      },
    });
    await prismaOne.outboxEvent.create({
      data: {
        eventType: OutboxEventType.PAYMENT_RECEIVED,
        aggregateType: 'PAYMENT',
        aggregateId: 'credit-currency-mismatch',
        payload: {
          ...paymentPayload('credit-currency-mismatch'),
          direction: PaymentDirection.CREDIT,
          amountCents: '4000',
        },
        availableAt: new Date(0),
      },
    });

    await workerOne.processOnce();

    const payment = await prismaOne.payment.findUniqueOrThrow({
      where: { id: 'credit-currency-mismatch' },
    });
    const fundingAccount = await prismaOne.fundingAccount.findUniqueOrThrow({
      where: { id: 'funding-account-1' },
    });
    const initialCredit = await prismaOne.ledgerEntry.findUniqueOrThrow({
      where: { entryKey: 'initial-credit:merchant-1' },
    });
    const posted = await prismaOne.ledgerEntry.aggregate({
      where: {
        fundingAccountId: fundingAccount.id,
        entryType: 'INITIAL_CREDIT',
      },
      _sum: { amount: true },
    });
    const reserved = await prismaOne.reservation.aggregate({
      where: { fundingAccountId: fundingAccount.id, status: 'ACTIVE' },
      _sum: { amount: true },
    });
    const event = await prismaOne.outboxEvent.findFirstOrThrow({
      where: {
        aggregateId: payment.id,
        eventType: OutboxEventType.PAYMENT_RECEIVED,
      },
    });

    expect(payment).toMatchObject({
      status: PaymentStatus.VALIDATION_FAILED,
      validatedAt: null,
      failureCode: 'FUNDING_ACCOUNT_UNAVAILABLE',
      validationCode: 'FUNDING_ACCOUNT_UNAVAILABLE',
      failureReason: 'No active USD funding account exists for merchant',
      validationMessage: 'No active USD funding account exists for merchant',
    });
    expect(
      await prismaOne.fundingAccount.count({
        where: { merchantId: 'merchant-1' },
      }),
    ).toBe(1);
    expect(fundingAccount).toMatchObject({
      status: FundingAccountStatus.ACTIVE,
      currency: 'CAD',
    });
    expect(initialCredit.amount).toBe(BigInt(10_000));
    expect(
      await prismaOne.reservation.count({ where: { paymentId: payment.id } }),
    ).toBe(0);
    expect(
      await prismaOne.ledgerEntry.count({
        where: { paymentId: payment.id, entryType: 'RESERVATION' },
      }),
    ).toBe(0);
    expect(
      await prismaOne.merchantDailyUsage.count({
        where: { merchantId: payment.merchantId },
      }),
    ).toBe(0);
    expect(BigInt(posted._sum.amount ?? 0)).toBe(BigInt(10_000));
    expect(BigInt(reserved._sum.amount ?? 0)).toBe(BigInt(0));
    expect(event).toMatchObject({
      status: OutboxEventStatus.PROCESSED,
      attempts: 1,
      lastError: null,
      claimedAt: null,
    });
    expect(event.processedAt).toBeInstanceOf(Date);
  });

  it('reserves USD ACH CREDIT only from the matching USD funding account', async () => {
    await prismaOne.merchant.update({
      where: { id: 'merchant-1' },
      data: {
        perPaymentLimit: BigInt(10_000),
        dailyAmountLimit: BigInt(10_000),
      },
    });
    await prismaOne.ledgerEntry.update({
      where: { entryKey: 'initial-credit:merchant-1' },
      data: { amount: BigInt(10_000) },
    });
    const cadAccount = await prismaOne.fundingAccount.create({
      data: {
        id: 'funding-account-cad-1',
        merchantId: 'merchant-1',
        currency: 'CAD',
        status: FundingAccountStatus.ACTIVE,
      },
    });
    await prismaOne.ledgerEntry.create({
      data: {
        entryKey: 'initial-credit:merchant-1:CAD',
        fundingAccountId: cadAccount.id,
        entryType: 'INITIAL_CREDIT',
        amount: BigInt(20_000),
      },
    });
    await prismaOne.payment.create({
      data: {
        id: 'credit-matching-usd-account',
        merchantId: 'merchant-1',
        idempotencyKey: 'credit-matching-usd-account-idem',
        requestFingerprint: 'credit-matching-usd-account-fingerprint',
        externalReference: 'credit-matching-usd-account-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(4_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'credit-matching-usd-account-reference',
        routingNumber: '021000021',
      },
    });
    await prismaOne.outboxEvent.create({
      data: {
        eventType: OutboxEventType.PAYMENT_RECEIVED,
        aggregateType: 'PAYMENT',
        aggregateId: 'credit-matching-usd-account',
        payload: {
          ...paymentPayload('credit-matching-usd-account'),
          direction: PaymentDirection.CREDIT,
          amountCents: '4000',
        },
        availableAt: new Date(0),
      },
    });

    await workerOne.processOnce();

    const payment = await prismaOne.payment.findUniqueOrThrow({
      where: { id: 'credit-matching-usd-account' },
    });
    const usdReservations = await prismaOne.reservation.findMany({
      where: { fundingAccountId: 'funding-account-1', status: 'ACTIVE' },
    });
    const usdEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        fundingAccountId: 'funding-account-1',
        paymentId: payment.id,
        entryType: 'RESERVATION',
      },
    });
    const cadReservations = await prismaOne.reservation.findMany({
      where: { fundingAccountId: cadAccount.id, status: 'ACTIVE' },
    });
    const cadEntries = await prismaOne.ledgerEntry.findMany({
      where: { fundingAccountId: cadAccount.id, entryType: 'RESERVATION' },
    });
    const usdPosted = await prismaOne.ledgerEntry.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        entryType: 'INITIAL_CREDIT',
      },
      _sum: { amount: true },
    });
    const cadPosted = await prismaOne.ledgerEntry.aggregate({
      where: { fundingAccountId: cadAccount.id, entryType: 'INITIAL_CREDIT' },
      _sum: { amount: true },
    });
    const usage = await prismaOne.merchantDailyUsage.findMany({
      where: { merchantId: payment.merchantId },
    });
    const event = await prismaOne.outboxEvent.findFirstOrThrow({
      where: {
        aggregateId: payment.id,
        eventType: OutboxEventType.PAYMENT_RECEIVED,
      },
    });
    const usdPostedBalance = BigInt(usdPosted._sum.amount ?? 0);
    const usdReservedAmount = usdReservations.reduce(
      (total, reservation) => total + reservation.amount,
      BigInt(0),
    );
    const cadPostedBalance = BigInt(cadPosted._sum.amount ?? 0);
    const cadReservedAmount = cadReservations.reduce(
      (total, reservation) => total + reservation.amount,
      BigInt(0),
    );

    expect(payment).toMatchObject({
      status: PaymentStatus.VALIDATED,
      failureCode: null,
      validationCode: null,
    });
    expect(payment.validatedAt).toBeInstanceOf(Date);
    expect(usdReservations).toHaveLength(1);
    expect(usdReservations[0]).toMatchObject({
      paymentId: payment.id,
      fundingAccountId: 'funding-account-1',
      amount: BigInt(4_000),
    });
    expect(usdEntries).toHaveLength(1);
    expect(usdEntries[0]).toMatchObject({
      fundingAccountId: 'funding-account-1',
      entryKey: `reservation:${payment.id}`,
    });
    expect(usdPostedBalance).toBe(BigInt(10_000));
    expect(usdReservedAmount).toBe(BigInt(4_000));
    expect(usdPostedBalance - usdReservedAmount).toBe(BigInt(6_000));
    expect(cadReservations).toHaveLength(0);
    expect(cadEntries).toHaveLength(0);
    expect(cadPostedBalance).toBe(BigInt(20_000));
    expect(cadReservedAmount).toBe(BigInt(0));
    expect(usage).toHaveLength(1);
    expect(usage[0].utilizedAmount).toBe(BigInt(4_000));
    expect(event).toMatchObject({
      status: OutboxEventStatus.PROCESSED,
      attempts: 1,
      lastError: null,
      claimedAt: null,
    });
    expect(event.processedAt).toBeInstanceOf(Date);
  });

  it('rejects ACH CREDIT when existing active reservations leave insufficient available balance', async () => {
    const businessDate = new Date(Date.UTC(2026, 6, 29));
    await prismaOne.merchant.update({
      where: { id: 'merchant-1' },
      data: {
        perPaymentLimit: BigInt(20_000),
        dailyAmountLimit: BigInt(20_000),
      },
    });
    await prismaOne.ledgerEntry.update({
      where: { entryKey: 'initial-credit:merchant-1' },
      data: { amount: BigInt(10_000) },
    });
    await prismaOne.payment.create({
      data: {
        id: 'existing-reserved-credit',
        merchantId: 'merchant-1',
        idempotencyKey: 'existing-reserved-credit-idem',
        requestFingerprint: 'existing-reserved-credit-fingerprint',
        externalReference: 'existing-reserved-credit-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(7_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'existing-reserved-credit-account',
        routingNumber: '021000021',
        status: PaymentStatus.VALIDATED,
        validatedAt: businessDate,
        createdAt: businessDate,
      },
    });
    await prismaOne.reservation.create({
      data: {
        paymentId: 'existing-reserved-credit',
        fundingAccountId: 'funding-account-1',
        amount: BigInt(7_000),
        status: 'ACTIVE',
      },
    });
    await prismaOne.ledgerEntry.create({
      data: {
        entryKey: 'reservation:existing-reserved-credit',
        fundingAccountId: 'funding-account-1',
        paymentId: 'existing-reserved-credit',
        entryType: 'RESERVATION',
        amount: BigInt(7_000),
      },
    });
    await prismaOne.merchantDailyUsage.create({
      data: {
        merchantId: 'merchant-1',
        businessDate,
        utilizedAmount: BigInt(7_000),
      },
    });
    await prismaOne.payment.create({
      data: {
        id: 'credit-after-existing-reservation',
        merchantId: 'merchant-1',
        idempotencyKey: 'credit-after-existing-reservation-idem',
        requestFingerprint: 'credit-after-existing-reservation-fingerprint',
        externalReference: 'credit-after-existing-reservation-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(4_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'credit-after-existing-reservation-account',
        routingNumber: '021000021',
        createdAt: businessDate,
      },
    });
    await prismaOne.outboxEvent.create({
      data: {
        eventType: OutboxEventType.PAYMENT_RECEIVED,
        aggregateType: 'PAYMENT',
        aggregateId: 'credit-after-existing-reservation',
        payload: {
          ...paymentPayload('credit-after-existing-reservation'),
          direction: PaymentDirection.CREDIT,
          amountCents: '4000',
          createdAt: businessDate.toISOString(),
        },
        availableAt: new Date(0),
      },
    });

    await workerOne.processOnce();

    const newPayment = await prismaOne.payment.findUniqueOrThrow({
      where: { id: 'credit-after-existing-reservation' },
    });
    const existingReservations = await prismaOne.reservation.findMany({
      where: { paymentId: 'existing-reserved-credit', status: 'ACTIVE' },
    });
    const existingEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        paymentId: 'existing-reserved-credit',
        entryType: 'RESERVATION',
      },
    });
    const usage = await prismaOne.merchantDailyUsage.findUniqueOrThrow({
      where: {
        merchantId_businessDate: { merchantId: 'merchant-1', businessDate },
      },
    });
    const posted = await prismaOne.ledgerEntry.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        entryType: 'INITIAL_CREDIT',
      },
      _sum: { amount: true },
    });
    const reserved = await prismaOne.reservation.aggregate({
      where: { fundingAccountId: 'funding-account-1', status: 'ACTIVE' },
      _sum: { amount: true },
    });
    const event = await prismaOne.outboxEvent.findFirstOrThrow({
      where: {
        aggregateId: newPayment.id,
        eventType: OutboxEventType.PAYMENT_RECEIVED,
      },
    });
    const postedBalance = BigInt(posted._sum.amount ?? 0);
    const activeReservedAmount = BigInt(reserved._sum.amount ?? 0);

    expect(newPayment).toMatchObject({
      status: PaymentStatus.VALIDATION_FAILED,
      validatedAt: null,
      failureCode: 'INSUFFICIENT_FUNDS',
      validationCode: 'INSUFFICIENT_FUNDS',
    });
    expect(newPayment.failureReason).toBe(
      'Available 3000, requested 4000, currency USD',
    );
    expect(existingReservations).toHaveLength(1);
    expect(existingReservations[0]).toMatchObject({
      paymentId: 'existing-reserved-credit',
      amount: BigInt(7_000),
    });
    expect(existingEntries).toHaveLength(1);
    expect(existingEntries[0]).toMatchObject({
      entryKey: 'reservation:existing-reserved-credit',
      amount: BigInt(7_000),
    });
    expect(
      await prismaOne.reservation.count({
        where: { paymentId: newPayment.id },
      }),
    ).toBe(0);
    expect(
      await prismaOne.ledgerEntry.count({
        where: { paymentId: newPayment.id, entryType: 'RESERVATION' },
      }),
    ).toBe(0);
    expect(usage.utilizedAmount).toBe(BigInt(7_000));
    expect(postedBalance).toBe(BigInt(10_000));
    expect(activeReservedAmount).toBe(BigInt(7_000));
    expect(postedBalance - activeReservedAmount).toBe(BigInt(3_000));
    expect(event).toMatchObject({
      status: OutboxEventStatus.PROCESSED,
      attempts: 1,
      lastError: null,
      claimedAt: null,
    });
    expect(event.processedAt).toBeInstanceOf(Date);
  });

  it('validates ACH CREDIT when a previous reservation is no longer active', async () => {
    const businessDate = new Date(Date.UTC(2026, 6, 29));
    await prismaOne.merchant.update({
      where: { id: 'merchant-1' },
      data: {
        perPaymentLimit: BigInt(20_000),
        dailyAmountLimit: BigInt(20_000),
      },
    });
    await prismaOne.ledgerEntry.update({
      where: { entryKey: 'initial-credit:merchant-1' },
      data: { amount: BigInt(10_000) },
    });
    await prismaOne.payment.create({
      data: {
        id: 'previously-released-credit',
        merchantId: 'merchant-1',
        idempotencyKey: 'previously-released-credit-idem',
        requestFingerprint: 'previously-released-credit-fingerprint',
        externalReference: 'previously-released-credit-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(7_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'previously-released-credit-account',
        routingNumber: '021000021',
        status: PaymentStatus.VALIDATED,
        validatedAt: businessDate,
        createdAt: businessDate,
      },
    });
    await prismaOne.reservation.create({
      data: {
        paymentId: 'previously-released-credit',
        fundingAccountId: 'funding-account-1',
        amount: BigInt(7_000),
        status: ReservationStatus.RELEASED,
        releasedAt: businessDate,
      },
    });
    await prismaOne.ledgerEntry.create({
      data: {
        entryKey: 'reservation:previously-released-credit',
        fundingAccountId: 'funding-account-1',
        paymentId: 'previously-released-credit',
        entryType: 'RESERVATION',
        amount: BigInt(7_000),
      },
    });
    await prismaOne.payment.create({
      data: {
        id: 'credit-after-released-reservation',
        merchantId: 'merchant-1',
        idempotencyKey: 'credit-after-released-reservation-idem',
        requestFingerprint: 'credit-after-released-reservation-fingerprint',
        externalReference: 'credit-after-released-reservation-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(4_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'credit-after-released-reservation-account',
        routingNumber: '021000021',
        createdAt: businessDate,
      },
    });
    await prismaOne.outboxEvent.create({
      data: {
        eventType: OutboxEventType.PAYMENT_RECEIVED,
        aggregateType: 'PAYMENT',
        aggregateId: 'credit-after-released-reservation',
        payload: {
          ...paymentPayload('credit-after-released-reservation'),
          direction: PaymentDirection.CREDIT,
          amountCents: '4000',
          createdAt: businessDate.toISOString(),
        },
        availableAt: new Date(0),
      },
    });

    await workerOne.processOnce();

    const payment = await prismaOne.payment.findUniqueOrThrow({
      where: { id: 'credit-after-released-reservation' },
    });
    const historicalReservations = await prismaOne.reservation.findMany({
      where: { paymentId: 'previously-released-credit' },
    });
    const historicalEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        paymentId: 'previously-released-credit',
        entryType: 'RESERVATION',
      },
    });
    const newReservations = await prismaOne.reservation.findMany({
      where: { paymentId: payment.id, status: ReservationStatus.ACTIVE },
    });
    const newEntries = await prismaOne.ledgerEntry.findMany({
      where: { paymentId: payment.id, entryType: 'RESERVATION' },
    });
    const usage = await prismaOne.merchantDailyUsage.findUniqueOrThrow({
      where: {
        merchantId_businessDate: { merchantId: 'merchant-1', businessDate },
      },
    });
    const posted = await prismaOne.ledgerEntry.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        entryType: 'INITIAL_CREDIT',
      },
      _sum: { amount: true },
    });
    const activeReservations = await prismaOne.reservation.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        status: ReservationStatus.ACTIVE,
      },
      _sum: { amount: true },
    });
    const event = await prismaOne.outboxEvent.findFirstOrThrow({
      where: {
        aggregateId: payment.id,
        eventType: OutboxEventType.PAYMENT_RECEIVED,
      },
    });
    const postedBalance = BigInt(posted._sum.amount ?? 0);
    const activeReservedAmount = BigInt(activeReservations._sum.amount ?? 0);

    expect(payment).toMatchObject({
      status: PaymentStatus.VALIDATED,
      failureCode: null,
      validationCode: null,
    });
    expect(payment.validatedAt).toBeInstanceOf(Date);
    expect(historicalReservations).toHaveLength(1);
    expect(historicalReservations[0]).toMatchObject({
      status: ReservationStatus.RELEASED,
      amount: BigInt(7_000),
    });
    expect(historicalEntries).toHaveLength(1);
    expect(historicalEntries[0]).toMatchObject({
      entryKey: 'reservation:previously-released-credit',
      amount: BigInt(7_000),
    });
    expect(newReservations).toHaveLength(1);
    expect(newReservations[0]).toMatchObject({ amount: BigInt(4_000) });
    expect(newEntries).toHaveLength(1);
    expect(newEntries[0].entryKey).toBe(
      'reservation:credit-after-released-reservation',
    );
    expect(usage.utilizedAmount).toBe(BigInt(4_000));
    expect(postedBalance).toBe(BigInt(10_000));
    expect(activeReservedAmount).toBe(BigInt(4_000));
    expect(postedBalance - activeReservedAmount).toBe(BigInt(6_000));
    expect(event).toMatchObject({
      status: OutboxEventStatus.PROCESSED,
      attempts: 1,
      lastError: null,
      claimedAt: null,
    });
    expect(event.processedAt).toBeInstanceOf(Date);
  });

  it('validates ACH CREDIT for the exact balance remaining after an active reservation', async () => {
    const businessDate = new Date(Date.UTC(2026, 6, 29));
    await prismaOne.merchant.update({
      where: { id: 'merchant-1' },
      data: {
        perPaymentLimit: BigInt(20_000),
        dailyAmountLimit: BigInt(20_000),
      },
    });
    await prismaOne.ledgerEntry.update({
      where: { entryKey: 'initial-credit:merchant-1' },
      data: { amount: BigInt(10_000) },
    });
    await prismaOne.payment.create({
      data: {
        id: 'existing-exact-balance-reservation',
        merchantId: 'merchant-1',
        idempotencyKey: 'existing-exact-balance-reservation-idem',
        requestFingerprint: 'existing-exact-balance-reservation-fingerprint',
        externalReference: 'existing-exact-balance-reservation-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(7_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'existing-exact-balance-reservation-account',
        routingNumber: '021000021',
        status: PaymentStatus.VALIDATED,
        validatedAt: businessDate,
        createdAt: businessDate,
      },
    });
    await prismaOne.reservation.create({
      data: {
        paymentId: 'existing-exact-balance-reservation',
        fundingAccountId: 'funding-account-1',
        amount: BigInt(7_000),
        status: ReservationStatus.ACTIVE,
      },
    });
    await prismaOne.ledgerEntry.create({
      data: {
        entryKey: 'reservation:existing-exact-balance-reservation',
        fundingAccountId: 'funding-account-1',
        paymentId: 'existing-exact-balance-reservation',
        entryType: 'RESERVATION',
        amount: BigInt(7_000),
      },
    });
    await prismaOne.merchantDailyUsage.create({
      data: {
        merchantId: 'merchant-1',
        businessDate,
        utilizedAmount: BigInt(7_000),
      },
    });
    await prismaOne.payment.create({
      data: {
        id: 'credit-using-exact-remaining-balance',
        merchantId: 'merchant-1',
        idempotencyKey: 'credit-using-exact-remaining-balance-idem',
        requestFingerprint: 'credit-using-exact-remaining-balance-fingerprint',
        externalReference: 'credit-using-exact-remaining-balance-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(3_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'credit-using-exact-remaining-balance-account',
        routingNumber: '021000021',
        createdAt: businessDate,
      },
    });
    await prismaOne.outboxEvent.create({
      data: {
        eventType: OutboxEventType.PAYMENT_RECEIVED,
        aggregateType: 'PAYMENT',
        aggregateId: 'credit-using-exact-remaining-balance',
        payload: {
          ...paymentPayload('credit-using-exact-remaining-balance'),
          direction: PaymentDirection.CREDIT,
          amountCents: '3000',
          createdAt: businessDate.toISOString(),
        },
        availableAt: new Date(0),
      },
    });

    await workerOne.processOnce();

    const payment = await prismaOne.payment.findUniqueOrThrow({
      where: { id: 'credit-using-exact-remaining-balance' },
    });
    const existingReservations = await prismaOne.reservation.findMany({
      where: {
        paymentId: 'existing-exact-balance-reservation',
        status: ReservationStatus.ACTIVE,
      },
    });
    const newReservations = await prismaOne.reservation.findMany({
      where: { paymentId: payment.id, status: ReservationStatus.ACTIVE },
    });
    const existingEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        paymentId: 'existing-exact-balance-reservation',
        entryType: 'RESERVATION',
      },
    });
    const newEntries = await prismaOne.ledgerEntry.findMany({
      where: { paymentId: payment.id, entryType: 'RESERVATION' },
    });
    const activeReservations = await prismaOne.reservation.findMany({
      where: {
        fundingAccountId: 'funding-account-1',
        status: ReservationStatus.ACTIVE,
      },
    });
    const posted = await prismaOne.ledgerEntry.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        entryType: 'INITIAL_CREDIT',
      },
      _sum: { amount: true },
    });
    const usage = await prismaOne.merchantDailyUsage.findUniqueOrThrow({
      where: {
        merchantId_businessDate: { merchantId: 'merchant-1', businessDate },
      },
    });
    const event = await prismaOne.outboxEvent.findFirstOrThrow({
      where: {
        aggregateId: payment.id,
        eventType: OutboxEventType.PAYMENT_RECEIVED,
      },
    });
    const postedBalance = BigInt(posted._sum.amount ?? 0);
    const activeReservedAmount = activeReservations.reduce(
      (total, reservation) => total + reservation.amount,
      BigInt(0),
    );

    expect(payment).toMatchObject({
      status: PaymentStatus.VALIDATED,
      failureCode: null,
      validationCode: null,
      failureReason: null,
    });
    expect(payment.validatedAt).toBeInstanceOf(Date);
    expect(existingReservations).toHaveLength(1);
    expect(existingReservations[0].amount).toBe(BigInt(7_000));
    expect(newReservations).toHaveLength(1);
    expect(newReservations[0].amount).toBe(BigInt(3_000));
    expect(existingEntries).toHaveLength(1);
    expect(existingEntries[0].entryKey).toBe(
      'reservation:existing-exact-balance-reservation',
    );
    expect(newEntries).toHaveLength(1);
    expect(newEntries[0].entryKey).toBe(
      'reservation:credit-using-exact-remaining-balance',
    );
    expect(activeReservations).toHaveLength(2);
    expect(usage.utilizedAmount).toBe(BigInt(10_000));
    expect(postedBalance).toBe(BigInt(10_000));
    expect(activeReservedAmount).toBe(BigInt(10_000));
    expect(postedBalance - activeReservedAmount).toBe(BigInt(0));
    expect(event).toMatchObject({
      status: OutboxEventStatus.PROCESSED,
      attempts: 1,
      lastError: null,
      claimedAt: null,
    });
    expect(event.processedAt).toBeInstanceOf(Date);
  });

  it('ignores active reservations belonging to a different funding account', async () => {
    const businessDate = new Date(Date.UTC(2026, 6, 29));
    await prismaOne.merchant.update({
      where: { id: 'merchant-1' },
      data: {
        perPaymentLimit: BigInt(30_000),
        dailyAmountLimit: BigInt(30_000),
      },
    });
    await prismaOne.ledgerEntry.update({
      where: { entryKey: 'initial-credit:merchant-1' },
      data: { amount: BigInt(10_000) },
    });
    const cadAccount = await prismaOne.fundingAccount.create({
      data: {
        id: 'funding-account-cad-isolation',
        merchantId: 'merchant-1',
        currency: 'CAD',
        status: FundingAccountStatus.ACTIVE,
      },
    });
    await prismaOne.ledgerEntry.create({
      data: {
        entryKey: 'initial-credit:merchant-1:CAD:isolation',
        fundingAccountId: cadAccount.id,
        entryType: 'INITIAL_CREDIT',
        amount: BigInt(20_000),
      },
    });
    await prismaOne.payment.create({
      data: {
        id: 'existing-cad-reservation',
        merchantId: 'merchant-1',
        idempotencyKey: 'existing-cad-reservation-idem',
        requestFingerprint: 'existing-cad-reservation-fingerprint',
        externalReference: 'existing-cad-reservation-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(18_000),
        currency: 'CAD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'existing-cad-reservation-account',
        routingNumber: '021000021',
        status: PaymentStatus.VALIDATED,
        validatedAt: businessDate,
        createdAt: businessDate,
      },
    });
    await prismaOne.reservation.create({
      data: {
        paymentId: 'existing-cad-reservation',
        fundingAccountId: cadAccount.id,
        amount: BigInt(18_000),
        status: ReservationStatus.ACTIVE,
      },
    });
    await prismaOne.ledgerEntry.create({
      data: {
        entryKey: 'reservation:existing-cad-reservation',
        fundingAccountId: cadAccount.id,
        paymentId: 'existing-cad-reservation',
        entryType: 'RESERVATION',
        amount: BigInt(18_000),
      },
    });
    await prismaOne.payment.create({
      data: {
        id: 'usd-credit-with-cad-reservation',
        merchantId: 'merchant-1',
        idempotencyKey: 'usd-credit-with-cad-reservation-idem',
        requestFingerprint: 'usd-credit-with-cad-reservation-fingerprint',
        externalReference: 'usd-credit-with-cad-reservation-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(4_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'usd-credit-with-cad-reservation-account',
        routingNumber: '021000021',
        createdAt: businessDate,
      },
    });
    await prismaOne.outboxEvent.create({
      data: {
        eventType: OutboxEventType.PAYMENT_RECEIVED,
        aggregateType: 'PAYMENT',
        aggregateId: 'usd-credit-with-cad-reservation',
        payload: {
          ...paymentPayload('usd-credit-with-cad-reservation'),
          direction: PaymentDirection.CREDIT,
          amountCents: '4000',
          createdAt: businessDate.toISOString(),
        },
        availableAt: new Date(0),
      },
    });

    await workerOne.processOnce();

    const payment = await prismaOne.payment.findUniqueOrThrow({
      where: { id: 'usd-credit-with-cad-reservation' },
    });
    const usdReservations = await prismaOne.reservation.findMany({
      where: {
        fundingAccountId: 'funding-account-1',
        status: ReservationStatus.ACTIVE,
      },
    });
    const usdEntries = await prismaOne.ledgerEntry.findMany({
      where: { paymentId: payment.id, entryType: 'RESERVATION' },
    });
    const cadReservations = await prismaOne.reservation.findMany({
      where: {
        fundingAccountId: cadAccount.id,
        status: ReservationStatus.ACTIVE,
      },
    });
    const cadEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        paymentId: 'existing-cad-reservation',
        entryType: 'RESERVATION',
      },
    });
    const usdPosted = await prismaOne.ledgerEntry.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        entryType: 'INITIAL_CREDIT',
      },
      _sum: { amount: true },
    });
    const cadPosted = await prismaOne.ledgerEntry.aggregate({
      where: { fundingAccountId: cadAccount.id, entryType: 'INITIAL_CREDIT' },
      _sum: { amount: true },
    });
    const usage = await prismaOne.merchantDailyUsage.findUniqueOrThrow({
      where: {
        merchantId_businessDate: { merchantId: 'merchant-1', businessDate },
      },
    });
    const event = await prismaOne.outboxEvent.findFirstOrThrow({
      where: {
        aggregateId: payment.id,
        eventType: OutboxEventType.PAYMENT_RECEIVED,
      },
    });
    const usdPostedBalance = BigInt(usdPosted._sum.amount ?? 0);
    const usdReservedAmount = usdReservations.reduce(
      (total, reservation) => total + reservation.amount,
      BigInt(0),
    );
    const cadPostedBalance = BigInt(cadPosted._sum.amount ?? 0);
    const cadReservedAmount = cadReservations.reduce(
      (total, reservation) => total + reservation.amount,
      BigInt(0),
    );

    expect(payment).toMatchObject({
      status: PaymentStatus.VALIDATED,
      failureCode: null,
      validationCode: null,
      failureReason: null,
    });
    expect(payment.validatedAt).toBeInstanceOf(Date);
    expect(usdReservations).toHaveLength(1);
    expect(usdReservations[0]).toMatchObject({
      paymentId: payment.id,
      amount: BigInt(4_000),
      fundingAccountId: 'funding-account-1',
    });
    expect(usdEntries).toHaveLength(1);
    expect(usdEntries[0]).toMatchObject({
      fundingAccountId: 'funding-account-1',
      entryKey: 'reservation:usd-credit-with-cad-reservation',
    });
    expect(usdPostedBalance).toBe(BigInt(10_000));
    expect(usdReservedAmount).toBe(BigInt(4_000));
    expect(usdPostedBalance - usdReservedAmount).toBe(BigInt(6_000));
    expect(cadReservations).toHaveLength(1);
    expect(cadReservations[0]).toMatchObject({
      paymentId: 'existing-cad-reservation',
      status: ReservationStatus.ACTIVE,
      amount: BigInt(18_000),
    });
    expect(cadEntries).toHaveLength(1);
    expect(cadEntries[0].entryKey).toBe('reservation:existing-cad-reservation');
    expect(cadPostedBalance).toBe(BigInt(20_000));
    expect(cadReservedAmount).toBe(BigInt(18_000));
    expect(cadPostedBalance - cadReservedAmount).toBe(BigInt(2_000));
    expect(usage.utilizedAmount).toBe(BigInt(4_000));
    expect(event).toMatchObject({
      status: OutboxEventStatus.PROCESSED,
      attempts: 1,
      lastError: null,
      claimedAt: null,
    });
    expect(event.processedAt).toBeInstanceOf(Date);
  });

  it('rejects ACH CREDIT when multiple active reservations together leave insufficient balance', async () => {
    const businessDate = new Date(Date.UTC(2026, 6, 29));
    await prismaOne.merchant.update({
      where: { id: 'merchant-1' },
      data: {
        perPaymentLimit: BigInt(20_000),
        dailyAmountLimit: BigInt(20_000),
      },
    });
    await prismaOne.ledgerEntry.update({
      where: { entryKey: 'initial-credit:merchant-1' },
      data: { amount: BigInt(10_000) },
    });

    await prismaOne.payment.createMany({
      data: [
        {
          id: 'existing-reservation-one',
          merchantId: 'merchant-1',
          idempotencyKey: 'existing-reservation-one-idem',
          requestFingerprint: 'existing-reservation-one-fingerprint',
          externalReference: 'existing-reservation-one-reference',
          direction: PaymentDirection.CREDIT,
          amountCents: BigInt(3_000),
          currency: 'USD',
          receiverName: 'Receiver Inc',
          receiverAccountRef: 'existing-reservation-one-account',
          routingNumber: '021000021',
          status: PaymentStatus.VALIDATED,
          validatedAt: businessDate,
          createdAt: businessDate,
        },
        {
          id: 'existing-reservation-two',
          merchantId: 'merchant-1',
          idempotencyKey: 'existing-reservation-two-idem',
          requestFingerprint: 'existing-reservation-two-fingerprint',
          externalReference: 'existing-reservation-two-reference',
          direction: PaymentDirection.CREDIT,
          amountCents: BigInt(4_000),
          currency: 'USD',
          receiverName: 'Receiver Inc',
          receiverAccountRef: 'existing-reservation-two-account',
          routingNumber: '021000021',
          status: PaymentStatus.VALIDATED,
          validatedAt: businessDate,
          createdAt: businessDate,
        },
      ],
    });
    await prismaOne.reservation.createMany({
      data: [
        {
          paymentId: 'existing-reservation-one',
          fundingAccountId: 'funding-account-1',
          amount: BigInt(3_000),
          status: ReservationStatus.ACTIVE,
        },
        {
          paymentId: 'existing-reservation-two',
          fundingAccountId: 'funding-account-1',
          amount: BigInt(4_000),
          status: ReservationStatus.ACTIVE,
        },
      ],
    });
    await prismaOne.ledgerEntry.createMany({
      data: [
        {
          entryKey: 'reservation:existing-reservation-one',
          fundingAccountId: 'funding-account-1',
          paymentId: 'existing-reservation-one',
          entryType: 'RESERVATION',
          amount: BigInt(3_000),
        },
        {
          entryKey: 'reservation:existing-reservation-two',
          fundingAccountId: 'funding-account-1',
          paymentId: 'existing-reservation-two',
          entryType: 'RESERVATION',
          amount: BigInt(4_000),
        },
      ],
    });
    await prismaOne.merchantDailyUsage.create({
      data: {
        merchantId: 'merchant-1',
        businessDate,
        utilizedAmount: BigInt(7_000),
      },
    });
    await prismaOne.payment.create({
      data: {
        id: 'credit-after-multiple-active-reservations',
        merchantId: 'merchant-1',
        idempotencyKey: 'credit-after-multiple-active-reservations-idem',
        requestFingerprint:
          'credit-after-multiple-active-reservations-fingerprint',
        externalReference:
          'credit-after-multiple-active-reservations-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(4_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'credit-after-multiple-active-reservations-account',
        routingNumber: '021000021',
        createdAt: businessDate,
      },
    });
    await prismaOne.outboxEvent.create({
      data: {
        eventType: OutboxEventType.PAYMENT_RECEIVED,
        aggregateType: 'PAYMENT',
        aggregateId: 'credit-after-multiple-active-reservations',
        payload: {
          ...paymentPayload('credit-after-multiple-active-reservations'),
          direction: PaymentDirection.CREDIT,
          amountCents: '4000',
          createdAt: businessDate.toISOString(),
        },
        availableAt: new Date(0),
      },
    });

    await workerOne.processOnce();

    const payment = await prismaOne.payment.findUniqueOrThrow({
      where: { id: 'credit-after-multiple-active-reservations' },
    });
    const firstReservation = await prismaOne.reservation.findMany({
      where: { paymentId: 'existing-reservation-one' },
    });
    const secondReservation = await prismaOne.reservation.findMany({
      where: { paymentId: 'existing-reservation-two' },
    });
    const existingEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        paymentId: {
          in: ['existing-reservation-one', 'existing-reservation-two'],
        },
        entryType: 'RESERVATION',
      },
      orderBy: { entryKey: 'asc' },
    });
    const newReservations = await prismaOne.reservation.findMany({
      where: { paymentId: payment.id },
    });
    const newEntries = await prismaOne.ledgerEntry.findMany({
      where: { paymentId: payment.id, entryType: 'RESERVATION' },
    });
    const usage = await prismaOne.merchantDailyUsage.findUniqueOrThrow({
      where: {
        merchantId_businessDate: { merchantId: 'merchant-1', businessDate },
      },
    });
    const posted = await prismaOne.ledgerEntry.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        entryType: 'INITIAL_CREDIT',
      },
      _sum: { amount: true },
    });
    const activeReservations = await prismaOne.reservation.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        status: ReservationStatus.ACTIVE,
      },
      _sum: { amount: true },
    });
    const event = await prismaOne.outboxEvent.findFirstOrThrow({
      where: {
        aggregateId: payment.id,
        eventType: OutboxEventType.PAYMENT_RECEIVED,
      },
    });
    const postedBalance = BigInt(posted._sum.amount ?? 0);
    const activeReservedAmount = BigInt(activeReservations._sum.amount ?? 0);

    expect(payment).toMatchObject({
      status: PaymentStatus.VALIDATION_FAILED,
      validatedAt: null,
      failureCode: 'INSUFFICIENT_FUNDS',
      validationCode: 'INSUFFICIENT_FUNDS',
    });
    expect(payment.failureReason).toContain('Available 3000');
    expect(payment.failureReason).toContain('requested 4000');
    expect(payment.failureReason).toContain('currency USD');
    expect(firstReservation).toHaveLength(1);
    expect(firstReservation[0]).toMatchObject({
      status: ReservationStatus.ACTIVE,
      amount: BigInt(3_000),
      fundingAccountId: 'funding-account-1',
    });
    expect(secondReservation).toHaveLength(1);
    expect(secondReservation[0]).toMatchObject({
      status: ReservationStatus.ACTIVE,
      amount: BigInt(4_000),
      fundingAccountId: 'funding-account-1',
    });
    expect(existingEntries).toHaveLength(2);
    expect(existingEntries.map((entry) => entry.entryKey)).toEqual([
      'reservation:existing-reservation-one',
      'reservation:existing-reservation-two',
    ]);
    expect(newReservations).toHaveLength(0);
    expect(newEntries).toHaveLength(0);
    expect(usage.utilizedAmount).toBe(BigInt(7_000));
    expect(postedBalance).toBe(BigInt(10_000));
    expect(activeReservedAmount).toBe(BigInt(7_000));
    expect(postedBalance - activeReservedAmount).toBe(BigInt(3_000));
    expect(event).toMatchObject({
      status: OutboxEventStatus.PROCESSED,
      attempts: 1,
      lastError: null,
      claimedAt: null,
    });
    expect(event.processedAt).toBeInstanceOf(Date);
  });

  it('validates ACH CREDIT using the combined balance from multiple posted ledger entries', async () => {
    const businessDate = new Date(Date.UTC(2026, 6, 29));
    await prismaOne.merchant.update({
      where: { id: 'merchant-1' },
      data: {
        perPaymentLimit: BigInt(20_000),
        dailyAmountLimit: BigInt(20_000),
      },
    });
    await prismaOne.ledgerEntry.update({
      where: { entryKey: 'initial-credit:merchant-1' },
      data: {
        entryKey: 'initial-credit:merchant-1:combined-posted',
        amount: BigInt(4_000),
      },
    });
    await prismaOne.ledgerEntry.create({
      data: {
        entryKey: 'credit-posted:merchant-1:combined-posted',
        fundingAccountId: 'funding-account-1',
        entryType: LedgerEntryType.CREDIT_POSTED,
        amount: BigInt(6_000),
      },
    });
    await prismaOne.payment.create({
      data: {
        id: 'credit-using-combined-posted-balance',
        merchantId: 'merchant-1',
        idempotencyKey: 'credit-using-combined-posted-balance-idem',
        requestFingerprint: 'credit-using-combined-posted-balance-fingerprint',
        externalReference: 'credit-using-combined-posted-balance-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(9_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'credit-using-combined-posted-balance-account',
        routingNumber: '021000021',
        createdAt: businessDate,
      },
    });
    await prismaOne.outboxEvent.create({
      data: {
        eventType: OutboxEventType.PAYMENT_RECEIVED,
        aggregateType: 'PAYMENT',
        aggregateId: 'credit-using-combined-posted-balance',
        payload: {
          ...paymentPayload('credit-using-combined-posted-balance'),
          direction: PaymentDirection.CREDIT,
          amountCents: '9000',
          createdAt: businessDate.toISOString(),
        },
        availableAt: new Date(0),
      },
    });

    await workerOne.processOnce();

    const payment = await prismaOne.payment.findUniqueOrThrow({
      where: { id: 'credit-using-combined-posted-balance' },
    });
    const postedEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        entryKey: {
          in: [
            'initial-credit:merchant-1:combined-posted',
            'credit-posted:merchant-1:combined-posted',
          ],
        },
      },
      orderBy: { entryKey: 'asc' },
    });
    const reservations = await prismaOne.reservation.findMany({
      where: { paymentId: payment.id, status: ReservationStatus.ACTIVE },
    });
    const reservationEntries = await prismaOne.ledgerEntry.findMany({
      where: { paymentId: payment.id, entryType: LedgerEntryType.RESERVATION },
    });
    const usage = await prismaOne.merchantDailyUsage.findUniqueOrThrow({
      where: {
        merchantId_businessDate: { merchantId: 'merchant-1', businessDate },
      },
    });
    const posted = await prismaOne.ledgerEntry.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        entryType: {
          in: [LedgerEntryType.INITIAL_CREDIT, LedgerEntryType.CREDIT_POSTED],
        },
      },
      _sum: { amount: true },
    });
    const activeReservations = await prismaOne.reservation.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        status: ReservationStatus.ACTIVE,
      },
      _sum: { amount: true },
    });
    const event = await prismaOne.outboxEvent.findFirstOrThrow({
      where: {
        aggregateId: payment.id,
        eventType: OutboxEventType.PAYMENT_RECEIVED,
      },
    });
    const postedBalance = BigInt(posted._sum.amount ?? 0);
    const activeReservedAmount = BigInt(activeReservations._sum.amount ?? 0);

    expect(payment).toMatchObject({
      status: PaymentStatus.VALIDATED,
      failureCode: null,
      validationCode: null,
      failureReason: null,
    });
    expect(payment.validatedAt).toBeInstanceOf(Date);
    expect(postedEntries).toHaveLength(2);
    expect(postedEntries).toEqual([
      expect.objectContaining({
        entryKey: 'credit-posted:merchant-1:combined-posted',
        entryType: LedgerEntryType.CREDIT_POSTED,
        amount: BigInt(6_000),
      }),
      expect.objectContaining({
        entryKey: 'initial-credit:merchant-1:combined-posted',
        entryType: LedgerEntryType.INITIAL_CREDIT,
        amount: BigInt(4_000),
      }),
    ]);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({
      fundingAccountId: 'funding-account-1',
      amount: BigInt(9_000),
      status: ReservationStatus.ACTIVE,
    });
    expect(reservationEntries).toHaveLength(1);
    expect(reservationEntries[0]).toMatchObject({
      entryKey: 'reservation:credit-using-combined-posted-balance',
      fundingAccountId: 'funding-account-1',
      amount: BigInt(9_000),
    });
    expect(usage.utilizedAmount).toBe(BigInt(9_000));
    expect(postedBalance).toBe(BigInt(10_000));
    expect(activeReservedAmount).toBe(BigInt(9_000));
    expect(postedBalance - activeReservedAmount).toBe(BigInt(1_000));
    expect(event).toMatchObject({
      status: OutboxEventStatus.PROCESSED,
      attempts: 1,
      lastError: null,
      claimedAt: null,
    });
    expect(event.processedAt).toBeInstanceOf(Date);
  });

  it('rejects ACH CREDIT when a negative posted ledger entry reduces available funding', async () => {
    const businessDate = new Date(Date.UTC(2026, 6, 29));
    await prismaOne.merchant.update({
      where: { id: 'merchant-1' },
      data: {
        perPaymentLimit: BigInt(20_000),
        dailyAmountLimit: BigInt(20_000),
      },
    });
    await prismaOne.ledgerEntry.update({
      where: { entryKey: 'initial-credit:merchant-1' },
      data: {
        entryKey: 'initial-credit:merchant-1:negative-posted',
        amount: BigInt(10_000),
      },
    });
    await prismaOne.ledgerEntry.create({
      data: {
        entryKey: 'debit-posted:merchant-1:negative-posted',
        fundingAccountId: 'funding-account-1',
        entryType: LedgerEntryType.DEBIT_POSTED,
        amount: BigInt(3_000),
      },
    });
    await prismaOne.payment.create({
      data: {
        id: 'credit-after-negative-posted-entry',
        merchantId: 'merchant-1',
        idempotencyKey: 'credit-after-negative-posted-entry-idem',
        requestFingerprint: 'credit-after-negative-posted-entry-fingerprint',
        externalReference: 'credit-after-negative-posted-entry-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(8_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'credit-after-negative-posted-entry-account',
        routingNumber: '021000021',
        createdAt: businessDate,
      },
    });
    await prismaOne.outboxEvent.create({
      data: {
        eventType: OutboxEventType.PAYMENT_RECEIVED,
        aggregateType: 'PAYMENT',
        aggregateId: 'credit-after-negative-posted-entry',
        payload: {
          ...paymentPayload('credit-after-negative-posted-entry'),
          direction: PaymentDirection.CREDIT,
          amountCents: '8000',
          createdAt: businessDate.toISOString(),
        },
        availableAt: new Date(0),
      },
    });

    await workerOne.processOnce();

    const payment = await prismaOne.payment.findUniqueOrThrow({
      where: { id: 'credit-after-negative-posted-entry' },
    });
    const postedEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        entryKey: {
          in: [
            'initial-credit:merchant-1:negative-posted',
            'debit-posted:merchant-1:negative-posted',
          ],
        },
      },
      orderBy: { entryKey: 'asc' },
    });
    const reservations = await prismaOne.reservation.findMany({
      where: { paymentId: payment.id },
    });
    const reservationEntries = await prismaOne.ledgerEntry.findMany({
      where: { paymentId: payment.id, entryType: LedgerEntryType.RESERVATION },
    });
    const usage = await prismaOne.merchantDailyUsage.count({
      where: { merchantId: 'merchant-1', businessDate },
    });
    const balances = await prismaOne.$queryRaw<{ total: bigint | null }[]>(
      Prisma.sql`SELECT COALESCE(SUM(CASE WHEN "entryType" IN ('INITIAL_CREDIT'::"LedgerEntryType", 'CREDIT_POSTED'::"LedgerEntryType", 'RETURN'::"LedgerEntryType", 'REVERSAL'::"LedgerEntryType", 'ADJUSTMENT'::"LedgerEntryType") THEN "amount" WHEN "entryType" = 'DEBIT_POSTED'::"LedgerEntryType" THEN -"amount" ELSE 0 END), 0) AS total FROM "LedgerEntry" WHERE "fundingAccountId" = ${'funding-account-1'}`,
    );
    const activeReservations = await prismaOne.reservation.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        status: ReservationStatus.ACTIVE,
      },
      _sum: { amount: true },
    });
    const event = await prismaOne.outboxEvent.findFirstOrThrow({
      where: {
        aggregateId: payment.id,
        eventType: OutboxEventType.PAYMENT_RECEIVED,
      },
    });
    const postedBalance = BigInt(balances[0]?.total ?? 0);
    const activeReservedAmount = BigInt(activeReservations._sum.amount ?? 0);

    expect(payment).toMatchObject({
      status: PaymentStatus.VALIDATION_FAILED,
      validatedAt: null,
      failureCode: 'INSUFFICIENT_FUNDS',
      validationCode: 'INSUFFICIENT_FUNDS',
    });
    expect(payment.failureReason).toContain('Available 7000');
    expect(payment.failureReason).toContain('requested 8000');
    expect(payment.failureReason).toContain('currency USD');
    expect(postedEntries).toHaveLength(2);
    expect(postedEntries).toEqual([
      expect.objectContaining({
        entryKey: 'debit-posted:merchant-1:negative-posted',
        entryType: LedgerEntryType.DEBIT_POSTED,
        amount: BigInt(3_000),
      }),
      expect.objectContaining({
        entryKey: 'initial-credit:merchant-1:negative-posted',
        entryType: LedgerEntryType.INITIAL_CREDIT,
        amount: BigInt(10_000),
      }),
    ]);
    expect(reservations).toHaveLength(0);
    expect(reservationEntries).toHaveLength(0);
    expect(usage).toBe(0);
    expect(postedBalance).toBe(BigInt(7_000));
    expect(activeReservedAmount).toBe(BigInt(0));
    expect(postedBalance - activeReservedAmount).toBe(BigInt(7_000));
    expect(event).toMatchObject({
      status: OutboxEventStatus.PROCESSED,
      attempts: 1,
      lastError: null,
      claimedAt: null,
    });
    expect(event.processedAt).toBeInstanceOf(Date);
  });

  it('validates ACH CREDIT using the net balance after posted debits and credits', async () => {
    const businessDate = new Date(Date.UTC(2026, 6, 29));
    await prismaOne.merchant.update({
      where: { id: 'merchant-1' },
      data: {
        perPaymentLimit: BigInt(20_000),
        dailyAmountLimit: BigInt(20_000),
      },
    });
    await prismaOne.ledgerEntry.update({
      where: { entryKey: 'initial-credit:merchant-1' },
      data: {
        entryKey: 'initial-credit:merchant-1:net-posted-history',
        amount: BigInt(10_000),
      },
    });
    await prismaOne.ledgerEntry.createMany({
      data: [
        {
          entryKey: 'debit-posted:merchant-1:net-posted-history',
          fundingAccountId: 'funding-account-1',
          entryType: LedgerEntryType.DEBIT_POSTED,
          amount: BigInt(7_000),
        },
        {
          entryKey: 'credit-posted:merchant-1:net-posted-history',
          fundingAccountId: 'funding-account-1',
          entryType: LedgerEntryType.CREDIT_POSTED,
          amount: BigInt(4_000),
        },
      ],
    });
    await prismaOne.payment.create({
      data: {
        id: 'credit-using-net-posted-history',
        merchantId: 'merchant-1',
        idempotencyKey: 'credit-using-net-posted-history-idem',
        requestFingerprint: 'credit-using-net-posted-history-fingerprint',
        externalReference: 'credit-using-net-posted-history-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(7_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'credit-using-net-posted-history-account',
        routingNumber: '021000021',
        createdAt: businessDate,
      },
    });
    await prismaOne.outboxEvent.create({
      data: {
        eventType: OutboxEventType.PAYMENT_RECEIVED,
        aggregateType: 'PAYMENT',
        aggregateId: 'credit-using-net-posted-history',
        payload: {
          ...paymentPayload('credit-using-net-posted-history'),
          direction: PaymentDirection.CREDIT,
          amountCents: '7000',
          createdAt: businessDate.toISOString(),
        },
        availableAt: new Date(0),
      },
    });

    await workerOne.processOnce();

    const payment = await prismaOne.payment.findUniqueOrThrow({
      where: { id: 'credit-using-net-posted-history' },
    });
    const postedEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        entryKey: {
          in: [
            'initial-credit:merchant-1:net-posted-history',
            'debit-posted:merchant-1:net-posted-history',
            'credit-posted:merchant-1:net-posted-history',
          ],
        },
      },
      orderBy: { entryKey: 'asc' },
    });
    const reservations = await prismaOne.reservation.findMany({
      where: { paymentId: payment.id, status: ReservationStatus.ACTIVE },
    });
    const reservationEntries = await prismaOne.ledgerEntry.findMany({
      where: { paymentId: payment.id, entryType: LedgerEntryType.RESERVATION },
    });
    const usage = await prismaOne.merchantDailyUsage.findUniqueOrThrow({
      where: {
        merchantId_businessDate: { merchantId: 'merchant-1', businessDate },
      },
    });
    const balances = await prismaOne.$queryRaw<{ total: bigint | null }[]>(
      Prisma.sql`SELECT COALESCE(SUM(CASE WHEN "entryType" IN ('INITIAL_CREDIT'::"LedgerEntryType", 'CREDIT_POSTED'::"LedgerEntryType", 'RETURN'::"LedgerEntryType", 'REVERSAL'::"LedgerEntryType", 'ADJUSTMENT'::"LedgerEntryType") THEN "amount" WHEN "entryType" = 'DEBIT_POSTED'::"LedgerEntryType" THEN -"amount" ELSE 0 END), 0) AS total FROM "LedgerEntry" WHERE "fundingAccountId" = ${'funding-account-1'}`,
    );
    const activeReservations = await prismaOne.reservation.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        status: ReservationStatus.ACTIVE,
      },
      _sum: { amount: true },
    });
    const event = await prismaOne.outboxEvent.findFirstOrThrow({
      where: {
        aggregateId: payment.id,
        eventType: OutboxEventType.PAYMENT_RECEIVED,
      },
    });
    const postedBalance = BigInt(balances[0]?.total ?? 0);
    const activeReservedAmount = BigInt(activeReservations._sum.amount ?? 0);

    expect(payment).toMatchObject({
      status: PaymentStatus.VALIDATED,
      failureCode: null,
      validationCode: null,
      failureReason: null,
    });
    expect(payment.validatedAt).toBeInstanceOf(Date);
    expect(postedEntries).toHaveLength(3);
    expect(postedEntries).toEqual([
      expect.objectContaining({
        entryKey: 'credit-posted:merchant-1:net-posted-history',
        entryType: LedgerEntryType.CREDIT_POSTED,
        amount: BigInt(4_000),
      }),
      expect.objectContaining({
        entryKey: 'debit-posted:merchant-1:net-posted-history',
        entryType: LedgerEntryType.DEBIT_POSTED,
        amount: BigInt(7_000),
      }),
      expect.objectContaining({
        entryKey: 'initial-credit:merchant-1:net-posted-history',
        entryType: LedgerEntryType.INITIAL_CREDIT,
        amount: BigInt(10_000),
      }),
    ]);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({
      fundingAccountId: 'funding-account-1',
      amount: BigInt(7_000),
      status: ReservationStatus.ACTIVE,
    });
    expect(reservationEntries).toHaveLength(1);
    expect(reservationEntries[0]).toMatchObject({
      entryKey: 'reservation:credit-using-net-posted-history',
      fundingAccountId: 'funding-account-1',
      amount: BigInt(7_000),
    });
    expect(usage.utilizedAmount).toBe(BigInt(7_000));
    expect(postedBalance).toBe(BigInt(7_000));
    expect(activeReservedAmount).toBe(BigInt(7_000));
    expect(postedBalance - activeReservedAmount).toBe(BigInt(0));
    expect(event).toMatchObject({
      status: OutboxEventStatus.PROCESSED,
      attempts: 1,
      lastError: null,
      claimedAt: null,
    });
    expect(event.processedAt).toBeInstanceOf(Date);
  });

  it('rejects a duplicate ledger entry key without modifying the original entry', async () => {
    await prismaOne.ledgerEntry.deleteMany({
      where: { fundingAccountId: 'funding-account-1' },
    });
    const original = await prismaOne.ledgerEntry.create({
      data: {
        id: 'duplicate-ledger-original',
        entryKey: 'duplicate-ledger-key-test',
        fundingAccountId: 'funding-account-1',
        entryType: LedgerEntryType.INITIAL_CREDIT,
        amount: BigInt(10_000),
      },
    });
    let error: unknown;

    try {
      await prismaOne.ledgerEntry.create({
        data: {
          id: 'duplicate-ledger-attempt',
          entryKey: 'duplicate-ledger-key-test',
          fundingAccountId: 'funding-account-1',
          entryType: LedgerEntryType.INITIAL_CREDIT,
          amount: BigInt(5_000),
        },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    const prismaError = error as Prisma.PrismaClientKnownRequestError;
    expect(prismaError.code).toBe('P2002');
    if (prismaError.meta?.target) {
      expect(prismaError.meta.target).toEqual(
        expect.arrayContaining(['entryKey']),
      );
    }

    const entries = await prismaOne.ledgerEntry.findMany({
      where: { entryKey: 'duplicate-ledger-key-test' },
    });
    const duplicate = await prismaOne.ledgerEntry.findUnique({
      where: { id: 'duplicate-ledger-attempt' },
    });
    const account = await prismaOne.fundingAccount.findUniqueOrThrow({
      where: {
        merchantId_currency: { merchantId: 'merchant-1', currency: 'USD' },
      },
    });
    const posted = await prismaOne.ledgerEntry.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        entryType: LedgerEntryType.INITIAL_CREDIT,
      },
      _sum: { amount: true },
    });
    const postedBalance = BigInt(posted._sum.amount ?? 0);

    expect(entries).toEqual([
      expect.objectContaining({
        id: original.id,
        entryKey: 'duplicate-ledger-key-test',
        fundingAccountId: 'funding-account-1',
        entryType: LedgerEntryType.INITIAL_CREDIT,
        amount: BigInt(10_000),
      }),
    ]);
    expect(account.currency).toBe('USD');
    expect(duplicate).toBeNull();
    expect(await prismaOne.ledgerEntry.count()).toBe(1);
    expect(postedBalance).toBe(BigInt(10_000));
    expect(await prismaOne.reservation.count()).toBe(0);
  });

  it('rejects a second reservation for the same payment without changing the original hold', async () => {
    const businessDate = new Date(Date.UTC(2026, 6, 29));
    await prismaOne.ledgerEntry.update({
      where: { entryKey: 'initial-credit:merchant-1' },
      data: { amount: BigInt(10_000) },
    });
    await prismaOne.payment.create({
      data: {
        id: 'duplicate-reservation-payment',
        merchantId: 'merchant-1',
        idempotencyKey: 'duplicate-reservation-payment-idem',
        requestFingerprint: 'duplicate-reservation-payment-fingerprint',
        externalReference: 'duplicate-reservation-payment-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(4_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'duplicate-reservation-payment-account',
        routingNumber: '021000021',
        status: PaymentStatus.VALIDATED,
        validatedAt: businessDate,
        createdAt: businessDate,
      },
    });
    const original = await prismaOne.reservation.create({
      data: {
        id: 'duplicate-reservation-original',
        paymentId: 'duplicate-reservation-payment',
        fundingAccountId: 'funding-account-1',
        amount: BigInt(4_000),
        status: ReservationStatus.ACTIVE,
      },
    });
    await prismaOne.ledgerEntry.create({
      data: {
        entryKey: 'reservation:duplicate-reservation-payment',
        fundingAccountId: 'funding-account-1',
        paymentId: 'duplicate-reservation-payment',
        entryType: LedgerEntryType.RESERVATION,
        amount: BigInt(4_000),
      },
    });
    let error: unknown;

    try {
      await prismaOne.reservation.create({
        data: {
          id: 'duplicate-reservation-attempt',
          paymentId: 'duplicate-reservation-payment',
          fundingAccountId: 'funding-account-1',
          amount: BigInt(5_000),
          status: ReservationStatus.ACTIVE,
        },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    const prismaError = error as Prisma.PrismaClientKnownRequestError;
    expect(prismaError.code).toBe('P2002');
    if (prismaError.meta?.target) {
      expect(prismaError.meta.target).toEqual(
        expect.arrayContaining(['paymentId']),
      );
    }

    const reservations = await prismaOne.reservation.findMany({
      where: { paymentId: 'duplicate-reservation-payment' },
    });
    const duplicate = await prismaOne.reservation.findUnique({
      where: { id: 'duplicate-reservation-attempt' },
    });
    const reservationEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        paymentId: 'duplicate-reservation-payment',
        entryType: LedgerEntryType.RESERVATION,
      },
    });
    const posted = await prismaOne.ledgerEntry.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        entryType: LedgerEntryType.INITIAL_CREDIT,
      },
      _sum: { amount: true },
    });
    const activeReservations = await prismaOne.reservation.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        status: ReservationStatus.ACTIVE,
      },
      _sum: { amount: true },
    });
    const postedBalance = BigInt(posted._sum.amount ?? 0);
    const activeReservedAmount = BigInt(activeReservations._sum.amount ?? 0);

    expect(reservations).toEqual([
      expect.objectContaining({
        id: original.id,
        amount: BigInt(4_000),
        status: ReservationStatus.ACTIVE,
        fundingAccountId: 'funding-account-1',
      }),
    ]);
    expect(duplicate).toBeNull();
    expect(reservationEntries).toEqual([
      expect.objectContaining({
        entryKey: 'reservation:duplicate-reservation-payment',
        amount: BigInt(4_000),
      }),
    ]);
    expect(postedBalance).toBe(BigInt(10_000));
    expect(activeReservedAmount).toBe(BigInt(4_000));
    expect(postedBalance - activeReservedAmount).toBe(BigInt(6_000));
    expect(await prismaOne.reservation.count()).toBe(1);
    expect(
      await prismaOne.reservation.count({
        where: {
          fundingAccountId: 'funding-account-1',
          status: ReservationStatus.ACTIVE,
        },
      }),
    ).toBe(1);
  });

  it('rejects a second reservation for a payment after the original reservation is released', async () => {
    const businessDate = new Date(Date.UTC(2026, 6, 29));
    await prismaOne.ledgerEntry.update({
      where: { entryKey: 'initial-credit:merchant-1' },
      data: { amount: BigInt(10_000) },
    });
    await prismaOne.payment.create({
      data: {
        id: 'released-duplicate-reservation-payment',
        merchantId: 'merchant-1',
        idempotencyKey: 'released-duplicate-reservation-payment-idem',
        requestFingerprint:
          'released-duplicate-reservation-payment-fingerprint',
        externalReference: 'released-duplicate-reservation-payment-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(4_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'released-duplicate-reservation-payment-account',
        routingNumber: '021000021',
        status: PaymentStatus.VALIDATED,
        validatedAt: businessDate,
        createdAt: businessDate,
      },
    });
    const original = await prismaOne.reservation.create({
      data: {
        id: 'released-reservation-original',
        paymentId: 'released-duplicate-reservation-payment',
        fundingAccountId: 'funding-account-1',
        amount: BigInt(4_000),
        status: ReservationStatus.RELEASED,
        releasedAt: businessDate,
      },
    });
    await prismaOne.ledgerEntry.create({
      data: {
        entryKey: 'reservation:released-duplicate-reservation-payment',
        fundingAccountId: 'funding-account-1',
        paymentId: 'released-duplicate-reservation-payment',
        entryType: LedgerEntryType.RESERVATION,
        amount: BigInt(4_000),
      },
    });
    let error: unknown;

    try {
      await prismaOne.reservation.create({
        data: {
          id: 'released-reservation-attempt',
          paymentId: 'released-duplicate-reservation-payment',
          fundingAccountId: 'funding-account-1',
          amount: BigInt(5_000),
          status: ReservationStatus.ACTIVE,
        },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    const prismaError = error as Prisma.PrismaClientKnownRequestError;
    expect(prismaError.code).toBe('P2002');
    if (prismaError.meta?.target) {
      expect(prismaError.meta.target).toEqual(
        expect.arrayContaining(['paymentId']),
      );
    }

    const reservations = await prismaOne.reservation.findMany({
      where: { paymentId: 'released-duplicate-reservation-payment' },
    });
    const duplicate = await prismaOne.reservation.findUnique({
      where: { id: 'released-reservation-attempt' },
    });
    const reservationEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        paymentId: 'released-duplicate-reservation-payment',
        entryType: LedgerEntryType.RESERVATION,
      },
    });
    const posted = await prismaOne.ledgerEntry.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        entryType: LedgerEntryType.INITIAL_CREDIT,
      },
      _sum: { amount: true },
    });
    const activeReservations = await prismaOne.reservation.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        status: ReservationStatus.ACTIVE,
      },
      _sum: { amount: true },
    });
    const postedBalance = BigInt(posted._sum.amount ?? 0);
    const activeReservedAmount = BigInt(activeReservations._sum.amount ?? 0);

    expect(reservations).toEqual([
      expect.objectContaining({
        id: original.id,
        amount: BigInt(4_000),
        status: ReservationStatus.RELEASED,
        fundingAccountId: 'funding-account-1',
        releasedAt: businessDate,
      }),
    ]);
    expect(duplicate).toBeNull();
    expect(reservationEntries).toEqual([
      expect.objectContaining({
        entryKey: 'reservation:released-duplicate-reservation-payment',
        amount: BigInt(4_000),
      }),
    ]);
    expect(postedBalance).toBe(BigInt(10_000));
    expect(activeReservedAmount).toBe(BigInt(0));
    expect(postedBalance - activeReservedAmount).toBe(BigInt(10_000));
    expect(await prismaOne.reservation.count()).toBe(1);
  });

  it('releasing an already released reservation is idempotent', async () => {
    const businessDate = new Date(Date.UTC(2026, 6, 29));
    await prismaOne.ledgerEntry.update({
      where: { entryKey: 'initial-credit:merchant-1' },
      data: { amount: BigInt(10_000) },
    });
    await prismaOne.payment.create({
      data: {
        id: 'idempotent-release-payment',
        merchantId: 'merchant-1',
        idempotencyKey: 'idempotent-release-payment-idem',
        requestFingerprint: 'idempotent-release-payment-fingerprint',
        externalReference: 'idempotent-release-payment-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(4_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'idempotent-release-payment-account',
        routingNumber: '021000021',
        status: PaymentStatus.VALIDATED,
        validatedAt: businessDate,
        createdAt: businessDate,
      },
    });
    await prismaOne.reservation.create({
      data: {
        id: 'idempotent-release-reservation',
        paymentId: 'idempotent-release-payment',
        fundingAccountId: 'funding-account-1',
        amount: BigInt(4_000),
        status: ReservationStatus.ACTIVE,
      },
    });
    await prismaOne.ledgerEntry.create({
      data: {
        entryKey: 'reservation:idempotent-release-payment',
        fundingAccountId: 'funding-account-1',
        paymentId: 'idempotent-release-payment',
        entryType: LedgerEntryType.RESERVATION,
        amount: BigInt(4_000),
      },
    });
    const lifecycle = new PaymentLifecycleRepository(prismaOne);
    const usageBefore = await prismaOne.merchantDailyUsage.count();
    const outboxBefore = await prismaOne.outboxEvent.count();

    const firstRelease = await lifecycle.releaseReservationForPayment(
      'idempotent-release-payment',
    );
    const reservationAfterFirst = await prismaOne.reservation.findUniqueOrThrow(
      {
        where: { paymentId: 'idempotent-release-payment' },
      },
    );
    const releaseEntriesAfterFirst = await prismaOne.ledgerEntry.findMany({
      where: {
        paymentId: 'idempotent-release-payment',
        entryType: LedgerEntryType.RESERVATION_RELEASE,
      },
    });

    const secondRelease = await lifecycle.releaseReservationForPayment(
      'idempotent-release-payment',
    );
    const reservations = await prismaOne.reservation.findMany({
      where: { paymentId: 'idempotent-release-payment' },
    });
    const originalEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        paymentId: 'idempotent-release-payment',
        entryType: LedgerEntryType.RESERVATION,
      },
    });
    const releaseEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        paymentId: 'idempotent-release-payment',
        entryType: LedgerEntryType.RESERVATION_RELEASE,
      },
    });
    const posted = await prismaOne.ledgerEntry.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        entryType: LedgerEntryType.INITIAL_CREDIT,
      },
      _sum: { amount: true },
    });
    const activeReservations = await prismaOne.reservation.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        status: ReservationStatus.ACTIVE,
      },
      _sum: { amount: true },
    });
    const postedBalance = BigInt(posted._sum.amount ?? 0);
    const activeReservedAmount = BigInt(activeReservations._sum.amount ?? 0);

    expect(firstRelease).toMatchObject({
      id: 'idempotent-release-reservation',
      status: ReservationStatus.RELEASED,
      amount: BigInt(4_000),
    });
    expect(firstRelease.releasedAt).toBeInstanceOf(Date);
    expect(reservationAfterFirst.releasedAt).toEqual(firstRelease.releasedAt);
    expect(releaseEntriesAfterFirst).toEqual([
      expect.objectContaining({
        entryKey: 'reservation-release:idempotent-release-payment',
        amount: BigInt(4_000),
        fundingAccountId: 'funding-account-1',
      }),
    ]);
    expect(secondRelease).toEqual(reservationAfterFirst);
    expect(reservations).toEqual([
      expect.objectContaining({
        id: 'idempotent-release-reservation',
        amount: BigInt(4_000),
        status: ReservationStatus.RELEASED,
        fundingAccountId: 'funding-account-1',
        releasedAt: firstRelease.releasedAt,
      }),
    ]);
    expect(originalEntries).toEqual([
      expect.objectContaining({
        entryKey: 'reservation:idempotent-release-payment',
        amount: BigInt(4_000),
      }),
    ]);
    expect(releaseEntries).toEqual([
      expect.objectContaining({
        entryKey: 'reservation-release:idempotent-release-payment',
        amount: BigInt(4_000),
      }),
    ]);
    expect(await prismaOne.merchantDailyUsage.count()).toBe(usageBefore);
    expect(await prismaOne.outboxEvent.count()).toBe(outboxBefore);
    expect(await prismaOne.payment.count()).toBe(1);
    expect(postedBalance).toBe(BigInt(10_000));
    expect(activeReservedAmount).toBe(BigInt(0));
    expect(postedBalance - activeReservedAmount).toBe(BigInt(10_000));
  });

  it('releases the same reservation concurrently exactly once', async () => {
    const businessDate = new Date(Date.UTC(2026, 6, 29));
    await prismaOne.ledgerEntry.update({
      where: { entryKey: 'initial-credit:merchant-1' },
      data: { amount: BigInt(10_000) },
    });
    await prismaOne.payment.create({
      data: {
        id: 'concurrent-release-payment',
        merchantId: 'merchant-1',
        idempotencyKey: 'concurrent-release-payment-idem',
        requestFingerprint: 'concurrent-release-payment-fingerprint',
        externalReference: 'concurrent-release-payment-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(4_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'concurrent-release-payment-account',
        routingNumber: '021000021',
        status: PaymentStatus.VALIDATED,
        validatedAt: businessDate,
        createdAt: businessDate,
      },
    });
    await prismaOne.reservation.create({
      data: {
        id: 'concurrent-release-reservation',
        paymentId: 'concurrent-release-payment',
        fundingAccountId: 'funding-account-1',
        amount: BigInt(4_000),
        status: ReservationStatus.ACTIVE,
      },
    });
    await prismaOne.ledgerEntry.create({
      data: {
        entryKey: 'reservation:concurrent-release-payment',
        fundingAccountId: 'funding-account-1',
        paymentId: 'concurrent-release-payment',
        entryType: LedgerEntryType.RESERVATION,
        amount: BigInt(4_000),
      },
    });
    const activeBefore = await prismaOne.reservation.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        status: ReservationStatus.ACTIVE,
      },
      _sum: { amount: true },
    });
    const usageBefore = await prismaOne.merchantDailyUsage.count();
    const outboxBefore = await prismaOne.outboxEvent.count();
    expect(BigInt(activeBefore._sum.amount ?? 0)).toBe(BigInt(4_000));
    expect(BigInt(10_000) - BigInt(activeBefore._sum.amount ?? 0)).toBe(
      BigInt(6_000),
    );
    expect(
      await prismaOne.ledgerEntry.count({
        where: {
          paymentId: 'concurrent-release-payment',
          entryType: LedgerEntryType.RESERVATION_RELEASE,
        },
      }),
    ).toBe(0);

    const lifecycleOne = new PaymentLifecycleRepository(prismaOne);
    const lifecycleTwo = new PaymentLifecycleRepository(prismaTwo);
    const firstReleasePromise = lifecycleOne.releaseReservationForPayment(
      'concurrent-release-payment',
    );
    const secondReleasePromise = lifecycleTwo.releaseReservationForPayment(
      'concurrent-release-payment',
    );
    const [firstRelease, secondRelease] = await Promise.all([
      firstReleasePromise,
      secondReleasePromise,
    ]);

    const reservations = await prismaOne.reservation.findMany({
      where: { paymentId: 'concurrent-release-payment' },
    });
    const originalEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        paymentId: 'concurrent-release-payment',
        entryType: LedgerEntryType.RESERVATION,
      },
    });
    const releaseEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        paymentId: 'concurrent-release-payment',
        entryType: LedgerEntryType.RESERVATION_RELEASE,
      },
    });
    const posted = await prismaOne.ledgerEntry.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        entryType: LedgerEntryType.INITIAL_CREDIT,
      },
      _sum: { amount: true },
    });
    const activeReservations = await prismaOne.reservation.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        status: ReservationStatus.ACTIVE,
      },
      _sum: { amount: true },
    });
    const postedBalance = BigInt(posted._sum.amount ?? 0);
    const activeReservedAmount = BigInt(activeReservations._sum.amount ?? 0);

    expect(firstRelease).toMatchObject({
      id: 'concurrent-release-reservation',
      status: ReservationStatus.RELEASED,
    });
    expect(secondRelease).toMatchObject({
      id: 'concurrent-release-reservation',
      status: ReservationStatus.RELEASED,
    });
    expect(firstRelease.releasedAt).toBeInstanceOf(Date);
    expect(secondRelease.releasedAt).toEqual(firstRelease.releasedAt);
    expect(reservations).toEqual([
      expect.objectContaining({
        id: 'concurrent-release-reservation',
        paymentId: 'concurrent-release-payment',
        amount: BigInt(4_000),
        status: ReservationStatus.RELEASED,
        releasedAt: firstRelease.releasedAt,
      }),
    ]);
    expect(originalEntries).toEqual([
      expect.objectContaining({
        entryKey: 'reservation:concurrent-release-payment',
        amount: BigInt(4_000),
      }),
    ]);
    expect(releaseEntries).toEqual([
      expect.objectContaining({
        entryKey: 'reservation-release:concurrent-release-payment',
        amount: BigInt(4_000),
      }),
    ]);
    expect(originalEntries.length + releaseEntries.length).toBe(2);
    expect(await prismaOne.merchantDailyUsage.count()).toBe(usageBefore);
    expect(await prismaOne.outboxEvent.count()).toBe(outboxBefore);
    expect(postedBalance).toBe(BigInt(10_000));
    expect(activeReservedAmount).toBe(BigInt(0));
    expect(postedBalance - activeReservedAmount).toBe(BigInt(10_000));
  });

  it('does not create financial state when releasing a payment with no reservation', async () => {
    const businessDate = new Date(Date.UTC(2026, 6, 29));
    await prismaOne.ledgerEntry.update({
      where: { entryKey: 'initial-credit:merchant-1' },
      data: { amount: BigInt(10_000) },
    });
    await prismaOne.payment.create({
      data: {
        id: 'release-without-reservation',
        merchantId: 'merchant-1',
        idempotencyKey: 'release-without-reservation-idem',
        requestFingerprint: 'release-without-reservation-fingerprint',
        externalReference: 'release-without-reservation-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(4_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'release-without-reservation-account',
        routingNumber: '021000021',
        status: PaymentStatus.VALIDATED,
        validatedAt: businessDate,
        createdAt: businessDate,
      },
    });
    const lifecycle = new PaymentLifecycleRepository(prismaOne);
    const paymentBefore = await prismaOne.payment.findUniqueOrThrow({
      where: { id: 'release-without-reservation' },
    });
    const usageBefore = await prismaOne.merchantDailyUsage.count();
    const outboxBefore = await prismaOne.outboxEvent.count();
    let error: unknown;

    try {
      await lifecycle.releaseReservationForPayment(
        'release-without-reservation',
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(OutboxProcessingError);
    expect((error as OutboxProcessingError).safeMessage).toBe(
      'Reservation not found for payment',
    );
    const paymentAfter = await prismaOne.payment.findUniqueOrThrow({
      where: { id: 'release-without-reservation' },
    });
    const reservations = await prismaOne.reservation.count({
      where: { paymentId: 'release-without-reservation' },
    });
    const reservationEntries = await prismaOne.ledgerEntry.count({
      where: {
        paymentId: 'release-without-reservation',
        entryType: LedgerEntryType.RESERVATION,
      },
    });
    const releaseEntries = await prismaOne.ledgerEntry.count({
      where: {
        paymentId: 'release-without-reservation',
        entryType: LedgerEntryType.RESERVATION_RELEASE,
      },
    });
    const posted = await prismaOne.ledgerEntry.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        entryType: LedgerEntryType.INITIAL_CREDIT,
      },
      _sum: { amount: true },
    });
    const activeReservations = await prismaOne.reservation.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        status: ReservationStatus.ACTIVE,
      },
      _sum: { amount: true },
    });
    const postedBalance = BigInt(posted._sum.amount ?? 0);
    const activeReservedAmount = BigInt(activeReservations._sum.amount ?? 0);

    expect(paymentAfter).toEqual(paymentBefore);
    expect(await prismaOne.payment.count()).toBe(1);
    expect(reservations).toBe(0);
    expect(await prismaOne.reservation.count()).toBe(0);
    expect(reservationEntries).toBe(0);
    expect(releaseEntries).toBe(0);
    expect(await prismaOne.ledgerEntry.count()).toBe(1);
    expect(await prismaOne.merchantDailyUsage.count()).toBe(usageBefore);
    expect(await prismaOne.outboxEvent.count()).toBe(outboxBefore);
    expect(postedBalance).toBe(BigInt(10_000));
    expect(activeReservedAmount).toBe(BigInt(0));
    expect(postedBalance - activeReservedAmount).toBe(BigInt(10_000));
  });

  it('rolls back reservation release when the release audit entry conflicts', async () => {
    const businessDate = new Date(Date.UTC(2026, 6, 29));
    await prismaOne.ledgerEntry.update({
      where: { entryKey: 'initial-credit:merchant-1' },
      data: { amount: BigInt(10_000) },
    });
    await prismaOne.payment.create({
      data: {
        id: 'release-ledger-conflict-payment',
        merchantId: 'merchant-1',
        idempotencyKey: 'release-ledger-conflict-payment-idem',
        requestFingerprint: 'release-ledger-conflict-payment-fingerprint',
        externalReference: 'release-ledger-conflict-payment-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(4_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'release-ledger-conflict-payment-account',
        routingNumber: '021000021',
        status: PaymentStatus.VALIDATED,
        validatedAt: businessDate,
        createdAt: businessDate,
      },
    });
    await prismaOne.reservation.create({
      data: {
        id: 'release-ledger-conflict-reservation',
        paymentId: 'release-ledger-conflict-payment',
        fundingAccountId: 'funding-account-1',
        amount: BigInt(4_000),
        status: ReservationStatus.ACTIVE,
      },
    });
    await prismaOne.ledgerEntry.createMany({
      data: [
        {
          entryKey: 'reservation:release-ledger-conflict-payment',
          fundingAccountId: 'funding-account-1',
          paymentId: 'release-ledger-conflict-payment',
          entryType: LedgerEntryType.RESERVATION,
          amount: BigInt(4_000),
        },
        {
          entryKey: 'reservation-release:release-ledger-conflict-payment',
          fundingAccountId: 'funding-account-1',
          paymentId: 'release-ledger-conflict-payment',
          entryType: LedgerEntryType.RESERVATION,
          amount: BigInt(1),
        },
      ],
    });
    const lifecycle = new PaymentLifecycleRepository(prismaOne);
    const paymentBefore = await prismaOne.payment.findUniqueOrThrow({
      where: { id: 'release-ledger-conflict-payment' },
    });
    const usageBefore = await prismaOne.merchantDailyUsage.count();
    const outboxBefore = await prismaOne.outboxEvent.count();
    const ledgerCountBefore = await prismaOne.ledgerEntry.count();
    let error: unknown;

    try {
      await lifecycle.releaseReservationForPayment(
        'release-ledger-conflict-payment',
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    const prismaError = error as Prisma.PrismaClientKnownRequestError;
    expect(prismaError.code).toBe('P2002');
    if (prismaError.meta?.target) {
      expect(prismaError.meta.target).toEqual(
        expect.arrayContaining(['entryKey']),
      );
    }
    const reservation = await prismaOne.reservation.findUniqueOrThrow({
      where: { paymentId: 'release-ledger-conflict-payment' },
    });
    const originalEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        paymentId: 'release-ledger-conflict-payment',
        entryKey: 'reservation:release-ledger-conflict-payment',
      },
    });
    const conflictingEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        paymentId: 'release-ledger-conflict-payment',
        entryKey: 'reservation-release:release-ledger-conflict-payment',
      },
    });
    const validReleaseEntries = await prismaOne.ledgerEntry.count({
      where: {
        paymentId: 'release-ledger-conflict-payment',
        entryType: LedgerEntryType.RESERVATION_RELEASE,
      },
    });
    const paymentAfter = await prismaOne.payment.findUniqueOrThrow({
      where: { id: 'release-ledger-conflict-payment' },
    });
    const posted = await prismaOne.ledgerEntry.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        entryType: LedgerEntryType.INITIAL_CREDIT,
      },
      _sum: { amount: true },
    });
    const activeReservations = await prismaOne.reservation.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        status: ReservationStatus.ACTIVE,
      },
      _sum: { amount: true },
    });
    const postedBalance = BigInt(posted._sum.amount ?? 0);
    const activeReservedAmount = BigInt(activeReservations._sum.amount ?? 0);

    expect(reservation).toMatchObject({
      id: 'release-ledger-conflict-reservation',
      amount: BigInt(4_000),
      status: ReservationStatus.ACTIVE,
      releasedAt: null,
      fundingAccountId: 'funding-account-1',
    });
    expect(originalEntries).toEqual([
      expect.objectContaining({
        entryKey: 'reservation:release-ledger-conflict-payment',
        entryType: LedgerEntryType.RESERVATION,
        amount: BigInt(4_000),
      }),
    ]);
    expect(conflictingEntries).toEqual([
      expect.objectContaining({
        entryKey: 'reservation-release:release-ledger-conflict-payment',
        entryType: LedgerEntryType.RESERVATION,
        amount: BigInt(1),
      }),
    ]);
    expect(validReleaseEntries).toBe(0);
    expect(await prismaOne.ledgerEntry.count()).toBe(ledgerCountBefore);
    expect(paymentAfter).toEqual(paymentBefore);
    expect(await prismaOne.merchantDailyUsage.count()).toBe(usageBefore);
    expect(await prismaOne.outboxEvent.count()).toBe(outboxBefore);
    expect(postedBalance).toBe(BigInt(10_000));
    expect(activeReservedAmount).toBe(BigInt(4_000));
    expect(postedBalance - activeReservedAmount).toBe(BigInt(6_000));
  });

  it('releases only the targeted reservation on a shared funding account', async () => {
    const businessDate = new Date(Date.UTC(2026, 6, 29));
    await prismaOne.ledgerEntry.update({
      where: { entryKey: 'initial-credit:merchant-1' },
      data: { amount: BigInt(10_000) },
    });
    await prismaOne.payment.createMany({
      data: [
        {
          id: 'targeted-release-payment-a',
          merchantId: 'merchant-1',
          idempotencyKey: 'targeted-release-payment-a-idem',
          requestFingerprint: 'targeted-release-payment-a-fingerprint',
          externalReference: 'targeted-release-payment-a-reference',
          direction: PaymentDirection.CREDIT,
          amountCents: BigInt(4_000),
          currency: 'USD',
          receiverName: 'Receiver Inc',
          receiverAccountRef: 'targeted-release-payment-a-account',
          routingNumber: '021000021',
          status: PaymentStatus.VALIDATED,
          validatedAt: businessDate,
          createdAt: businessDate,
        },
        {
          id: 'targeted-release-payment-b',
          merchantId: 'merchant-1',
          idempotencyKey: 'targeted-release-payment-b-idem',
          requestFingerprint: 'targeted-release-payment-b-fingerprint',
          externalReference: 'targeted-release-payment-b-reference',
          direction: PaymentDirection.CREDIT,
          amountCents: BigInt(3_000),
          currency: 'USD',
          receiverName: 'Receiver Inc',
          receiverAccountRef: 'targeted-release-payment-b-account',
          routingNumber: '021000021',
          status: PaymentStatus.VALIDATED,
          validatedAt: businessDate,
          createdAt: businessDate,
        },
      ],
    });
    await prismaOne.reservation.createMany({
      data: [
        {
          id: 'targeted-release-reservation-a',
          paymentId: 'targeted-release-payment-a',
          fundingAccountId: 'funding-account-1',
          amount: BigInt(4_000),
          status: ReservationStatus.ACTIVE,
        },
        {
          id: 'targeted-release-reservation-b',
          paymentId: 'targeted-release-payment-b',
          fundingAccountId: 'funding-account-1',
          amount: BigInt(3_000),
          status: ReservationStatus.ACTIVE,
        },
      ],
    });
    await prismaOne.ledgerEntry.createMany({
      data: [
        {
          entryKey: 'reservation:targeted-release-payment-a',
          fundingAccountId: 'funding-account-1',
          paymentId: 'targeted-release-payment-a',
          entryType: LedgerEntryType.RESERVATION,
          amount: BigInt(4_000),
        },
        {
          entryKey: 'reservation:targeted-release-payment-b',
          fundingAccountId: 'funding-account-1',
          paymentId: 'targeted-release-payment-b',
          entryType: LedgerEntryType.RESERVATION,
          amount: BigInt(3_000),
        },
      ],
    });
    const activeBefore = await prismaOne.reservation.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        status: ReservationStatus.ACTIVE,
      },
      _sum: { amount: true },
    });
    const usageBefore = await prismaOne.merchantDailyUsage.count();
    const outboxBefore = await prismaOne.outboxEvent.count();
    expect(BigInt(activeBefore._sum.amount ?? 0)).toBe(BigInt(7_000));
    expect(BigInt(10_000) - BigInt(activeBefore._sum.amount ?? 0)).toBe(
      BigInt(3_000),
    );

    const release = await new PaymentLifecycleRepository(
      prismaOne,
    ).releaseReservationForPayment('targeted-release-payment-a');

    const reservationA = await prismaOne.reservation.findUniqueOrThrow({
      where: { paymentId: 'targeted-release-payment-a' },
    });
    const reservationB = await prismaOne.reservation.findUniqueOrThrow({
      where: { paymentId: 'targeted-release-payment-b' },
    });
    const paymentAEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        paymentId: 'targeted-release-payment-a',
        entryType: LedgerEntryType.RESERVATION,
      },
    });
    const paymentBEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        paymentId: 'targeted-release-payment-b',
        entryType: LedgerEntryType.RESERVATION,
      },
    });
    const paymentAReleaseEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        paymentId: 'targeted-release-payment-a',
        entryType: LedgerEntryType.RESERVATION_RELEASE,
      },
    });
    const paymentBReleaseEntries = await prismaOne.ledgerEntry.count({
      where: {
        paymentId: 'targeted-release-payment-b',
        entryType: LedgerEntryType.RESERVATION_RELEASE,
      },
    });
    const posted = await prismaOne.ledgerEntry.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        entryType: LedgerEntryType.INITIAL_CREDIT,
      },
      _sum: { amount: true },
    });
    const activeReservations = await prismaOne.reservation.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        status: ReservationStatus.ACTIVE,
      },
      _sum: { amount: true },
    });
    const postedBalance = BigInt(posted._sum.amount ?? 0);
    const activeReservedAmount = BigInt(activeReservations._sum.amount ?? 0);

    expect(release).toMatchObject({
      id: 'targeted-release-reservation-a',
      status: ReservationStatus.RELEASED,
    });
    expect(reservationA).toMatchObject({
      id: 'targeted-release-reservation-a',
      amount: BigInt(4_000),
      status: ReservationStatus.RELEASED,
      releasedAt: release.releasedAt,
    });
    expect(reservationA.releasedAt).toBeInstanceOf(Date);
    expect(reservationB).toMatchObject({
      id: 'targeted-release-reservation-b',
      amount: BigInt(3_000),
      status: ReservationStatus.ACTIVE,
      releasedAt: null,
    });
    expect(paymentAEntries).toEqual([
      expect.objectContaining({
        entryKey: 'reservation:targeted-release-payment-a',
        amount: BigInt(4_000),
      }),
    ]);
    expect(paymentBEntries).toEqual([
      expect.objectContaining({
        entryKey: 'reservation:targeted-release-payment-b',
        amount: BigInt(3_000),
      }),
    ]);
    expect(paymentAReleaseEntries).toEqual([
      expect.objectContaining({
        entryKey: 'reservation-release:targeted-release-payment-a',
        amount: BigInt(4_000),
      }),
    ]);
    expect(paymentBReleaseEntries).toBe(0);
    expect(await prismaOne.reservation.count()).toBe(2);
    expect(
      await prismaOne.reservation.count({
        where: { status: ReservationStatus.RELEASED },
      }),
    ).toBe(1);
    expect(
      await prismaOne.reservation.count({
        where: { status: ReservationStatus.ACTIVE },
      }),
    ).toBe(1);
    expect(await prismaOne.ledgerEntry.count()).toBe(4);
    expect(await prismaOne.merchantDailyUsage.count()).toBe(usageBefore);
    expect(await prismaOne.outboxEvent.count()).toBe(outboxBefore);
    expect(postedBalance).toBe(BigInt(10_000));
    expect(activeReservedAmount).toBe(BigInt(3_000));
    expect(postedBalance - activeReservedAmount).toBe(BigInt(7_000));
  });

  it('releases a reservation without affecting another funding account', async () => {
    const businessDate = new Date(Date.UTC(2026, 6, 29));
    await prismaOne.ledgerEntry.deleteMany({
      where: { fundingAccountId: 'funding-account-1' },
    });
    await prismaOne.fundingAccount.delete({
      where: { id: 'funding-account-1' },
    });
    await prismaOne.fundingAccount.createMany({
      data: [
        {
          id: 'funding-account-usd',
          merchantId: 'merchant-1',
          currency: 'USD',
          status: FundingAccountStatus.ACTIVE,
        },
        {
          id: 'funding-account-cad',
          merchantId: 'merchant-1',
          currency: 'CAD',
          status: FundingAccountStatus.ACTIVE,
        },
      ],
    });
    await prismaOne.ledgerEntry.createMany({
      data: [
        {
          entryKey: 'initial-credit:cross-account-release:USD',
          fundingAccountId: 'funding-account-usd',
          entryType: LedgerEntryType.INITIAL_CREDIT,
          amount: BigInt(10_000),
        },
        {
          entryKey: 'initial-credit:cross-account-release:CAD',
          fundingAccountId: 'funding-account-cad',
          entryType: LedgerEntryType.INITIAL_CREDIT,
          amount: BigInt(20_000),
        },
      ],
    });
    await prismaOne.payment.createMany({
      data: [
        {
          id: 'cross-account-release-payment-usd',
          merchantId: 'merchant-1',
          idempotencyKey: 'cross-account-release-payment-usd-idem',
          requestFingerprint: 'cross-account-release-payment-usd-fingerprint',
          externalReference: 'cross-account-release-payment-usd-reference',
          direction: PaymentDirection.CREDIT,
          amountCents: BigInt(4_000),
          currency: 'USD',
          receiverName: 'Receiver Inc',
          receiverAccountRef: 'cross-account-release-payment-usd-account',
          routingNumber: '021000021',
          status: PaymentStatus.VALIDATED,
          validatedAt: businessDate,
          createdAt: businessDate,
        },
        {
          id: 'cross-account-release-payment-cad',
          merchantId: 'merchant-1',
          idempotencyKey: 'cross-account-release-payment-cad-idem',
          requestFingerprint: 'cross-account-release-payment-cad-fingerprint',
          externalReference: 'cross-account-release-payment-cad-reference',
          direction: PaymentDirection.CREDIT,
          amountCents: BigInt(8_000),
          currency: 'CAD',
          receiverName: 'Receiver Inc',
          receiverAccountRef: 'cross-account-release-payment-cad-account',
          routingNumber: '021000021',
          status: PaymentStatus.VALIDATED,
          validatedAt: businessDate,
          createdAt: businessDate,
        },
      ],
    });
    await prismaOne.reservation.createMany({
      data: [
        {
          id: 'cross-account-release-reservation-usd',
          paymentId: 'cross-account-release-payment-usd',
          fundingAccountId: 'funding-account-usd',
          amount: BigInt(4_000),
          status: ReservationStatus.ACTIVE,
        },
        {
          id: 'cross-account-release-reservation-cad',
          paymentId: 'cross-account-release-payment-cad',
          fundingAccountId: 'funding-account-cad',
          amount: BigInt(8_000),
          status: ReservationStatus.ACTIVE,
        },
      ],
    });
    await prismaOne.ledgerEntry.createMany({
      data: [
        {
          entryKey: 'reservation:cross-account-release-payment-usd',
          fundingAccountId: 'funding-account-usd',
          paymentId: 'cross-account-release-payment-usd',
          entryType: LedgerEntryType.RESERVATION,
          amount: BigInt(4_000),
        },
        {
          entryKey: 'reservation:cross-account-release-payment-cad',
          fundingAccountId: 'funding-account-cad',
          paymentId: 'cross-account-release-payment-cad',
          entryType: LedgerEntryType.RESERVATION,
          amount: BigInt(8_000),
        },
      ],
    });
    const usdActiveBefore = await prismaOne.reservation.aggregate({
      where: {
        fundingAccountId: 'funding-account-usd',
        status: ReservationStatus.ACTIVE,
      },
      _sum: { amount: true },
    });
    const cadActiveBefore = await prismaOne.reservation.aggregate({
      where: {
        fundingAccountId: 'funding-account-cad',
        status: ReservationStatus.ACTIVE,
      },
      _sum: { amount: true },
    });
    const usageBefore = await prismaOne.merchantDailyUsage.count();
    const outboxBefore = await prismaOne.outboxEvent.count();
    expect(BigInt(usdActiveBefore._sum.amount ?? 0)).toBe(BigInt(4_000));
    expect(BigInt(10_000) - BigInt(usdActiveBefore._sum.amount ?? 0)).toBe(
      BigInt(6_000),
    );
    expect(BigInt(cadActiveBefore._sum.amount ?? 0)).toBe(BigInt(8_000));
    expect(BigInt(20_000) - BigInt(cadActiveBefore._sum.amount ?? 0)).toBe(
      BigInt(12_000),
    );

    const release = await new PaymentLifecycleRepository(
      prismaOne,
    ).releaseReservationForPayment('cross-account-release-payment-usd');

    const usdReservation = await prismaOne.reservation.findUniqueOrThrow({
      where: { paymentId: 'cross-account-release-payment-usd' },
    });
    const cadReservation = await prismaOne.reservation.findUniqueOrThrow({
      where: { paymentId: 'cross-account-release-payment-cad' },
    });
    const usdReservationEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        paymentId: 'cross-account-release-payment-usd',
        entryType: LedgerEntryType.RESERVATION,
      },
    });
    const cadReservationEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        paymentId: 'cross-account-release-payment-cad',
        entryType: LedgerEntryType.RESERVATION,
      },
    });
    const usdReleaseEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        paymentId: 'cross-account-release-payment-usd',
        entryType: LedgerEntryType.RESERVATION_RELEASE,
      },
    });
    const cadReleaseEntries = await prismaOne.ledgerEntry.count({
      where: {
        paymentId: 'cross-account-release-payment-cad',
        entryType: LedgerEntryType.RESERVATION_RELEASE,
      },
    });
    const [usdPosted, cadPosted, usdActive, cadActive] = await Promise.all([
      prismaOne.ledgerEntry.aggregate({
        where: {
          fundingAccountId: 'funding-account-usd',
          entryType: LedgerEntryType.INITIAL_CREDIT,
        },
        _sum: { amount: true },
      }),
      prismaOne.ledgerEntry.aggregate({
        where: {
          fundingAccountId: 'funding-account-cad',
          entryType: LedgerEntryType.INITIAL_CREDIT,
        },
        _sum: { amount: true },
      }),
      prismaOne.reservation.aggregate({
        where: {
          fundingAccountId: 'funding-account-usd',
          status: ReservationStatus.ACTIVE,
        },
        _sum: { amount: true },
      }),
      prismaOne.reservation.aggregate({
        where: {
          fundingAccountId: 'funding-account-cad',
          status: ReservationStatus.ACTIVE,
        },
        _sum: { amount: true },
      }),
    ]);
    const usdPostedBalance = BigInt(usdPosted._sum.amount ?? 0);
    const usdActiveReservedAmount = BigInt(usdActive._sum.amount ?? 0);
    const cadPostedBalance = BigInt(cadPosted._sum.amount ?? 0);
    const cadActiveReservedAmount = BigInt(cadActive._sum.amount ?? 0);

    expect(release).toMatchObject({
      id: 'cross-account-release-reservation-usd',
      status: ReservationStatus.RELEASED,
    });
    expect(usdReservation).toMatchObject({
      id: 'cross-account-release-reservation-usd',
      amount: BigInt(4_000),
      status: ReservationStatus.RELEASED,
      releasedAt: release.releasedAt,
    });
    expect(usdReservation.releasedAt).toBeInstanceOf(Date);
    expect(cadReservation).toMatchObject({
      id: 'cross-account-release-reservation-cad',
      amount: BigInt(8_000),
      status: ReservationStatus.ACTIVE,
      releasedAt: null,
    });
    expect(usdReservationEntries).toEqual([
      expect.objectContaining({
        entryKey: 'reservation:cross-account-release-payment-usd',
        amount: BigInt(4_000),
      }),
    ]);
    expect(cadReservationEntries).toEqual([
      expect.objectContaining({
        entryKey: 'reservation:cross-account-release-payment-cad',
        amount: BigInt(8_000),
      }),
    ]);
    expect(usdReleaseEntries).toEqual([
      expect.objectContaining({
        entryKey: 'reservation-release:cross-account-release-payment-usd',
        amount: BigInt(4_000),
      }),
    ]);
    expect(cadReleaseEntries).toBe(0);
    expect(await prismaOne.reservation.count()).toBe(2);
    expect(await prismaOne.ledgerEntry.count()).toBe(5);
    expect(await prismaOne.merchantDailyUsage.count()).toBe(usageBefore);
    expect(await prismaOne.outboxEvent.count()).toBe(outboxBefore);
    expect(usdPostedBalance).toBe(BigInt(10_000));
    expect(usdActiveReservedAmount).toBe(BigInt(0));
    expect(usdPostedBalance - usdActiveReservedAmount).toBe(BigInt(10_000));
    expect(cadPostedBalance).toBe(BigInt(20_000));
    expect(cadActiveReservedAmount).toBe(BigInt(8_000));
    expect(cadPostedBalance - cadActiveReservedAmount).toBe(BigInt(12_000));
  });

  it('keeps posted balance unchanged after release across mixed posted ledger history', async () => {
    const businessDate = new Date(Date.UTC(2026, 6, 29));
    await prismaOne.ledgerEntry.update({
      where: { entryKey: 'initial-credit:merchant-1' },
      data: {
        entryKey: 'initial-credit:mixed-ledger-release',
        amount: BigInt(10_000),
      },
    });
    await prismaOne.ledgerEntry.createMany({
      data: [
        {
          entryKey: 'credit-posted:mixed-ledger-release',
          fundingAccountId: 'funding-account-1',
          entryType: LedgerEntryType.CREDIT_POSTED,
          amount: BigInt(6_000),
        },
        {
          entryKey: 'debit-posted:mixed-ledger-release',
          fundingAccountId: 'funding-account-1',
          entryType: LedgerEntryType.DEBIT_POSTED,
          amount: BigInt(3_000),
        },
      ],
    });
    await prismaOne.payment.create({
      data: {
        id: 'mixed-ledger-release-payment',
        merchantId: 'merchant-1',
        idempotencyKey: 'mixed-ledger-release-payment-idem',
        requestFingerprint: 'mixed-ledger-release-payment-fingerprint',
        externalReference: 'mixed-ledger-release-payment-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(4_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'mixed-ledger-release-payment-account',
        routingNumber: '021000021',
        status: PaymentStatus.VALIDATED,
        validatedAt: businessDate,
        createdAt: businessDate,
      },
    });
    await prismaOne.reservation.create({
      data: {
        id: 'mixed-ledger-release-reservation',
        paymentId: 'mixed-ledger-release-payment',
        fundingAccountId: 'funding-account-1',
        amount: BigInt(4_000),
        status: ReservationStatus.ACTIVE,
      },
    });
    await prismaOne.ledgerEntry.create({
      data: {
        entryKey: 'reservation:mixed-ledger-release-payment',
        fundingAccountId: 'funding-account-1',
        paymentId: 'mixed-ledger-release-payment',
        entryType: LedgerEntryType.RESERVATION,
        amount: BigInt(4_000),
      },
    });
    const balanceQuery = () =>
      prismaOne.$queryRaw<{ total: bigint | null }[]>(
        Prisma.sql`SELECT COALESCE(SUM(CASE WHEN "entryType" IN ('INITIAL_CREDIT'::"LedgerEntryType", 'CREDIT_POSTED'::"LedgerEntryType", 'RETURN'::"LedgerEntryType", 'REVERSAL'::"LedgerEntryType", 'ADJUSTMENT'::"LedgerEntryType") THEN "amount" WHEN "entryType" = 'DEBIT_POSTED'::"LedgerEntryType" THEN -"amount" ELSE 0 END), 0) AS total FROM "LedgerEntry" WHERE "fundingAccountId" = ${'funding-account-1'}`,
      );
    const [beforeRows, activeBefore] = await Promise.all([
      balanceQuery(),
      prismaOne.reservation.aggregate({
        where: {
          fundingAccountId: 'funding-account-1',
          status: ReservationStatus.ACTIVE,
        },
        _sum: { amount: true },
      }),
    ]);
    const usageBefore = await prismaOne.merchantDailyUsage.count();
    const outboxBefore = await prismaOne.outboxEvent.count();
    const postedBefore = BigInt(beforeRows[0]?.total ?? 0);
    const activeReservedBefore = BigInt(activeBefore._sum.amount ?? 0);
    expect(postedBefore).toBe(BigInt(13_000));
    expect(activeReservedBefore).toBe(BigInt(4_000));
    expect(postedBefore - activeReservedBefore).toBe(BigInt(9_000));
    expect(
      await prismaOne.ledgerEntry.count({
        where: {
          paymentId: 'mixed-ledger-release-payment',
          entryType: LedgerEntryType.RESERVATION_RELEASE,
        },
      }),
    ).toBe(0);

    const release = await new PaymentLifecycleRepository(
      prismaOne,
    ).releaseReservationForPayment('mixed-ledger-release-payment');

    const reservation = await prismaOne.reservation.findUniqueOrThrow({
      where: { paymentId: 'mixed-ledger-release-payment' },
    });
    const originalEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        paymentId: 'mixed-ledger-release-payment',
        entryType: LedgerEntryType.RESERVATION,
      },
    });
    const releaseEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        paymentId: 'mixed-ledger-release-payment',
        entryType: LedgerEntryType.RESERVATION_RELEASE,
      },
    });
    const [afterRows, activeAfter] = await Promise.all([
      balanceQuery(),
      prismaOne.reservation.aggregate({
        where: {
          fundingAccountId: 'funding-account-1',
          status: ReservationStatus.ACTIVE,
        },
        _sum: { amount: true },
      }),
    ]);
    const postedAfter = BigInt(afterRows[0]?.total ?? 0);
    const activeReservedAfter = BigInt(activeAfter._sum.amount ?? 0);

    expect(release).toMatchObject({
      id: 'mixed-ledger-release-reservation',
      status: ReservationStatus.RELEASED,
    });
    expect(reservation).toMatchObject({
      id: 'mixed-ledger-release-reservation',
      amount: BigInt(4_000),
      status: ReservationStatus.RELEASED,
      releasedAt: release.releasedAt,
    });
    expect(reservation.releasedAt).toBeInstanceOf(Date);
    expect(originalEntries).toEqual([
      expect.objectContaining({
        entryKey: 'reservation:mixed-ledger-release-payment',
        amount: BigInt(4_000),
      }),
    ]);
    expect(releaseEntries).toEqual([
      expect.objectContaining({
        entryKey: 'reservation-release:mixed-ledger-release-payment',
        entryType: LedgerEntryType.RESERVATION_RELEASE,
        amount: BigInt(4_000),
      }),
    ]);
    expect(await prismaOne.reservation.count()).toBe(1);
    expect(await prismaOne.ledgerEntry.count()).toBe(5);
    expect(await prismaOne.merchantDailyUsage.count()).toBe(usageBefore);
    expect(await prismaOne.outboxEvent.count()).toBe(outboxBefore);
    expect(postedAfter).toBe(BigInt(13_000));
    expect(activeReservedAfter).toBe(BigInt(0));
    expect(postedAfter - activeReservedAfter).toBe(BigInt(13_000));
  });

  it('releases an existing reservation after the funding account becomes inactive', async () => {
    const businessDate = new Date(Date.UTC(2026, 6, 29));
    await prismaOne.ledgerEntry.deleteMany({
      where: { fundingAccountId: 'funding-account-1' },
    });
    await prismaOne.fundingAccount.delete({
      where: { id: 'funding-account-1' },
    });
    await prismaOne.fundingAccount.create({
      data: {
        id: 'inactive-account-release-funding',
        merchantId: 'merchant-1',
        currency: 'USD',
        status: FundingAccountStatus.ACTIVE,
      },
    });
    await prismaOne.ledgerEntry.create({
      data: {
        entryKey: 'initial-credit:inactive-account-release',
        fundingAccountId: 'inactive-account-release-funding',
        entryType: LedgerEntryType.INITIAL_CREDIT,
        amount: BigInt(10_000),
      },
    });
    await prismaOne.payment.create({
      data: {
        id: 'inactive-account-release-payment',
        merchantId: 'merchant-1',
        idempotencyKey: 'inactive-account-release-payment-idem',
        requestFingerprint: 'inactive-account-release-payment-fingerprint',
        externalReference: 'inactive-account-release-payment-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(4_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'inactive-account-release-payment-account',
        routingNumber: '021000021',
        status: PaymentStatus.VALIDATED,
        validatedAt: businessDate,
        createdAt: businessDate,
      },
    });
    await prismaOne.reservation.create({
      data: {
        id: 'inactive-account-release-reservation',
        paymentId: 'inactive-account-release-payment',
        fundingAccountId: 'inactive-account-release-funding',
        amount: BigInt(4_000),
        status: ReservationStatus.ACTIVE,
      },
    });
    await prismaOne.ledgerEntry.create({
      data: {
        entryKey: 'reservation:inactive-account-release-payment',
        fundingAccountId: 'inactive-account-release-funding',
        paymentId: 'inactive-account-release-payment',
        entryType: LedgerEntryType.RESERVATION,
        amount: BigInt(4_000),
      },
    });
    await prismaOne.fundingAccount.update({
      where: { id: 'inactive-account-release-funding' },
      data: { status: FundingAccountStatus.CLOSED },
    });
    const accountBefore = await prismaOne.fundingAccount.findUniqueOrThrow({
      where: { id: 'inactive-account-release-funding' },
    });
    const activeBefore = await prismaOne.reservation.aggregate({
      where: {
        fundingAccountId: 'inactive-account-release-funding',
        status: ReservationStatus.ACTIVE,
      },
      _sum: { amount: true },
    });
    const postedBeforeAggregate = await prismaOne.ledgerEntry.aggregate({
      where: {
        fundingAccountId: 'inactive-account-release-funding',
        entryType: LedgerEntryType.INITIAL_CREDIT,
      },
      _sum: { amount: true },
    });
    const usageBefore = await prismaOne.merchantDailyUsage.count();
    const outboxBefore = await prismaOne.outboxEvent.count();
    expect(accountBefore.status).toBe(FundingAccountStatus.CLOSED);
    expect(BigInt(activeBefore._sum.amount ?? 0)).toBe(BigInt(4_000));
    expect(BigInt(10_000) - BigInt(activeBefore._sum.amount ?? 0)).toBe(
      BigInt(6_000),
    );

    const release = await new PaymentLifecycleRepository(
      prismaOne,
    ).releaseReservationForPayment('inactive-account-release-payment');

    const reservation = await prismaOne.reservation.findUniqueOrThrow({
      where: { paymentId: 'inactive-account-release-payment' },
    });
    const accountAfter = await prismaOne.fundingAccount.findUniqueOrThrow({
      where: { id: 'inactive-account-release-funding' },
    });
    const originalEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        paymentId: 'inactive-account-release-payment',
        entryType: LedgerEntryType.RESERVATION,
      },
    });
    const releaseEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        paymentId: 'inactive-account-release-payment',
        entryType: LedgerEntryType.RESERVATION_RELEASE,
      },
    });
    const posted = await prismaOne.ledgerEntry.aggregate({
      where: {
        fundingAccountId: 'inactive-account-release-funding',
        entryType: LedgerEntryType.INITIAL_CREDIT,
      },
      _sum: { amount: true },
    });
    const activeAfter = await prismaOne.reservation.aggregate({
      where: {
        fundingAccountId: 'inactive-account-release-funding',
        status: ReservationStatus.ACTIVE,
      },
      _sum: { amount: true },
    });
    const postedBefore = BigInt(postedBeforeAggregate._sum.amount ?? 0);
    const activeReservedBefore = BigInt(activeBefore._sum.amount ?? 0);
    const postedAfter = BigInt(posted._sum.amount ?? 0);
    const activeReservedAfter = BigInt(activeAfter._sum.amount ?? 0);

    expect(release).toMatchObject({
      id: 'inactive-account-release-reservation',
      status: ReservationStatus.RELEASED,
    });
    expect(reservation).toMatchObject({
      id: 'inactive-account-release-reservation',
      amount: BigInt(4_000),
      status: ReservationStatus.RELEASED,
      releasedAt: release.releasedAt,
      fundingAccountId: 'inactive-account-release-funding',
    });
    expect(reservation.releasedAt).toBeInstanceOf(Date);
    expect(accountAfter).toMatchObject({
      status: FundingAccountStatus.CLOSED,
      currency: 'USD',
      merchantId: 'merchant-1',
    });
    expect(originalEntries).toEqual([
      expect.objectContaining({
        entryKey: 'reservation:inactive-account-release-payment',
        amount: BigInt(4_000),
      }),
    ]);
    expect(releaseEntries).toEqual([
      expect.objectContaining({
        entryKey: 'reservation-release:inactive-account-release-payment',
        amount: BigInt(4_000),
      }),
    ]);
    expect(await prismaOne.reservation.count()).toBe(1);
    expect(await prismaOne.ledgerEntry.count()).toBe(3);
    expect(await prismaOne.merchantDailyUsage.count()).toBe(usageBefore);
    expect(await prismaOne.outboxEvent.count()).toBe(outboxBefore);
    expect(postedBefore).toBe(BigInt(10_000));
    expect(postedAfter).toBe(BigInt(10_000));
    expect(activeReservedBefore).toBe(BigInt(4_000));
    expect(activeReservedAfter).toBe(BigInt(0));
    expect(postedBefore - activeReservedBefore).toBe(BigInt(6_000));
    expect(postedAfter - activeReservedAfter).toBe(BigInt(10_000));
  });

  it('keeps reservation release idempotent across repository instances', async () => {
    const businessDate = new Date(Date.UTC(2026, 6, 29));
    await prismaOne.ledgerEntry.update({
      where: { entryKey: 'initial-credit:merchant-1' },
      data: { amount: BigInt(10_000) },
    });
    await prismaOne.payment.create({
      data: {
        id: 'cross-instance-release-payment',
        merchantId: 'merchant-1',
        idempotencyKey: 'cross-instance-release-payment-idem',
        requestFingerprint: 'cross-instance-release-payment-fingerprint',
        externalReference: 'cross-instance-release-payment-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(4_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'cross-instance-release-payment-account',
        routingNumber: '021000021',
        status: PaymentStatus.VALIDATED,
        validatedAt: businessDate,
        createdAt: businessDate,
      },
    });
    await prismaOne.reservation.create({
      data: {
        id: 'cross-instance-release-reservation',
        paymentId: 'cross-instance-release-payment',
        fundingAccountId: 'funding-account-1',
        amount: BigInt(4_000),
        status: ReservationStatus.ACTIVE,
      },
    });
    await prismaOne.ledgerEntry.create({
      data: {
        entryKey: 'reservation:cross-instance-release-payment',
        fundingAccountId: 'funding-account-1',
        paymentId: 'cross-instance-release-payment',
        entryType: LedgerEntryType.RESERVATION,
        amount: BigInt(4_000),
      },
    });
    const repositoryA = new PaymentLifecycleRepository(prismaOne);
    const usageBefore = await prismaOne.merchantDailyUsage.count();
    const outboxBefore = await prismaOne.outboxEvent.count();

    const firstRelease = await repositoryA.releaseReservationForPayment(
      'cross-instance-release-payment',
    );
    const reservationAfterFirst = await prismaOne.reservation.findUniqueOrThrow(
      {
        where: { paymentId: 'cross-instance-release-payment' },
      },
    );
    const releaseAfterFirst = await prismaOne.ledgerEntry.findFirstOrThrow({
      where: {
        paymentId: 'cross-instance-release-payment',
        entryType: LedgerEntryType.RESERVATION_RELEASE,
      },
    });
    const configB = new WorkerConfigService({
      ...process.env,
      OUTBOX_BATCH_SIZE: '2',
      OUTBOX_MAX_ATTEMPTS: '3',
      OUTBOX_CLAIM_LEASE_MS: '30000',
    });
    const prismaB = new WorkerPrismaService(configB);
    await prismaB.onModuleInit();
    let secondRelease;
    try {
      const repositoryB = new PaymentLifecycleRepository(prismaB);
      secondRelease = await repositoryB.releaseReservationForPayment(
        'cross-instance-release-payment',
      );
    } finally {
      await prismaB.onModuleDestroy();
    }

    const reservations = await prismaOne.reservation.findMany({
      where: { paymentId: 'cross-instance-release-payment' },
    });
    const originalEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        paymentId: 'cross-instance-release-payment',
        entryType: LedgerEntryType.RESERVATION,
      },
    });
    const releaseEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        paymentId: 'cross-instance-release-payment',
        entryType: LedgerEntryType.RESERVATION_RELEASE,
      },
    });
    const posted = await prismaOne.ledgerEntry.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        entryType: LedgerEntryType.INITIAL_CREDIT,
      },
      _sum: { amount: true },
    });
    const activeReservations = await prismaOne.reservation.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        status: ReservationStatus.ACTIVE,
      },
      _sum: { amount: true },
    });
    const postedBalance = BigInt(posted._sum.amount ?? 0);
    const activeReservedAmount = BigInt(activeReservations._sum.amount ?? 0);

    expect(firstRelease).toMatchObject({
      id: 'cross-instance-release-reservation',
      status: ReservationStatus.RELEASED,
    });
    expect(secondRelease).toEqual(reservationAfterFirst);
    expect(reservations).toEqual([
      expect.objectContaining({
        id: 'cross-instance-release-reservation',
        amount: BigInt(4_000),
        status: ReservationStatus.RELEASED,
        releasedAt: firstRelease.releasedAt,
      }),
    ]);
    expect(originalEntries).toEqual([
      expect.objectContaining({
        entryKey: 'reservation:cross-instance-release-payment',
        amount: BigInt(4_000),
      }),
    ]);
    expect(releaseEntries).toEqual([
      expect.objectContaining({
        id: releaseAfterFirst.id,
        entryKey: 'reservation-release:cross-instance-release-payment',
        amount: BigInt(4_000),
      }),
    ]);
    expect(await prismaOne.reservation.count()).toBe(1);
    expect(await prismaOne.ledgerEntry.count()).toBe(3);
    expect(await prismaOne.merchantDailyUsage.count()).toBe(usageBefore);
    expect(await prismaOne.outboxEvent.count()).toBe(outboxBefore);
    expect(postedBalance).toBe(BigInt(10_000));
    expect(activeReservedAmount).toBe(BigInt(0));
    expect(postedBalance - activeReservedAmount).toBe(BigInt(10_000));
  });

  it('releases the persisted reservation without reselecting a funding account', async () => {
    const businessDate = new Date(Date.UTC(2026, 6, 29));
    await prismaOne.ledgerEntry.deleteMany({
      where: { fundingAccountId: 'funding-account-1' },
    });
    await prismaOne.fundingAccount.delete({
      where: { id: 'funding-account-1' },
    });
    await prismaOne.fundingAccount.createMany({
      data: [
        {
          id: 'persisted-release-account-usd',
          merchantId: 'merchant-1',
          currency: 'USD',
          status: FundingAccountStatus.ACTIVE,
        },
        {
          id: 'persisted-release-account-cad',
          merchantId: 'merchant-1',
          currency: 'CAD',
          status: FundingAccountStatus.ACTIVE,
        },
      ],
    });
    await prismaOne.ledgerEntry.createMany({
      data: [
        {
          entryKey: 'initial-credit:persisted-release:USD',
          fundingAccountId: 'persisted-release-account-usd',
          entryType: LedgerEntryType.INITIAL_CREDIT,
          amount: BigInt(10_000),
        },
        {
          entryKey: 'initial-credit:persisted-release:CAD',
          fundingAccountId: 'persisted-release-account-cad',
          entryType: LedgerEntryType.INITIAL_CREDIT,
          amount: BigInt(20_000),
        },
      ],
    });
    await prismaOne.payment.create({
      data: {
        id: 'persisted-account-release-payment',
        merchantId: 'merchant-1',
        idempotencyKey: 'persisted-account-release-payment-idem',
        requestFingerprint: 'persisted-account-release-payment-fingerprint',
        externalReference: 'persisted-account-release-payment-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(4_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'persisted-account-release-payment-account',
        routingNumber: '021000021',
        status: PaymentStatus.VALIDATED,
        validatedAt: businessDate,
        createdAt: businessDate,
      },
    });
    await prismaOne.reservation.create({
      data: {
        id: 'persisted-account-release-reservation',
        paymentId: 'persisted-account-release-payment',
        fundingAccountId: 'persisted-release-account-cad',
        amount: BigInt(4_000),
        status: ReservationStatus.ACTIVE,
      },
    });
    await prismaOne.ledgerEntry.create({
      data: {
        entryKey: 'reservation:persisted-account-release-payment',
        fundingAccountId: 'persisted-release-account-cad',
        paymentId: 'persisted-account-release-payment',
        entryType: LedgerEntryType.RESERVATION,
        amount: BigInt(4_000),
      },
    });
    const [usdActiveBefore, cadActiveBefore] = await Promise.all([
      prismaOne.reservation.aggregate({
        where: {
          fundingAccountId: 'persisted-release-account-usd',
          status: ReservationStatus.ACTIVE,
        },
        _sum: { amount: true },
      }),
      prismaOne.reservation.aggregate({
        where: {
          fundingAccountId: 'persisted-release-account-cad',
          status: ReservationStatus.ACTIVE,
        },
        _sum: { amount: true },
      }),
    ]);
    const usageBefore = await prismaOne.merchantDailyUsage.count();
    const outboxBefore = await prismaOne.outboxEvent.count();
    expect(BigInt(usdActiveBefore._sum.amount ?? 0)).toBe(BigInt(0));
    expect(BigInt(cadActiveBefore._sum.amount ?? 0)).toBe(BigInt(4_000));

    const release = await new PaymentLifecycleRepository(
      prismaOne,
    ).releaseReservationForPayment('persisted-account-release-payment');

    const reservation = await prismaOne.reservation.findUniqueOrThrow({
      where: { paymentId: 'persisted-account-release-payment' },
    });
    const originalEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        paymentId: 'persisted-account-release-payment',
        entryType: LedgerEntryType.RESERVATION,
      },
    });
    const releaseEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        paymentId: 'persisted-account-release-payment',
        entryType: LedgerEntryType.RESERVATION_RELEASE,
      },
    });
    const usdReleaseEntries = await prismaOne.ledgerEntry.count({
      where: {
        fundingAccountId: 'persisted-release-account-usd',
        entryType: LedgerEntryType.RESERVATION_RELEASE,
      },
    });
    const [usdPosted, cadPosted, usdActiveAfter, cadActiveAfter] =
      await Promise.all([
        prismaOne.ledgerEntry.aggregate({
          where: {
            fundingAccountId: 'persisted-release-account-usd',
            entryType: LedgerEntryType.INITIAL_CREDIT,
          },
          _sum: { amount: true },
        }),
        prismaOne.ledgerEntry.aggregate({
          where: {
            fundingAccountId: 'persisted-release-account-cad',
            entryType: LedgerEntryType.INITIAL_CREDIT,
          },
          _sum: { amount: true },
        }),
        prismaOne.reservation.aggregate({
          where: {
            fundingAccountId: 'persisted-release-account-usd',
            status: ReservationStatus.ACTIVE,
          },
          _sum: { amount: true },
        }),
        prismaOne.reservation.aggregate({
          where: {
            fundingAccountId: 'persisted-release-account-cad',
            status: ReservationStatus.ACTIVE,
          },
          _sum: { amount: true },
        }),
      ]);
    const usdPostedBalance = BigInt(usdPosted._sum.amount ?? 0);
    const cadPostedBalance = BigInt(cadPosted._sum.amount ?? 0);
    const usdActiveReservedAmount = BigInt(usdActiveAfter._sum.amount ?? 0);
    const cadActiveReservedAmount = BigInt(cadActiveAfter._sum.amount ?? 0);

    expect(release).toMatchObject({
      id: 'persisted-account-release-reservation',
      status: ReservationStatus.RELEASED,
    });
    expect(reservation).toMatchObject({
      id: 'persisted-account-release-reservation',
      fundingAccountId: 'persisted-release-account-cad',
      amount: BigInt(4_000),
      status: ReservationStatus.RELEASED,
      releasedAt: release.releasedAt,
    });
    expect(reservation.releasedAt).toBeInstanceOf(Date);
    expect(originalEntries).toEqual([
      expect.objectContaining({
        entryKey: 'reservation:persisted-account-release-payment',
        fundingAccountId: 'persisted-release-account-cad',
        amount: BigInt(4_000),
      }),
    ]);
    expect(releaseEntries).toEqual([
      expect.objectContaining({
        entryKey: 'reservation-release:persisted-account-release-payment',
        fundingAccountId: 'persisted-release-account-cad',
        amount: BigInt(4_000),
      }),
    ]);
    expect(usdReleaseEntries).toBe(0);
    expect(await prismaOne.reservation.count()).toBe(1);
    expect(await prismaOne.ledgerEntry.count()).toBe(4);
    expect(await prismaOne.merchantDailyUsage.count()).toBe(usageBefore);
    expect(await prismaOne.outboxEvent.count()).toBe(outboxBefore);
    expect(usdPostedBalance).toBe(BigInt(10_000));
    expect(usdActiveReservedAmount).toBe(BigInt(0));
    expect(usdPostedBalance - usdActiveReservedAmount).toBe(BigInt(10_000));
    expect(cadPostedBalance).toBe(BigInt(20_000));
    expect(cadActiveReservedAmount).toBe(BigInt(0));
    expect(cadPostedBalance - cadActiveReservedAmount).toBe(BigInt(20_000));
  });

  it('settles an active reservation exactly once', async () => {
    const businessDate = new Date(Date.UTC(2026, 6, 29));
    await prismaOne.ledgerEntry.update({
      where: { entryKey: 'initial-credit:merchant-1' },
      data: { amount: BigInt(10_000) },
    });
    await prismaOne.payment.create({
      data: {
        id: 'first-settlement-payment',
        merchantId: 'merchant-1',
        idempotencyKey: 'first-settlement-payment-idem',
        requestFingerprint: 'first-settlement-payment-fingerprint',
        externalReference: 'first-settlement-payment-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(4_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'first-settlement-payment-account',
        routingNumber: '021000021',
        status: PaymentStatus.SUBMITTED,
        validatedAt: businessDate,
        createdAt: businessDate,
      },
    });
    await prismaOne.reservation.create({
      data: {
        id: 'first-settlement-reservation',
        paymentId: 'first-settlement-payment',
        fundingAccountId: 'funding-account-1',
        amount: BigInt(4_000),
        status: ReservationStatus.ACTIVE,
      },
    });
    await prismaOne.ledgerEntry.create({
      data: {
        entryKey: 'reservation:first-settlement-payment',
        fundingAccountId: 'funding-account-1',
        paymentId: 'first-settlement-payment',
        entryType: LedgerEntryType.RESERVATION,
        amount: BigInt(4_000),
      },
    });
    const activeBefore = await prismaOne.reservation.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        status: ReservationStatus.ACTIVE,
      },
      _sum: { amount: true },
    });
    const usageBefore = await prismaOne.merchantDailyUsage.count();
    const outboxBefore = await prismaOne.outboxEvent.count();
    const postedBefore = BigInt(10_000);
    const activeReservedBefore = BigInt(activeBefore._sum.amount ?? 0);
    expect(activeReservedBefore).toBe(BigInt(4_000));
    expect(postedBefore - activeReservedBefore).toBe(BigInt(6_000));

    const lifecycle = new PaymentLifecycleRepository(prismaOne);
    const firstSettlement = await lifecycle.settleReservationForPayment(
      'first-settlement-payment',
    );
    if (!firstSettlement) {
      throw new Error('Expected the credit reservation to settle.');
    }
    const reservationAfterFirst = await prismaOne.reservation.findUniqueOrThrow(
      {
        where: { paymentId: 'first-settlement-payment' },
      },
    );
    const settlementAfterFirst = await prismaOne.ledgerEntry.findFirstOrThrow({
      where: {
        paymentId: 'first-settlement-payment',
        entryType: LedgerEntryType.SETTLEMENT,
      },
    });

    const secondSettlement = await lifecycle.settleReservationForPayment(
      'first-settlement-payment',
    );
    if (!secondSettlement) {
      throw new Error(
        'Expected the settled credit reservation to be returned from the repository.',
      );
    }
    const reservations = await prismaOne.reservation.findMany({
      where: { paymentId: 'first-settlement-payment' },
    });
    const reservationEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        paymentId: 'first-settlement-payment',
        entryType: LedgerEntryType.RESERVATION,
      },
    });
    const settlementEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        paymentId: 'first-settlement-payment',
        entryType: LedgerEntryType.SETTLEMENT,
      },
    });
    const posted = await prismaOne.ledgerEntry.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        entryType: LedgerEntryType.INITIAL_CREDIT,
      },
      _sum: { amount: true },
    });
    const activeAfter = await prismaOne.reservation.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        status: ReservationStatus.ACTIVE,
      },
      _sum: { amount: true },
    });
    const postedAfter = BigInt(posted._sum.amount ?? 0);
    const activeReservedAfter = BigInt(activeAfter._sum.amount ?? 0);

    expect(firstSettlement).toMatchObject({
      id: 'first-settlement-reservation',
      status: ReservationStatus.SETTLED,
      amount: BigInt(4_000),
    });
    expect(firstSettlement.settledAt).toBeInstanceOf(Date);
    expect(secondSettlement).toEqual(reservationAfterFirst);
    expect(reservations).toEqual([
      expect.objectContaining({
        id: 'first-settlement-reservation',
        paymentId: 'first-settlement-payment',
        fundingAccountId: 'funding-account-1',
        amount: BigInt(4_000),
        status: ReservationStatus.SETTLED,
        settledAt: firstSettlement.settledAt,
      }),
    ]);
    expect(reservationEntries).toEqual([
      expect.objectContaining({
        entryKey: 'reservation:first-settlement-payment',
        amount: BigInt(4_000),
      }),
    ]);
    expect(settlementEntries).toEqual([
      expect.objectContaining({
        id: settlementAfterFirst.id,
        entryKey: 'settlement:first-settlement-payment',
        amount: BigInt(4_000),
      }),
    ]);
    expect(await prismaOne.reservation.count()).toBe(1);
    expect(await prismaOne.ledgerEntry.count()).toBe(3);
    expect(await prismaOne.merchantDailyUsage.count()).toBe(usageBefore);
    expect(await prismaOne.outboxEvent.count()).toBe(outboxBefore + 1);
    expect(postedBefore).toBe(BigInt(10_000));
    expect(postedAfter).toBe(BigInt(10_000));
    expect(activeReservedBefore).toBe(BigInt(4_000));
    expect(activeReservedAfter).toBe(BigInt(0));
    expect(postedBefore - activeReservedBefore).toBe(BigInt(6_000));
    expect(postedAfter - activeReservedAfter).toBe(BigInt(10_000));
  });

  it('settles the same reservation concurrently exactly once', async () => {
    const businessDate = new Date(Date.UTC(2026, 6, 29));
    await prismaOne.ledgerEntry.update({
      where: { entryKey: 'initial-credit:merchant-1' },
      data: { amount: BigInt(10_000) },
    });
    await prismaOne.payment.create({
      data: {
        id: 'concurrent-settlement-payment',
        merchantId: 'merchant-1',
        idempotencyKey: 'concurrent-settlement-payment-idem',
        requestFingerprint: 'concurrent-settlement-payment-fingerprint',
        externalReference: 'concurrent-settlement-payment-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(4_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'concurrent-settlement-payment-account',
        routingNumber: '021000021',
        status: PaymentStatus.SUBMITTED,
        validatedAt: businessDate,
        createdAt: businessDate,
      },
    });
    await prismaOne.reservation.create({
      data: {
        id: 'concurrent-settlement-reservation',
        paymentId: 'concurrent-settlement-payment',
        fundingAccountId: 'funding-account-1',
        amount: BigInt(4_000),
        status: ReservationStatus.ACTIVE,
      },
    });
    await prismaOne.ledgerEntry.create({
      data: {
        entryKey: 'reservation:concurrent-settlement-payment',
        fundingAccountId: 'funding-account-1',
        paymentId: 'concurrent-settlement-payment',
        entryType: LedgerEntryType.RESERVATION,
        amount: BigInt(4_000),
      },
    });
    const activeBefore = await prismaOne.reservation.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        status: ReservationStatus.ACTIVE,
      },
      _sum: { amount: true },
    });
    const usageBefore = await prismaOne.merchantDailyUsage.count();
    const outboxBefore = await prismaOne.outboxEvent.count();
    expect(BigInt(activeBefore._sum.amount ?? 0)).toBe(BigInt(4_000));
    expect(BigInt(10_000) - BigInt(activeBefore._sum.amount ?? 0)).toBe(
      BigInt(6_000),
    );

    const repositoryOne = new PaymentLifecycleRepository(prismaOne);
    const repositoryTwo = new PaymentLifecycleRepository(prismaTwo);
    const firstSettlementPromise = repositoryOne.settleReservationForPayment(
      'concurrent-settlement-payment',
    );
    const secondSettlementPromise = repositoryTwo.settleReservationForPayment(
      'concurrent-settlement-payment',
    );
    const [firstSettlement, secondSettlement] = await Promise.all([
      firstSettlementPromise,
      secondSettlementPromise,
    ]);
    if (!firstSettlement || !secondSettlement) {
      throw new Error(
        'Expected both concurrent credit settlements to return a reservation.',
      );
    }

    const reservations = await prismaOne.reservation.findMany({
      where: { paymentId: 'concurrent-settlement-payment' },
    });
    const reservationEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        paymentId: 'concurrent-settlement-payment',
        entryType: LedgerEntryType.RESERVATION,
      },
    });
    const settlementEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        paymentId: 'concurrent-settlement-payment',
        entryType: LedgerEntryType.SETTLEMENT,
      },
    });
    const posted = await prismaOne.ledgerEntry.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        entryType: LedgerEntryType.INITIAL_CREDIT,
      },
      _sum: { amount: true },
    });
    const activeAfter = await prismaOne.reservation.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        status: ReservationStatus.ACTIVE,
      },
      _sum: { amount: true },
    });
    const postedBalance = BigInt(posted._sum.amount ?? 0);
    const activeReservedAmount = BigInt(activeAfter._sum.amount ?? 0);

    expect(firstSettlement).toMatchObject({
      id: 'concurrent-settlement-reservation',
      status: ReservationStatus.SETTLED,
    });
    expect(secondSettlement).toMatchObject({
      id: 'concurrent-settlement-reservation',
      status: ReservationStatus.SETTLED,
    });
    expect(firstSettlement.settledAt).toBeInstanceOf(Date);
    expect(secondSettlement.settledAt).toEqual(firstSettlement.settledAt);
    expect(reservations).toEqual([
      expect.objectContaining({
        id: 'concurrent-settlement-reservation',
        amount: BigInt(4_000),
        status: ReservationStatus.SETTLED,
        settledAt: firstSettlement.settledAt,
      }),
    ]);
    expect(reservationEntries).toEqual([
      expect.objectContaining({
        entryKey: 'reservation:concurrent-settlement-payment',
        amount: BigInt(4_000),
      }),
    ]);
    expect(settlementEntries).toEqual([
      expect.objectContaining({
        entryKey: 'settlement:concurrent-settlement-payment',
        amount: BigInt(4_000),
      }),
    ]);
    expect(await prismaOne.reservation.count()).toBe(1);
    expect(await prismaOne.ledgerEntry.count()).toBe(3);
    expect(await prismaOne.merchantDailyUsage.count()).toBe(usageBefore);
    expect(await prismaOne.outboxEvent.count()).toBe(outboxBefore + 1);
    expect(postedBalance).toBe(BigInt(10_000));
    expect(activeReservedAmount).toBe(BigInt(0));
    expect(postedBalance - activeReservedAmount).toBe(BigInt(10_000));
  });

  it('settles a submitted ACH debit exactly once across repeated and concurrent calls', async () => {
    const submittedAt = new Date(Date.UTC(2026, 6, 29));
    await prismaOne.payment.create({
      data: {
        id: 'concurrent-debit-settlement-payment',
        merchantId: 'merchant-1',
        idempotencyKey: 'concurrent-debit-settlement-idem',
        requestFingerprint: 'concurrent-debit-settlement-fingerprint',
        externalReference: 'concurrent-debit-settlement-reference',
        direction: PaymentDirection.DEBIT,
        amountCents: BigInt(2_500),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'concurrent-debit-settlement-account',
        routingNumber: '021000021',
        status: PaymentStatus.SUBMITTED,
        validatedAt: submittedAt,
        exportedAt: submittedAt,
        createdAt: submittedAt,
      },
    });

    const repositoryOne = new PaymentLifecycleRepository(prismaOne);
    const repositoryTwo = new PaymentLifecycleRepository(prismaTwo);
    const [first, second] = await Promise.all([
      repositoryOne.settleReservationForPayment(
        'concurrent-debit-settlement-payment',
      ),
      repositoryTwo.settleReservationForPayment(
        'concurrent-debit-settlement-payment',
      ),
    ]);
    const third = await repositoryOne.settleReservationForPayment(
      'concurrent-debit-settlement-payment',
    );

    const [payment, reservations, debitEntries, settledEvents] =
      await Promise.all([
        prismaOne.payment.findUniqueOrThrow({
          where: { id: 'concurrent-debit-settlement-payment' },
        }),
        prismaOne.reservation.findMany({
          where: { paymentId: 'concurrent-debit-settlement-payment' },
        }),
        prismaOne.ledgerEntry.findMany({
          where: {
            paymentId: 'concurrent-debit-settlement-payment',
            entryType: LedgerEntryType.DEBIT_POSTED,
          },
        }),
        prismaOne.outboxEvent.findMany({
          where: {
            aggregateId: 'concurrent-debit-settlement-payment',
            aggregateType: 'PAYMENT',
            eventType: OutboxEventType.PAYMENT_SETTLED,
          },
        }),
      ]);

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(third).toBeNull();
    expect(payment.status).toBe(PaymentStatus.SETTLED);
    expect(reservations).toHaveLength(0);
    expect(debitEntries).toEqual([
      expect.objectContaining({
        entryKey: 'debit-posted:concurrent-debit-settlement-payment',
        fundingAccountId: 'funding-account-1',
        amount: BigInt(2_500),
      }),
    ]);
    expect(settledEvents).toHaveLength(1);
    expect(await prismaOne.ledgerEntry.count()).toBe(2);
  });

  it('returns a settled ACH debit exactly once across repeated and concurrent calls', async () => {
    const settledAt = new Date(Date.UTC(2026, 6, 29));
    await prismaOne.ledgerEntry.update({
      where: { entryKey: 'initial-credit:merchant-1' },
      data: { amount: BigInt(10_000) },
    });
    await prismaOne.payment.create({
      data: {
        id: 'concurrent-debit-return-payment',
        merchantId: 'merchant-1',
        idempotencyKey: 'concurrent-debit-return-idem',
        requestFingerprint: 'concurrent-debit-return-fingerprint',
        externalReference: 'concurrent-debit-return-reference',
        direction: PaymentDirection.DEBIT,
        amountCents: BigInt(2_500),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'concurrent-debit-return-account',
        routingNumber: '021000021',
        status: PaymentStatus.SETTLED,
        validatedAt: settledAt,
        exportedAt: settledAt,
        createdAt: settledAt,
      },
    });
    await prismaOne.ledgerEntry.create({
      data: {
        entryKey: 'debit-posted:concurrent-debit-return-payment',
        fundingAccountId: 'funding-account-1',
        paymentId: 'concurrent-debit-return-payment',
        entryType: LedgerEntryType.DEBIT_POSTED,
        amount: BigInt(2_500),
      },
    });
    const balance = () =>
      prismaOne.$queryRaw<{ total: bigint | null }[]>(
        Prisma.sql`SELECT COALESCE(SUM(CASE WHEN "entryType" IN ('INITIAL_CREDIT'::"LedgerEntryType", 'CREDIT_POSTED'::"LedgerEntryType", 'RETURN'::"LedgerEntryType", 'REVERSAL'::"LedgerEntryType", 'ADJUSTMENT'::"LedgerEntryType") THEN "amount" WHEN "entryType" = 'DEBIT_POSTED'::"LedgerEntryType" THEN -"amount" ELSE 0 END), 0) AS total FROM "LedgerEntry" WHERE "fundingAccountId" = ${'funding-account-1'}`,
      );
    expect(BigInt((await balance())[0]?.total ?? 0)).toBe(BigInt(7_500));

    const repositoryOne = new PaymentLifecycleRepository(prismaOne);
    const repositoryTwo = new PaymentLifecycleRepository(prismaTwo);
    const [first, second] = await Promise.all([
      repositoryOne.returnSettlementForPayment(
        'concurrent-debit-return-payment',
        'R01',
      ),
      repositoryTwo.returnSettlementForPayment(
        'concurrent-debit-return-payment',
        'R01',
      ),
    ]);
    const third = await repositoryOne.returnSettlementForPayment(
      'concurrent-debit-return-payment',
      'R01',
    );

    const [payment, reservations, debitEntries, returnEntries, returnedEvents] =
      await Promise.all([
        prismaOne.payment.findUniqueOrThrow({
          where: { id: 'concurrent-debit-return-payment' },
        }),
        prismaOne.reservation.count({
          where: { paymentId: 'concurrent-debit-return-payment' },
        }),
        prismaOne.ledgerEntry.findMany({
          where: {
            paymentId: 'concurrent-debit-return-payment',
            entryType: LedgerEntryType.DEBIT_POSTED,
          },
        }),
        prismaOne.ledgerEntry.findMany({
          where: {
            paymentId: 'concurrent-debit-return-payment',
            entryType: LedgerEntryType.RETURN,
          },
        }),
        prismaOne.outboxEvent.findMany({
          where: {
            aggregateId: 'concurrent-debit-return-payment',
            aggregateType: 'PAYMENT',
            eventType: OutboxEventType.PAYMENT_RETURNED,
          },
        }),
      ]);

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(third).toBeNull();
    expect(payment).toMatchObject({
      status: PaymentStatus.RETURNED,
      failureCode: 'R01',
      failureReason: 'ACH debit return',
    });
    expect(reservations).toBe(0);
    expect(debitEntries).toEqual([
      expect.objectContaining({
        entryKey: 'debit-posted:concurrent-debit-return-payment',
        fundingAccountId: 'funding-account-1',
        amount: BigInt(2_500),
      }),
    ]);
    expect(returnEntries).toEqual([
      expect.objectContaining({
        entryKey: 'debit-return:concurrent-debit-return-payment',
        fundingAccountId: 'funding-account-1',
        amount: BigInt(2_500),
      }),
    ]);
    expect(returnedEvents).toHaveLength(1);
    expect(BigInt((await balance())[0]?.total ?? 0)).toBe(BigInt(10_000));
  });

  it('rejects a non-settled ACH debit return without financial effects', async () => {
    await prismaOne.payment.create({
      data: {
        id: 'submitted-debit-return-payment',
        merchantId: 'merchant-1',
        idempotencyKey: 'submitted-debit-return-idem',
        requestFingerprint: 'submitted-debit-return-fingerprint',
        externalReference: 'submitted-debit-return-reference',
        direction: PaymentDirection.DEBIT,
        amountCents: BigInt(2_500),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'submitted-debit-return-account',
        routingNumber: '021000021',
        status: PaymentStatus.SUBMITTED,
        validatedAt: new Date(),
        exportedAt: new Date(),
      },
    });

    await expect(
      new PaymentLifecycleRepository(prismaOne).returnSettlementForPayment(
        'submitted-debit-return-payment',
        'R01',
      ),
    ).rejects.toMatchObject({
      safeMessage: 'Payment is not settled for return',
    });
    expect(
      await prismaOne.ledgerEntry.count({
        where: { paymentId: 'submitted-debit-return-payment' },
      }),
    ).toBe(0);
    expect(
      await prismaOne.outboxEvent.count({
        where: {
          aggregateId: 'submitted-debit-return-payment',
          eventType: OutboxEventType.PAYMENT_RETURNED,
        },
      }),
    ).toBe(0);
  });

  it('does not settle a submitted ACH debit without an active matching funding account', async () => {
    const submittedAt = new Date(Date.UTC(2026, 6, 29));
    await prismaOne.payment.create({
      data: {
        id: 'debit-settlement-without-account',
        merchantId: 'merchant-1',
        idempotencyKey: 'debit-settlement-without-account-idem',
        requestFingerprint: 'debit-settlement-without-account-fingerprint',
        externalReference: 'debit-settlement-without-account-reference',
        direction: PaymentDirection.DEBIT,
        amountCents: BigInt(2_500),
        currency: 'CAD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'debit-settlement-without-account',
        routingNumber: '021000021',
        status: PaymentStatus.SUBMITTED,
        validatedAt: submittedAt,
        exportedAt: submittedAt,
        createdAt: submittedAt,
      },
    });

    const lifecycle = new PaymentLifecycleRepository(prismaOne);
    await expect(
      lifecycle.settleReservationForPayment('debit-settlement-without-account'),
    ).rejects.toMatchObject({
      safeMessage: 'No active CAD funding account exists for merchant',
    });

    const [payment, reservations, entries, events] = await Promise.all([
      prismaOne.payment.findUniqueOrThrow({
        where: { id: 'debit-settlement-without-account' },
      }),
      prismaOne.reservation.count({
        where: { paymentId: 'debit-settlement-without-account' },
      }),
      prismaOne.ledgerEntry.count({
        where: { paymentId: 'debit-settlement-without-account' },
      }),
      prismaOne.outboxEvent.count({
        where: {
          aggregateId: 'debit-settlement-without-account',
          aggregateType: 'PAYMENT',
          eventType: OutboxEventType.PAYMENT_SETTLED,
        },
      }),
    ]);

    expect(payment.status).toBe(PaymentStatus.SUBMITTED);
    expect(reservations).toBe(0);
    expect(entries).toBe(0);
    expect(events).toBe(0);
  });

  it('rolls back settlement when the settlement audit entry conflicts', async () => {
    const businessDate = new Date(Date.UTC(2026, 6, 29));
    await prismaOne.ledgerEntry.update({
      where: { entryKey: 'initial-credit:merchant-1' },
      data: { amount: BigInt(10_000) },
    });
    await prismaOne.payment.create({
      data: {
        id: 'settlement-ledger-conflict-payment',
        merchantId: 'merchant-1',
        idempotencyKey: 'settlement-ledger-conflict-payment-idem',
        requestFingerprint: 'settlement-ledger-conflict-payment-fingerprint',
        externalReference: 'settlement-ledger-conflict-payment-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(4_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'settlement-ledger-conflict-payment-account',
        routingNumber: '021000021',
        status: PaymentStatus.SUBMITTED,
        validatedAt: businessDate,
        createdAt: businessDate,
      },
    });
    await prismaOne.reservation.create({
      data: {
        id: 'settlement-ledger-conflict-reservation',
        paymentId: 'settlement-ledger-conflict-payment',
        fundingAccountId: 'funding-account-1',
        amount: BigInt(4_000),
        status: ReservationStatus.ACTIVE,
      },
    });
    await prismaOne.ledgerEntry.createMany({
      data: [
        {
          entryKey: 'reservation:settlement-ledger-conflict-payment',
          fundingAccountId: 'funding-account-1',
          paymentId: 'settlement-ledger-conflict-payment',
          entryType: LedgerEntryType.RESERVATION,
          amount: BigInt(4_000),
        },
        {
          entryKey: 'settlement:settlement-ledger-conflict-payment',
          fundingAccountId: 'funding-account-1',
          paymentId: 'settlement-ledger-conflict-payment',
          entryType: LedgerEntryType.RESERVATION,
          amount: BigInt(1),
        },
      ],
    });
    const lifecycle = new PaymentLifecycleRepository(prismaOne);
    const usageBefore = await prismaOne.merchantDailyUsage.count();
    const outboxBefore = await prismaOne.outboxEvent.count();
    const ledgerCountBefore = await prismaOne.ledgerEntry.count();
    let error: unknown;

    try {
      await lifecycle.settleReservationForPayment(
        'settlement-ledger-conflict-payment',
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    const prismaError = error as Prisma.PrismaClientKnownRequestError;
    expect(prismaError.code).toBe('P2002');
    const reservation = await prismaOne.reservation.findUniqueOrThrow({
      where: { paymentId: 'settlement-ledger-conflict-payment' },
    });
    const reservationEntries = await prismaOne.ledgerEntry.count({
      where: {
        paymentId: 'settlement-ledger-conflict-payment',
        entryKey: 'reservation:settlement-ledger-conflict-payment',
      },
    });
    const conflictingEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        paymentId: 'settlement-ledger-conflict-payment',
        entryKey: 'settlement:settlement-ledger-conflict-payment',
      },
    });
    const validSettlementEntries = await prismaOne.ledgerEntry.count({
      where: {
        paymentId: 'settlement-ledger-conflict-payment',
        entryType: LedgerEntryType.SETTLEMENT,
      },
    });
    const posted = await prismaOne.ledgerEntry.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        entryType: LedgerEntryType.INITIAL_CREDIT,
      },
      _sum: { amount: true },
    });
    const activeReservations = await prismaOne.reservation.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        status: ReservationStatus.ACTIVE,
      },
      _sum: { amount: true },
    });
    const postedBalance = BigInt(posted._sum.amount ?? 0);
    const activeReservedAmount = BigInt(activeReservations._sum.amount ?? 0);

    expect(reservation).toMatchObject({
      id: 'settlement-ledger-conflict-reservation',
      amount: BigInt(4_000),
      status: ReservationStatus.ACTIVE,
      settledAt: null,
    });
    expect(reservationEntries).toBe(1);
    expect(conflictingEntries).toEqual([
      expect.objectContaining({
        entryType: LedgerEntryType.RESERVATION,
        amount: BigInt(1),
        entryKey: 'settlement:settlement-ledger-conflict-payment',
      }),
    ]);
    expect(validSettlementEntries).toBe(0);
    expect(await prismaOne.ledgerEntry.count()).toBe(ledgerCountBefore);
    expect(await prismaOne.reservation.count()).toBe(1);
    expect(await prismaOne.merchantDailyUsage.count()).toBe(usageBefore);
    expect(await prismaOne.outboxEvent.count()).toBe(outboxBefore);
    expect(postedBalance).toBe(BigInt(10_000));
    expect(activeReservedAmount).toBe(BigInt(4_000));
    expect(postedBalance - activeReservedAmount).toBe(BigInt(6_000));
  });

  it('returns a settled payment exactly once', async () => {
    const businessDate = new Date(Date.UTC(2026, 6, 29));
    await prismaOne.ledgerEntry.update({
      where: { entryKey: 'initial-credit:merchant-1' },
      data: { amount: BigInt(10_000) },
    });
    await prismaOne.payment.create({
      data: {
        id: 'first-return-payment',
        merchantId: 'merchant-1',
        idempotencyKey: 'first-return-payment-idem',
        requestFingerprint: 'first-return-payment-fingerprint',
        externalReference: 'first-return-payment-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(4_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'first-return-payment-account',
        routingNumber: '021000021',
        status: PaymentStatus.VALIDATED,
        validatedAt: businessDate,
        createdAt: businessDate,
      },
    });
    await prismaOne.reservation.create({
      data: {
        id: 'first-return-reservation',
        paymentId: 'first-return-payment',
        fundingAccountId: 'funding-account-1',
        amount: BigInt(4_000),
        status: ReservationStatus.SETTLED,
        settledAt: businessDate,
      },
    });
    await prismaOne.ledgerEntry.createMany({
      data: [
        {
          entryKey: 'reservation:first-return-payment',
          fundingAccountId: 'funding-account-1',
          paymentId: 'first-return-payment',
          entryType: LedgerEntryType.RESERVATION,
          amount: BigInt(4_000),
        },
        {
          entryKey: 'settlement:first-return-payment',
          fundingAccountId: 'funding-account-1',
          paymentId: 'first-return-payment',
          entryType: LedgerEntryType.SETTLEMENT,
          amount: BigInt(4_000),
        },
      ],
    });
    const balanceQuery = () =>
      prismaOne.$queryRaw<{ total: bigint | null }[]>(
        Prisma.sql`SELECT COALESCE(SUM(CASE WHEN "entryType" IN ('INITIAL_CREDIT'::"LedgerEntryType", 'CREDIT_POSTED'::"LedgerEntryType", 'RETURN'::"LedgerEntryType", 'REVERSAL'::"LedgerEntryType", 'ADJUSTMENT'::"LedgerEntryType") THEN "amount" WHEN "entryType" = 'DEBIT_POSTED'::"LedgerEntryType" THEN -"amount" ELSE 0 END), 0) AS total FROM "LedgerEntry" WHERE "fundingAccountId" = ${'funding-account-1'}`,
      );
    const [beforeRows, activeBefore] = await Promise.all([
      balanceQuery(),
      prismaOne.reservation.aggregate({
        where: {
          fundingAccountId: 'funding-account-1',
          status: ReservationStatus.ACTIVE,
        },
        _sum: { amount: true },
      }),
    ]);
    const usageBefore = await prismaOne.merchantDailyUsage.count();
    const outboxBefore = await prismaOne.outboxEvent.count();
    const postedBefore = BigInt(beforeRows[0]?.total ?? 0);
    const activeReservedBefore = BigInt(activeBefore._sum.amount ?? 0);
    expect(postedBefore).toBe(BigInt(10_000));
    expect(activeReservedBefore).toBe(BigInt(0));

    const lifecycle = new PaymentLifecycleRepository(prismaOne);
    const firstReturn = await lifecycle.returnSettlementForPayment(
      'first-return-payment',
      'R01',
    );
    const reservationAfterFirst = await prismaOne.reservation.findUniqueOrThrow(
      {
        where: { paymentId: 'first-return-payment' },
      },
    );
    const returnAfterFirst = await prismaOne.ledgerEntry.findFirstOrThrow({
      where: {
        paymentId: 'first-return-payment',
        entryType: LedgerEntryType.RETURN,
      },
    });
    const secondReturn = await lifecycle.returnSettlementForPayment(
      'first-return-payment',
      'R01',
    );
    if (!firstReturn || !secondReturn) {
      throw new Error('Expected credit return to return its reservation.');
    }
    const reservations = await prismaOne.reservation.findMany({
      where: { paymentId: 'first-return-payment' },
    });
    const settlementEntries = await prismaOne.ledgerEntry.count({
      where: {
        paymentId: 'first-return-payment',
        entryType: LedgerEntryType.SETTLEMENT,
      },
    });
    const returnEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        paymentId: 'first-return-payment',
        entryType: LedgerEntryType.RETURN,
      },
    });
    const [afterRows, activeAfter] = await Promise.all([
      balanceQuery(),
      prismaOne.reservation.aggregate({
        where: {
          fundingAccountId: 'funding-account-1',
          status: ReservationStatus.ACTIVE,
        },
        _sum: { amount: true },
      }),
    ]);
    const postedAfter = BigInt(afterRows[0]?.total ?? 0);
    const activeReservedAfter = BigInt(activeAfter._sum.amount ?? 0);

    expect(firstReturn).toMatchObject({
      id: 'first-return-reservation',
      status: ReservationStatus.RETURNED,
      returnCode: 'R01',
    });
    expect(firstReturn.returnedAt).toBeInstanceOf(Date);
    expect(secondReturn).toEqual(reservationAfterFirst);
    expect(reservations).toEqual([
      expect.objectContaining({
        id: 'first-return-reservation',
        status: ReservationStatus.RETURNED,
        settledAt: businessDate,
        returnedAt: firstReturn.returnedAt,
        returnCode: 'R01',
      }),
    ]);
    expect(settlementEntries).toBe(1);
    expect(returnEntries).toEqual([
      expect.objectContaining({
        id: returnAfterFirst.id,
        entryKey: 'return:first-return-payment',
        amount: BigInt(4_000),
      }),
    ]);
    expect(await prismaOne.reservation.count()).toBe(1);
    expect(await prismaOne.ledgerEntry.count()).toBe(4);
    expect(await prismaOne.merchantDailyUsage.count()).toBe(usageBefore);
    expect(await prismaOne.outboxEvent.count()).toBe(outboxBefore + 1);
    expect(postedAfter).toBe(BigInt(14_000));
    expect(activeReservedAfter).toBe(BigInt(0));
    expect(postedBefore - activeReservedBefore).toBe(BigInt(10_000));
    expect(postedAfter - activeReservedAfter).toBe(BigInt(14_000));
  });

  it('returns the same settled payment concurrently exactly once', async () => {
    const businessDate = new Date(Date.UTC(2026, 6, 29));
    await prismaOne.ledgerEntry.update({
      where: { entryKey: 'initial-credit:merchant-1' },
      data: { amount: BigInt(10_000) },
    });
    await prismaOne.payment.create({
      data: {
        id: 'concurrent-return-payment',
        merchantId: 'merchant-1',
        idempotencyKey: 'concurrent-return-payment-idem',
        requestFingerprint: 'concurrent-return-payment-fingerprint',
        externalReference: 'concurrent-return-payment-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(4_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'concurrent-return-payment-account',
        routingNumber: '021000021',
        status: PaymentStatus.VALIDATED,
        validatedAt: businessDate,
        createdAt: businessDate,
      },
    });
    await prismaOne.reservation.create({
      data: {
        id: 'concurrent-return-reservation',
        paymentId: 'concurrent-return-payment',
        fundingAccountId: 'funding-account-1',
        amount: BigInt(4_000),
        status: ReservationStatus.SETTLED,
        settledAt: businessDate,
      },
    });
    await prismaOne.ledgerEntry.createMany({
      data: [
        {
          entryKey: 'reservation:concurrent-return-payment',
          fundingAccountId: 'funding-account-1',
          paymentId: 'concurrent-return-payment',
          entryType: LedgerEntryType.RESERVATION,
          amount: BigInt(4_000),
        },
        {
          entryKey: 'settlement:concurrent-return-payment',
          fundingAccountId: 'funding-account-1',
          paymentId: 'concurrent-return-payment',
          entryType: LedgerEntryType.SETTLEMENT,
          amount: BigInt(4_000),
        },
      ],
    });
    const usageBefore = await prismaOne.merchantDailyUsage.count();
    const outboxBefore = await prismaOne.outboxEvent.count();
    const repositoryOne = new PaymentLifecycleRepository(prismaOne);
    const repositoryTwo = new PaymentLifecycleRepository(prismaTwo);
    const firstReturnPromise = repositoryOne.returnSettlementForPayment(
      'concurrent-return-payment',
      'R01',
    );
    const secondReturnPromise = repositoryTwo.returnSettlementForPayment(
      'concurrent-return-payment',
      'R01',
    );
    const [firstReturn, secondReturn] = await Promise.all([
      firstReturnPromise,
      secondReturnPromise,
    ]);
    if (!firstReturn || !secondReturn) {
      throw new Error(
        'Expected both concurrent credit returns to return reservations.',
      );
    }
    const reservations = await prismaOne.reservation.findMany({
      where: { paymentId: 'concurrent-return-payment' },
    });
    const returnEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        paymentId: 'concurrent-return-payment',
        entryType: LedgerEntryType.RETURN,
      },
    });
    const balances = await prismaOne.$queryRaw<{ total: bigint | null }[]>(
      Prisma.sql`SELECT COALESCE(SUM(CASE WHEN "entryType" IN ('INITIAL_CREDIT'::"LedgerEntryType", 'CREDIT_POSTED'::"LedgerEntryType", 'RETURN'::"LedgerEntryType", 'REVERSAL'::"LedgerEntryType", 'ADJUSTMENT'::"LedgerEntryType") THEN "amount" WHEN "entryType" = 'DEBIT_POSTED'::"LedgerEntryType" THEN -"amount" ELSE 0 END), 0) AS total FROM "LedgerEntry" WHERE "fundingAccountId" = ${'funding-account-1'}`,
    );
    const activeReservations = await prismaOne.reservation.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        status: ReservationStatus.ACTIVE,
      },
      _sum: { amount: true },
    });
    const postedBalance = BigInt(balances[0]?.total ?? 0);
    const activeReservedAmount = BigInt(activeReservations._sum.amount ?? 0);

    expect(firstReturn).toMatchObject({
      id: 'concurrent-return-reservation',
      status: ReservationStatus.RETURNED,
      returnCode: 'R01',
    });
    expect(secondReturn).toMatchObject({
      id: 'concurrent-return-reservation',
      status: ReservationStatus.RETURNED,
      returnCode: 'R01',
    });
    expect(firstReturn.returnedAt).toBeInstanceOf(Date);
    expect(secondReturn.returnedAt).toEqual(firstReturn.returnedAt);
    expect(reservations).toEqual([
      expect.objectContaining({
        id: 'concurrent-return-reservation',
        status: ReservationStatus.RETURNED,
        settledAt: businessDate,
        returnedAt: firstReturn.returnedAt,
        returnCode: 'R01',
      }),
    ]);
    expect(returnEntries).toEqual([
      expect.objectContaining({
        entryKey: 'return:concurrent-return-payment',
        amount: BigInt(4_000),
      }),
    ]);
    expect(await prismaOne.reservation.count()).toBe(1);
    expect(await prismaOne.ledgerEntry.count()).toBe(4);
    expect(await prismaOne.merchantDailyUsage.count()).toBe(usageBefore);
    expect(await prismaOne.outboxEvent.count()).toBe(outboxBefore + 1);
    expect(postedBalance).toBe(BigInt(14_000));
    expect(activeReservedAmount).toBe(BigInt(0));
    expect(postedBalance - activeReservedAmount).toBe(BigInt(14_000));
  });

  it('rolls back return when the return audit entry conflicts', async () => {
    const businessDate = new Date(Date.UTC(2026, 6, 29));
    await prismaOne.ledgerEntry.update({
      where: { entryKey: 'initial-credit:merchant-1' },
      data: { amount: BigInt(10_000) },
    });
    await prismaOne.payment.create({
      data: {
        id: 'return-ledger-conflict-payment',
        merchantId: 'merchant-1',
        idempotencyKey: 'return-ledger-conflict-payment-idem',
        requestFingerprint: 'return-ledger-conflict-payment-fingerprint',
        externalReference: 'return-ledger-conflict-payment-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(4_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'return-ledger-conflict-payment-account',
        routingNumber: '021000021',
        status: PaymentStatus.VALIDATED,
        validatedAt: businessDate,
        createdAt: businessDate,
      },
    });
    await prismaOne.reservation.create({
      data: {
        id: 'return-ledger-conflict-reservation',
        paymentId: 'return-ledger-conflict-payment',
        fundingAccountId: 'funding-account-1',
        amount: BigInt(4_000),
        status: ReservationStatus.SETTLED,
        settledAt: businessDate,
      },
    });
    await prismaOne.ledgerEntry.createMany({
      data: [
        {
          entryKey: 'reservation:return-ledger-conflict-payment',
          fundingAccountId: 'funding-account-1',
          paymentId: 'return-ledger-conflict-payment',
          entryType: LedgerEntryType.RESERVATION,
          amount: BigInt(4_000),
        },
        {
          entryKey: 'settlement:return-ledger-conflict-payment',
          fundingAccountId: 'funding-account-1',
          paymentId: 'return-ledger-conflict-payment',
          entryType: LedgerEntryType.SETTLEMENT,
          amount: BigInt(4_000),
        },
        {
          entryKey: 'return:return-ledger-conflict-payment',
          fundingAccountId: 'funding-account-1',
          paymentId: 'return-ledger-conflict-payment',
          entryType: LedgerEntryType.RESERVATION,
          amount: BigInt(1),
        },
      ],
    });
    const lifecycle = new PaymentLifecycleRepository(prismaOne);
    const usageBefore = await prismaOne.merchantDailyUsage.count();
    const outboxBefore = await prismaOne.outboxEvent.count();
    const ledgerCountBefore = await prismaOne.ledgerEntry.count();
    let error: unknown;
    try {
      await lifecycle.returnSettlementForPayment(
        'return-ledger-conflict-payment',
        'R01',
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    const prismaError = error as Prisma.PrismaClientKnownRequestError;
    expect(prismaError.code).toBe('P2002');
    const reservation = await prismaOne.reservation.findUniqueOrThrow({
      where: { paymentId: 'return-ledger-conflict-payment' },
    });
    const reservationEntries = await prismaOne.ledgerEntry.count({
      where: {
        paymentId: 'return-ledger-conflict-payment',
        entryType: LedgerEntryType.RESERVATION,
        entryKey: 'reservation:return-ledger-conflict-payment',
      },
    });
    const settlementEntries = await prismaOne.ledgerEntry.count({
      where: {
        paymentId: 'return-ledger-conflict-payment',
        entryType: LedgerEntryType.SETTLEMENT,
      },
    });
    const conflictingEntries = await prismaOne.ledgerEntry.findMany({
      where: {
        paymentId: 'return-ledger-conflict-payment',
        entryKey: 'return:return-ledger-conflict-payment',
      },
    });
    const validReturnEntries = await prismaOne.ledgerEntry.count({
      where: {
        paymentId: 'return-ledger-conflict-payment',
        entryType: LedgerEntryType.RETURN,
      },
    });
    const posted = await prismaOne.ledgerEntry.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        entryType: LedgerEntryType.INITIAL_CREDIT,
      },
      _sum: { amount: true },
    });
    const active = await prismaOne.reservation.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        status: ReservationStatus.ACTIVE,
      },
      _sum: { amount: true },
    });
    const postedBalance = BigInt(posted._sum.amount ?? 0);
    const activeReservedAmount = BigInt(active._sum.amount ?? 0);

    expect(reservation).toMatchObject({
      id: 'return-ledger-conflict-reservation',
      status: ReservationStatus.SETTLED,
      settledAt: businessDate,
      returnedAt: null,
      returnCode: null,
    });
    expect(reservationEntries).toBe(1);
    expect(settlementEntries).toBe(1);
    expect(conflictingEntries).toEqual([
      expect.objectContaining({
        entryType: LedgerEntryType.RESERVATION,
        amount: BigInt(1),
        entryKey: 'return:return-ledger-conflict-payment',
      }),
    ]);
    expect(validReturnEntries).toBe(0);
    expect(await prismaOne.ledgerEntry.count()).toBe(ledgerCountBefore);
    expect(await prismaOne.reservation.count()).toBe(1);
    expect(await prismaOne.merchantDailyUsage.count()).toBe(usageBefore);
    expect(await prismaOne.outboxEvent.count()).toBe(outboxBefore);
    expect(postedBalance).toBe(BigInt(10_000));
    expect(activeReservedAmount).toBe(BigInt(0));
    expect(postedBalance - activeReservedAmount).toBe(BigInt(10_000));
  });

  it('processes the same bank settlement event exactly once', async () => {
    const timestamp = new Date('2026-07-29T12:00:00.000Z');
    await prismaOne.ledgerEntry.update({
      where: { entryKey: 'initial-credit:merchant-1' },
      data: { amount: BigInt(10_000) },
    });
    await prismaOne.payment.create({
      data: {
        id: 'reconciled-payment',
        merchantId: 'merchant-1',
        idempotencyKey: 'reconciled-payment-idem',
        requestFingerprint: 'reconciled-payment-fingerprint',
        externalReference: 'reconciled-payment-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(4_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'reconciled-payment-account',
        routingNumber: '021000021',
        status: PaymentStatus.SETTLED,
        validatedAt: timestamp,
        createdAt: timestamp,
      },
    });
    await prismaOne.reservation.create({
      data: {
        id: 'reconciled-reservation',
        paymentId: 'reconciled-payment',
        fundingAccountId: 'funding-account-1',
        amount: BigInt(4_000),
        status: ReservationStatus.SETTLED,
        settledAt: timestamp,
      },
    });
    await prismaOne.ledgerEntry.createMany({
      data: [
        {
          entryKey: 'reservation:reconciled-payment',
          fundingAccountId: 'funding-account-1',
          paymentId: 'reconciled-payment',
          entryType: LedgerEntryType.RESERVATION,
          amount: BigInt(4_000),
        },
        {
          entryKey: 'settlement:reconciled-payment',
          fundingAccountId: 'funding-account-1',
          paymentId: 'reconciled-payment',
          entryType: LedgerEntryType.SETTLEMENT,
          amount: BigInt(4_000),
        },
      ],
    });
    const lifecycle = new PaymentLifecycleRepository(prismaOne);
    const event = {
      bankEventId: 'bank-event-001',
      paymentId: 'reconciled-payment',
      eventType: 'SETTLED' as const,
      eventTimestamp: timestamp,
    };
    const usageBefore = await prismaOne.merchantDailyUsage.count();
    const outboxBefore = await prismaOne.outboxEvent.count();
    const first = await lifecycle.processBankSettlementEvent(event);
    const second = await lifecycle.processBankSettlementEvent(event);
    const events = await prismaOne.processedBankEvent.findMany({
      where: { bankEventId: 'bank-event-001' },
    });
    const payment = await prismaOne.payment.findUniqueOrThrow({
      where: { id: 'reconciled-payment' },
    });
    const reservation = await prismaOne.reservation.findUniqueOrThrow({
      where: { paymentId: 'reconciled-payment' },
    });
    const settlementEntries = await prismaOne.ledgerEntry.count({
      where: {
        paymentId: 'reconciled-payment',
        entryType: LedgerEntryType.SETTLEMENT,
      },
    });
    const posted = await prismaOne.ledgerEntry.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        entryType: LedgerEntryType.INITIAL_CREDIT,
      },
      _sum: { amount: true },
    });
    const active = await prismaOne.reservation.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        status: ReservationStatus.ACTIVE,
      },
      _sum: { amount: true },
    });
    const postedBalance = BigInt(posted._sum.amount ?? 0);
    const available = postedBalance - BigInt(active._sum.amount ?? 0);

    expect(first).toEqual(second);
    expect(events).toEqual([
      expect.objectContaining({
        id: first.id,
        bankEventId: 'bank-event-001',
        paymentId: 'reconciled-payment',
        eventType: 'SETTLED',
        eventTimestamp: timestamp,
      }),
    ]);
    expect(payment.status).toBe(PaymentStatus.SETTLED);
    expect(reservation.status).toBe(ReservationStatus.SETTLED);
    expect(settlementEntries).toBe(1);
    expect(postedBalance).toBe(BigInt(10_000));
    expect(available).toBe(BigInt(10_000));
    expect(await prismaOne.merchantDailyUsage.count()).toBe(usageBefore);
    expect(await prismaOne.outboxEvent.count()).toBe(outboxBefore);
  });

  it('completes a full ACH payment lifecycle successfully', async () => {
    const createdAt = new Date('2026-07-29T12:00:00.000Z');
    await prismaOne.ledgerEntry.update({
      where: { entryKey: 'initial-credit:merchant-1' },
      data: { amount: BigInt(10_000) },
    });
    await prismaOne.payment.create({
      data: {
        id: 'end-to-end-payment',
        merchantId: 'merchant-1',
        idempotencyKey: 'end-to-end-payment-idem',
        requestFingerprint: 'end-to-end-payment-fingerprint',
        externalReference: 'end-to-end-payment-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(4_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'end-to-end-payment-account',
        routingNumber: '021000021',
        status: PaymentStatus.RECEIVED,
        createdAt,
      },
    });
    await prismaOne.outboxEvent.create({
      data: {
        id: 'end-to-end-payment-event',
        eventType: OutboxEventType.PAYMENT_RECEIVED,
        aggregateType: 'PAYMENT',
        aggregateId: 'end-to-end-payment',
        payload: {
          ...paymentPayload('end-to-end-payment'),
          direction: PaymentDirection.CREDIT,
          amountCents: '4000',
          createdAt: createdAt.toISOString(),
        },
        availableAt: new Date(0),
      },
    });

    const [claimedEvent] = await repositoryOne.claimPending(1);
    expect(claimedEvent).toMatchObject({ id: 'end-to-end-payment-event' });
    const lifecycle = new PaymentLifecycleRepository(prismaOne);
    const validation = new PaymentValidationService(lifecycle);
    await validation.validate('end-to-end-payment', claimedEvent.id);
    const generated = await new NachaFileGeneratorService(prismaOne).generate(
      createdAt,
    );
    expect(generated).not.toBeNull();
    const settled =
      await lifecycle.settleReservationForPayment('end-to-end-payment');
    if (!settled) {
      throw new Error('Expected the credit reservation to settle.');
    }
    const reconciled = await lifecycle.processBankSettlementEvent({
      bankEventId: 'end-to-end-bank-event',
      paymentId: 'end-to-end-payment',
      eventType: 'SETTLED',
      eventTimestamp: new Date('2026-07-29T13:00:00.000Z'),
    });
    const returned = await lifecycle.returnSettlementForPayment(
      'end-to-end-payment',
      'R01',
    );
    if (!returned) {
      throw new Error('Expected credit return to return its reservation.');
    }

    const payment = await prismaOne.payment.findUniqueOrThrow({
      where: { id: 'end-to-end-payment' },
    });
    const reservation = await prismaOne.reservation.findUniqueOrThrow({
      where: { paymentId: 'end-to-end-payment' },
    });
    const ledgerCounts = await prismaOne.ledgerEntry.groupBy({
      by: ['entryType'],
      where: { paymentId: 'end-to-end-payment' },
      _count: { _all: true },
    });
    const processedEvents = await prismaOne.processedBankEvent.findMany({
      where: { bankEventId: 'end-to-end-bank-event' },
    });
    const outbox = await prismaOne.outboxEvent.findUniqueOrThrow({
      where: { id: 'end-to-end-payment-event' },
    });
    const posted = await prismaOne.$queryRaw<{ total: bigint | null }[]>(
      Prisma.sql`SELECT COALESCE(SUM(CASE WHEN "entryType" IN ('INITIAL_CREDIT'::"LedgerEntryType", 'CREDIT_POSTED'::"LedgerEntryType", 'RETURN'::"LedgerEntryType", 'REVERSAL'::"LedgerEntryType", 'ADJUSTMENT'::"LedgerEntryType") THEN "amount" WHEN "entryType" = 'DEBIT_POSTED'::"LedgerEntryType" THEN -"amount" ELSE 0 END), 0) AS total FROM "LedgerEntry" WHERE "fundingAccountId" = ${'funding-account-1'}`,
    );
    const active = await prismaOne.reservation.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        status: ReservationStatus.ACTIVE,
      },
      _sum: { amount: true },
    });
    const postedBalance = BigInt(posted[0]?.total ?? 0);
    const activeReserved = BigInt(active._sum.amount ?? 0);

    expect(settled.status).toBe(ReservationStatus.SETTLED);
    expect(reconciled).toMatchObject({ bankEventId: 'end-to-end-bank-event' });
    expect(returned.status).toBe(ReservationStatus.RETURNED);
    expect(payment).toMatchObject({ status: PaymentStatus.RETURNED });
    expect(payment.validatedAt).toBeInstanceOf(Date);
    expect(reservation).toMatchObject({
      status: ReservationStatus.RETURNED,
      returnCode: 'R01',
    });
    expect(reservation.settledAt).toBeInstanceOf(Date);
    expect(reservation.returnedAt).toBeInstanceOf(Date);
    expect(ledgerCounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entryType: LedgerEntryType.RESERVATION,
          _count: { _all: 1 },
        }),
        expect.objectContaining({
          entryType: LedgerEntryType.SETTLEMENT,
          _count: { _all: 1 },
        }),
        expect.objectContaining({
          entryType: LedgerEntryType.RETURN,
          _count: { _all: 1 },
        }),
      ]),
    );
    expect(await prismaOne.ledgerEntry.count()).toBe(4);
    expect(processedEvents).toHaveLength(1);
    expect(postedBalance).toBe(BigInt(14_000));
    expect(activeReserved).toBe(BigInt(0));
    expect(postedBalance - activeReserved).toBe(BigInt(14_000));
    expect(await prismaOne.merchantDailyUsage.count()).toBe(1);
    expect(outbox).toMatchObject({ status: OutboxEventStatus.PROCESSED });
  });

  it('publishes an outbox event exactly once after a worker retry', async () => {
    const config = new WorkerConfigService({
      ...process.env,
      OUTBOX_BATCH_SIZE: '1',
      OUTBOX_MAX_ATTEMPTS: '3',
      OUTBOX_CLAIM_LEASE_MS: '30000',
    });
    const publishAttempts: string[] = [];
    const publisher = {
      handle: (event: { id: string }): void => {
        publishAttempts.push(event.id);
      },
    };
    const retryWorker = new OutboxPollingService(
      repositoryOne,
      publisher as unknown as OutboxHandler,
      config,
    );
    await prismaOne.outboxEvent.create({
      data: {
        id: 'publish-retry-event-001',
        eventType: OutboxEventType.PAYMENT_RECEIVED,
        aggregateType: 'TEST',
        aggregateId: 'publish-retry-aggregate-001',
        payload: {
          eventId: 'publish-retry-event-001',
          kind: 'deterministic-test',
        },
        status: OutboxEventStatus.PENDING,
        availableAt: new Date(0),
      },
    });
    const markProcessed = jest
      .spyOn(repositoryOne, 'markProcessed')
      .mockRejectedValueOnce(new Error('controlled crash after publish'));

    try {
      await retryWorker.processOnce();
    } finally {
      markProcessed.mockRestore();
    }

    const afterFailure = await prismaOne.outboxEvent.findUniqueOrThrow({
      where: { id: 'publish-retry-event-001' },
    });
    expect(publishAttempts).toEqual(['publish-retry-event-001']);
    expect(afterFailure).toMatchObject({
      status: OutboxEventStatus.PENDING,
      processedAt: null,
      attempts: 1,
    });

    await prismaOne.outboxEvent.update({
      where: { id: afterFailure.id },
      data: { availableAt: new Date(0) },
    });
    await retryWorker.processOnce();

    const event = await prismaOne.outboxEvent.findUniqueOrThrow({
      where: { id: 'publish-retry-event-001' },
    });
    expect(publishAttempts).toEqual([
      'publish-retry-event-001',
      'publish-retry-event-001',
    ]);
    expect(await prismaOne.outboxEvent.count()).toBe(1);
    expect(event).toMatchObject({
      status: OutboxEventStatus.PROCESSED,
      attempts: 2,
      lastError: null,
    });
    expect(event.processedAt).toBeInstanceOf(Date);
    expect(await prismaOne.payment.count()).toBe(0);
    expect(await prismaOne.reservation.count()).toBe(0);
    expect(await prismaOne.ledgerEntry.count()).toBe(1);
  });

  it('reprocesses a bank settlement event successfully after a failed transaction', async () => {
    const timestamp = new Date('2026-07-29T12:00:00.000Z');
    await prismaOne.ledgerEntry.update({
      where: { entryKey: 'initial-credit:merchant-1' },
      data: { amount: BigInt(10_000) },
    });
    await prismaOne.payment.create({
      data: {
        id: 'retry-bank-event-payment',
        merchantId: 'merchant-1',
        idempotencyKey: 'retry-bank-event-payment-idem',
        requestFingerprint: 'retry-bank-event-payment-fingerprint',
        externalReference: 'retry-bank-event-payment-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(4_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'retry-bank-event-payment-account',
        routingNumber: '021000021',
        status: PaymentStatus.SETTLED,
        validatedAt: timestamp,
        createdAt: timestamp,
      },
    });
    await prismaOne.reservation.create({
      data: {
        id: 'retry-bank-event-reservation',
        paymentId: 'retry-bank-event-payment',
        fundingAccountId: 'funding-account-1',
        amount: BigInt(4_000),
        status: ReservationStatus.SETTLED,
        settledAt: timestamp,
      },
    });
    await prismaOne.ledgerEntry.createMany({
      data: [
        {
          entryKey: 'reservation:retry-bank-event-payment',
          fundingAccountId: 'funding-account-1',
          paymentId: 'retry-bank-event-payment',
          entryType: LedgerEntryType.RESERVATION,
          amount: BigInt(4_000),
        },
        {
          entryKey: 'settlement:retry-bank-event-payment',
          fundingAccountId: 'funding-account-1',
          paymentId: 'retry-bank-event-payment',
          entryType: LedgerEntryType.SETTLEMENT,
          amount: BigInt(4_000),
        },
      ],
    });

    const lifecycle = new PaymentLifecycleRepository(prismaOne);
    const event = {
      bankEventId: 'retry-bank-event-001',
      paymentId: 'retry-bank-event-payment',
      eventType: 'SETTLED' as const,
      eventTimestamp: timestamp,
    };
    const usageBefore = await prismaOne.merchantDailyUsage.count();
    const outboxBefore = await prismaOne.outboxEvent.count();
    const spy = jest
      .spyOn(
        PaymentLifecycleRepository.prototype as unknown as {
          afterBankSettlementEventPersisted: () => Promise<void>;
        },
        'afterBankSettlementEventPersisted',
      )
      .mockRejectedValueOnce(
        new Error('controlled bank settlement transaction failure'),
      );

    let firstError: unknown;
    try {
      await lifecycle.processBankSettlementEvent(event);
    } catch (caught) {
      firstError = caught;
    } finally {
      spy.mockRestore();
    }

    expect(firstError).toEqual(
      expect.objectContaining({
        message: 'controlled bank settlement transaction failure',
      }),
    );
    expect(
      await prismaOne.processedBankEvent.count({
        where: { bankEventId: event.bankEventId },
      }),
    ).toBe(0);

    const second = await lifecycle.processBankSettlementEvent(event);
    const processedEvents = await prismaOne.processedBankEvent.findMany({
      where: { bankEventId: event.bankEventId },
    });
    const reservation = await prismaOne.reservation.findUniqueOrThrow({
      where: { paymentId: event.paymentId },
    });
    const payment = await prismaOne.payment.findUniqueOrThrow({
      where: { id: event.paymentId },
    });
    const ledgerCounts = await prismaOne.ledgerEntry.groupBy({
      by: ['entryType'],
      where: { paymentId: event.paymentId },
      _count: { _all: true },
    });
    const posted = await prismaOne.$queryRaw<{ total: bigint | null }[]>(
      Prisma.sql`SELECT COALESCE(SUM(CASE WHEN "entryType" IN ('INITIAL_CREDIT'::"LedgerEntryType", 'CREDIT_POSTED'::"LedgerEntryType", 'RETURN'::"LedgerEntryType", 'REVERSAL'::"LedgerEntryType", 'ADJUSTMENT'::"LedgerEntryType") THEN "amount" WHEN "entryType" = 'DEBIT_POSTED'::"LedgerEntryType" THEN -"amount" ELSE 0 END), 0) AS total FROM "LedgerEntry" WHERE "fundingAccountId" = ${'funding-account-1'}`,
    );
    const activeReservations = await prismaOne.reservation.aggregate({
      where: {
        fundingAccountId: 'funding-account-1',
        status: ReservationStatus.ACTIVE,
      },
      _sum: { amount: true },
    });
    const postedBalance = BigInt(posted[0]?.total ?? 0);
    const availableBalance =
      postedBalance - BigInt(activeReservations._sum.amount ?? 0);

    expect(second).toMatchObject({
      bankEventId: event.bankEventId,
      paymentId: event.paymentId,
    });
    expect(processedEvents).toHaveLength(1);
    expect(reservation.status).toBe(ReservationStatus.SETTLED);
    expect(payment.status).toBe(PaymentStatus.SETTLED);
    expect(ledgerCounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entryType: LedgerEntryType.RESERVATION,
          _count: { _all: 1 },
        }),
        expect.objectContaining({
          entryType: LedgerEntryType.SETTLEMENT,
          _count: { _all: 1 },
        }),
      ]),
    );
    expect(await prismaOne.ledgerEntry.count()).toBe(3);
    expect(postedBalance).toBe(BigInt(10_000));
    expect(availableBalance).toBe(BigInt(10_000));
    expect(await prismaOne.merchantDailyUsage.count()).toBe(usageBefore);
    expect(await prismaOne.outboxEvent.count()).toBe(outboxBefore);
  });

  it('ignores a late bank settlement event after a payment has already been returned', async () => {
    const settledAt = new Date('2026-07-29T12:00:00.000Z');
    const returnedAt = new Date('2026-07-29T13:00:00.000Z');
    const eventTimestamp = new Date('2026-07-29T14:00:00.000Z');
    await prismaOne.ledgerEntry.update({
      where: { entryKey: 'initial-credit:merchant-1' },
      data: { amount: BigInt(10_000) },
    });
    await prismaOne.payment.create({
      data: {
        id: 'late-bank-settlement-payment',
        merchantId: 'merchant-1',
        idempotencyKey: 'late-bank-settlement-payment-idem',
        requestFingerprint: 'late-bank-settlement-payment-fingerprint',
        externalReference: 'late-bank-settlement-payment-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(4_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'late-bank-settlement-payment-account',
        routingNumber: '021000021',
        status: PaymentStatus.RETURNED,
        validatedAt: settledAt,
        createdAt: settledAt,
      },
    });
    await prismaOne.reservation.create({
      data: {
        id: 'late-bank-settlement-reservation',
        paymentId: 'late-bank-settlement-payment',
        fundingAccountId: 'funding-account-1',
        amount: BigInt(4_000),
        status: ReservationStatus.RETURNED,
        settledAt,
        returnedAt,
        returnCode: 'R01',
      },
    });
    await prismaOne.ledgerEntry.createMany({
      data: [
        {
          entryKey: 'reservation:late-bank-settlement-payment',
          fundingAccountId: 'funding-account-1',
          paymentId: 'late-bank-settlement-payment',
          entryType: LedgerEntryType.RESERVATION,
          amount: BigInt(4_000),
        },
        {
          entryKey: 'settlement:late-bank-settlement-payment',
          fundingAccountId: 'funding-account-1',
          paymentId: 'late-bank-settlement-payment',
          entryType: LedgerEntryType.SETTLEMENT,
          amount: BigInt(4_000),
        },
        {
          entryKey: 'return:late-bank-settlement-payment',
          fundingAccountId: 'funding-account-1',
          paymentId: 'late-bank-settlement-payment',
          entryType: LedgerEntryType.RETURN,
          amount: BigInt(4_000),
        },
      ],
    });
    const lifecycle = new PaymentLifecycleRepository(prismaOne);
    const usageBefore = await prismaOne.merchantDailyUsage.count();
    const outboxBefore = await prismaOne.outboxEvent.count();
    const balancesBefore = await prismaOne.$queryRaw<
      { total: bigint | null }[]
    >(
      Prisma.sql`SELECT COALESCE(SUM(CASE WHEN "entryType" IN ('INITIAL_CREDIT'::"LedgerEntryType", 'CREDIT_POSTED'::"LedgerEntryType", 'RETURN'::"LedgerEntryType", 'REVERSAL'::"LedgerEntryType", 'ADJUSTMENT'::"LedgerEntryType") THEN "amount" WHEN "entryType" = 'DEBIT_POSTED'::"LedgerEntryType" THEN -"amount" ELSE 0 END), 0) AS total FROM "LedgerEntry" WHERE "fundingAccountId" = ${'funding-account-1'}`,
    );
    const result = await lifecycle.processBankSettlementEvent({
      bankEventId: 'late-bank-settlement-event',
      paymentId: 'late-bank-settlement-payment',
      eventType: 'SETTLED',
      eventTimestamp,
    });
    const events = await prismaOne.processedBankEvent.findMany({
      where: { bankEventId: 'late-bank-settlement-event' },
    });
    const reservation = await prismaOne.reservation.findUniqueOrThrow({
      where: { paymentId: 'late-bank-settlement-payment' },
    });
    const payment = await prismaOne.payment.findUniqueOrThrow({
      where: { id: 'late-bank-settlement-payment' },
    });
    const ledgerCounts = await prismaOne.ledgerEntry.groupBy({
      by: ['entryType'],
      where: { paymentId: 'late-bank-settlement-payment' },
      _count: { _all: true },
    });
    const balancesAfter = await prismaOne.$queryRaw<{ total: bigint | null }[]>(
      Prisma.sql`SELECT COALESCE(SUM(CASE WHEN "entryType" IN ('INITIAL_CREDIT'::"LedgerEntryType", 'CREDIT_POSTED'::"LedgerEntryType", 'RETURN'::"LedgerEntryType", 'REVERSAL'::"LedgerEntryType", 'ADJUSTMENT'::"LedgerEntryType") THEN "amount" WHEN "entryType" = 'DEBIT_POSTED'::"LedgerEntryType" THEN -"amount" ELSE 0 END), 0) AS total FROM "LedgerEntry" WHERE "fundingAccountId" = ${'funding-account-1'}`,
    );

    expect(result).toMatchObject({
      bankEventId: 'late-bank-settlement-event',
      paymentId: 'late-bank-settlement-payment',
    });
    expect(events).toHaveLength(1);
    expect(reservation).toMatchObject({
      status: ReservationStatus.RETURNED,
      returnedAt,
      returnCode: 'R01',
    });
    expect(payment.status).toBe(PaymentStatus.RETURNED);
    expect(ledgerCounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entryType: LedgerEntryType.RESERVATION,
          _count: { _all: 1 },
        }),
        expect.objectContaining({
          entryType: LedgerEntryType.SETTLEMENT,
          _count: { _all: 1 },
        }),
        expect.objectContaining({
          entryType: LedgerEntryType.RETURN,
          _count: { _all: 1 },
        }),
      ]),
    );
    expect(await prismaOne.ledgerEntry.count()).toBe(4);
    expect(BigInt(balancesBefore[0]?.total ?? 0)).toBe(BigInt(14_000));
    expect(BigInt(balancesAfter[0]?.total ?? 0)).toBe(BigInt(14_000));
    expect(await prismaOne.merchantDailyUsage.count()).toBe(usageBefore);
    expect(await prismaOne.outboxEvent.count()).toBe(outboxBefore);
  });

  it('serializes concurrent daily-limit reservations without double-counting', async () => {
    await prismaOne.merchant.update({
      where: { id: 'merchant-1' },
      data: {
        dailyAmountLimit: BigInt(10_000),
        perPaymentLimit: BigInt(10_000),
      },
    });
    await prismaOne.payment.createMany({
      data: ['daily-one', 'daily-two'].map((id) => ({
        id,
        merchantId: 'merchant-1',
        idempotencyKey: `${id}-idem`,
        requestFingerprint: `${id}-fingerprint`,
        externalReference: `${id}-reference`,
        direction: PaymentDirection.DEBIT,
        amountCents: BigInt(6_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: `${id}-account`,
        routingNumber: '021000021',
      })),
    });
    await prismaOne.outboxEvent.createMany({
      data: ['daily-one', 'daily-two'].map((id) => ({
        eventType: OutboxEventType.PAYMENT_RECEIVED,
        aggregateType: 'PAYMENT',
        aggregateId: id,
        payload: paymentPayload(id),
        availableAt: new Date(0),
      })),
    });

    await Promise.all([workerOne.processOnce(), workerTwo.processOnce()]);

    const payments = await prismaOne.payment.findMany({
      where: { id: { in: ['daily-one', 'daily-two'] } },
    });
    expect(
      payments.filter((item) => item.status === PaymentStatus.VALIDATED),
    ).toHaveLength(1);
    expect(
      payments.find((item) => item.status === PaymentStatus.VALIDATION_FAILED),
    ).toMatchObject({
      validationCode: 'EXCEEDS_DAILY_AMOUNT_LIMIT',
      failureCode: 'EXCEEDS_DAILY_AMOUNT_LIMIT',
    });
    expect(
      await prismaOne.merchantDailyUsage.findFirst({
        where: { merchantId: 'merchant-1' },
      }),
    ).toMatchObject({ utilizedAmount: BigInt(6_000) });
  });

  it('recovers stale claims safely across concurrent workers', async () => {
    const staleClaimedAt = new Date(Date.now() - 31_000);
    const freshClaimedAt = new Date(Date.now() - 1_000);
    await prismaOne.outboxEvent.createMany({
      data: [
        {
          eventType: OutboxEventType.PAYMENT_RECEIVED,
          aggregateType: 'PAYMENT',
          aggregateId: 'stale-retry',
          payload: {},
          status: OutboxEventStatus.PROCESSING,
          attempts: 1,
          claimedAt: staleClaimedAt,
        },
        {
          eventType: OutboxEventType.PAYMENT_RECEIVED,
          aggregateType: 'PAYMENT',
          aggregateId: 'stale-failed',
          payload: {},
          status: OutboxEventStatus.PROCESSING,
          attempts: 3,
          claimedAt: staleClaimedAt,
        },
        {
          eventType: OutboxEventType.PAYMENT_RECEIVED,
          aggregateType: 'PAYMENT',
          aggregateId: 'fresh',
          payload: {},
          status: OutboxEventStatus.PROCESSING,
          attempts: 1,
          claimedAt: freshClaimedAt,
        },
      ],
    });

    await Promise.all([
      repositoryOne.recoverExpiredClaims(3, 30_000),
      repositoryTwo.recoverExpiredClaims(3, 30_000),
    ]);

    const events = await prismaOne.outboxEvent.findMany({
      orderBy: { aggregateId: 'asc' },
    });

    expect(events[0]).toMatchObject({
      aggregateId: 'fresh',
      status: OutboxEventStatus.PROCESSING,
      attempts: 1,
      claimedAt: freshClaimedAt,
      lastError: null,
    });
    expect(events[1]).toMatchObject({
      aggregateId: 'stale-failed',
      status: OutboxEventStatus.FAILED,
      attempts: 3,
      claimedAt: null,
      lastError: 'Previous worker claim expired',
    });
    expect(events[2]).toMatchObject({
      aggregateId: 'stale-retry',
      status: OutboxEventStatus.PENDING,
      attempts: 1,
      claimedAt: null,
      lastError: 'Previous worker claim expired',
    });
  });

  it('emits each payment lifecycle outbox event exactly once', async () => {
    const createdAt = new Date('2026-07-29T12:00:00.000Z');
    await prismaOne.payment.create({
      data: {
        id: 'lifecycle-outbox-payment',
        merchantId: 'merchant-1',
        idempotencyKey: 'lifecycle-outbox-idempotency',
        requestFingerprint: 'lifecycle-outbox-fingerprint',
        externalReference: 'lifecycle-outbox-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: BigInt(4_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'lifecycle-outbox-account',
        routingNumber: '021000021',
        createdAt,
      },
    });
    await prismaOne.outboxEvent.create({
      data: {
        eventKey: 'payment:lifecycle-outbox-payment:PAYMENT_RECEIVED',
        eventType: OutboxEventType.PAYMENT_RECEIVED,
        aggregateType: 'PAYMENT',
        aggregateId: 'lifecycle-outbox-payment',
        payload: {
          ...paymentPayload('lifecycle-outbox-payment'),
          merchantId: 'merchant-1',
          amountCents: '4000',
          direction: PaymentDirection.CREDIT,
        },
        availableAt: new Date(0),
      },
    });

    const [claimed] = await repositoryOne.claimPending(1);
    const lifecycle = new PaymentLifecycleRepository(prismaOne);
    const validation = new PaymentValidationService(lifecycle);
    await validation.validate('lifecycle-outbox-payment', claimed.id);
    await validation
      .validate('lifecycle-outbox-payment', claimed.id)
      .catch(() => undefined);
    const generated = await new NachaFileGeneratorService(prismaOne).generate(
      createdAt,
    );
    expect(generated).not.toBeNull();
    await lifecycle.settleReservationForPayment('lifecycle-outbox-payment');
    await lifecycle.settleReservationForPayment('lifecycle-outbox-payment');
    await lifecycle.returnSettlementForPayment(
      'lifecycle-outbox-payment',
      'R01',
    );
    await lifecycle.returnSettlementForPayment(
      'lifecycle-outbox-payment',
      'R01',
    );

    const events = await prismaOne.outboxEvent.findMany({
      where: { aggregateId: 'lifecycle-outbox-payment' },
    });
    const count = (type: OutboxEventType) =>
      events.filter((event) => event.eventType === type).length;
    const payment = await prismaOne.payment.findUniqueOrThrow({
      where: { id: 'lifecycle-outbox-payment' },
    });
    const reservation = await prismaOne.reservation.findUniqueOrThrow({
      where: { paymentId: payment.id },
    });
    const ledger = await prismaOne.ledgerEntry.groupBy({
      by: ['entryType'],
      where: { paymentId: payment.id },
      _count: { _all: true },
    });

    expect(count(OutboxEventType.PAYMENT_RECEIVED)).toBe(1);
    expect(count(OutboxEventType.PAYMENT_VALIDATED)).toBe(1);
    expect(count(OutboxEventType.PAYMENT_VALIDATION_FAILED)).toBe(0);
    expect(count(OutboxEventType.PAYMENT_RESERVED)).toBe(1);
    expect(count(OutboxEventType.PAYMENT_SUBMITTED)).toBe(1);
    expect(count(OutboxEventType.PAYMENT_SETTLED)).toBe(1);
    expect(count(OutboxEventType.PAYMENT_RETURNED)).toBe(1);
    expect(events).toHaveLength(6);
    expect(new Set(events.map((event) => event.eventKey)).size).toBe(6);
    for (const event of events) {
      const payload = event.payload as {
        paymentId: string;
        merchantId: string;
        amountCents: string;
      };
      expect(payload.paymentId).toBe(payment.id);
      expect(payload.merchantId).toBe('merchant-1');
      expect(payload.amountCents).toBe('4000');
    }
    expect(
      events.find(
        (event) => event.eventType === OutboxEventType.PAYMENT_RETURNED,
      )?.payload,
    ).toMatchObject({ returnCode: 'R01' });
    expect(payment.status).toBe(PaymentStatus.RETURNED);
    expect(reservation.status).toBe(ReservationStatus.RETURNED);
    expect(ledger).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entryType: LedgerEntryType.RESERVATION,
          _count: { _all: 1 },
        }),
        expect.objectContaining({
          entryType: LedgerEntryType.SETTLEMENT,
          _count: { _all: 1 },
        }),
        expect.objectContaining({
          entryType: LedgerEntryType.RETURN,
          _count: { _all: 1 },
        }),
      ]),
    );
  });

  it('materializes one webhook delivery per active endpoint exactly once', async () => {
    await prismaOne.payment.create({
      data: {
        id: 'webhook-materialized-payment',
        merchantId: 'merchant-1',
        idempotencyKey: 'webhook-materialized-idem',
        requestFingerprint: 'webhook-materialized-fingerprint',
        externalReference: 'webhook-materialized-reference',
        direction: PaymentDirection.DEBIT,
        amountCents: BigInt(4_000),
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: 'webhook-materialized-account',
        routingNumber: '021000021',
      },
    });
    const endpoints = await Promise.all([
      prismaOne.merchantWebhookEndpoint.create({
        data: {
          id: 'webhook-active-one',
          merchantId: 'merchant-1',
          url: 'https://one.example.test',
          encryptedSigningSecret: 'cipher-one',
          signingSecretIv: 'iv-one',
          signingSecretAuthTag: 'tag-one',
          signingSecretKeyVersion: 'v1',
        },
      }),
      prismaOne.merchantWebhookEndpoint.create({
        data: {
          id: 'webhook-active-two',
          merchantId: 'merchant-1',
          url: 'https://two.example.test',
          encryptedSigningSecret: 'cipher-two',
          signingSecretIv: 'iv-two',
          signingSecretAuthTag: 'tag-two',
          signingSecretKeyVersion: 'v1',
        },
      }),
      prismaOne.merchantWebhookEndpoint.create({
        data: {
          id: 'webhook-inactive',
          merchantId: 'merchant-1',
          url: 'https://inactive.example.test',
          encryptedSigningSecret: 'cipher-three',
          signingSecretIv: 'iv-three',
          signingSecretAuthTag: 'tag-three',
          signingSecretKeyVersion: 'v1',
          isActive: false,
        },
      }),
    ]);
    const event = await prismaOne.outboxEvent.create({
      data: {
        eventKey: 'payment:webhook-materialized-payment:PAYMENT_VALIDATED',
        eventType: OutboxEventType.PAYMENT_VALIDATED,
        aggregateType: 'PAYMENT',
        aggregateId: 'webhook-materialized-payment',
        payload: {
          paymentId: 'webhook-materialized-payment',
          merchantId: 'merchant-1',
          paymentStatus: 'VALIDATED',
          amountCents: '4000',
          currency: 'USD',
          direction: 'DEBIT',
          validationCode: null,
          returnCode: null,
          occurredAt: '2026-07-29T12:00:00.000Z',
        },
      },
    });
    const materializerOne = new WebhookDeliveryMaterializerService(prismaOne);
    const materializerTwo = new WebhookDeliveryMaterializerService(prismaTwo);
    await materializerOne.materialize(event);
    await materializerOne.materialize(event);
    await Promise.all([
      materializerOne.materialize(event),
      materializerTwo.materialize(event),
    ]);
    const deliveries = await prismaOne.webhookDelivery.findMany({
      where: { outboxEventId: event.id },
      orderBy: { webhookEndpointId: 'asc' },
    });
    expect(deliveries).toHaveLength(2);
    expect(deliveries.map((delivery) => delivery.webhookEndpointId)).toEqual(
      endpoints
        .slice(0, 2)
        .map((endpoint) => endpoint.id)
        .sort(),
    );
    expect(
      deliveries.every(
        (delivery) =>
          delivery.status === 'PENDING' &&
          delivery.attemptCount === 0 &&
          delivery.nextAttemptAt instanceof Date,
      ),
    ).toBe(true);
    expect(new Set(deliveries.map((delivery) => delivery.eventId)).size).toBe(
      2,
    );
    expect(
      deliveries.every(
        (delivery) =>
          (delivery.payload as { type: string; data: { amountCents: string } })
            .type === 'payment.validated' &&
          (delivery.payload as { data: { amountCents: string } }).data
            .amountCents === '4000',
      ),
    ).toBe(true);
    expect(
      await prismaOne.webhookDelivery.count({
        where: { webhookEndpointId: 'webhook-inactive' },
      }),
    ).toBe(0);
    expect(await prismaOne.outboxEvent.count()).toBe(1);
    expect(await prismaOne.payment.count()).toBe(1);
    expect(await prismaOne.reservation.count()).toBe(0);
    expect(await prismaOne.ledgerEntry.count()).toBe(1);
  });

  it('retries a merchant webhook and marks it delivered exactly once', async () => {
    process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString(
      'base64',
    );
    process.env.WEBHOOK_SECRET_ENCRYPTION_KEY_VERSION = 'test-v1';
    const secret = 'webhook-test-signing-secret';
    const requests: Array<{
      headers: Record<string, string | string[] | undefined>;
      body: string;
    }> = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        requests.push({ headers: req.headers, body });
        res.statusCode = requests.length === 1 ? 500 : 200;
        res.end();
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as { port: number }).port;
    try {
      const crypto = new WebhookSecretCryptoService({
        get: (key: string) => process.env[key],
      } as never);
      const endpointService = new MerchantWebhookEndpointsService(
        prismaOne,
        crypto,
        { get: () => 'test' } as never,
      );
      const endpoint = await endpointService.create(
        'merchant-1',
        `http://127.0.0.1:${port}/webhook`,
        secret,
      );
      await prismaOne.payment.create({
        data: {
          id: 'webhook-retry-payment',
          merchantId: 'merchant-1',
          idempotencyKey: 'webhook-retry-idem',
          requestFingerprint: 'webhook-retry-fingerprint',
          externalReference: 'webhook-retry-reference',
          direction: PaymentDirection.DEBIT,
          amountCents: BigInt(4_000),
          currency: 'USD',
          receiverName: 'Receiver Inc',
          receiverAccountRef: 'webhook-retry-account',
          routingNumber: '021000021',
        },
      });
      const event = await prismaOne.outboxEvent.create({
        data: {
          eventKey: 'payment:webhook-retry-payment:PAYMENT_VALIDATED',
          eventType: OutboxEventType.PAYMENT_VALIDATED,
          aggregateType: 'PAYMENT',
          aggregateId: 'webhook-retry-payment',
          payload: {
            paymentId: 'webhook-retry-payment',
            merchantId: 'merchant-1',
            paymentStatus: 'VALIDATED',
            amountCents: '4000',
            currency: 'USD',
            direction: 'DEBIT',
            validationCode: null,
            returnCode: null,
            occurredAt: '2026-07-30T12:00:00.000Z',
          },
        },
      });
      await new WebhookDeliveryMaterializerService(prismaOne).materialize(
        event,
      );
      const materialized = await prismaOne.webhookDelivery.findUniqueOrThrow({
        where: {
          webhookEndpointId_outboxEventId: {
            webhookEndpointId: endpoint.id,
            outboxEventId: event.id,
          },
        },
      });
      await prismaOne.webhookDelivery.update({
        where: { id: materialized.id },
        data: { nextAttemptAt: new Date(0) },
      });
      const config = new WorkerConfigService({
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL!,
        WEBHOOK_BATCH_SIZE: '1',
        WEBHOOK_INITIAL_RETRY_SECONDS: '1',
        WEBHOOK_MAX_RETRY_SECONDS: '1',
        WEBHOOK_REQUEST_TIMEOUT_MS: '1000',
        WEBHOOK_WORKER_ID: 'test-worker',
      });
      const processor = new WebhookDeliveryProcessorService(prismaOne, config);
      await processor.processOnce();
      let delivery = await prismaOne.webhookDelivery.findUniqueOrThrow({
        where: {
          webhookEndpointId_outboxEventId: {
            webhookEndpointId: endpoint.id,
            outboxEventId: event.id,
          },
        },
      });
      expect(delivery).toMatchObject({
        status: 'PENDING',
        attemptCount: 1,
        responseStatus: 500,
        deliveredAt: null,
        claimedAt: null,
        claimedBy: null,
      });
      expect(delivery.nextAttemptAt).toBeInstanceOf(Date);
      await prismaOne.webhookDelivery.update({
        where: { id: delivery.id },
        data: { nextAttemptAt: new Date(0) },
      });
      await processor.processOnce();
      delivery = await prismaOne.webhookDelivery.findUniqueOrThrow({
        where: { id: delivery.id },
      });
      expect(delivery).toMatchObject({
        status: 'DELIVERED',
        attemptCount: 2,
        responseStatus: 200,
        claimedAt: null,
        claimedBy: null,
        nextAttemptAt: null,
      });
      expect(delivery.deliveredAt).toBeInstanceOf(Date);
      await processor.processOnce();
      expect(requests).toHaveLength(2);
      expect(await prismaOne.webhookDelivery.count()).toBe(1);
      for (const request of requests) {
        const timestamp = request.headers['x-achflow-timestamp'] as string;
        const signature = request.headers['x-achflow-signature'] as string;
        expect(request.headers['x-achflow-event-id']).toBe(delivery.eventId);
        expect(signature).toMatch(/^v1=[0-9a-f]{64}$/);
        expect(signature).toBe(
          `v1=${createHmac('sha256', secret).update(`${timestamp}.${request.body}`).digest('hex')}`,
        );
        const modifiedBody = request.body.replace('"4000"', '"4001"');
        expect(
          `v1=${createHmac('sha256', secret)
            .update(`${timestamp}.${modifiedBody}`)
            .digest('hex')}`,
        ).not.toBe(signature);
        expect(
          `v1=${createHmac('sha256', 'wrong-webhook-secret')
            .update(`${timestamp}.${request.body}`)
            .digest('hex')}`,
        ).not.toBe(signature);
        expect(request.headers['content-type']).toContain('application/json');
        const payload = JSON.parse(request.body) as {
          data: { amountCents: string };
        };
        expect(payload.data.amountCents).toBe('4000');
      }
      expect(await prismaOne.outboxEvent.count()).toBe(1);
      expect(await prismaOne.payment.count()).toBe(1);
      expect(await prismaOne.reservation.count()).toBe(0);
      expect(await prismaOne.ledgerEntry.count()).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('generates one NACHA file containing eligible ACH payments exactly once', async () => {
    const date = new Date('2026-07-30T00:00:00.000Z');
    const rows = [
      ['nacha-debit-one', PaymentDirection.DEBIT, BigInt(1200), '021000021'],
      ['nacha-debit-two', PaymentDirection.DEBIT, BigInt(2300), '011000015'],
      ['nacha-credit-one', PaymentDirection.CREDIT, BigInt(3400), '031000503'],
    ] as const;
    await prismaOne.payment.createMany({
      data: rows.map(([id, direction, amountCents, routingNumber]) => ({
        id,
        merchantId: 'merchant-1',
        idempotencyKey: `${id}-idem`,
        requestFingerprint: `${id}-fingerprint`,
        externalReference: `${id}-reference`,
        direction,
        amountCents,
        currency: 'USD',
        receiverName: 'Receiver Inc',
        receiverAccountRef: `${id}-account`,
        routingNumber,
        status: PaymentStatus.VALIDATED,
        validatedAt: date,
      })),
    });
    const generator = new NachaFileGeneratorService(prismaOne);
    const first = await generator.generate(date);
    expect(first).not.toBeNull();
    const generated = first!;
    const records = generated.file.split('\n');
    const file = await prismaOne.achFile.findUniqueOrThrow({
      where: { id: generated.metadata.id },
    });
    const exported = await prismaOne.payment.findMany({
      where: { id: { in: rows.map(([id]) => id) } },
      orderBy: { id: 'asc' },
    });
    expect(await prismaOne.achFile.count()).toBe(1);
    expect(
      exported.every(
        (payment) =>
          payment.exportedAt &&
          payment.achFileId === file.id &&
          payment.status === PaymentStatus.SUBMITTED,
      ),
    ).toBe(true);
    expect(records.every((record) => record.length === 94)).toBe(true);
    expect(records.length % 10).toBe(0);
    expect(records[0]).toMatch(/^1.{93}$/);
    expect(
      records.filter((record) => /^5(?:220|225).{90}$/.test(record)),
    ).toHaveLength(2);
    expect(
      records.filter((record) => /^6(?:22|27).{91}$/.test(record)),
    ).toHaveLength(3);
    expect(records.filter((record) => /^8.{93}$/.test(record))).toHaveLength(2);
    expect(records.filter((record) => /^9.{93}$/.test(record))).toHaveLength(
      records.length - 8,
    );
    expect(
      records
        .filter((record) => /^6(?:22|27)/.test(record))
        .map((record) => record.slice(29, 39)),
    ).toEqual(['0000001200', '0000002300', '0000003400']);
    expect(
      records
        .filter((record) => /^6(?:22|27)/.test(record))
        .map((record) => record.slice(3, 11)),
    ).toEqual(['02100002', '01100001', '03100050']);
    expect(
      records
        .filter((record) => /^6(?:22|27)/.test(record))
        .map((record) => record.slice(78, 93)),
    ).toEqual(['000000000000001', '000000000000002', '000000000000001']);
    const batchControls = records.filter((record) => record.startsWith('8'));
    expect(
      batchControls.map((record) => ({
        serviceClass: record.slice(1, 4),
        entryCount: record.slice(4, 10),
        entryHash: record.slice(10, 20),
        debitTotal: record.slice(20, 30),
        creditTotal: record.slice(30, 40),
      })),
    ).toEqual([
      {
        serviceClass: '200',
        entryCount: '000002',
        entryHash: '0003200003',
        debitTotal: '0000003500',
        creditTotal: '0000000000',
      },
      {
        serviceClass: '200',
        entryCount: '000001',
        entryHash: '0003100050',
        debitTotal: '0000000000',
        creditTotal: '0000003400',
      },
    ]);
    expect(records.at(-1)).toBe('9'.repeat(94));
    expect(file).toMatchObject({
      totalEntries: 3,
      debitTotalCents: BigInt(3500),
      creditTotalCents: BigInt(3400),
      entryHash: (
        (BigInt('02100002') + BigInt('01100001') + BigInt('03100050')) %
        BigInt(10_000_000_000)
      ).toString(),
    });
    expect(file.sha256).toBe(
      createHash('sha256').update(generated.file).digest('hex'),
    );
    const fileControlIndex = records.findIndex(
      (record) => record[0] === '9' && record !== '9'.repeat(94),
    );
    const fileControl = records[fileControlIndex];
    expect(fileControl).toBeDefined();
    expect(fileControl.slice(1, 7)).toBe('000002');
    expect(fileControl.slice(7, 13)).toBe(
      String(records.length / 10).padStart(6, '0'),
    );
    expect(fileControl.slice(13, 21)).toBe('00000003');
    expect(fileControl.slice(21, 31)).toBe('0006300053');
    expect(fileControl.slice(31, 41)).toBe('0000003500');
    expect(fileControl.slice(41, 51)).toBe('0000003400');
    expect(records.slice(fileControlIndex + 1)).toEqual(
      Array(records.length - fileControlIndex - 1).fill('9'.repeat(94)),
    );
    expect(await generator.generate(date)).toBeNull();
    expect(await prismaOne.achFile.count()).toBe(1);
    expect(
      await prismaOne.outboxEvent.count({
        where: { eventType: OutboxEventType.PAYMENT_SUBMITTED },
      }),
    ).toBe(3);
    expect(await prismaOne.reservation.count()).toBe(0);
    expect(await prismaOne.ledgerEntry.count()).toBe(1);
  });

  it('generates separate NACHA files for eligible payments from different merchants', async () => {
    const date = new Date('2026-07-30T00:00:00.000Z');
    await prismaOne.merchant.create({
      data: {
        id: 'merchant-2',
        merchantCode: 'WORKER_TWO',
        legalName: 'Worker Two LLC',
        displayName: 'Worker Two',
        status: MerchantStatus.ACTIVE,
        allowAchDebit: true,
        allowAchCredit: true,
        perPaymentLimit: BigInt(10000),
        dailyAmountLimit: BigInt(100000),
      },
    });
    await prismaOne.payment.createMany({
      data: [
        {
          id: 'merchant-one-export',
          merchantId: 'merchant-1',
          idempotencyKey: 'merchant-one-export-key',
          requestFingerprint: 'merchant-one-export-fingerprint',
          direction: PaymentDirection.DEBIT,
          amountCents: BigInt(1200),
          currency: 'USD',
          receiverName: 'Merchant One Receiver',
          receiverAccountRef: 'merchant-one-account',
          routingNumber: '021000021',
          status: PaymentStatus.VALIDATED,
          validatedAt: date,
        },
        {
          id: 'merchant-two-export',
          merchantId: 'merchant-2',
          idempotencyKey: 'merchant-two-export-key',
          requestFingerprint: 'merchant-two-export-fingerprint',
          direction: PaymentDirection.CREDIT,
          amountCents: BigInt(3400),
          currency: 'USD',
          receiverName: 'Merchant Two Receiver',
          receiverAccountRef: 'merchant-two-account',
          routingNumber: '031000503',
          status: PaymentStatus.VALIDATED,
          validatedAt: date,
        },
      ],
    });

    const generated = await new NachaFileGeneratorService(
      prismaOne,
    ).generateAll(date);
    expect(generated).toHaveLength(2);
    const [first, second] = generated;
    const files = await prismaOne.achFile.findMany({
      include: { payments: { orderBy: { id: 'asc' } } },
      orderBy: { companyId: 'asc' },
    });
    expect(files).toHaveLength(2);
    expect(
      files.map((file) => ({
        companyId: file.companyId,
        payments: file.payments.map((payment) => payment.id),
      })),
    ).toEqual([
      { companyId: 'merchant-1', payments: ['merchant-one-export'] },
      { companyId: 'merchant-2', payments: ['merchant-two-export'] },
    ]);
    expect(first.file.split('\n').every((record) => record.length === 94)).toBe(
      true,
    );
    expect(
      second.file.split('\n').every((record) => record.length === 94),
    ).toBe(true);
    const exportedPayments = await prismaOne.payment.findMany({
      where: { id: { in: ['merchant-one-export', 'merchant-two-export'] } },
      select: { status: true, exportedAt: true, achFileId: true },
    });
    expect(exportedPayments).toHaveLength(2);
    expect(
      exportedPayments.every(
        (payment) =>
          payment.status === PaymentStatus.SUBMITTED &&
          payment.exportedAt instanceof Date &&
          payment.achFileId !== null,
      ),
    ).toBe(true);
  });

  it('schedules merchant-separated NACHA generation exactly once across worker instances', async () => {
    const date = new Date('2026-07-30T00:00:00.000Z');
    const schedulerConfig = new WorkerConfigService({
      ...process.env,
      NACHA_GENERATION_ENABLED: 'true',
      NACHA_GENERATION_INTERVAL_MS: '300000',
    });
    const schedulerOne = new NachaGenerationSchedulerService(
      new NachaFileGeneratorService(prismaOne),
      schedulerConfig,
    );
    const schedulerTwo = new NachaGenerationSchedulerService(
      new NachaFileGeneratorService(prismaTwo),
      schedulerConfig,
    );

    await expect(schedulerOne.processOnce()).resolves.toEqual({
      status: 'COMPLETED',
      fileCount: 0,
      paymentCount: 0,
    });
    expect(await prismaOne.achFile.count()).toBe(0);

    await prismaOne.merchant.create({
      data: {
        id: 'merchant-2',
        merchantCode: 'WORKER_TWO',
        legalName: 'Worker Two LLC',
        displayName: 'Worker Two',
        status: MerchantStatus.ACTIVE,
        allowAchDebit: true,
        allowAchCredit: true,
        perPaymentLimit: BigInt(10000),
        dailyAmountLimit: BigInt(100000),
      },
    });
    await prismaOne.payment.createMany({
      data: [
        {
          id: 'scheduled-merchant-one-export',
          merchantId: 'merchant-1',
          idempotencyKey: 'scheduled-merchant-one-key',
          requestFingerprint: 'scheduled-merchant-one-fingerprint',
          direction: PaymentDirection.DEBIT,
          amountCents: BigInt(1200),
          currency: 'USD',
          receiverName: 'Merchant One Receiver',
          receiverAccountRef: 'merchant-one-account',
          routingNumber: '021000021',
          status: PaymentStatus.VALIDATED,
          validatedAt: date,
        },
        {
          id: 'scheduled-merchant-two-export',
          merchantId: 'merchant-2',
          idempotencyKey: 'scheduled-merchant-two-key',
          requestFingerprint: 'scheduled-merchant-two-fingerprint',
          direction: PaymentDirection.CREDIT,
          amountCents: BigInt(3400),
          currency: 'USD',
          receiverName: 'Merchant Two Receiver',
          receiverAccountRef: 'merchant-two-account',
          routingNumber: '031000503',
          status: PaymentStatus.VALIDATED,
          validatedAt: date,
        },
      ],
    });

    const [first, second] = await Promise.all([
      schedulerOne.processOnce(),
      schedulerTwo.processOnce(),
    ]);
    expect(first.fileCount + second.fileCount).toBe(2);
    expect(first.paymentCount + second.paymentCount).toBe(2);

    await expect(schedulerOne.processOnce()).resolves.toEqual({
      status: 'COMPLETED',
      fileCount: 0,
      paymentCount: 0,
    });
    const files = await prismaOne.achFile.findMany({
      include: { payments: { orderBy: { id: 'asc' } } },
      orderBy: { companyId: 'asc' },
    });
    expect(files).toHaveLength(2);
    expect(
      files.map((file) => ({
        companyId: file.companyId,
        payments: file.payments.map((payment) => payment.id),
      })),
    ).toEqual([
      {
        companyId: 'merchant-1',
        payments: ['scheduled-merchant-one-export'],
      },
      {
        companyId: 'merchant-2',
        payments: ['scheduled-merchant-two-export'],
      },
    ]);
    expect(
      await prismaOne.payment.count({
        where: { status: PaymentStatus.SUBMITTED, exportedAt: { not: null } },
      }),
    ).toBe(2);
  });
});
