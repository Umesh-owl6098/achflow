import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaymentsTable } from "./payments-table";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const payment = {
  id: "payment-12345678",
  merchant: { merchantCode: "DEMO", displayName: "Demo Merchant" },
  externalReference: "invoice-001",
  direction: "DEBIT",
  amountCents: "2500",
  currency: "USD",
  status: "VALIDATED",
  createdAt: "2026-07-30T00:00:00.000Z",
  updatedAt: "2026-07-30T00:01:00.000Z",
};

function renderPayments() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <PaymentsTable />
    </QueryClientProvider>,
  );
}

function response(data = [payment], page = 1, total = data.length) {
  return new Response(
    JSON.stringify({
      data,
      page,
      limit: 25,
      total,
      totalPages: total > 25 ? 2 : 1,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("PaymentsTable", () => {
  it("renders a live payment table with status badges", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response()));
    renderPayments();
    expect(await screen.findByText("Demo Merchant")).toBeInTheDocument();
    expect(screen.getAllByText("VALIDATED").length).toBeGreaterThan(1);
  });

  it("debounces payment searches before querying", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetchMock);
    renderPayments();
    await screen.findByText("Demo Merchant");
    fireEvent.change(
      screen.getByPlaceholderText("Search payment, reference, merchant"),
      { target: { value: "invoice-001" } },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), {
      timeout: 1000,
    });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "search=invoice-001",
    );
  });

  it("sends status filters and advances server-side pagination", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(
          url.includes("page=2")
            ? response([payment], 2, 26)
            : response([payment], 1, 26),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    renderPayments();
    await screen.findByText("Demo Merchant");
    fireEvent.change(screen.getByLabelText("Status filter"), {
      target: { value: "VALIDATED" },
    });
    await waitFor(() =>
      expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain(
        "status=VALIDATED",
      ),
    );
    fireEvent.click(screen.getByLabelText("Next page"));
    await waitFor(() =>
      expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain("page=2"),
    );
  });

  it("shows a professional empty state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([])));
    renderPayments();
    expect(await screen.findByText("No payments found")).toBeInTheDocument();
  });
});
