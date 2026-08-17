import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebhooksManager } from "./webhooks-manager";

const endpoint = {
  id: "endpoint-001",
  url: "https://merchant.example/webhooks",
  isActive: true,
  createdAt: "2026-08-17T00:00:00.000Z",
  updatedAt: "2026-08-17T00:00:00.000Z",
  deliveries: [],
};

function renderManager() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <WebhooksManager />
    </QueryClientProvider>,
  );
}

function webhookList(data: (typeof endpoint)[]) {
  return new Response(
    JSON.stringify({
      data,
      summary: {
        active: data.filter((item) => item.isActive).length,
        disabled: data.filter((item) => !item.isActive).length,
        failedDeliveries: 0,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WebhooksManager removal", () => {
  it("removes an endpoint after a safe hard-delete result", async () => {
    let endpoints = [endpoint];
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "DELETE") {
          endpoints = [];
          return new Response(
            JSON.stringify({ deleted: true, disabled: false }),
            {
              status: 200,
            },
          );
        }
        return webhookList(endpoints);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    renderManager();

    await screen.findByText(endpoint.url);
    fireEvent.click(screen.getByLabelText(`Remove ${endpoint.url}`));
    fireEvent.click(screen.getByRole("button", { name: "Remove endpoint" }));

    expect(
      await screen.findByText("Webhook endpoint deleted."),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText(endpoint.url)).not.toBeInTheDocument(),
    );
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE"),
    ).toHaveLength(1);
  });

  it("retains and archives an endpoint when its audit history prevents deletion", async () => {
    let endpoints = [endpoint];
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "DELETE") {
          endpoints = [{ ...endpoint, isActive: false }];
          return new Response(
            JSON.stringify({ deleted: false, disabled: true }),
            {
              status: 200,
            },
          );
        }
        return webhookList(endpoints);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    renderManager();

    await screen.findByText(endpoint.url);
    fireEvent.click(screen.getByLabelText(`Remove ${endpoint.url}`));
    const confirm = screen.getByRole("button", { name: "Remove endpoint" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(
      await screen.findByText(
        "Webhook endpoint has delivery history, so it was disabled instead of deleted.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("ARCHIVED")).toBeInTheDocument();
    expect(screen.getByText(endpoint.url)).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE"),
    ).toHaveLength(1);
  });

  it("preserves endpoint create, test, and enable-disable requests", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST" && url.endsWith("/test")) {
          return new Response(JSON.stringify({ id: "delivery-001" }), {
            status: 201,
          });
        }
        if (init?.method === "POST") {
          return new Response(JSON.stringify({ id: "endpoint-002" }), {
            status: 201,
          });
        }
        if (init?.method === "PATCH") {
          return new Response(
            JSON.stringify({ ...endpoint, isActive: false }),
            {
              status: 200,
            },
          );
        }
        return webhookList([endpoint]);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    renderManager();

    await screen.findByText(endpoint.url);
    fireEvent.click(screen.getByLabelText(`Test ${endpoint.url}`));
    fireEvent.click(screen.getByLabelText(`Toggle ${endpoint.url}`));
    fireEvent.click(screen.getByRole("button", { name: "Add endpoint" }));
    fireEvent.change(
      screen.getByPlaceholderText("https://example.com/webhooks/achflow"),
      { target: { value: "https://merchant.example/new" } },
    );
    fireEvent.change(screen.getByPlaceholderText("Signing secret"), {
      target: { value: "test-webhook-secret" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save encrypted endpoint" }),
    );

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).endsWith(`/api/webhooks/${endpoint.id}/test`) &&
            init?.method === "POST",
        ),
      ).toBe(true);
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).endsWith(`/api/webhooks/${endpoint.id}`) &&
            init?.method === "PATCH",
        ),
      ).toBe(true);
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).endsWith("/api/webhooks") && init?.method === "POST",
        ),
      ).toBe(true);
    });
  });
});
