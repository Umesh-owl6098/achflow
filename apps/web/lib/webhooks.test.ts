import { describe, expect, it } from "vitest";
import { deliveryTone, parseWebhooks } from "./webhooks";

describe("webhook data", () => {
  it("parses endpoint delivery history and maps delivery status", () => {
    const result = parseWebhooks({
      data: [
        {
          id: "endpoint-1",
          url: "https://merchant.example/webhooks",
          isActive: true,
          createdAt: "2026-07-30T00:00:00.000Z",
          updatedAt: "2026-07-30T00:00:00.000Z",
          deliveries: [],
        },
      ],
      summary: { active: 1, disabled: 0, failedDeliveries: 0 },
    });
    expect(result.data).toHaveLength(1);
    expect(deliveryTone("DELIVERED")).toBe("success");
    expect(deliveryTone("FAILED")).toBe("failure");
  });
});
