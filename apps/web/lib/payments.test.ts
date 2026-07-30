import { describe, expect, it } from "vitest";
import { parsePaymentListResponse, paymentListSearchParams } from "./payments";

const response = {
  data: [
    {
      id: "payment-001",
      merchant: { merchantCode: "DEMO", displayName: "Demo Merchant" },
      externalReference: "invoice-001",
      direction: "DEBIT",
      amountCents: "2500",
      currency: "USD",
      status: "VALIDATED",
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:01:00.000Z",
    },
  ],
  page: 1,
  limit: 25,
  total: 1,
  totalPages: 1,
};

describe("payments response utilities", () => {
  it("parses a typed payment list response", () => {
    expect(parsePaymentListResponse(response).data[0]?.id).toBe("payment-001");
  });

  it("rejects malformed payment list data", () => {
    expect(() => parsePaymentListResponse({ data: [] })).toThrow("invalid");
  });

  it("creates bounded server-side pagination search parameters", () => {
    expect(
      paymentListSearchParams({
        search: "invoice-001",
        status: "VALIDATED",
        direction: "DEBIT",
        dateRange: "7d",
        startDate: "",
        endDate: "",
        sortBy: "amountCents",
        sortOrder: "asc",
        page: 2,
      }),
    ).toContain("page=2");
  });
});
