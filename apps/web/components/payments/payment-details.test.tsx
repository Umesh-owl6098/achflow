import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaymentDetailsView } from "./payment-details";

const payment = {
  id: "payment-1",
  idempotencyKey: "idempotency-key-1",
  externalReference: "invoice-1",
  direction: "CREDIT",
  amountCents: "2500",
  currency: "USD",
  status: "RETURNED",
  createdAt: "2026-07-30T12:00:00.000Z",
  updatedAt: "2026-07-30T12:05:00.000Z",
  validatedAt: "2026-07-30T12:01:00.000Z",
  merchant: { merchantCode: "DEMO", displayName: "Demo Merchant" },
};

const details = {
  ...payment,
  payment,
  reservation: {
    id: "reservation-1",
    amount: "2500",
    status: "RETURNED",
    fundingAccountId: "funding-1",
    createdAt: "2026-07-30T12:01:00.000Z",
    releasedAt: null,
    settledAt: "2026-07-30T12:03:00.000Z",
    returnedAt: "2026-07-30T12:05:00.000Z",
    returnCode: "R01",
  },
  ledgerSummary: {
    entries: [
      {
        id: "ledger-1",
        entryKey: "reservation:payment-1",
        entryType: "RESERVATION",
        amount: "2500",
        createdAt: "2026-07-30T12:01:00.000Z",
      },
      {
        id: "ledger-2",
        entryKey: "return:payment-1",
        entryType: "RETURN",
        amount: "2500",
        createdAt: "2026-07-30T12:05:00.000Z",
      },
    ],
    postedBalance: "10000",
    activeReservedAmount: "0",
    availableBalance: "10000",
  },
  outboxEvents: [
    {
      id: "outbox-1",
      eventType: "PAYMENT_RECEIVED",
      status: "PROCESSED",
      attempts: 1,
      createdAt: "2026-07-30T12:00:00.000Z",
      processedAt: "2026-07-30T12:00:01.000Z",
    },
    {
      id: "outbox-2",
      eventType: "PAYMENT_SUBMITTED",
      status: "PROCESSED",
      attempts: 1,
      createdAt: "2026-07-30T12:02:00.000Z",
      processedAt: "2026-07-30T12:02:01.000Z",
    },
    {
      id: "outbox-3",
      eventType: "PAYMENT_RETURNED",
      status: "PROCESSED",
      attempts: 1,
      createdAt: "2026-07-30T12:05:00.000Z",
      processedAt: "2026-07-30T12:05:01.000Z",
    },
  ],
};

function renderDetails() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <PaymentDetailsView paymentId="payment-1" />
    </QueryClientProvider>,
  );
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PaymentDetailsView", () => {
  it("renders a payment lifecycle timeline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(details)));
    renderDetails();

    expect(await screen.findByText("RECEIVED")).toBeInTheDocument();
    expect(screen.getByText("VALIDATED")).toBeInTheDocument();
    expect(screen.getByText("SUBMITTED")).toBeInTheDocument();
    expect(screen.getByText("SETTLED")).toBeInTheDocument();
    expect(screen.getAllByText("RETURNED")).toHaveLength(3);
  });

  it("renders ledger entries with their balance impacts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(details)));
    renderDetails();

    expect(await screen.findByText("RESERVATION")).toBeInTheDocument();
    expect(screen.getByText("Audit only")).toBeInTheDocument();
    expect(screen.getByText("RETURN")).toBeInTheDocument();
    expect(screen.getByText("+$25.00")).toBeInTheDocument();
  });

  it("renders dispatched outbox events", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(details)));
    renderDetails();

    expect(await screen.findByText("PAYMENT_RECEIVED")).toBeInTheDocument();
    expect(screen.getByText("PAYMENT_SUBMITTED")).toBeInTheDocument();
    expect(screen.getByText("PAYMENT_RETURNED")).toBeInTheDocument();
  });

  it("renders a loading state while payment details load", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    renderDetails();

    expect(screen.getByText("Loading payment details")).toBeInTheDocument();
  });

  it("renders a professional not-found state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({}, 404)));
    renderDetails();

    expect(await screen.findByText("Payment not found")).toBeInTheDocument();
  });

  it("shows and copies pretty formatted raw JSON", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(details)));
    Object.assign(navigator, { clipboard: { writeText } });
    renderDetails();

    await screen.findByText("Payment details");
    fireEvent.click(screen.getByRole("button", { name: "Raw JSON" }));
    expect(screen.getByText(/"id": "payment-1"/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('"id": "payment-1"'),
    );
  });
});
