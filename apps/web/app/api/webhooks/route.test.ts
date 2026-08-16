import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("/api/webhooks BFF", () => {
  it("uses the server-side admin key for endpoint reads", async () => {
    vi.stubEnv("ACHFLOW_ADMIN_API_KEY", "admin-key");
    vi.stubEnv("ACHFLOW_API_KEY", "merchant-key");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await GET(
      new NextRequest("http://localhost:3001/api/webhooks?search=hook"),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/admin\/webhooks\?search=hook$/),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer admin-key" }),
      }),
    );
  });

  it("keeps endpoint creation merchant-scoped", async () => {
    vi.stubEnv("ACHFLOW_ADMIN_API_KEY", "admin-key");
    vi.stubEnv("ACHFLOW_API_KEY", "merchant-key");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: "endpoint-1" }), { status: 201 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await POST(
      new NextRequest("http://localhost:3001/api/webhooks", {
        method: "POST",
        body: JSON.stringify({ url: "https://merchant.example/webhooks" }),
      }),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/webhooks$/),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer merchant-key",
        }),
      }),
    );
  });
});
