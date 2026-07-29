import { execFileSync } from 'node:child_process';
import { Client } from 'pg';
import {
  testDatabaseAdminUrl,
  testDatabaseName,
  testDatabaseUrl,
} from './test-database';

export default async function globalSetup(): Promise<void> {
  const client = new Client({ connectionString: testDatabaseAdminUrl });

  await client.connect();

  try {
    const result = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = 'achflow_test'",
    );

    if (result.rowCount === 0) {
      await client.query(`CREATE DATABASE ${testDatabaseName}`);
    }
  } finally {
    await client.end();
  }

  execFileSync(
    'pnpm',
    ['exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
    {
      cwd: __dirname + '/..',
      env: { ...process.env, DATABASE_URL: testDatabaseUrl },
      stdio: 'inherit',
    },
  );
}
