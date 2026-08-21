-- Database defaults are the single source for new merchant payment limits.
ALTER TABLE "Merchant"
  ALTER COLUMN "perPaymentLimit" SET DEFAULT 10000,
  ALTER COLUMN "dailyAmountLimit" SET DEFAULT 100000;

-- Normalize legacy/demo records without changing identity, credentials, status,
-- payments, funding accounts, or balances. Never lower an existing limit.
UPDATE "Merchant"
SET "perPaymentLimit" = 10000
WHERE "perPaymentLimit" < 10000;

UPDATE "Merchant"
SET "dailyAmountLimit" = 100000
WHERE "dailyAmountLimit" < 100000;
