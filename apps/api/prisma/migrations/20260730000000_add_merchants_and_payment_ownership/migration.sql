-- CreateEnum
CREATE TYPE "MerchantStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateTable
CREATE TABLE "Merchant" (
    "id" TEXT NOT NULL,
    "merchantCode" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "status" "MerchantStatus" NOT NULL DEFAULT 'ACTIVE',
    "allowAchDebit" BOOLEAN NOT NULL DEFAULT false,
    "allowAchCredit" BOOLEAN NOT NULL DEFAULT false,
    "perPaymentLimit" BIGINT NOT NULL,
    "dailyAmountLimit" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Merchant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Merchant_merchantCode_key" ON "Merchant"("merchantCode");

-- Add the relationship as nullable so existing history can be preserved first.
ALTER TABLE "Payment" ADD COLUMN "merchantId" TEXT;

-- A single explicit development merchant owns all historic development rows.
INSERT INTO "Merchant" (
    "id", "merchantCode", "legalName", "displayName", "status",
    "allowAchDebit", "allowAchCredit", "perPaymentLimit", "dailyAmountLimit", "updatedAt"
) VALUES (
    '00000000-0000-0000-0000-000000000001',
    'DEVELOPMENT_LEGACY',
    'Development Legacy Merchant LLC',
    'Development Legacy Merchant',
    'ACTIVE', true, true, 999999999999, 999999999999, CURRENT_TIMESTAMP
);

UPDATE "Payment"
SET "merchantId" = '00000000-0000-0000-0000-000000000001'
WHERE "merchantId" IS NULL;

ALTER TABLE "Payment" ALTER COLUMN "merchantId" SET NOT NULL;
ALTER TABLE "Payment" DROP COLUMN "originatorName";

CREATE INDEX "Payment_merchantId_idx" ON "Payment"("merchantId");
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_merchantId_fkey"
  FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
