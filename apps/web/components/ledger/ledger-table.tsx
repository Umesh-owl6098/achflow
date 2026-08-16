"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from "@/components/foundation/states";
import { StatusBadge } from "@/components/foundation/status-badge";
import { PageHeader } from "@/components/foundation/page-header";
import { statusTone } from "@/lib/dashboard";
import {
  formatCents,
  ledgerCsv,
  ledgerEntryTypes,
  ledgerSearchParams,
  parseLedgerData,
  type LedgerData,
  type LedgerFilters,
  type LedgerRow,
} from "@/lib/ledger";

const initialFilters: LedgerFilters = {
  merchantId: "",
  search: "",
  entryType: "",
  dateRange: "all",
  startDate: "",
  endDate: "",
  minAmount: "",
  maxAmount: "",
};

async function loadLedger(filters: LedgerFilters): Promise<LedgerData> {
  const response = await fetch(`/api/ledger?${ledgerSearchParams(filters)}`, {
    headers: { Accept: "application/json" },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error("Ledger data is unavailable.");
  return parseLedgerData(body);
}

type MerchantOption = { id: string; displayName: string; merchantCode: string };

async function loadMerchants(): Promise<MerchantOption[]> {
  const response = await fetch("/api/admin/merchants", {
    headers: { Accept: "application/json" },
  });
  const body: unknown = await response.json().catch(() => null);
  if (
    !response.ok ||
    !body ||
    typeof body !== "object" ||
    !("data" in body) ||
    !Array.isArray(body.data)
  ) {
    throw new Error("Merchant data is unavailable.");
  }
  return body.data.filter(isMerchantOption);
}

function isMerchantOption(value: unknown): value is MerchantOption {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    "displayName" in value &&
    "merchantCode" in value &&
    typeof value.id === "string" &&
    typeof value.displayName === "string" &&
    typeof value.merchantCode === "string"
  );
}

function useDebouncedValue(value: string, delay = 300): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [delay, value]);
  return debounced;
}

