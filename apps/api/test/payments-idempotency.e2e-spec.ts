import { PaymentDirection } from '@prisma/client';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { CreatePaymentDto } from '../src/payments/dto/create-payment.dto';
import { SerializedPayment } from '../src/payments/payment.mapper';
import { PaymentsService } from '../src/payments/payments.service';
import { PrismaService } from '../src/prisma/prisma.service';

const defaultDatabaseUrl =
  'postgresql://achflow:achflow@localhost:5435/achflow';

describe('Payments idempotency (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let paymentsService: PaymentsService;

  const paymentPayload: CreatePaymentDto = {
    idempotencyKey: 'integration-idem-key',
    direction: PaymentDirection.DEBIT,
    amountCents: 5000,
    currency: 'USD',
    originatorName: 'Originator LLC',
    receiverName: 'Receiver Inc',
    receiverAccountRef: 'acct-integration-1',
    routingNumber: '021000021',
    description: 'Integration test payment',
  };

  beforeAll(async () => {
    process.env.DATABASE_URL ??= defaultDatabaseUrl;

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
    await prisma.payment.deleteMany();
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates a payment on the first request', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/payments')
      .send(paymentPayload)
      .expect(201);

    const body = response.body as SerializedPayment;

    expect(body.id).toBeDefined();
    expect(body.idempotencyKey).toBe(paymentPayload.idempotencyKey);
    expect(body.amountCents).toBe('5000');

    const count = await prisma.payment.count();
    expect(count).toBe(1);
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

    const firstBody = first.body as SerializedPayment;
    const secondBody = second.body as SerializedPayment;

    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody.createdAt).toBe(firstBody.createdAt);

    const count = await prisma.payment.count();
    expect(count).toBe(1);
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
  });
});
