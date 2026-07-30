CREATE TABLE "PaymentIdempotencyRecord" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaymentIdempotencyRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentIdempotencyRecord_paymentId_key" ON "PaymentIdempotencyRecord"("paymentId");
CREATE UNIQUE INDEX "PaymentIdempotencyRecord_merchantId_idempotencyKey_key" ON "PaymentIdempotencyRecord"("merchantId", "idempotencyKey");

ALTER TABLE "PaymentIdempotencyRecord" ADD CONSTRAINT "PaymentIdempotencyRecord_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentIdempotencyRecord" ADD CONSTRAINT "PaymentIdempotencyRecord_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
