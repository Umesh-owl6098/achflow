import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "./settings-manager";

const status = {
  general: {
    platformName: "ACHFlow",
    environment: "local",
    defaultTimezone: "UTC",
    defaultDateFormat: "YYYY-MM-DD",
    defaultCurrency: "USD",
  },
  achProcessing: {
    defaultSecCode: "PPD",
    processingWindow: "On-demand outbound batch generation",
    sameDayAchEnabled: false,
    debitEnabled: true,
    creditEnabled: true,
    maximumPaymentAmount: "Merchant-specific limits",
    retryPolicy: "Exponential backoff, maximum 5 attempts",
    returnHandling: "Supported returns",
  },
  nacha: {
    immediateDestination: "*****6789",
    immediateOrigin: "*****4321",
    companyId: "Merchant code per batch",
    companyName: "Merchant legal name per batch",
    originatingDfiIdentification: "******78",
    fileIdModifier: "A (fixed)",
    balancedFiles: false,
  },
  webhooks: {
    timeoutMs: 5000,
    maxRetryAttempts: 5,
    retryBackoff: "Exponential 1s to 60s",
    signatureAlgorithm: "HMAC-SHA256 (v1)",
    signingSecretStorage: "AES-256-GCM encrypted at rest",
  },
  security: {
    merchantApiKeyBehavior: "One active hashed API key per merchant",
    adminControlPlane: "Configured",
    keyRotationGuidance: "Shown once",
    secretMasking: "Raw secrets are never returned.",
    environmentHealth: [{ name: "ACHFLOW_ADMIN_API_KEY", configured: true }],
  },
  health: {
    api: "HEALTHY" as const,
    database: "HEALTHY" as const,
    redis: "HEALTHY" as const,
    worker: "UNKNOWN" as const,
    lastWorkerHeartbeatAt: null,
    outboxBacklog: 2,
    pendingWebhookDeliveries: 1,
  },
  generatedAt: "2026-07-30T12:00:00.000Z",
};

function renderSettings() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <SettingsManager />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SettingsManager", () => {
  it("renders real configuration through the secured BFF", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(status), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    renderSettings();

    expect(await screen.findByText("ACHFlow")).toBeInTheDocument();
    expect(screen.getByText("UTC")).toBeInTheDocument();
    expect(
      screen.getByText(
        "platform configuration has no persisted settings source yet",
        { exact: false },
      ),
    ).toBeInTheDocument();
  });

  it("shows live backlog and honest unknown worker health", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(status), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    renderSettings();
    await screen.findByText("ACHFlow");

    fireEvent.click(screen.getByRole("button", { name: "System Health" }));
    expect(screen.getByText("Outbox backlog")).toBeInTheDocument();
    expect(screen.getByText("UNKNOWN")).toBeInTheDocument();
    expect(
      screen.getByText("Not available — worker heartbeat is not persisted"),
    ).toBeInTheDocument();
  });
});
