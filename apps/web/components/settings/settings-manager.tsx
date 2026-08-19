"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorState, LoadingState } from "@/components/foundation/states";
import { PageHeader } from "@/components/foundation/page-header";
import { StatusBadge } from "@/components/foundation/status-badge";

type Health = "HEALTHY" | "UNHEALTHY" | "STALE" | "UNKNOWN";
type SystemStatus = {
  general: {
    platformName: string;
    environment: string;
    defaultTimezone: string;
    defaultDateFormat: string;
    defaultCurrency: string;
  };
  achProcessing: {
    defaultSecCode: string;
    processingWindow: string;
    sameDayAchEnabled: boolean;
    debitEnabled: boolean;
    creditEnabled: boolean;
    maximumPaymentAmount: string;
    retryPolicy: string;
    returnHandling: string;
    nachaGeneration: {
      status: "ENABLED" | "DISABLED" | "UNKNOWN";
      intervalMs: number | null;
    };
  };
  nacha: {
    immediateDestination: string;
    immediateOrigin: string;
    companyId: string;
    companyName: string;
    originatingDfiIdentification: string;
    fileIdModifier: string;
    balancedFiles: boolean;
  };
  webhooks: {
    timeoutMs: number;
    maxRetryAttempts: number;
    retryBackoff: string;
    signatureAlgorithm: string;
    signingSecretStorage: string;
  };
  security: {
    merchantApiKeyBehavior: string;
    adminControlPlane: string;
    keyRotationGuidance: string;
    secretMasking: string;
    environmentHealth: Array<{ name: string; configured: boolean }>;
  };
  health: {
    api: Health;
    database: Health;
    redis: Health;
    worker: Health;
    lastWorkerHeartbeatAt: string | null;
    outboxBacklog: number;
    pendingWebhookDeliveries: number;
  };
  generatedAt: string;
};

const tabs = [
  "General",
  "ACH Processing",
  "NACHA",
  "Webhooks",
  "Security",
  "System Health",
] as const;
type Tab = (typeof tabs)[number];

