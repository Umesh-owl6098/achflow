export type DeliveryStatus = "PENDING" | "PROCESSING" | "DELIVERED" | "FAILED";
export type WebhookDelivery = {
  id: string;
  eventId: string;
  eventType: string;
  status: DeliveryStatus;
  attemptCount: number;
  responseStatus: number | null;
  lastErrorCode: string | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  payload?: unknown;
};
export type WebhookEndpoint = {
  id: string;
  url: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  deliveries: WebhookDelivery[];
};
export type WebhooksResponse = {
  data: WebhookEndpoint[];
  summary: { active: number; disabled: number; failedDeliveries: number };
};
export function parseWebhooks(value: unknown): WebhooksResponse {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as { data?: unknown }).data)
  )
    throw new Error("Webhook response has an invalid format.");
  return value as WebhooksResponse;
}
export function deliveryTone(
  status: DeliveryStatus,
): "success" | "pending" | "failure" | "neutral" {
  return status === "DELIVERED"
    ? "success"
    : status === "FAILED"
      ? "failure"
      : status === "PROCESSING"
        ? "pending"
        : "neutral";
}
