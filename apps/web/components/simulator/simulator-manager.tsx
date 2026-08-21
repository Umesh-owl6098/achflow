"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pause, Play, RotateCcw, Square } from "lucide-react";
import { ConfirmationDialog } from "@/components/foundation/confirmation-dialog";
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from "@/components/foundation/states";
import { PageHeader } from "@/components/foundation/page-header";
import { StatusBadge } from "@/components/foundation/status-badge";
import { Button } from "@/components/ui/button";
import {
  merchantEligibility,
  type MerchantEligibility,
  type SimulatorMerchant,
} from "@/lib/simulator-eligibility";

type Run = {
  id: string;
  status: "RUNNING" | "PAUSED" | "STOPPED" | "COMPLETED" | "FAILED";
  startedAt: string;
  completedAt: string | null;
  generatedCount: number;
  successfulCount: number;
  failedCount: number;
  returnedCount: number;
  averageLatencyMs: number;
  failureSummary: unknown;
  merchantIds: string[];
  configuration: unknown;
};
type RunDetail = Run & {
  recentPayments: Array<{
    id: string;
    status: string;
    direction: string;
    amountCents: string;
    createdAt: string;
    failureReason: string | null;
  }>;
};
type Form = {
  merchantIds: string[];
  direction: "DEBIT" | "CREDIT" | "MIXED";
  transactionCount: number;
  transactionsPerSecond: number;
  minimumAmountCents: number;
  maximumAmountCents: number;
  secCode: string;
  effectiveEntryDate: string;
  descriptionPrefix: string;
  idempotencyKeyPrefix: string;
  successfulPercent: number;
  validationFailurePercent: number;
  insufficientFundsPercent: number;
  returnPercent: number;
  duplicatePercent: number;
  delayedProcessingPercent: number;
  webhookFailurePercent: number;
};
const defaults: Form = {
  merchantIds: [],
  direction: "MIXED",
  transactionCount: 10,
  transactionsPerSecond: 2,
  minimumAmountCents: 1,
  maximumAmountCents: 10_000,
  secCode: "PPD",
  effectiveEntryDate: "",
  descriptionPrefix: "Simulator",
  idempotencyKeyPrefix: "",
  successfulPercent: 100,
  validationFailurePercent: 0,
  insufficientFundsPercent: 0,
  returnPercent: 0,
  duplicatePercent: 0,
  delayedProcessingPercent: 0,
  webhookFailurePercent: 0,
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      typeof body === "object" && body !== null && "message" in body
        ? String(body.message)
        : "Simulator request failed.",
    );
  }
  return body as T;
}
function money(cents: string) {
  return `$${(BigInt(cents) / 100n).toString()}.${(BigInt(cents) % 100n).toString().padStart(2, "0")}`;
}
function metric(label: string, value: string | number) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-950">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}

