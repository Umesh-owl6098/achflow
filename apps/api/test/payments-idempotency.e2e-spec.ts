import {
  MerchantStatus,
  OutboxEventType,
  PaymentDirection,
} from '@prisma/client';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { CreatePaymentDto } from '../src/payments/dto/create-payment.dto';
import { PaymentResponseDto } from '../src/payments/dto/payment-response.dto';
import { PaymentsService } from '../src/payments/payments.service';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Payments idempotency (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let paymentsService: PaymentsService;

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
  });

  beforeEach(async () => {
    await prisma.outboxEvent.deleteMany();
    await prisma.payment.deleteMany();
    await prisma.merchantDailyUsage.deleteMany();
    await prisma.merchant.deleteMany();
    await prisma.merchant.createMany({
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

  afterAll(async () => {
    await app.close();
  });

  it('creates a payment and PAYMENT_RECEIVED outbox event atomically', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/payments')
      .send(paymentPayload)
      .expect(201);

    const body = response.body as PaymentResponseDto;

    expect(body.id).toBeDefined();
    expect(body.idempotencyKey).toBe(paymentPayload.idempotencyKey);
    expect(body.amountCents).toBe('5000');
    expect(body.status).toBe('RECEIVED');
    expect(body.merchant).toEqual({
      merchantCode: 'TEST_BOTH',
      displayName: 'Test Both',
    });
    expect(body).not.toHaveProperty('requestFingerprint');

    const count = await prisma.payment.count();
    expect(count).toBe(1);

    const outboxEvents = await prisma.outboxEvent.findMany();
    expect(outboxEvents).toHaveLength(1);
    expect(outboxEvents[0]).toMatchObject({
      eventType: OutboxEventType.PAYMENT_RECEIVED,
      aggregateType: 'PAYMENT',
      aggregateId: body.id,
    });
    expect(outboxEvents[0].payload).toEqual({
      paymentId: body.id,
      externalReference: null,
      direction: paymentPayload.direction,
      amountCents: '5000',
      currency: paymentPayload.currency,
      createdAt: body.createdAt,
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

  it('returns the original payment for a repeated identical request', async () => {
    const first = await request(app.getHttpServer())
      .post('/api/v1/payments')
      .send(paymentPayload)
      .expect(201);

    const second = await request(app.getHttpServer())
      .post('/api/v1/payments')
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

  it('does not expose the request fingerprint when retrieving a payment', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/payments')
      .send(paymentPayload)
      .expect(201);
    const createdBody = created.body as PaymentResponseDto;

    const response = await request(app.getHttpServer())
      .get(`/api/v1/payments/${createdBody.id}`)
      .expect(200);

    const body = response.body as PaymentResponseDto;

    expect(body.id).toBe(createdBody.id);
    expect(body.amountCents).toBe('5000');
    expect(body).not.toHaveProperty('requestFingerprint');
  });

  it('returns 409 when the same key is reused with a different payload', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/payments')
      .send(paymentPayload)
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/payments')
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
      .send({ ...paymentPayload, merchantCode: 'UNKNOWN' })
      .expect(404);
  });

  it('returns 409 when the same key is reused by a different merchant', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/payments')
      .send(paymentPayload)
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/payments')
      .send({ ...paymentPayload, merchantCode: 'TEST_CREDIT' })
      .expect(409);
  });

  it('creates only one database record for concurrent identical requests', async () => {
    const concurrentPayload: CreatePaymentDto = {
      ...paymentPayload,
      idempotencyKey: 'concurrent-idem-key',
    };

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        paymentsService.create(concurrentPayload),
      ),
    );

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.filter((result) => !result.created)).toHaveLength(9);

    const paymentIds = new Set(results.map((result) => result.payment.id));
    expect(paymentIds.size).toBe(1);

    const count = await prisma.payment.count({
      where: { idempotencyKey: 'concurrent-idem-key' },
    });
    expect(count).toBe(1);
    expect(await prisma.outboxEvent.count()).toBe(1);
  });
});