async function fetchSystemStatus(): Promise<SystemStatus> {
  const response = await fetch("/api/admin/system/status", {
    headers: { Accept: "application/json" },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && "message" in body
        ? String(body.message)
        : "System status is unavailable.";
    throw new Error(message);
  }
  return body as SystemStatus;
}

export function SettingsManager() {
  const [activeTab, setActiveTab] = useState<Tab>("General");
  const [copied, setCopied] = useState(false);
  const query = useQuery({
    queryKey: ["admin-system-status"],
    queryFn: fetchSystemStatus,
    refetchInterval: 30_000,
  });
  const apiBaseUrl =
    process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000/api/v1";

  if (query.isLoading) return <LoadingState label="Loading settings" />;
  if (query.isError)
    return (
      <ErrorState
        title="Settings unavailable"
        description="Live configuration and system health could not be loaded."
        onRetry={() => void query.refetch()}
      />
    );
  const status = query.data;
  if (!status) return null;

  const copyApiBaseUrl = async () => {
    await navigator.clipboard.writeText(apiBaseUrl);
    setCopied(true);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Settings"
        description="Read-only platform configuration, control-plane security, and live operational status."
        actions={
          <Button variant="outline" onClick={() => void query.refetch()}>
            <RefreshCw className="mr-2 h-4 w-4" /> Refresh status
          </Button>
        }
      />
      <section className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
        Platform configuration has no persisted settings source yet, so
        operational values are intentionally read-only. This avoids presenting a
        save action that cannot safely persist a change.
      </section>
      <nav
        aria-label="Settings sections"
        className="flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-800"
      >
        {tabs.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-slate-500 ${activeTab === tab ? "border-slate-900 text-slate-950 dark:border-white dark:text-white" : "border-transparent text-slate-500 hover:text-slate-950 dark:hover:text-white"}`}
          >
            {tab}
          </button>
        ))}
      </nav>

      {activeTab === "General" ? (
        <SettingsSection
          title="General"
          description="Current console defaults and API location."
        >
          <SettingsGrid>
            <Setting
              label="Platform name"
              value={status.general.platformName}
            />
            <Setting
              label="Environment"
              value={status.general.environment}
              badge
            />
            <Setting
              label="Default timezone"
              value={status.general.defaultTimezone}
            />
            <Setting
              label="Date format"
              value={status.general.defaultDateFormat}
            />
            <Setting
              label="Default currency"
              value={status.general.defaultCurrency}
            />
            <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
              <p className="text-xs text-slate-500">API base URL</p>
              <code className="mt-1 block break-all text-sm">{apiBaseUrl}</code>
              <Button
                size="sm"
                variant="ghost"
                className="mt-2"
                onClick={() => void copyApiBaseUrl()}
              >
                {copied ? (
                  <Check className="mr-1 h-3.5 w-3.5" />
                ) : (
                  <Copy className="mr-1 h-3.5 w-3.5" />
                )}
                {copied ? "Copied" : "Copy URL"}
              </Button>
            </div>
          </SettingsGrid>
        </SettingsSection>
      ) : null}

      {activeTab === "ACH Processing" ? (
        <SettingsSection
          title="ACH Processing"
          description="Current outbound ACH behavior from the production implementation."
        >
          <SettingsGrid>
            <Setting
              label="Default SEC code"
              value={status.achProcessing.defaultSecCode}
            />
            <Setting
              label="Processing window"
              value={status.achProcessing.processingWindow}
            />
            <Setting
              label="Same-day ACH"
              value={
                status.achProcessing.sameDayAchEnabled ? "Enabled" : "Disabled"
              }
              badge
            />
            <Setting
              label="ACH debit"
              value={status.achProcessing.debitEnabled ? "Enabled" : "Disabled"}
              badge
            />
            <Setting
              label="ACH credit"
              value={
                status.achProcessing.creditEnabled ? "Enabled" : "Disabled"
              }
              badge
            />
            <Setting
              label="Maximum payment amount"
              value={status.achProcessing.maximumPaymentAmount}
            />
            <Setting
              label="Retry policy"
              value={status.achProcessing.retryPolicy}
            />
            <Setting
              label="Return handling"
              value={status.achProcessing.returnHandling}
            />
            <Setting
              label="Scheduled NACHA generation"
              value={
                status.achProcessing.nachaGeneration.status === "ENABLED"
                  ? `Enabled — every ${formatInterval(status.achProcessing.nachaGeneration.intervalMs)}`
                  : status.achProcessing.nachaGeneration.status
              }
            />
          </SettingsGrid>
        </SettingsSection>
      ) : null}

      {activeTab === "NACHA" ? (
        <SettingsSection
          title="NACHA Configuration"
          description="Sensitive identifiers are masked; merchant identity is selected per batch."
        >
          <SettingsGrid>
            <Setting
              label="Immediate destination"
              value={status.nacha.immediateDestination}
              masked
            />
            <Setting
              label="Immediate origin"
              value={status.nacha.immediateOrigin}
              masked
            />
            <Setting label="Company ID" value={status.nacha.companyId} />
            <Setting label="Company name" value={status.nacha.companyName} />
            <Setting
              label="Originating DFI"
              value={status.nacha.originatingDfiIdentification}
              masked
            />
            <Setting
              label="File ID modifier"
              value={status.nacha.fileIdModifier}
            />
            <Setting
              label="File type"
              value={status.nacha.balancedFiles ? "Balanced" : "Unbalanced"}
              badge
            />
          </SettingsGrid>
        </SettingsSection>
      ) : null}

      {activeTab === "Webhooks" ? (
        <SettingsSection
          title="Webhook Defaults"
          description="Delivery behavior is read from the active worker configuration."
        >
          <SettingsGrid>
            <Setting
              label="Default timeout"
              value={`${status.webhooks.timeoutMs} ms`}
            />
            <Setting
              label="Maximum retry attempts"
              value={String(status.webhooks.maxRetryAttempts)}
            />
            <Setting
              label="Retry backoff"
              value={status.webhooks.retryBackoff}
            />
            <Setting
              label="Signature algorithm"
              value={status.webhooks.signatureAlgorithm}
            />
            <Setting
              label="Signing-secret metadata"
              value={status.webhooks.signingSecretStorage}
              masked
            />
          </SettingsGrid>
        </SettingsSection>
      ) : null}

      {activeTab === "Security" ? (
        <SettingsSection
          title="Security"
          description="Secret values stay server-side and are never returned by this endpoint."
        >
          <SettingsGrid>
            <Setting
              label="Merchant API keys"
              value={status.security.merchantApiKeyBehavior}
            />
            <Setting
              label="Admin control plane"
              value={status.security.adminControlPlane}
              badge
            />
            <Setting
              label="Key rotation"
              value={status.security.keyRotationGuidance}
            />
            <Setting
              label="Secret handling"
              value={status.security.secretMasking}
            />
          </SettingsGrid>
          <div className="mt-5 rounded-lg border border-slate-200 dark:border-slate-800">
            <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3 text-sm font-medium dark:border-slate-800">
              <ShieldCheck className="h-4 w-4" />
              Environment-variable health
            </div>
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {status.security.environmentHealth.map((item) => (
                <div
                  key={item.name}
                  className="flex items-center justify-between px-4 py-3 text-sm"
                >
                  <code>{item.name}</code>
                  <StatusBadge tone={item.configured ? "success" : "failure"}>
                    {item.configured ? "CONFIGURED" : "MISSING"}
                  </StatusBadge>
                </div>
              ))}
            </div>
          </div>
        </SettingsSection>
      ) : null}

      {activeTab === "System Health" ? (
        <SettingsSection
          title="System Health"
          description={`Last sampled ${new Date(status.generatedAt).toLocaleString()}.`}
        >
          <SettingsGrid>
            <HealthCard label="API" health={status.health.api} />
            <HealthCard label="Database" health={status.health.database} />
            <HealthCard label="Redis" health={status.health.redis} />
            <HealthCard label="Worker" health={status.health.worker} />
            <Setting
              label="Outbox backlog"
              value={String(status.health.outboxBacklog)}
            />
            <Setting
              label="Pending webhook deliveries"
              value={String(status.health.pendingWebhookDeliveries)}
            />
            <Setting
              label="Last worker heartbeat"
              value={
                status.health.lastWorkerHeartbeatAt
                  ? new Date(
                      status.health.lastWorkerHeartbeatAt,
                    ).toLocaleString()
                  : "No worker heartbeat recorded"
              }
            />
          </SettingsGrid>
        </SettingsSection>
      ) : null}
    </div>
  );
}

function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-slate-500">{description}</p>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function SettingsGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{children}</div>
  );
}

function Setting({
  label,
  value,
  badge = false,
  masked = false,
}: {
  label: string;
  value: string;
  badge?: boolean;
  masked?: boolean;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-950">
      <p className="text-xs text-slate-500">{label}</p>
      <div className="mt-1">
        {badge ? (
          <StatusBadge
            tone={
              value === "Enabled" || value === "Configured"
                ? "success"
                : value === "Disabled"
                  ? "neutral"
                  : "pending"
            }
          >
            {value.toUpperCase()}
          </StatusBadge>
        ) : (
          <p
            className={
              masked
                ? "font-mono text-sm tracking-widest"
                : "text-sm font-medium"
            }
          >
            {value}
          </p>
        )}
      </div>
    </div>
  );
}

function HealthCard({ label, health }: { label: string; health: Health }) {
  const tone =
    health === "HEALTHY"
      ? "success"
      : health === "UNHEALTHY"
        ? "failure"
        : "neutral";
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-950">
      <p className="text-xs text-slate-500">{label}</p>
      <div className="mt-1">
        <StatusBadge tone={tone}>{health}</StatusBadge>
      </div>
    </div>
  );
}

function formatInterval(intervalMs: number | null): string {
  if (!intervalMs) return "unknown interval";
  if (intervalMs % 60_000 === 0) return `${intervalMs / 60_000} minutes`;
  if (intervalMs % 1_000 === 0) return `${intervalMs / 1_000} seconds`;
  return `${intervalMs} ms`;
}
