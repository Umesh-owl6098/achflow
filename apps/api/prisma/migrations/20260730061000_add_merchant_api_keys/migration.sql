CREATE TABLE "MerchantApiKey" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "hashedApiKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MerchantApiKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MerchantApiKey_merchantId_key" ON "MerchantApiKey"("merchantId");
CREATE UNIQUE INDEX "MerchantApiKey_hashedApiKey_key" ON "MerchantApiKey"("hashedApiKey");

ALTER TABLE "MerchantApiKey" ADD CONSTRAINT "MerchantApiKey_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
