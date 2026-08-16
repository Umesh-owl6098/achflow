import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("GET /api/payments/:paymentId", () => {
  it("uses the server-side admin key and admin payment detail endpoint", async () => {
    vi.stubEnv("ACHFLOW_ADMIN_API_KEY", "admin-key");
    vi.stubEnv("ACHFLOW_API_KEY", "merchant-key");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "payment-2" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      new NextRequest("http://localhost:3001/api/payments/payment-2"),
      { params: Promise.resolve({ paymentId: "payment-2" }) },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/admin\/payments\/payment-2$/),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer admin-key" }),
      }),
    );
    await expect(response.json()).resolves.toEqual({ id: "payment-2" });
  });
});
