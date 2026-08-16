import { testDatabaseUrl } from './test-database';

process.env.DATABASE_URL = testDatabaseUrl;
process.env.MERCHANT_API_KEY_HASH_SECRET = 'achflow-api-test-hash-secret';
process.env.ACHFLOW_ADMIN_API_KEY = 'achflow-api-test-admin-key';
process.env.REDIS_URL = 'redis://localhost:6379/15';
process.env.PAYMENT_API_RATE_LIMIT_MAX_REQUESTS = '100';
process.env.PAYMENT_API_RATE_LIMIT_WINDOW_SECONDS = '60';
process.env.PAYMENT_API_RATE_LIMIT_NAMESPACE = 'achflow:test:payment-api';
process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString(
  'base64',
);
process.env.WEBHOOK_SECRET_ENCRYPTION_KEY_VERSION = 'test-v1';
