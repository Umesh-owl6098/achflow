import {
  FundingAccountStatus,
  LedgerEntryType,
  MerchantStatus,
  OutboxEventType,
  PaymentDirection,
  PaymentStatus,
} from '@prisma/client';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { MerchantAuthenticationService } from '../src/auth/merchant-authentication.service';
import { CreatePaymentDto } from '../src/payments/dto/create-payment.dto';
import { PaymentResponseDto } from '../src/payments/dto/payment-response.dto';
import { PaymentsService } from '../src/payments/payments.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { MerchantWebhookEndpointsService } from '../src/webhooks/merchant-webhook-endpoints.service';
import { WebhookSecretCryptoService } from '../src/webhooks/webhook-secret-crypto.service';

type DashboardResponse = {
  summary: {
    paymentsToday: number;
    totalAmountCents: string;
    debitAmountCents: string;
    creditAmountCents: string;
  };
  dailyVolume: unknown[];
  recentPayments: Array<{
    id: string;
    merchant: { merchantCode: string; displayName: string };
    amountCents: string;
  }>;
};

type PaymentListResponse = {
  data: Array<{
    id: string;
    merchant: { merchantCode: string; displayName: string };
    externalReference: string | null;
    direction: string;
    amountCents: string;
    status: string;
  }>;
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

type LedgerResponse = {
  merchant: { merchantCode: string; displayName: string };
  summary: {
    totalCreditsCents: string;
    totalDebitsCents: string;
    netPositionCents: string;
    outstandingReservedAmountCents: string;
  };
  data: Array<{
    entryKey: string;
    entryType: string;
    debitAmountCents: string;
    runningBalanceCents: string;
    payment: {
      id: string;
      externalReference: string | null;
    } | null;
    reservation: {
      amountCents: string;
      status: string;
    } | null;
  }>;
};

type AdminDashboardResponse = {
  summary: { paymentsToday: number };
};

describe('Payments idempotency (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let paymentsService: PaymentsService;
  let merchantAuthentication: MerchantAuthenticationService;
  let webhookEndpoints: MerchantWebhookEndpointsService;
  let webhookCrypto: WebhookSecretCryptoService;

  const testBothApiKey = 'merchant-api-key-test-both';
  const testCreditApiKey = 'merchant-api-key-test-credit';
  const adminApiKey = 'achflow-api-test-admin-key';
  const bearer = (apiKey: string) => `Bearer ${apiKey}`;

  const paymentPayload: CreatePaymentDto = {
    idempotencyKey: 'integration-idem-key',
    direction: PaymentDirection.DEBIT,
    amountCents: 5000,
    currency: 'USD',
    merchantCode: 'TEST_BOTH',
    receiverName: 'Receiver Inc',
    receiverAccountRef: 'acct-integration-1',
    routingNumber: '021000021',
    description: 'Integration test payment',
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );

    await app.init();

    prisma = app.get(PrismaService);
    paymentsService = app.get(PaymentsService);
    merchantAuthentication = app.get(MerchantAuthenticationService);
    webhookEndpoints = app.get(MerchantWebhookEndpointsService);
    webhookCrypto = app.get(WebhookSecretCryptoService);
  });

  beforeEach(async () => {
    await prisma.$transaction(async (transaction) => {
      await transaction.webhookDelivery.deleteMany();
      await transaction.outboxEvent.deleteMany();
      await transaction.reservation.deleteMany();
      await transaction.ledgerEntry.deleteMany();
      await transaction.processedBankEvent.deleteMany();
      await transaction.merchantDailyUsage.deleteMany();
      await transaction.paymentIdempotencyRecord.deleteMany();
      await transaction.payment.deleteMany();
      await transaction.achFile.deleteMany();
      await transaction.fundingAccount.deleteMany();
      await transaction.merchantApiKey.deleteMany();
      await transaction.merchantWebhookEndpoint.deleteMany();
      await transaction.merchant.deleteMany();
      await transaction.merchant.createMany({
        data: [
          {
            merchantCode: 'TEST_BOTH',
            legalName: 'Test Both LLC',
            displayName: 'Test Both',
            status: MerchantStatus.ACTIVE,
            allowAchDebit: true,
            allowAchCredit: true,
            perPaymentLimit: BigInt(1000000),
            dailyAmountLimit: BigInt(5000000),
          },
          {
            merchantCode: 'TEST_CREDIT',
            legalName: 'Test Credit LLC',
            displayName: 'Test Credit',
            status: MerchantStatus.ACTIVE,
            allowAchDebit: false,
            allowAchCredit: true,
            perPaymentLimit: BigInt(1000000),
            dailyAmountLimit: BigInt(5000000),
          },
        ],
      });
    });
    const merchants = await prisma.merchant.findMany({
      where: { merchantCode: { in: ['TEST_BOTH', 'TEST_CREDIT'] } },
    });
    await prisma.merchantApiKey.createMany({
      data: merchants.map((merchant) => ({
        merchantId: merchant.id,
        hashedApiKey: merchantAuthentication.hashApiKey(
          merchant.merchantCode === 'TEST_BOTH'
            ? testBothApiKey
            : testCreditApiKey,
        ),
      })),
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates a payment and PAYMENT_RECEIVED outbox event atomically', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/payments')
      .set('Idempotency-Key', paymentPayload.idempotencyKey!)
      .set('Authorization', bearer(testBothApiKey))
      .send(paymentPayload)
      .expect(201);

    const body = response.body as PaymentResponseDto;

    expect(body.id).toBeDefined();
    expect(body.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(body.idempotencyKey).toBe(paymentPayload.idempotencyKey);
    expect(body.amountCents).toMatch(/^\d+$/);
    expect(body.amountCents).toBe('5000');
    expect(body.currency).toMatch(/^[A-Z]{3}$/);
    expect(body.status).toBe('RECEIVED');
    expect(Object.values(PaymentStatus)).toContain(body.status);
    expect(String(body.createdAt)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(String(body.updatedAt)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(body.merchant).toEqual({
      merchantCode: 'TEST_BOTH',
      displayName: 'Test Both',
    });
    expect(body).not.toHaveProperty('requestFingerprint');

    const count = await prisma.payment.count();
    expect(count).toBe(1);
    const persistedPayment = await prisma.payment.findUniqueOrThrow({
      where: { id: body.id },
    });

    const outboxEvents = await prisma.outboxEvent.findMany();
    expect(outboxEvents).toHaveLength(1);
    expect(outboxEvents[0]).toMatchObject({
      eventType: OutboxEventType.PAYMENT_RECEIVED,
      aggregateType: 'PAYMENT',
      aggregateId: body.id,
    });
    expect(outboxEvents[0].payload).toMatchObject({
      paymentId: body.id,
      merchantId: persistedPayment.merchantId,
      paymentStatus: 'RECEIVED',
      direction: paymentPayload.direction,
      amountCents: '5000',
      currency: paymentPayload.currency,
      validationCode: null,
      returnCode: null,
      occurredAt: body.createdAt,
    });
    expect(JSON.stringify(outboxEvents[0].payload)).not.toContain(
      'requestFingerprint',
    );
    expect(JSON.stringify(outboxEvents[0].payload)).not.toContain(
      'routingNumber',
    );
    expect(JSON.stringify(outboxEvents[0].payload)).not.toContain(
      'receiverAccountRef',
    );
  });

  it('returns authenticated read-only dashboard data for the merchant', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/payments')
      .set('Idempotency-Key', paymentPayload.idempotencyKey!)
      .set('Authorization', bearer(testBothApiKey))
      .send(paymentPayload)
      .expect(201);

    const dashboard = await request(app.getHttpServer())
      .get('/api/v1/dashboard')
      .set('Authorization', bearer(testBothApiKey))
      .expect(200);
    const dashboardBody = dashboard.body as unknown as DashboardResponse;
    const createdPayment = response.body as unknown as PaymentResponseDto;

    expect(dashboardBody).toMatchObject({
      summary: {
        paymentsToday: 1,
        totalAmountCents: '5000',
        debitAmountCents: '5000',
        creditAmountCents: '0',
      },
    });
    expect(dashboardBody.dailyVolume).toHaveLength(7);
    expect(dashboardBody.recentPayments[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(dashboardBody.recentPayments[0].amountCents).toMatch(/^\d+$/);
    expect(dashboardBody.recentPayments).toEqual([
      expect.objectContaining({
        id: createdPayment.id,
        merchant: { merchantCode: 'TEST_BOTH', displayName: 'Test Both' },
        amountCents: '5000',
      }),
    ]);
  });

  it('keeps merchant reads isolated while admin operations reads aggregate and filter merchants', async () => {
    const [merchantOne, merchantTwo] = await prisma.merchant.findMany({
      where: { merchantCode: { in: ['TEST_BOTH', 'TEST_CREDIT'] } },
      orderBy: { merchantCode: 'asc' },
    });
    await prisma.payment.createMany({
      data: [
        {
          id: 'admin-merchant-one-payment',
          merchantId: merchantOne.id,
          idempotencyKey: 'admin-merchant-one-key',
          requestFingerprint: 'admin-merchant-one-fingerprint',
          direction: PaymentDirection.DEBIT,
          amountCents: BigInt(1200),
          currency: 'USD',
          receiverName: 'Merchant One Receiver',
          receiverAccountRef: 'merchant-one-account',
          routingNumber: '021000021',
          status: PaymentStatus.VALIDATED,
        },
        {
          id: 'admin-merchant-two-payment',
          merchantId: merchantTwo.id,
          idempotencyKey: 'admin-merchant-two-key',
          requestFingerprint: 'admin-merchant-two-fingerprint',
          direction: PaymentDirection.CREDIT,
          amountCents: BigInt(3400),
          currency: 'USD',
          receiverName: 'Merchant Two Receiver',
          receiverAccountRef: 'merchant-two-account',
          routingNumber: '031000503',
          status: PaymentStatus.VALIDATED,
        },
      ],
    });
    const fundingAccount = await prisma.fundingAccount.create({
      data: { merchantId: merchantTwo.id, currency: 'USD' },
    });
    await prisma.ledgerEntry.create({
      data: {
        entryKey: 'admin-merchant-two-credit',
        fundingAccountId: fundingAccount.id,
        paymentId: 'admin-merchant-two-payment',
        entryType: LedgerEntryType.CREDIT_POSTED,
        amount: BigInt(3400),
      },
    });

    await request(app.getHttpServer())
      .get('/api/v1/payments/admin-merchant-two-payment')
      .set('Authorization', bearer(testBothApiKey))
      .expect(404);
    const allDashboard = await request(app.getHttpServer())
      .get('/api/v1/admin/dashboard')
      .set('Authorization', bearer(adminApiKey))
      .expect(200);
    const allDashboardBody = allDashboard.body as AdminDashboardResponse;
    expect(allDashboardBody.summary.paymentsToday).toBe(2);
    const filteredDashboard = await request(app.getHttpServer())
      .get('/api/v1/admin/dashboard')
      .query({ merchantId: merchantTwo.id })
      .set('Authorization', bearer(adminApiKey))
      .expect(200);
    const filteredDashboardBody =
      filteredDashboard.body as AdminDashboardResponse;
    expect(filteredDashboardBody.summary.paymentsToday).toBe(1);
    const ledger = await request(app.getHttpServer())
      .get('/api/v1/admin/ledger')
      .query({ merchantId: merchantTwo.id })
      .set('Authorization', bearer(adminApiKey))
      .expect(200);
    const ledgerBody = ledger.body as unknown as LedgerResponse;
    expect(ledgerBody.data).toHaveLength(1);
    expect(ledgerBody.data[0]?.payment?.id).toBe('admin-merchant-two-payment');
  });

  it('creates a simulator payment for an active non-default merchant', async () => {
    const merchant = await prisma.merchant.findUniqueOrThrow({
      where: { merchantCode: 'TEST_CREDIT' },
    });
    const run = await request(app.getHttpServer())
      .post('/api/v1/admin/simulator/runs')
      .set('Authorization', bearer(adminApiKey))
      .send({
        merchantIds: [merchant.id],
        direction: 'CREDIT',
        transactionCount: 1,
        transactionsPerSecond: 25,
        minimumAmountCents: 100,
        maximumAmountCents: 100,
        secCode: 'PPD',
        descriptionPrefix: 'Merchant B simulation',
        scenario: {
          successfulPercent: 100,
          validationFailurePercent: 0,
          returnPercent: 0,
          insufficientFundsPercent: 0,
          duplicatePercent: 0,
          delayedProcessingPercent: 0,
          webhookFailurePercent: 0,
        },
      })
      .expect(201);
    const runId = (run.body as { id: string }).id;
    await waitForSimulatorPayment(prisma, runId);
    await waitForSimulatorCompletion(prisma, runId);
    const payment = await prisma.payment.findFirstOrThrow({
      where: { externalReference: { startsWith: `sim:${runId}:` } },
    });
    expect(payment.merchantId).toBe(merchant.id);
    expect(payment.direction).toBe(PaymentDirection.CREDIT);
    expect(payment.status).toBe(PaymentStatus.RECEIVED);
  });

  it('lists authenticated merchant payments with server-side filters and pagination', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/payments')
      .set('Idempotency-Key', 'payment-list-key')
      .set('Authorization', bearer(testBothApiKey))
      .send({ ...paymentPayload, externalReference: 'list-reference-001' })
      .expect(201);
    const createdPayment = created.body as unknown as PaymentResponseDto;

    const listed = await request(app.getHttpServer())
      .get('/api/v1/payments')
      .query({
        search: 'list-reference-001',
        status: 'RECEIVED',
        direction: 'DEBIT',
        dateRange: '30d',
        sortBy: 'amountCents',
        sortOrder: 'asc',
        page: 1,
        limit: 25,
      })
      .set('Authorization', bearer(testBothApiKey))
      .expect(200);
    const listBody = listed.body as unknown as PaymentListResponse;

    expect(listBody).toMatchObject({
      page: 1,
      limit: 25,
      total: 1,
      totalPages: 1,
    });
    expect(listBody.data).toEqual([
      expect.objectContaining({
        id: createdPayment.id,
        externalReference: 'list-reference-001',
        direction: 'DEBIT',
        amountCents: '5000',
        status: 'RECEIVED',
        merchant: { merchantCode: 'TEST_BOTH', displayName: 'Test Both' },
      }),
    ]);
    expect(listBody.data[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(listBody.data[0].amountCents).toMatch(/^\d+$/);
    expect(Object.values(PaymentStatus)).toContain(listBody.data[0].status);
  });

  it('returns merchant-scoped ledger entries, summaries, and read-only filters', async () => {
    const merchant = await prisma.merchant.findUniqueOrThrow({
      where: { merchantCode: 'TEST_BOTH' },
    });
    const fundingAccount = await prisma.fundingAccount.create({
      data: {
        merchantId: merchant.id,
        currency: 'USD',
        status: FundingAccountStatus.ACTIVE,
      },
    });
    const payment = await prisma.payment.create({
      data: {
        id: 'ledger-payment',
        merchantId: merchant.id,
        idempotencyKey: 'ledger-payment-idempotency-key',
        requestFingerprint: 'ledger-payment-fingerprint',
        externalReference: 'ledger-reference-001',
        direction: PaymentDirection.CREDIT,
        amountCents: 2000n,
        currency: 'USD',
        status: PaymentStatus.VALIDATED,
        receiverName: 'Ledger Receiver',
        receiverAccountRef: 'ledger-account',
        routingNumber: '021000021',
      },
    });
    await prisma.reservation.create({
      data: {
        paymentId: payment.id,
        fundingAccountId: fundingAccount.id,
        amount: 2000n,
      },
    });
    const createdAt = new Date('2026-07-30T12:00:00.000Z');
    await prisma.ledgerEntry.create({
      data: {
        entryKey: 'ledger-test:initial-credit',
        fundingAccountId: fundingAccount.id,
        entryType: LedgerEntryType.INITIAL_CREDIT,
        amount: 10000n,
        createdAt,
      },
    });
    await prisma.ledgerEntry.create({
      data: {
        entryKey: 'ledger-test:debit-posted',
        fundingAccountId: fundingAccount.id,
        paymentId: payment.id,
        entryType: LedgerEntryType.DEBIT_POSTED,
        amount: 2500n,
        createdAt: new Date('2026-07-30T12:01:00.000Z'),
      },
    });
    await prisma.ledgerEntry.create({
      data: {
        entryKey: 'ledger-test:reservation',
        fundingAccountId: fundingAccount.id,
        paymentId: payment.id,
        entryType: LedgerEntryType.RESERVATION,
        amount: 2000n,
        createdAt: new Date('2026-07-30T12:02:00.000Z'),
      },
    });

    const response = await request(app.getHttpServer())
      .get('/api/v1/ledger')
      .set('Authorization', bearer(testBothApiKey))
      .expect(200);
    const ledgerBody = response.body as unknown as LedgerResponse;

    expect(ledgerBody).toMatchObject({
      merchant: { merchantCode: 'TEST_BOTH', displayName: 'Test Both' },
      summary: {
        totalCreditsCents: '10000',
        totalDebitsCents: '2500',
        netPositionCents: '7500',
        outstandingReservedAmountCents: '2000',
      },
    });
    const debitEntry = ledgerBody.data.find(
      (entry) => entry.entryKey === 'ledger-test:debit-posted',
    );
    expect(debitEntry).toMatchObject({
      entryType: 'DEBIT_POSTED',
      debitAmountCents: '2500',
      runningBalanceCents: '7500',
      payment: {
        id: payment.id,
        externalReference: 'ledger-reference-001',
      },
      reservation: { amountCents: '2000', status: 'ACTIVE' },
    });
    expect(debitEntry?.entryKey).toMatch(/^ledger-test:[a-z-]+$/);
    expect(debitEntry?.debitAmountCents).toMatch(/^\d+$/);
    expect(debitEntry?.runningBalanceCents).toMatch(/^-?\d+$/);

    const filtered = await request(app.getHttpServer())
      .get('/api/v1/ledger')
      .query({
        search: 'ledger-reference-001',
        entryType: 'DEBIT_POSTED',
      })
      .set('Authorization', bearer(testBothApiKey))
      .expect(200);
    const filteredBody = filtered.body as unknown as LedgerResponse;
    expect(filteredBody.data).toEqual([
      expect.objectContaining({ entryKey: 'ledger-test:debit-posted' }),
    ]);
  });

  it('returns merchant-scoped NACHA file metadata and a reconstructed download', async () => {
    const merchant = await prisma.merchant.findUniqueOrThrow({
      where: { merchantCode: 'TEST_BOTH' },
    });
    const achFile = await prisma.achFile.create({
      data: {
        fileName: 'ach-260730-api-test.ach',
        companyId: merchant.id,
        effectiveEntryDate: new Date('2026-07-30T00:00:00.000Z'),
        status: 'GENERATED',
        totalEntries: 2,
        debitTotalCents: 2000n,
        creditTotalCents: 5000n,
        entryHash: '42000004',
        sha256: 'test-sha256',
      },
    });
    await prisma.payment.createMany({
      data: [
        {
          id: 'nacha-debit-payment',
          merchantId: merchant.id,
          idempotencyKey: 'nacha-debit-idempotency',
          requestFingerprint: 'nacha-debit-fingerprint',
          direction: PaymentDirection.DEBIT,
          amountCents: 2000n,
          currency: 'USD',
          status: PaymentStatus.SUBMITTED,
          receiverName: 'Debit Receiver',
          receiverAccountRef: 'debit-account',
          routingNumber: '021000021',
          exportedAt: new Date('2026-07-30T12:00:00.000Z'),
          achFileId: achFile.id,
        },
        {
          id: 'nacha-credit-payment',
          merchantId: merchant.id,
          idempotencyKey: 'nacha-credit-idempotency',
          requestFingerprint: 'nacha-credit-fingerprint',
          direction: PaymentDirection.CREDIT,
          amountCents: 5000n,
          currency: 'USD',
          status: PaymentStatus.SUBMITTED,
          receiverName: 'Credit Receiver',
          receiverAccountRef: 'credit-account',
          routingNumber: '021000021',
          exportedAt: new Date('2026-07-30T12:00:00.000Z'),
          achFileId: achFile.id,
        },
      ],
    });

    const listed = await request(app.getHttpServer())
      .get('/api/v1/nacha-files')
      .set('Authorization', bearer(testBothApiKey))
      .expect(200);
    const listedBody = listed.body as unknown as {
      summary: { paymentsExported: number; totalExportAmountCents: string };
      data: Array<{
        id: string;
        submissionStatus: string;
        debitCount: number;
        creditCount: number;
      }>;
    };
    expect(listedBody.summary).toEqual({
      filesGeneratedToday: 1,
      paymentsExported: 2,
      totalExportAmountCents: '7000',
      pendingSubmissionFiles: 0,
    });
    expect(listedBody.data).toEqual([
      expect.objectContaining({
        id: achFile.id,
        submissionStatus: 'SUBMITTED',
        debitCount: 1,
        creditCount: 1,
      }),
    ]);
    expect(listedBody.data[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    const download = await request(app.getHttpServer())
      .get(`/api/v1/nacha-files/${achFile.id}/download`)
      .set('Authorization', bearer(testBothApiKey))
      .expect(200);
    expect(download.headers['content-disposition']).toContain(achFile.fileName);
    expect(download.text.split('\n').every((line) => line.length === 94)).toBe(
      true,
    );
  });

  it('returns the original payment for a repeated identical request', async () => {
    const first = await request(app.getHttpServer())
      .post('/api/v1/payments')
      .set('Idempotency-Key', paymentPayload.idempotencyKey!)
      .set('Authorization', bearer(testBothApiKey))
      .send(paymentPayload)
      .expect(201);

    const second = await request(app.getHttpServer())
      .post('/api/v1/payments')
      .set('Idempotency-Key', paymentPayload.idempotencyKey!)
      .set('Authorization', bearer(testBothApiKey))
      .send(paymentPayload)
      .expect(200);

    const firstBody = first.body as PaymentResponseDto;
    const secondBody = second.body as PaymentResponseDto;

    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody.createdAt).toBe(firstBody.createdAt);
    expect(secondBody).not.toHaveProperty('requestFingerprint');

    const count = await prisma.payment.count();
    expect(count).toBe(1);
    expect(await prisma.outboxEvent.count()).toBe(1);
  });

  it('creates a payment exactly once when the same idempotency key is retried', async () => {
    const payload = { ...paymentPayload };
    delete payload.idempotencyKey;
    const idempotencyKey = 'payment-create-key-001';

    const first = await request(app.getHttpServer())
      .post('/api/v1/payments')
      .set('Idempotency-Key', idempotencyKey)
      .set('Authorization', bearer(testBothApiKey))
      .send(payload)
      .expect(201);
    const second = await request(app.getHttpServer())
      .post('/api/v1/payments')
      .set('Idempotency-Key', idempotencyKey)
      .set('Authorization', bearer(testBothApiKey))
      .send(payload)
      .expect(200);
    const conflict = await request(app.getHttpServer())
      .post('/api/v1/payments')
      .set('Idempotency-Key', idempotencyKey)
      .set('Authorization', bearer(testBothApiKey))
      .send({ ...payload, amountCents: 5001 })
      .expect(409);

    const firstBody = first.body as PaymentResponseDto;
    const secondBody = second.body as PaymentResponseDto;
    expect(firstBody.id).toBeDefined();
    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody).toEqual(firstBody);
    expect(conflict.body).toMatchObject({
      statusCode: 409,
      error: 'Conflict',
    });

    expect(await prisma.payment.count()).toBe(1);
    expect(await prisma.paymentIdempotencyRecord.count()).toBe(1);
    expect(await prisma.outboxEvent.count()).toBe(1);
    expect(await prisma.reservation.count()).toBe(0);
    expect(await prisma.ledgerEntry.count()).toBe(0);
  });

  it('does not expose the request fingerprint when retrieving a payment', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/payments')
      .set('Idempotency-Key', paymentPayload.idempotencyKey!)
      .set('Authorization', bearer(testBothApiKey))
      .send(paymentPayload)
      .expect(201);
    const createdBody = created.body as PaymentResponseDto;

    const response = await request(app.getHttpServer())
      .get(`/api/v1/payments/${createdBody.id}`)
      .set('Authorization', bearer(testBothApiKey))
      .expect(200);

    const body = response.body as PaymentResponseDto;

    expect(body.id).toBe(createdBody.id);
    expect(body.amountCents).toBe('5000');
    expect(body).not.toHaveProperty('requestFingerprint');
  });

  it('prevents one merchant from accessing another merchant payment', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/payments')
      .set('Authorization', bearer(testBothApiKey))
      .set('Idempotency-Key', 'cross-merchant-payment-key')
      .send(paymentPayload)
      .expect(201);
    const paymentId = (created.body as PaymentResponseDto).id;

    const missingAuthorization = await request(app.getHttpServer())
      .get(`/api/v1/payments/${paymentId}`)
      .expect(401);
    const invalidKey = await request(app.getHttpServer())
      .get(`/api/v1/payments/${paymentId}`)
      .set('Authorization', bearer('invalid-merchant-api-key'))
      .expect(401);
    const otherMerchant = await request(app.getHttpServer())
      .get(`/api/v1/payments/${paymentId}`)
      .set('Authorization', bearer(testCreditApiKey))
      .expect(404);

    expect(missingAuthorization.body).toMatchObject({ statusCode: 401 });
    expect(invalidKey.body).toMatchObject({ statusCode: 401 });
    expect(otherMerchant.body).toMatchObject({ statusCode: 404 });
    expect(await prisma.payment.count()).toBe(1);
    await expect(
      prisma.payment.findUniqueOrThrow({ where: { id: paymentId } }),
    ).resolves.toMatchObject({ status: 'RECEIVED' });
    expect(await prisma.outboxEvent.count()).toBe(1);
    expect(await prisma.reservation.count()).toBe(0);
    expect(await prisma.ledgerEntry.count()).toBe(0);
  });

  it('rate limits one merchant without affecting another merchant', async () => {
    const previousMaxRequests = process.env.PAYMENT_API_RATE_LIMIT_MAX_REQUESTS;
    const previousNamespace = process.env.PAYMENT_API_RATE_LIMIT_NAMESPACE;
    process.env.PAYMENT_API_RATE_LIMIT_MAX_REQUESTS = '2';
    process.env.PAYMENT_API_RATE_LIMIT_NAMESPACE = `achflow:test:rate-limit:${randomUUID()}`;

    try {
      const merchantA = await prisma.merchant.findUniqueOrThrow({
        where: { merchantCode: 'TEST_BOTH' },
      });
      const merchantB = await prisma.merchant.findUniqueOrThrow({
        where: { merchantCode: 'TEST_CREDIT' },
      });
      const createPayment = (id: string, merchantId: string) =>
        prisma.payment.create({
          data: {
            id,
            merchantId,
            idempotencyKey: `rate-limit:${id}`,
            requestFingerprint: `rate-limit:${id}`,
            direction: PaymentDirection.DEBIT,
            amountCents: 5000n,
            currency: 'USD',
            receiverName: 'Rate Limit Receiver',
            receiverAccountRef: `rate-limit-account:${id}`,
            routingNumber: '021000021',
          },
        });

      const paymentA = await createPayment(
        'rate-limit-payment-a',
        merchantA.id,
      );
      const paymentB = await createPayment(
        'rate-limit-payment-b',
        merchantB.id,
      );

      const first = await request(app.getHttpServer())
        .get(`/api/v1/payments/${paymentA.id}`)
        .set('Authorization', bearer(testBothApiKey));
      const second = await request(app.getHttpServer())
        .get(`/api/v1/payments/${paymentA.id}`)
        .set('Authorization', bearer(testBothApiKey));
      const limited = await request(app.getHttpServer())
        .get(`/api/v1/payments/${paymentA.id}`)
        .set('Authorization', bearer(testBothApiKey));
      const otherMerchant = await request(app.getHttpServer())
        .get(`/api/v1/payments/${paymentB.id}`)
        .set('Authorization', bearer(testCreditApiKey));

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(limited.status).toBe(429);
      expect(limited.headers['retry-after']).toMatch(/^\d+$/);
      expect(limited.body).toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
      expect(otherMerchant.status).toBe(200);

      expect(await prisma.payment.count()).toBe(2);
      expect(await prisma.reservation.count()).toBe(0);
      expect(await prisma.ledgerEntry.count()).toBe(0);
      expect(await prisma.outboxEvent.count()).toBe(0);
      await expect(
        prisma.payment.findUniqueOrThrow({ where: { id: paymentA.id } }),
      ).resolves.toMatchObject({ status: 'RECEIVED' });
    } finally {
      if (previousMaxRequests === undefined) {
        delete process.env.PAYMENT_API_RATE_LIMIT_MAX_REQUESTS;
      } else {
        process.env.PAYMENT_API_RATE_LIMIT_MAX_REQUESTS = previousMaxRequests;
      }
      if (previousNamespace === undefined) {
        delete process.env.PAYMENT_API_RATE_LIMIT_NAMESPACE;
      } else {
        process.env.PAYMENT_API_RATE_LIMIT_NAMESPACE = previousNamespace;
      }
    }
  });

  it('encrypts and decrypts a merchant webhook signing secret without storing plaintext', async () => {
    const merchant = await prisma.merchant.findUniqueOrThrow({
      where: { merchantCode: 'TEST_BOTH' },
    });
    const plaintext = 'test-webhook-signing-secret';
    const endpoint = await webhookEndpoints.create(
      merchant.id,
      'http://127.0.0.1:4010/webhooks',
      plaintext,
    );
    const persisted = await prisma.merchantWebhookEndpoint.findUniqueOrThrow({
      where: { id: endpoint.id },
      include: { merchant: true },
    });

    expect(
      [
        persisted.encryptedSigningSecret,
        persisted.signingSecretIv,
        persisted.signingSecretAuthTag,
        persisted.signingSecretKeyVersion,
      ].join('|'),
    ).not.toContain(plaintext);
    expect(persisted.encryptedSigningSecret).toBeTruthy();
    expect(persisted.signingSecretIv).toBeTruthy();
    expect(persisted.signingSecretAuthTag).toBeTruthy();
    expect(persisted.signingSecretKeyVersion).toBe('test-v1');
    expect(
      webhookCrypto.decrypt({
        ciphertext: persisted.encryptedSigningSecret,
        iv: persisted.signingSecretIv,
        authTag: persisted.signingSecretAuthTag,
        keyVersion: persisted.signingSecretKeyVersion,
      }),
    ).toBe(plaintext);
    expect(persisted).toMatchObject({
      url: 'http://127.0.0.1:4010/webhooks',
      merchantId: merchant.id,
      merchant: { id: merchant.id },
    });
  });

  it('returns 409 when the same key is reused with a different payload', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/payments')
      .set('Idempotency-Key', paymentPayload.idempotencyKey!)
      .set('Authorization', bearer(testBothApiKey))
      .send(paymentPayload)
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/payments')
      .set('Idempotency-Key', paymentPayload.idempotencyKey!)
      .set('Authorization', bearer(testBothApiKey))
      .send({
        ...paymentPayload,
        amountCents: 7500,
      })
      .expect(409);

    const count = await prisma.payment.count();
    expect(count).toBe(1);
  });

  it('rejects an unknown merchant code', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/payments')
      .set('Idempotency-Key', paymentPayload.idempotencyKey!)
      .set('Authorization', bearer(testBothApiKey))
      .send({ ...paymentPayload, merchantCode: 'UNKNOWN' })
      .expect(404);
  });

  it('allows the same key to be reused by a different merchant', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/payments')
      .set('Idempotency-Key', paymentPayload.idempotencyKey!)
      .set('Authorization', bearer(testBothApiKey))
      .send(paymentPayload)
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/payments')
      .set('Idempotency-Key', paymentPayload.idempotencyKey!)
      .set('Authorization', bearer(testCreditApiKey))
      .send({ ...paymentPayload, merchantCode: 'TEST_CREDIT' })
      .expect(201);
  });

  it('creates only one database record for concurrent identical requests', async () => {
    const concurrentPayload: CreatePaymentDto = {
      ...paymentPayload,
      idempotencyKey: 'concurrent-idem-key',
    };

    const merchant = await prisma.merchant.findUniqueOrThrow({
      where: { merchantCode: 'TEST_BOTH' },
    });
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        paymentsService.create(
          concurrentPayload,
          concurrentPayload.idempotencyKey,
          merchant,
        ),
      ),
    );

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.filter((result) => !result.created)).toHaveLength(9);

    const paymentIds = new Set(results.map((result) => result.payment.id));
    expect(paymentIds.size).toBe(1);

    const count = await prisma.payment.count();
    expect(count).toBe(1);
    expect(await prisma.outboxEvent.count()).toBe(1);
  });

  it('returns one identical financial result across 100 idempotent create evaluations', async () => {
    const idempotencyKey = 'consistency-evaluation-key';
    const payload: CreatePaymentDto = {
      ...paymentPayload,
      idempotencyKey,
      externalReference: 'consistency-evaluation-reference',
    };
    const merchant = await prisma.merchant.findUniqueOrThrow({
      where: { merchantCode: 'TEST_BOTH' },
    });

    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        paymentsService.create(payload, idempotencyKey, merchant),
      ),
    );

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.filter((result) => !result.created)).toHaveLength(99);
    expect(new Set(results.map((result) => result.payment.id)).size).toBe(1);
    expect(
      results.every(
        (result) =>
          result.payment.id === results[0].payment.id &&
          result.payment.createdAt.getTime() ===
            results[0].payment.createdAt.getTime() &&
          result.payment.status === 'RECEIVED' &&
          result.payment.amountCents === '5000',
      ),
    ).toBe(true);
    expect(await prisma.payment.count()).toBe(1);
    expect(await prisma.paymentIdempotencyRecord.count()).toBe(1);
    expect(await prisma.outboxEvent.count()).toBe(1);
    expect(await prisma.reservation.count()).toBe(0);
    expect(await prisma.ledgerEntry.count()).toBe(0);
  });

  it('exposes the payment lifecycle through REST endpoints', async () => {
    const merchant = await prisma.merchant.findUniqueOrThrow({
      where: { merchantCode: 'TEST_BOTH' },
    });
    const fundingAccount = await prisma.fundingAccount.create({
      data: {
        merchantId: merchant.id,
        currency: 'USD',
        status: FundingAccountStatus.ACTIVE,
      },
    });
    await prisma.ledgerEntry.create({
      data: {
        entryKey: 'initial-credit:api-lifecycle',
        fundingAccountId: fundingAccount.id,
        entryType: LedgerEntryType.INITIAL_CREDIT,
        amount: BigInt(10_000),
      },
    });
    const created = await request(app.getHttpServer())
      .post('/api/v1/payments')
      .set('Idempotency-Key', 'api-lifecycle-idempotency-key')
      .set('Authorization', bearer(testBothApiKey))
      .send({
        ...paymentPayload,
        idempotencyKey: 'api-lifecycle-idempotency-key',
        externalReference: 'api-lifecycle-reference',
        direction: PaymentDirection.CREDIT,
        amountCents: 4000,
      })
      .expect(201);
    const paymentId = (created.body as PaymentResponseDto).id;

    await request(app.getHttpServer())
      .post(`/api/v1/payments/${paymentId}/validate`)
      .set('Authorization', bearer(testBothApiKey))
      .expect(201)
      .expect((response) =>
        expect((response.body as { status: string }).status).toBe('VALIDATED'),
      );
    await request(app.getHttpServer())
      .post(`/api/v1/payments/${paymentId}/reserve`)
      .set('Authorization', bearer(testBothApiKey))
      .expect(201)
      .expect((response) =>
        expect((response.body as { status: string }).status).toBe('ACTIVE'),
      );
    await request(app.getHttpServer())
      .post(`/api/v1/payments/${paymentId}/settle`)
      .set('Authorization', bearer(testBothApiKey))
      .expect(400)
      .expect((response) =>
        expect(response.body).toMatchObject({
          message: 'Payment is not submitted for settlement.',
        }),
      );
    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: 'SUBMITTED', exportedAt: new Date() },
    });
    await request(app.getHttpServer())
      .post(`/api/v1/payments/${paymentId}/settle`)
      .set('Authorization', bearer(testBothApiKey))
      .expect(201)
      .expect((response) =>
        expect((response.body as { status: string }).status).toBe('SETTLED'),
      );
    await request(app.getHttpServer())
      .post(`/api/v1/payments/${paymentId}/return`)
      .set('Authorization', bearer(testBothApiKey))
      .send({ returnCode: 'R01' })
      .expect(201)
      .expect((response) =>
        expect((response.body as { status: string }).status).toBe('RETURNED'),
      );

    const details = await request(app.getHttpServer())
      .get(`/api/v1/payments/${paymentId}`)
      .set('Authorization', bearer(testBothApiKey))
      .expect(200);

    expect(details.body).toMatchObject({
      id: paymentId,
      status: 'RETURNED',
      payment: { id: paymentId, status: 'RETURNED' },
      reservation: { status: 'RETURNED', returnCode: 'R01' },
      fundingAccount: { id: fundingAccount.id, currency: 'USD' },
      ledgerSummary: {
        postedBalance: '14000',
        activeReservedAmount: '0',
        availableBalance: '14000',
      },
    });
    expect(details.body).not.toHaveProperty('requestFingerprint');
    expect(
      (details.body as { payment: Record<string, unknown> }).payment,
    ).not.toHaveProperty('requestFingerprint');
    expect(
      (
        details.body as {
          outboxEvents: Array<{ eventType: string; status: string }>;
        }
      ).outboxEvents,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'PAYMENT_RECEIVED',
          status: 'PENDING',
        }),
        expect.objectContaining({
          eventType: 'PAYMENT_VALIDATED',
          status: 'PENDING',
        }),
        expect.objectContaining({
          eventType: 'PAYMENT_RESERVED',
          status: 'PENDING',
        }),
        expect.objectContaining({
          eventType: 'PAYMENT_SETTLED',
          status: 'PENDING',
        }),
        expect.objectContaining({
          eventType: 'PAYMENT_RETURNED',
          status: 'PENDING',
        }),
      ]),
    );
  });
});

async function waitForSimulatorPayment(
  prisma: PrismaService,
  runId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const payment = await prisma.payment.findFirst({
      where: { externalReference: { startsWith: `sim:${runId}:` } },
      select: { id: true },
    });
    if (payment) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Simulator payment was not created in time.');
}

async function waitForSimulatorCompletion(
  prisma: PrismaService,
  runId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const run = await prisma.simulatorRun.findUnique({
      where: { id: runId },
      select: { status: true },
    });
    if (run?.status === 'COMPLETED') return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Simulator run did not complete in time.');
}
