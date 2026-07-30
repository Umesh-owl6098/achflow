import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LedgerTable } from "./ledger-table";

const row = {
  id: "ledger-1",
  entryKey: "reservation:payment-1",
  entryType: "RESERVATION",
  amountCents: "2500",
  debitAmountCents: "0",
  creditAmountCents: "0",
  balanceImpactCents: "0",
  runningBalanceCents: "10000",
  createdAt: "2026-07-30T12:00:00.000Z",
  fundingAccountId: "funding-1",
  currency: "USD",
  merchant: { merchantCode: "DEMO", displayName: "Demo Merchant" },
  payment: {
    id: "payment-1",
    externalReference: "invoice-001",
    direction: "CREDIT",
    amountCents: "2500",
    currency: "USD",
    status: "VALIDATED",
  },
  reservation: {
    amountCents: "2500",
    status: "ACTIVE",
    createdAt: "2026-07-30T12:00:00.000Z",
    releasedAt: null,
    settledAt: null,
    returnedAt: null,
    returnCode: null,
  },
  status: "VALIDATED",
};

const responseBody = {
  merchant: row.merchant,
  data: [
    row,
    {
      ...row,
      id: "ledger-2",
      entryKey: "debit:payment-1",
      entryType: "DEBIT_POSTED",
      amountCents: "1000",
      debitAmountCents: "1000",
      balanceImpactCents: "-1000",
      runningBalanceCents: "9000",
      createdAt: "2026-07-30T12:01:00.000Z",
    },
  ],
  summary: {
    totalCreditsCents: "10000",
    totalDebitsCents: "1000",
    netPositionCents: "9000",
    outstandingReservedAmountCents: "2500",
  },
};

function renderLedger() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <LedgerTable />
    </QueryClientProvider>,
  );
}

function response(body = responseBody, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LedgerTable", () => {
  it("renders ledger rows and calculated summary totals", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response()));
    renderLedger();

    expect(
      await screen.findByRole("cell", { name: "RESERVATION" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("cell", { name: "DEBIT_POSTED" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Total credits")).toBeInTheDocument();
    expect(screen.getAllByText("$100.00")).toHaveLength(2);
    expect(screen.getByText("Outstanding reserved")).toBeInTheDocument();
    expect(screen.getByText("$25.00")).toBeInTheDocument();
  });

  it("sends entry type filters to the BFF", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetchMock);
    renderLedger();
    await screen.findByRole("cell", { name: "RESERVATION" });

    fireEvent.change(screen.getByLabelText("Entry type filter"), {
      target: { value: "DEBIT_POSTED" },
    });
    await waitFor(() =>
      expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain(
        "entryType=DEBIT_POSTED",
      ),
    );
  });

  it("debounces searches before querying the BFF", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetchMock);
    renderLedger();
    await screen.findByRole("cell", { name: "RESERVATION" });

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

  it("opens a side panel with payment, reservation, and ledger history", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response()));
    renderLedger();
    const reservationCell = await screen.findByRole("cell", {
      name: "RESERVATION",
    });

    fireEvent.click(reservationCell);
    expect(await screen.findByText("Ledger entry")).toBeInTheDocument();
    expect(screen.getByText("Payment summary")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Reservation" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Ledger history")).toBeInTheDocument();
    expect(screen.getByText("Current balance impact")).toBeInTheDocument();
  });

  it("renders an empty ledger state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({ ...responseBody, data: [] })),
    );
    renderLedger();

    expect(
      await screen.findByText("No ledger entries found"),
    ).toBeInTheDocument();
  });
});
