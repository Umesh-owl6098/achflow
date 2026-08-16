import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("GET /api/payments", () => {
  it("uses the server-side admin key and preserves list query parameters", async () => {
    vi.stubEnv("ACHFLOW_ADMIN_API_KEY", "admin-key");
    vi.stubEnv("ACHFLOW_API_KEY", "merchant-key");
    const body = {
      data: [
        {
          id: "payment-2",
          merchant: { merchantCode: "OTHER", displayName: "Other Merchant" },
          externalReference: "invoice-2",
          direction: "DEBIT",
          amountCents: "2500",
          currency: "USD",
          status: "VALIDATED",
          createdAt: "2026-08-16T00:00:00.000Z",
          updatedAt: "2026-08-16T00:00:00.000Z",
        },
      ],
      page: 2,
      limit: 25,
      total: 26,
      totalPages: 2,
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      new NextRequest(
        "http://localhost:3001/api/payments?search=invoice-2&page=2&status=VALIDATED",
      ),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(
        /\/admin\/payments\?search=invoice-2&page=2&status=VALIDATED$/,
      ),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer admin-key" }),
      }),
    );
    await expect(response.json()).resolves.toEqual(body);
  });
});
