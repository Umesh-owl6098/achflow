import { beforeEach, describe, expect, it, vi } from "vitest";

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
