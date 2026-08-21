import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MerchantsManager } from "./merchants-manager";

const merchant = {
  id: "merchant-001",
  merchantCode: "NORTHSTAR",
  displayName: "Northstar Paper",
  status: "ACTIVE",
  createdAt: "2026-07-30T00:00:00.000Z",
  paymentCount: 4,
  totalProcessedVolumeCents: "125000",
  webhookEndpointCount: 2,
  postedBalanceCents: "200000",
  reservedBalanceCents: "25000",
  availableBalanceCents: "175000",
};

function renderMerchants() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MerchantsManager />
    </QueryClientProvider>,
  );
}

function response(data = [merchant]) {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MerchantsManager", () => {
  it("renders merchant balances and summary data from the secured BFF", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response()));
    renderMerchants();

    expect(await screen.findByText("Northstar Paper")).toBeInTheDocument();
    expect(screen.getByText("Available balance")).toBeInTheDocument();
    expect(screen.getByText("$1750.00")).toBeInTheDocument();
    expect(screen.getAllByText("$1250.00")).toHaveLength(2);
  });

  it("filters the merchant table by status and search text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response([
          merchant,
          {
            ...merchant,
            id: "merchant-002",
            merchantCode: "HARBOR",
            displayName: "Harbor Goods",
            status: "SUSPENDED",
          },
        ]),
      ),
    );
    renderMerchants();
    await screen.findByText("Northstar Paper");

    fireEvent.change(screen.getByLabelText("Merchant status"), {
      target: { value: "SUSPENDED" },
    });
    expect(screen.getByText("Harbor Goods")).toBeInTheDocument();
    expect(screen.queryByText("Northstar Paper")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search merchants"), {
      target: { value: "northstar" },
    });
    await waitFor(() =>
      expect(screen.getByText("No merchants found")).toBeInTheDocument(),
    );
  });

  it("allows the create form to omit limits and use API defaults", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response()));
    renderMerchants();
    await screen.findByText("Northstar Paper");

    fireEvent.click(screen.getByRole("button", { name: "Create merchant" }));

    expect(
      screen.getByLabelText("Per-payment limit (cents)"),
    ).not.toBeRequired();
    expect(screen.getByLabelText("Daily limit (cents)")).not.toBeRequired();
    expect(screen.getByLabelText("Merchant name")).toBeRequired();
  });
});
