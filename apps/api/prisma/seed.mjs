import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to seed merchants.');
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const merchants = [
  {
    merchantCode: 'DEMO_BOTH',
    legalName: 'Northstar Paper Company LLC',
    displayName: 'Northstar Paper',
    status: 'ACTIVE',
    allowAchDebit: true,
    allowAchCredit: true,
    perPaymentLimit: 2500000n,
    dailyAmountLimit: 10000000n,
  },
  {
    merchantCode: 'DEMO_CREDIT_ONLY',
    legalName: 'Blue Meadow Payroll Services LLC',
    displayName: 'Blue Meadow Payroll',
    status: 'ACTIVE',
    allowAchDebit: false,
    allowAchCredit: true,
    perPaymentLimit: 1000000n,
    dailyAmountLimit: 5000000n,
  },
  {
    merchantCode: 'DEMO_SUSPENDED',
    legalName: 'Harbor Lantern Goods LLC',
    displayName: 'Harbor Lantern Goods',
    status: 'SUSPENDED',
    allowAchDebit: true,
    allowAchCredit: true,
    perPaymentLimit: 500000n,
    dailyAmountLimit: 2000000n,
  },
];

for (const merchant of merchants) {
  await prisma.merchant.upsert({
    where: { merchantCode: merchant.merchantCode },
    create: merchant,
    update: merchant,
  });
}

await prisma.$disconnect();
