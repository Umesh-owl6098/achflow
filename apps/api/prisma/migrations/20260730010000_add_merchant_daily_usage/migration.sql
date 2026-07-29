-- CreateTable
CREATE TABLE "MerchantDailyUsage" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "utilizedAmount" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MerchantDailyUsage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MerchantDailyUsage_merchantId_businessDate_key"
  ON "MerchantDailyUsage"("merchantId", "businessDate");
CREATE INDEX "MerchantDailyUsage_businessDate_idx"
  ON "MerchantDailyUsage"("businessDate");
ALTER TABLE "MerchantDailyUsage" ADD CONSTRAINT "MerchantDailyUsage_merchantId_fkey"
  FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Existing validated payments are already reserved utilization.
INSERT INTO "MerchantDailyUsage" (
  "id", "merchantId", "businessDate", "utilizedAmount", "createdAt", "updatedAt"
)
SELECT
  md5("merchantId" || ':' || ("createdAt" AT TIME ZONE 'UTC')::date::text),
  "merchantId",
  ("createdAt" AT TIME ZONE 'UTC')::date,
  SUM("amountCents"),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Payment"
WHERE "status" = 'VALIDATED'::"PaymentStatus"
GROUP BY "merchantId", ("createdAt" AT TIME ZONE 'UTC')::date;
