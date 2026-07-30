CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'PROCESSING', 'DELIVERED', 'FAILED');

CREATE TABLE "WebhookDelivery" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "webhookEndpointId" TEXT NOT NULL,
  "outboxEventId" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  "lastAttemptAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "responseStatus" INTEGER,
  "lastErrorCode" TEXT,
  "claimedAt" TIMESTAMP(3),
  "claimedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WebhookDelivery_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WebhookDelivery_webhookEndpointId_fkey" FOREIGN KEY ("webhookEndpointId") REFERENCES "MerchantWebhookEndpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WebhookDelivery_outboxEventId_fkey" FOREIGN KEY ("outboxEventId") REFERENCES "OutboxEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "WebhookDelivery_eventId_key" ON "WebhookDelivery"("eventId");
CREATE UNIQUE INDEX "WebhookDelivery_webhookEndpointId_outboxEventId_key" ON "WebhookDelivery"("webhookEndpointId", "outboxEventId");
CREATE INDEX "WebhookDelivery_status_nextAttemptAt_idx" ON "WebhookDelivery"("status", "nextAttemptAt");
CREATE INDEX "WebhookDelivery_claimedAt_idx" ON "WebhookDelivery"("claimedAt");
CREATE INDEX "WebhookDelivery_merchantId_idx" ON "WebhookDelivery"("merchantId");
CREATE INDEX "WebhookDelivery_webhookEndpointId_idx" ON "WebhookDelivery"("webhookEndpointId");
