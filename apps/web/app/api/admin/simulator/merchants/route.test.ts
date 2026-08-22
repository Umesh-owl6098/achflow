import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

describe("GET /api/admin/simulator/merchants", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("ACHFLOW_ADMIN_API_KEY", "admin-key");
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://api.test/api/v1");
  });

  it("forwards the server-only admin key to the simulator eligibility endpoint", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("./route");

    const response = await GET();

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.test/api/v1/admin/simulator/merchants",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer admin-key" }),
      }),
    );
  });
});

describe("POST /api/admin/simulator/merchants/:merchantId/demo-funding", () => {
  it("forwards explicit demo funding with the server-only admin key", async () => {
    vi.resetModules();
    vi.stubEnv("ACHFLOW_ADMIN_API_KEY", "admin-key");
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://api.test/api/v1");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ provisioned: true }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("./[merchantId]/demo-funding/route");

    await POST(
      new NextRequest(
        "http://localhost:3001/api/admin/simulator/merchants/merchant-1/demo-funding",
        {
          method: "POST",
          body: JSON.stringify({ amountCents: "100000", currency: "USD" }),
        },
      ),
      { params: Promise.resolve({ merchantId: "merchant-1" }) },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.test/api/v1/admin/simulator/merchants/merchant-1/demo-funding",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer admin-key" }),
        body: JSON.stringify({ amountCents: "100000", currency: "USD" }),
      }),
    );
  });
});
