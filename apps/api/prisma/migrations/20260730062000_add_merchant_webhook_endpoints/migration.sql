CREATE TABLE "MerchantWebhookEndpoint" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "encryptedSigningSecret" TEXT NOT NULL,
    "signingSecretIv" TEXT NOT NULL,
    "signingSecretAuthTag" TEXT NOT NULL,
    "signingSecretKeyVersion" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MerchantWebhookEndpoint_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MerchantWebhookEndpoint_merchantId_isActive_idx" ON "MerchantWebhookEndpoint"("merchantId", "isActive");
ALTER TABLE "MerchantWebhookEndpoint" ADD CONSTRAINT "MerchantWebhookEndpoint_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
