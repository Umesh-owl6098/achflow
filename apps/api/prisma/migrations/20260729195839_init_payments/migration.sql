-- CreateEnum
CREATE TYPE "PaymentDirection" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('RECEIVED', 'VALIDATED', 'PENDING', 'PROCESSING', 'SUBMITTED', 'SETTLED', 'RETURNED', 'FAILED', 'CANCELLED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "externalReference" TEXT,
    "direction" "PaymentDirection" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'RECEIVED',
    "amountCents" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "originatorName" TEXT NOT NULL,
    "receiverName" TEXT NOT NULL,
    "receiverAccountRef" TEXT NOT NULL,
    "routingNumber" TEXT NOT NULL,
    "description" TEXT,
    "failureCode" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Payment_idempotencyKey_key" ON "Payment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Payment_status_idx" ON "Payment"("status");

-- CreateIndex
CREATE INDEX "Payment_createdAt_idx" ON "Payment"("createdAt");