export function LedgerTable() {
  const [filters, setFilters] = useState(initialFilters);
  const [selected, setSelected] = useState<LedgerRow | null>(null);
  const debouncedSearch = useDebouncedValue(filters.search);
  const queryFilters = { ...filters, search: debouncedSearch };
  const query = useQuery({
    queryKey: ["ledger", queryFilters],
    queryFn: () => loadLedger(queryFilters),
  });
  const merchantsQuery = useQuery({
    queryKey: ["admin-merchants"],
    queryFn: loadMerchants,
  });

  function updateFilters(update: Partial<LedgerFilters>) {
    setFilters((current) => ({ ...current, ...update }));
  }

  if (query.isLoading) return <LedgerSkeleton />;
  if (query.isError)
    return (
      <ErrorState
        title="Ledger unavailable"
        description="Live ledger data could not be loaded."
        onRetry={() => void query.refetch()}
      />
    );
  if (!query.data) return <LedgerSkeleton />;

  const data = query.data;
  return (
    <div className="space-y-5">
      <PageHeader
        title="Ledger"
        description="Immutable funding-account movements across the selected operations scope."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => downloadCsv(data.data)}
            disabled={data.data.length === 0}
          >
            <Download className="h-4 w-4" />
            Export CSV
          </Button>
        }
      />
      <LedgerSummary summary={data.summary} />
      <section className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950 lg:grid-cols-4">
        <label className="relative block lg:col-span-2">
          <span className="sr-only">Search ledger</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={filters.search}
            onChange={(event) => updateFilters({ search: event.target.value })}
            placeholder="Search payment, reference, merchant"
            className="h-9 w-full rounded-md border border-slate-200 bg-slate-50 pl-9 pr-3 text-sm outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-200 dark:border-slate-800 dark:bg-slate-900 dark:focus:border-slate-600 dark:focus:ring-slate-800"
          />
        </label>
        <label className="text-xs font-medium text-slate-500 dark:text-slate-400">
          Merchant scope
          <select
            aria-label="Merchant filter"
            value={filters.merchantId}
            onChange={(event) =>
              updateFilters({ merchantId: event.target.value })
            }
            className="mt-1 block h-9 w-full rounded-md border border-slate-200 bg-slate-100 px-2 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300"
          >
            <option value="">All merchants</option>
            {(merchantsQuery.data ?? []).map((merchant) => (
              <option key={merchant.id} value={merchant.id}>
                {merchant.displayName} ({merchant.merchantCode})
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-slate-500 dark:text-slate-400">
          Entry type
          <select
            aria-label="Entry type filter"
            value={filters.entryType}
            onChange={(event) =>
              updateFilters({ entryType: event.target.value })
            }
            className="mt-1 block h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-900 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100"
          >
            <option value="">All entry types</option>
            {ledgerEntryTypes.map((entryType) => (
              <option key={entryType} value={entryType}>
                {entryType.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-slate-500 dark:text-slate-400">
          Date range
          <select
            aria-label="Ledger date range filter"
            value={filters.dateRange}
            onChange={(event) =>
              updateFilters({
                dateRange: event.target.value as LedgerFilters["dateRange"],
              })
            }
            className="mt-1 block h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-900 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100"
          >
            <option value="all">All time</option>
            <option value="today">Today</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        <label className="text-xs font-medium text-slate-500 dark:text-slate-400">
          Minimum amount (USD)
          <input
            aria-label="Minimum amount filter"
            inputMode="decimal"
            value={filters.minAmount}
            onChange={(event) =>
              updateFilters({ minAmount: event.target.value })
            }
            placeholder="0.00"
            className="mt-1 block h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-800 dark:bg-slate-900"
          />
        </label>
        <label className="text-xs font-medium text-slate-500 dark:text-slate-400">
          Maximum amount (USD)
          <input
            aria-label="Maximum amount filter"
            inputMode="decimal"
            value={filters.maxAmount}
            onChange={(event) =>
              updateFilters({ maxAmount: event.target.value })
            }
            placeholder="Any"
            className="mt-1 block h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-800 dark:bg-slate-900"
          />
        </label>
        {filters.dateRange === "custom" ? (
          <div className="flex gap-3 lg:col-span-2">
            <label className="flex-1 text-xs font-medium text-slate-500 dark:text-slate-400">
              From
              <input
                aria-label="Ledger custom start date"
                type="date"
                value={filters.startDate}
                onChange={(event) =>
                  updateFilters({ startDate: event.target.value })
                }
                className="mt-1 block h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-800 dark:bg-slate-900"
              />
            </label>
            <label className="flex-1 text-xs font-medium text-slate-500 dark:text-slate-400">
              To
              <input
                aria-label="Ledger custom end date"
                type="date"
                value={filters.endDate}
                onChange={(event) =>
                  updateFilters({ endDate: event.target.value })
                }
                className="mt-1 block h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-800 dark:bg-slate-900"
              />
            </label>
          </div>
        ) : null}
      </section>
      {data.data.length === 0 ? (
        <EmptyState
          title="No ledger entries found"
          description="Try adjusting the search or filters to find matching account movements."
        />
      ) : (
        <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1060px] text-left text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 dark:bg-slate-900/60 dark:text-slate-400">
                <tr>
                  <th className="px-4 py-3 font-medium">Timestamp</th>
                  <th className="px-4 py-3 font-medium">Payment ID</th>
                  <th className="px-4 py-3 font-medium">Merchant</th>
                  <th className="px-4 py-3 font-medium">Entry type</th>
                  <th className="px-4 py-3 text-right font-medium">Debit</th>
                  <th className="px-4 py-3 text-right font-medium">Credit</th>
                  <th className="px-4 py-3 text-right font-medium">
                    Running balance
                  </th>
                  <th className="px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((row) => (
                  <tr
                    key={row.id}
                    tabIndex={0}
                    onClick={() => setSelected(row)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelected(row);
                      }
                    }}
                    className="cursor-pointer border-t border-slate-100 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-500 dark:border-slate-900 dark:hover:bg-slate-900/50"
                  >
                    <td className="px-4 py-3 text-slate-500 dark:text-slate-400">
                      {formatDate(row.createdAt)}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {row.payment ? `${row.payment.id.slice(0, 8)}…` : "—"}
                    </td>
                    <td className="px-4 py-3">{row.merchant.displayName}</td>
                    <td className="px-4 py-3">{row.entryType}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {row.debitAmountCents === "0"
                        ? "—"
                        : formatCents(row.debitAmountCents, row.currency)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {row.creditAmountCents === "0"
                        ? "—"
                        : formatCents(row.creditAmountCents, row.currency)}
                    </td>
                    <td className="px-4 py-3 text-right font-medium tabular-nums">
                      {formatCents(row.runningBalanceCents, row.currency)}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge tone={statusTone(row.status)}>
                        {row.status.replaceAll("_", " ")}
                      </StatusBadge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <LedgerDetailPanel
        row={selected}
        history={data.data.filter(
          (entry) => entry.payment?.id === selected?.payment?.id,
        )}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

function LedgerSummary({ summary }: { summary: LedgerData["summary"] }) {
  const cards = [
    ["Total credits", summary.totalCreditsCents, "emerald"],
    ["Total debits", summary.totalDebitsCents, "red"],
    ["Net position", summary.netPositionCents, "slate"],
    ["Outstanding reserved", summary.outstandingReservedAmountCents, "amber"],
  ] as const;
  return (
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map(([label, amount, tone]) => (
        <div
          key={label}
          className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950"
        >
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
            {label}
          </p>
          <p
            className={`mt-2 text-xl font-semibold tabular-nums ${tone === "emerald" ? "text-emerald-700 dark:text-emerald-300" : tone === "red" ? "text-red-700 dark:text-red-300" : tone === "amber" ? "text-amber-700 dark:text-amber-300" : "text-slate-950 dark:text-white"}`}
          >
            {formatCents(amount)}
          </p>
        </div>
      ))}
    </section>
  );
}

function LedgerDetailPanel({
  row,
  history,
  onClose,
}: {
  row: LedgerRow | null;
  history: LedgerRow[];
  onClose: () => void;
}) {
  return (
    <Dialog open={row !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="left-auto right-0 top-0 h-dvh w-full max-w-md translate-x-0 translate-y-0 overflow-y-auto rounded-none border-y-0 border-r-0">
        {row ? (
          <>
            <DialogHeader>
              <DialogTitle>Ledger entry</DialogTitle>
              <DialogDescription>{row.entryKey}</DialogDescription>
            </DialogHeader>
            <div className="mt-6 space-y-6 text-sm">
              <PanelSection title="Payment summary">
                <PanelValue
                  label="Payment ID"
                  value={row.payment?.id ?? "No linked payment"}
                />
                <PanelValue
                  label="External reference"
                  value={row.payment?.externalReference ?? "—"}
                />
                <PanelValue
                  label="Status"
                  value={row.status.replaceAll("_", " ")}
                />
              </PanelSection>
              <PanelSection title="Reservation">
                <PanelValue
                  label="Status"
                  value={row.reservation?.status ?? "No reservation"}
                />
                <PanelValue
                  label="Reserved amount"
                  value={
                    row.reservation
                      ? formatCents(row.reservation.amountCents, row.currency)
                      : "—"
                  }
                />
                <PanelValue
                  label="Created"
                  value={
                    row.reservation
                      ? formatDate(row.reservation.createdAt)
                      : "—"
                  }
                />
              </PanelSection>
              <PanelSection title="Ledger history">
                {history.length > 0 ? (
                  <ul className="space-y-2">
                    {history.map((entry) => (
                      <li
                        key={entry.id}
                        className="flex items-start justify-between gap-4"
                      >
                        <span>{entry.entryType.replaceAll("_", " ")}</span>
                        <span className="text-right text-slate-500 dark:text-slate-400">
                          {formatDate(entry.createdAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <PanelValue
                    label="Entry type"
                    value={row.entryType.replaceAll("_", " ")}
                  />
                )}
              </PanelSection>
              <PanelSection title="Current balance impact">
                <PanelValue
                  label="Entry impact"
                  value={formatCents(row.balanceImpactCents, row.currency)}
                />
                <PanelValue
                  label="Running balance"
                  value={formatCents(row.runningBalanceCents, row.currency)}
                />
              </PanelSection>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function PanelSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="mt-3 space-y-2">{children}</div>
    </section>
  );
}

function PanelValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-slate-500 dark:text-slate-400">{label}</span>
      <span className="break-all text-right font-medium">{value}</span>
    </div>
  );
}

function downloadCsv(rows: LedgerRow[]) {
  const file = new Blob([ledgerCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "achflow-ledger.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}

function LedgerSkeleton() {
  return (
    <div className="space-y-5" aria-label="Loading ledger">
      <LoadingState label="Loading ledger entries" />
      <div className="h-80 animate-pulse rounded-lg border border-slate-200 bg-slate-100 dark:border-slate-800 dark:bg-slate-900" />
    </div>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