export function SimulatorManager() {
  const [form, setForm] = useState<Form>(defaults);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const merchantsQuery = useQuery({
    queryKey: ["simulator-merchants"],
    queryFn: () =>
      api<{ data: SimulatorMerchant[] }>("/api/admin/simulator/merchants"),
  });
  const runsQuery = useQuery({
    queryKey: ["simulator-runs"],
    queryFn: () => api<{ data: Run[] }>("/api/admin/simulator/runs"),
    refetchInterval: 2_000,
  });
  const detailQuery = useQuery({
    queryKey: ["simulator-run", selectedRunId],
    queryFn: () => api<RunDetail>(`/api/admin/simulator/runs/${selectedRunId}`),
    enabled: Boolean(selectedRunId),
    refetchInterval: 2_000,
  });
  const merchants = merchantsQuery.data?.data ?? [];
  const active = merchants.filter((merchant) => merchant.status === "ACTIVE");
  const selectedMerchants = merchants.filter((merchant) =>
    form.merchantIds.includes(merchant.id),
  );
  const eligibility = selectedMerchants.map((merchant) =>
    merchantEligibility(merchant, {
      direction: form.direction,
      minimumAmountCents: form.minimumAmountCents,
      maximumAmountCents: form.maximumAmountCents,
      transactionCount: form.transactionCount,
      selectedMerchantCount: selectedMerchants.length,
      validationFailurePercent: form.validationFailurePercent,
    }),
  );
  const eligibilityByMerchantId = new Map<string, MerchantEligibility>(
    eligibility.map((result) => [result.merchantId, result]),
  );
  const run =
    detailQuery.data ??
    runsQuery.data?.data.find((item) => item.id === selectedRunId);
  const scenarioTotal =
    form.successfulPercent +
    form.validationFailurePercent +
    form.duplicatePercent;
  const configValid =
    form.merchantIds.length > 0 &&
    form.minimumAmountCents <= form.maximumAmountCents &&
    scenarioTotal === 100 &&
    eligibility.every((merchant) => merchant.eligible);
  const update = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((current) => ({
      ...current,
      [key]: value,
      insufficientFundsPercent: 0,
      returnPercent: 0,
      delayedProcessingPercent: 0,
      webhookFailurePercent: 0,
    }));
  const start = async () => {
    const payload = {
      merchantIds: form.merchantIds,
      direction: form.direction,
      transactionCount: form.transactionCount,
      transactionsPerSecond: form.transactionsPerSecond,
      minimumAmountCents: form.minimumAmountCents,
      maximumAmountCents: form.maximumAmountCents,
      secCode: form.secCode,
      effectiveEntryDate: form.effectiveEntryDate || undefined,
      descriptionPrefix: form.descriptionPrefix,
      idempotencyKeyPrefix: form.idempotencyKeyPrefix || undefined,
      scenario: {
        successfulPercent: form.successfulPercent,
        validationFailurePercent: form.validationFailurePercent,
        insufficientFundsPercent: 0,
        returnPercent: 0,
        duplicatePercent: form.duplicatePercent,
        delayedProcessingPercent: 0,
        webhookFailurePercent: 0,
      },
    };
    const created = await api<Run>("/api/admin/simulator/runs", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    setSelectedRunId(created.id);
    await queryClient.invalidateQueries({ queryKey: ["simulator-runs"] });
  };
  const control = async (action: "pause" | "resume" | "stop") => {
    if (!run) return;
    await api(`/api/admin/simulator/runs/${run.id}/${action}`, {
      method: "POST",
    });
    await queryClient.invalidateQueries({ queryKey: ["simulator-runs"] });
    await queryClient.invalidateQueries({
      queryKey: ["simulator-run", run.id],
    });
  };
  const payments = detailQuery.data?.recentPayments ?? [];
  const remaining = run
    ? Math.max(0, form.transactionCount - run.generatedCount)
    : form.transactionCount;
  const elapsedSeconds = run
    ? Math.max(1, (Date.now() - new Date(run.startedAt).getTime()) / 1_000)
    : 0;
  const currentTps = run
    ? (run.generatedCount / elapsedSeconds).toFixed(1)
    : "0.0";
  if (merchantsQuery.isLoading)
    return <LoadingState label="Loading simulator configuration" />;
  if (merchantsQuery.isError)
    return <ErrorState description={merchantsQuery.error.message} />;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Transaction simulator"
        description="Generate controlled ACH traffic through the real payment API, idempotency layer, outbox, and worker."
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <section className="space-y-5 rounded-lg border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-950">
          <div>
            <h2 className="font-semibold">Run configuration</h2>
            <p className="mt-1 text-sm text-slate-500">
              Local-development control plane. Limits: 500 transactions and 25
              TPS.
            </p>
          </div>
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Merchants</legend>
            <div className="flex flex-wrap gap-2">
              {merchants.map((merchant) => {
                const selected = form.merchantIds.includes(merchant.id);
                const result = eligibilityByMerchantId.get(merchant.id);
                const inactive = merchant.status !== "ACTIVE";
                return (
                  <label
                    key={merchant.id}
                    className="flex max-w-full items-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm dark:border-slate-800"
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={inactive}
                      onChange={(event) =>
                        update(
                          "merchantIds",
                          event.target.checked
                            ? [...form.merchantIds, merchant.id]
                            : form.merchantIds.filter(
                                (id) => id !== merchant.id,
                              ),
                        )
                      }
                    />
                    {merchant.displayName}{" "}
                    <span className="text-xs text-slate-500">
                      {merchant.merchantCode}
                    </span>
                    <StatusBadge tone={inactive ? "neutral" : "success"}>
                      {merchant.status}
                    </StatusBadge>
                    {selected && result ? (
                      <span
                        className={
                          result.eligible
                            ? "text-xs text-emerald-700 dark:text-emerald-400"
                            : "text-xs text-red-700 dark:text-red-400"
                        }
                      >
                        {result.eligible
                          ? `Eligible · safe maximum ${money(String(result.safeMaximumAmountCents ?? 0))}`
                          : `Not eligible · ${result.reasons.join(" ")}`}
                      </span>
                    ) : null}
                  </label>
                );
              })}
            </div>
            {active.length === 0 ? (
              <p className="mt-2 text-sm text-amber-700">
                No active merchant is eligible for simulation.
              </p>
            ) : null}
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Select
              label="Direction"
              value={form.direction}
              onChange={(value) =>
                update("direction", value as Form["direction"])
              }
              options={["DEBIT", "CREDIT", "MIXED"]}
            />
            <NumberInput
              label="Transactions"
              value={form.transactionCount}
              min={1}
              max={500}
              onChange={(value) => update("transactionCount", value)}
            />
            <NumberInput
              label="Transactions / second"
              value={form.transactionsPerSecond}
              min={1}
              max={25}
              onChange={(value) => update("transactionsPerSecond", value)}
            />
            <TextInput
              label="SEC code"
              value={form.secCode}
              onChange={(value) => update("secCode", value.toUpperCase())}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <NumberInput
              label="Minimum cents"
              value={form.minimumAmountCents}
              min={1}
              max={1_000_000}
              onChange={(value) => update("minimumAmountCents", value)}
            />
            <NumberInput
              label="Maximum cents"
              value={form.maximumAmountCents}
              min={1}
              max={1_000_000}
              onChange={(value) => update("maximumAmountCents", value)}
            />
            <TextInput
              label="Effective date"
              type="date"
              value={form.effectiveEntryDate}
              onChange={(value) => update("effectiveEntryDate", value)}
            />
            <TextInput
              label="Idempotency-key prefix"
              value={form.idempotencyKeyPrefix}
              onChange={(value) => update("idempotencyKeyPrefix", value)}
            />
          </div>
          <TextInput
            label="Description prefix"
            value={form.descriptionPrefix}
            onChange={(value) => update("descriptionPrefix", value)}
          />
          <div>
            <h3 className="mb-2 text-sm font-medium">Scenario distribution</h3>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <NumberInput
                label="Successful %"
                value={form.successfulPercent}
                min={0}
                max={100}
                onChange={(value) => update("successfulPercent", value)}
              />
              <NumberInput
                label="Validation failure %"
                value={form.validationFailurePercent}
                min={0}
                max={100}
                onChange={(value) => update("validationFailurePercent", value)}
              />
              <NumberInput
                label="Duplicate retry %"
                value={form.duplicatePercent}
                min={0}
                max={100}
                onChange={(value) => update("duplicatePercent", value)}
              />
              <NumberInput
                label="Return % (Unavailable)"
                value={0}
                min={0}
                max={100}
                disabled
              />
              <NumberInput
                label="Insufficient funds % (Unavailable)"
                value={0}
                min={0}
                max={100}
                disabled
              />
              <NumberInput
                label="Delayed processing % (Unavailable)"
                value={0}
                min={0}
                max={100}
                disabled
              />
              <NumberInput
                label="Webhook failures % (Unavailable)"
                value={0}
                min={0}
                max={100}
                disabled
              />
            </div>
            <p
              className={
                scenarioTotal === 100
                  ? "mt-2 text-xs text-slate-500"
                  : "mt-2 text-xs text-red-600"
              }
            >
              Outcome total: {scenarioTotal}% (must equal 100). Return,
              insufficient-funds, delayed-processing and webhook-failure
              injection are not available in the current simulator.
            </p>
            {eligibility.some((merchant) => !merchant.eligible) ? (
              <p className="mt-2 text-xs text-red-600">
                Resolve each selected merchant&apos;s eligibility issue before
                starting a run.
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {configValid ? (
              <ConfirmationDialog
                trigger={
                  <Button>
                    <Play className="mr-2 h-4 w-4" />
                    Start run
                  </Button>
                }
                title="Start transaction simulation?"
                description={`This will create up to ${form.transactionCount} real payments at up to ${form.transactionsPerSecond} TPS using the selected active merchants.`}
                confirmLabel="Start simulation"
                onConfirm={() => void start()}
              />
            ) : (
              <Button disabled>Complete configuration to start</Button>
            )}
            <Button variant="outline" onClick={() => setForm(defaults)}>
              <RotateCcw className="mr-2 h-4 w-4" />
              Reset
            </Button>
            {run?.status === "RUNNING" ? (
              <>
                <Button variant="outline" onClick={() => void control("pause")}>
                  <Pause className="mr-2 h-4 w-4" />
                  Pause
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => void control("stop")}
                >
                  <Square className="mr-2 h-4 w-4" />
                  Stop
                </Button>
              </>
            ) : null}
            {run?.status === "PAUSED" ? (
              <Button onClick={() => void control("resume")}>
                <Play className="mr-2 h-4 w-4" />
                Resume
              </Button>
            ) : null}
          </div>
        </section>
        <aside className="rounded-lg border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-950">
          <h2 className="font-semibold">Run history</h2>
          {runsQuery.isLoading ? (
            <p className="mt-3 text-sm text-slate-500">Loading runs…</p>
          ) : (runsQuery.data?.data.length ?? 0) === 0 ? (
            <EmptyState
              title="No simulator runs"
              description="Start a controlled run to create real payment traffic."
            />
          ) : (
            <div className="mt-3 space-y-2">
              {runsQuery.data?.data.map((item) => (
                <button
                  key={item.id}
                  onClick={() => setSelectedRunId(item.id)}
                  className="w-full rounded-md border border-slate-200 p-3 text-left text-sm dark:border-slate-800"
                >
                  <div className="flex justify-between gap-2">
                    <span className="font-mono text-xs">
                      {item.id.slice(0, 8)}
                    </span>
                    <StatusBadge
                      tone={
                        item.status === "COMPLETED"
                          ? "success"
                          : item.status === "FAILED" ||
                              item.status === "STOPPED"
                            ? "failure"
                            : "pending"
                      }
                    >
                      {item.status}
                    </StatusBadge>
                  </div>
                  <p className="mt-1 text-slate-500">
                    {item.generatedCount} generated ·{" "}
                    {new Date(item.startedAt).toLocaleTimeString()}
                  </p>
                </button>
              ))}
            </div>
          )}
        </aside>
      </div>
      <section className="space-y-4">
        <h2 className="text-base font-semibold">Live monitoring</h2>
        {run ? (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-8">
              {metric("Status", run.status)}
              {metric("Generated", run.generatedCount)}
              {metric("Accepted", run.successfulCount)}
              {metric("Errors", run.failedCount)}
              {metric("Average latency", `${run.averageLatencyMs} ms`)}
              {metric("Remaining", remaining)}
              {metric("Current TPS", currentTps)}
              {metric("Elapsed", `${Math.floor(elapsedSeconds)} s`)}
            </div>
            <div className="h-2 overflow-hidden rounded bg-slate-200 dark:bg-slate-800">
              <div
                className="h-full bg-emerald-600"
                style={{
                  width: `${Math.min(100, (run.generatedCount / Math.max(1, form.transactionCount)) * 100)}%`,
                }}
              />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950">
                <h3 className="text-sm font-medium">Status distribution</h3>
                <div className="mt-3 space-y-2 text-sm">
                  <DistributionRow
                    label="Accepted"
                    value={run.successfulCount}
                    total={run.generatedCount}
                    tone="bg-emerald-600"
                  />
                  <DistributionRow
                    label="Failed"
                    value={run.failedCount}
                    total={run.generatedCount}
                    tone="bg-red-600"
                  />
                  <DistributionRow
                    label="Returned"
                    value={run.returnedCount}
                    total={run.generatedCount}
                    tone="bg-amber-500"
                  />
                </div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950">
                <h3 className="text-sm font-medium">Scenario and errors</h3>
                <p className="mt-2 text-sm text-slate-500">
                  Success {form.successfulPercent}% · validation failures{" "}
                  {form.validationFailurePercent}% · duplicate retries{" "}
                  {form.duplicatePercent}%
                </p>
                {run.failureSummary ? (
                  <pre className="mt-3 overflow-auto rounded bg-slate-50 p-2 text-xs text-red-700 dark:bg-slate-900 dark:text-red-300">
                    {JSON.stringify(run.failureSummary, null, 2)}
                  </pre>
                ) : (
                  <p className="mt-3 text-sm text-slate-500">
                    No simulator API errors recorded.
                  </p>
                )}
              </div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
              <div className="border-b border-slate-200 px-4 py-3 text-sm font-medium dark:border-slate-800">
                Recent generated payments
              </div>
              {payments.length === 0 ? (
                <div className="p-4 text-sm text-slate-500">
                  Payments will appear as the run calls the production payment
                  API.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="text-left text-xs text-slate-500">
                      <tr>
                        <th className="p-3">Payment</th>
                        <th className="p-3">Direction</th>
                        <th className="p-3">Amount</th>
                        <th className="p-3">Status</th>
                        <th className="p-3">Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payments.map((payment) => (
                        <tr
                          key={payment.id}
                          className="border-t border-slate-100 dark:border-slate-900"
                        >
                          <td className="p-3">
                            <Link
                              className="font-mono text-blue-700 hover:underline dark:text-blue-400"
                              href={`/payments/${payment.id}`}
                            >
                              {payment.id.slice(0, 12)}
                            </Link>
                          </td>
                          <td className="p-3">{payment.direction}</td>
                          <td className="p-3">{money(payment.amountCents)}</td>
                          <td className="p-3">
                            <StatusBadge
                              tone={
                                payment.status.includes("FAILED")
                                  ? "failure"
                                  : "pending"
                              }
                            >
                              {payment.status}
                            </StatusBadge>
                          </td>
                          <td className="p-3">
                            {new Date(payment.createdAt).toLocaleTimeString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        ) : (
          <EmptyState
            title="Select a run"
            description="Run metrics, payment links, and errors are displayed here without resetting your configuration."
          />
        )}
      </section>
    </div>
  );
}
function TextInput({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <label className="grid gap-1 text-xs font-medium text-slate-600 dark:text-slate-300">
      {label}
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-800 dark:bg-slate-950"
      />
    </label>
  );
}
function NumberInput({
  label,
  value,
  min,
  max,
  onChange = () => undefined,
  disabled = false,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange?: (value: number) => void;
  disabled?: boolean;
}) {
  return (
    <label className="grid gap-1 text-xs font-medium text-slate-600 dark:text-slate-300">
      {label}
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(event) =>
          onChange(
            Math.max(
              min,
              Math.min(max, Number.parseInt(event.target.value || "0", 10)),
            ),
          )
        }
        className="h-9 rounded-md border border-slate-200 bg-white px-2 text-sm disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-800 dark:bg-slate-950"
      />
    </label>
  );
}
function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
}) {
  return (
    <label className="grid gap-1 text-xs font-medium text-slate-600 dark:text-slate-300">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-800 dark:bg-slate-950"
      >
        {options.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </select>
    </label>
  );
}

function DistributionRow({
  label,
  value,
  total,
  tone,
}: {
  label: string;
  value: number;
  total: number;
  tone: string;
}) {
  const percentage = Math.min(100, (value / Math.max(1, total)) * 100);
  return (
    <div>
      <div className="mb-1 flex justify-between">
        <span>{label}</span>
        <span>{value}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded bg-slate-200 dark:bg-slate-800">
        <div className={`h-full ${tone}`} style={{ width: `${percentage}%` }} />
      </div>
    </div>
  );
}
