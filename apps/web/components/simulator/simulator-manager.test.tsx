import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SimulatorManager } from "./simulator-manager";

const activeMerchant = {
  id: "merchant-active",
  merchantCode: "ACTIVE",
  displayName: "Active merchant",
  status: "ACTIVE",
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
  it("loads active merchants from the admin BFF and validates scenario totals", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/api/admin/merchants") {
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
  });
});
