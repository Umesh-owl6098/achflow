CREATE TABLE "ProcessedBankEvent" (
  "id" TEXT NOT NULL,
  "bankEventId" TEXT NOT NULL,
  "paymentId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "eventTimestamp" TIMESTAMP(3) NOT NULL,
  "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProcessedBankEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProcessedBankEvent_bankEventId_key" ON "ProcessedBankEvent"("bankEventId");
CREATE INDEX "ProcessedBankEvent_paymentId_idx" ON "ProcessedBankEvent"("paymentId");
ALTER TABLE "ProcessedBankEvent" ADD CONSTRAINT "ProcessedBankEvent_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
