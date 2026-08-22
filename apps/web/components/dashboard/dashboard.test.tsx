import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./dashboard";

const response = {
  summary: {
    paymentsToday: 1,
    totalAmountCents: "2500",
    debitAmountCents: "2500",
    creditAmountCents: "0",
    submittedPayments: 0,
    settledPayments: 0,
    returnedPayments: 0,
  },
  dailyVolume: Array.from({ length: 7 }, (_, index) => ({
    date: `2026-07-${String(24 + index).padStart(2, "0")}`,
    debitCount: 0,
    creditCount: 0,
    totalCount: 0,
    debitAmountCents: "0",
    creditAmountCents: "0",
    totalAmountCents: "0",
  })),
  statusDistribution: [{ status: "RECEIVED", count: 1 }],
  recentPayments: [
    {
      id: "payment-12345678",
      merchant: { merchantCode: "DEMO", displayName: "Demo Merchant" },
      externalReference: "invoice-1",
      direction: "DEBIT",
      status: "RECEIVED",
      amountCents: "2500",
      currency: "USD",
      createdAt: "2026-07-30T00:00:00.000Z",
    },
  ],
  generatedAt: "2026-07-30T00:00:00.000Z",
};

function renderDashboard() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <Dashboard />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Dashboard", () => {
  it("renders live dashboard summary data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(response), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    renderDashboard();
    expect((await screen.findAllByText("$25.00")).length).toBeGreaterThan(0);
    expect(screen.getByText("Demo Merchant")).toBeInTheDocument();
    expect(screen.getByText("Transactions")).toBeInTheDocument();
    expect(screen.getByText("Amounts")).toBeInTheDocument();
    expect(
      screen.getByText("Today: 0 total · 0 debit · 0 credit"),
    ).toBeInTheDocument();
  });
  it("renders an empty state for an empty payment database", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ...response, recentPayments: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    renderDashboard();
    expect(await screen.findByText("No payments yet")).toBeInTheDocument();
  });
  it("renders an API error state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "Unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    renderDashboard();
    expect(
      await screen.findByText("Dashboard unavailable"),
    ).toBeInTheDocument();
  });

  it("loads all merchants first and updates dashboard data for a selected merchant", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.startsWith("/api/admin/merchants")
        ? {
            data: [
              {
                id: "merchant-b",
                merchantCode: "B",
                displayName: "Merchant B",
              },
            ],
          }
        : response;
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    renderDashboard();
    await screen.findByText("Demo Merchant");
    await screen.findByRole("option", { name: "Merchant B (B)" });
    fireEvent.change(screen.getByLabelText("Merchant scope"), {
      target: { value: "merchant-b" },
    });

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/dashboard?merchantId=merchant-b",
        expect.anything(),
      ),
    );
  });
});
