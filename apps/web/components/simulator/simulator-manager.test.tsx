import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SimulatorManager } from "./simulator-manager";

const activeMerchant = {
  id: "merchant-active",
  merchantCode: "ACTIVE",
  displayName: "Active merchant",
  status: "ACTIVE",
  allowAchDebit: true,
  allowAchCredit: true,
  perPaymentLimit: "1000",
  dailyAmountLimit: "100000",
  dailyUtilizedAmountCents: "0",
  activeFundingCurrencies: ["USD"],
};

function renderSimulator() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <SimulatorManager />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SimulatorManager", () => {
  it("uses only supported scenarios and prevents unsupported fault injection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/api/admin/simulator/merchants") {
          return Promise.resolve(
            new Response(JSON.stringify({ data: [activeMerchant] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    );
    renderSimulator();

    expect(await screen.findByText("Active merchant")).toBeInTheDocument();
    expect(screen.getByText("No simulator runs")).toBeInTheDocument();
    expect(screen.getByLabelText("Minimum cents")).toHaveValue(1);
    expect(screen.getByLabelText("Maximum cents")).toHaveValue(10_000);
    expect(
      screen.getByRole("button", { name: "Complete configuration to start" }),
    ).toBeDisabled();

    fireEvent.click(screen.getByLabelText(/Active merchant ACTIVE/));
    expect(screen.getByRole("button", { name: /Start run/ })).toBeEnabled();

    fireEvent.change(screen.getByLabelText("Successful %"), {
      target: { value: "90" },
    });
    expect(screen.getByText(/Outcome total: 90%/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Complete configuration to start" }),
    ).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Validation failure %"), {
      target: { value: "5" },
    });
    fireEvent.change(screen.getByLabelText("Duplicate retry %"), {
      target: { value: "5" },
    });
    expect(screen.getByText(/Outcome total: 100%/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Start run/ })).toBeEnabled();

    for (const label of [
      "Return % (Unavailable)",
      "Insufficient funds % (Unavailable)",
      "Delayed processing % (Unavailable)",
      "Webhook failures % (Unavailable)",
    ]) {
      expect(screen.getByLabelText(label)).toBeDisabled();
      fireEvent.change(screen.getByLabelText(label), {
        target: { value: "1" },
      });
      expect(screen.getByText(/Outcome total: 100%/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Start run/ })).toBeEnabled();
    }
  });

  it("blocks a selected merchant whose requested minimum exceeds its real limit", async () => {
    const lowLimitMerchant = {
      ...activeMerchant,
      id: "merchant-low-limit",
      merchantCode: "LOW_LIMIT",
      displayName: "Low limit merchant",
      perPaymentLimit: "45",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/api/admin/simulator/merchants") {
          return Promise.resolve(
            new Response(JSON.stringify({ data: [lowLimitMerchant] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ data: [] }), { status: 200 }),
        );
      }),
    );
    renderSimulator();

    expect(await screen.findByText("Low limit merchant")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Low limit merchant LOW_LIMIT/));
    fireEvent.change(screen.getByLabelText("Minimum cents"), {
      target: { value: "100" },
    });

    expect(screen.getByText(/Not eligible/)).toHaveTextContent(
      "$1.00 exceeds its $0.45 per-payment limit.",
    );
    expect(
      screen.getByRole("button", { name: "Complete configuration to start" }),
    ).toBeDisabled();
  });
});
