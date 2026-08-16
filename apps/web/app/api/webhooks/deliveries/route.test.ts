import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("GET /api/webhooks/deliveries", () => {
  it("uses the server-side admin key and admin delivery endpoint", async () => {
    vi.stubEnv("ACHFLOW_ADMIN_API_KEY", "admin-key");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await GET(
      new NextRequest(
        "http://localhost:3001/api/webhooks/deliveries?status=FAILED",
      ),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/admin\/webhooks\/deliveries\?status=FAILED$/),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer admin-key" }),
      }),
    );
  });
});
