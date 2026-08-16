import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("GET /api/webhooks/:endpointId/deliveries", () => {
  it("uses the server-side admin key and admin endpoint delivery route", async () => {
    vi.stubEnv("ACHFLOW_ADMIN_API_KEY", "admin-key");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await GET(
      new NextRequest(
        "http://localhost:3001/api/webhooks/endpoint-1/deliveries?status=FAILED",
      ),
      { params: Promise.resolve({ endpointId: "endpoint-1" }) },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(
        /\/admin\/webhooks\/endpoint-1\/deliveries\?status=FAILED$/,
      ),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer admin-key" }),
      }),
    );
  });
});
