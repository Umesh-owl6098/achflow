import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("GET /api/dashboard", () => {
  it("uses the server-only admin key and preserves an optional merchant scope", async () => {
    vi.stubEnv("ACHFLOW_ADMIN_API_KEY", "admin-key");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ summary: {} }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await GET(
      new NextRequest(
        "http://localhost:3001/api/dashboard?merchantId=merchant-b",
      ),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/admin\/dashboard\?merchantId=merchant-b$/),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer admin-key" }),
      }),
    );
  });
});
