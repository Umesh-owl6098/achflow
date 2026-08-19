"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Download, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from "@/components/foundation/states";
import { PageHeader } from "@/components/foundation/page-header";
import { StatusBadge } from "@/components/foundation/status-badge";
import { statusTone } from "@/lib/dashboard";
import {
  formatNachaCents,
  nachaFilesSearchParams,
  parseNachaFilesData,
  type NachaFile,
  type NachaFilesData,
  type NachaFilesFilters,
} from "@/lib/nacha-files";

const initialFilters: NachaFilesFilters = {
  merchantId: "",
  search: "",
  status: "",
  dateRange: "all",
  startDate: "",
  endDate: "",
  page: 1,
};

async function loadNachaFiles(
  filters: NachaFilesFilters,
): Promise<NachaFilesData> {
  const response = await fetch(
    `/api/nacha-files?${nachaFilesSearchParams(filters)}`,
    { headers: { Accept: "application/json" } },
  );
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error("NACHA file data is unavailable.");
  return parseNachaFilesData(body);
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
  )
    throw new Error("Merchant data is unavailable.");
  return body.data.filter(
    (value): value is MerchantOption =>
      typeof value === "object" &&
      value !== null &&
      "id" in value &&
      "displayName" in value &&
      "merchantCode" in value &&
      typeof value.id === "string" &&
      typeof value.displayName === "string" &&
      typeof value.merchantCode === "string",
  );
}

function useDebouncedValue(value: string, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [delay, value]);
  return debounced;
}

export function NachaFilesTable() {
  const [filters, setFilters] = useState(initialFilters);
  const [selected, setSelected] = useState<NachaFile | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const queryFilters = {
    ...filters,
    search: useDebouncedValue(filters.search),
  };
  const query = useQuery({
    queryKey: ["nacha-files", queryFilters],
    queryFn: () => loadNachaFiles(queryFilters),
  });
  const merchantsQuery = useQuery({
    queryKey: ["admin-merchants"],
    queryFn: loadMerchants,
  });
  const updateFilters = (update: Partial<NachaFilesFilters>) =>
    setFilters((current) => ({
      ...current,
      ...update,
      page: update.page ?? 1,
    }));

  if (query.isLoading) return <NachaFilesSkeleton />;
  if (query.isError)
    return (
      <ErrorState
        title="NACHA files unavailable"
        description="Live file metadata could not be loaded."
        onRetry={() => void query.refetch()}
      />
    );
  if (!query.data) return <NachaFilesSkeleton />;
  const data = query.data;

  return (
    <div className="space-y-5">
      <PageHeader
        title="NACHA Files"
        description="Outbound ACH batches generated for the selected operations scope."
      />
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Summary
          label="Files generated today"
          value={String(data.summary.filesGeneratedToday)}
        />
        <Summary
          label="Payments exported"
          value={String(data.summary.paymentsExported)}
        />
        <Summary
          label="Total export amount"
          value={formatNachaCents(data.summary.totalExportAmountCents)}
        />
        <Summary
          label="Pending submission"
          value={String(data.summary.pendingSubmissionFiles)}
        />
      </section>
      <section className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950 lg:grid-cols-4">
        <label className="relative block lg:col-span-2">
          <span className="sr-only">Search NACHA files</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={filters.search}
            onChange={(event) => updateFilters({ search: event.target.value })}
            placeholder="Search file ID or file name"
            className="h-9 w-full rounded-md border border-slate-200 bg-slate-50 pl-9 pr-3 text-sm outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-200 dark:border-slate-800 dark:bg-slate-900"
          />
        </label>
        <label className="text-xs font-medium text-slate-500 dark:text-slate-400">
          Merchant
          <select
            aria-label="Merchant filter"
            value={filters.merchantId}
            onChange={(event) =>
              updateFilters({ merchantId: event.target.value })
            }
            className="mt-1 block h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-800 dark:bg-slate-900"
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
          Submission status
          <select
            aria-label="Submission status filter"
            value={filters.status}
            onChange={(event) =>
              updateFilters({
                status: event.target.value as NachaFilesFilters["status"],
              })
            }
            className="mt-1 block h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-800 dark:bg-slate-900"
          >
            <option value="">All statuses</option>
            <option value="SUBMITTED">Submitted</option>
            <option value="PENDING">Pending</option>
            <option value="FAILED">Failed</option>
          </select>
        </label>
        <label className="text-xs font-medium text-slate-500 dark:text-slate-400">
          Date range
          <select
            aria-label="NACHA date range filter"
            value={filters.dateRange}
            onChange={(event) =>
              updateFilters({
                dateRange: event.target.value as NachaFilesFilters["dateRange"],
              })
            }
            className="mt-1 block h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-800 dark:bg-slate-900"
          >
            <option value="all">All time</option>
            <option value="today">Today</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        {filters.dateRange === "custom" ? (
          <div className="flex gap-3 lg:col-span-2">
            <DateInput
              label="From"
              ariaLabel="NACHA custom start date"
              value={filters.startDate}
              onChange={(startDate) => updateFilters({ startDate })}
            />
            <DateInput
              label="To"
              ariaLabel="NACHA custom end date"
              value={filters.endDate}
              onChange={(endDate) => updateFilters({ endDate })}
            />
          </div>
        ) : null}
      </section>
      {data.data.length === 0 ? (
        <EmptyState
          title="No NACHA files found"
          description="Try adjusting the search or filters to find generated ACH batches."
        />
      ) : (
        <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1080px] text-left text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 dark:bg-slate-900/60 dark:text-slate-400">
                <tr>
                  <th className="px-4 py-3 font-medium">File ID</th>
                  <th className="px-4 py-3 font-medium">File name</th>
                  <th className="px-4 py-3 font-medium">Created</th>
                  <th className="px-4 py-3 text-right font-medium">
                    Total payments
                  </th>
                  <th className="px-4 py-3 text-right font-medium">
                    Total amount
                  </th>
                  <th className="px-4 py-3 text-right font-medium">
                    Debit count
                  </th>
                  <th className="px-4 py-3 text-right font-medium">
                    Credit count
                  </th>
                  <th className="px-4 py-3 font-medium">Submission status</th>
                  <th className="px-4 py-3 font-medium">Exported by</th>
                  <th className="px-4 py-3">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((file) => (
                  <tr
                    key={file.id}
                    tabIndex={0}
                    onClick={() => setSelected(file)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelected(file);
                      }
                    }}
                    className="cursor-pointer border-t border-slate-100 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-500 dark:border-slate-900 dark:hover:bg-slate-900/50"
                  >
                    <td className="px-4 py-3 font-mono text-xs">
                      {file.id.slice(0, 8)}…
                    </td>
                    <td className="px-4 py-3 font-medium">{file.fileName}</td>
                    <td className="px-4 py-3 text-slate-500">
                      {formatDate(file.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {file.totalPayments}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatNachaCents(file.totalAmountCents)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {file.debitCount}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {file.creditCount}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge tone={statusTone(file.submissionStatus)}>
                        {file.submissionStatus}
                      </StatusBadge>
                    </td>
                    <td className="px-4 py-3 text-slate-500">
                      {file.exportedBy}
                    </td>
                    <td className="px-4 py-3">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(event) => {
                          event.stopPropagation();
                          void downloadFile(file);
                        }}
                      >
                        <Download className="h-4 w-4" />
                        <span className="sr-only">
                          Download {file.fileName}
                        </span>
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <Pagination
        page={data.page}
        totalPages={data.totalPages}
        total={data.total}
        onPageChange={(page) => updateFilters({ page })}
      />
      <NachaFileDetails
        file={selected}
        onClose={() => setSelected(null)}
        copied={copied}
        onCopy={async (fileId) => {
          await navigator.clipboard.writeText(fileId);
          setCopied(fileId);
          window.setTimeout(() => setCopied(null), 1600);
        }}
      />
    </div>
  );
}

function Pagination({
  page,
  totalPages,
  total,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between gap-3 text-sm text-slate-500 dark:text-slate-400">
      <span>{total} files</span>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          Previous
        </Button>
        <span>
          Page {page} of {totalPages}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

function NachaFileDetails({
  file,
  onClose,
  copied,
  onCopy,
}: {
  file: NachaFile | null;
  onClose: () => void;
  copied: string | null;
  onCopy: (fileId: string) => Promise<void>;
}) {
  return (
    <Dialog
      open={Boolean(file)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>NACHA file</DialogTitle>
          <DialogDescription>{file?.fileName ?? ""}</DialogDescription>
        </DialogHeader>
        {file ? (
          <div className="space-y-5 text-sm">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void downloadFile(file)}
              >
                <Download className="h-4 w-4" />
                Download NACHA
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void onCopy(file.id)}
              >
                {copied === file.id ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
                {copied === file.id ? "Copied" : "Copy file ID"}
              </Button>
            </div>
            <Panel
              title="File metadata"
              values={[
                ["File ID", file.id],
                ["Effective entry date", formatDate(file.effectiveEntryDate)],
                ["Generated", formatDate(file.createdAt)],
                ["Submission", file.submissionStatus],
                ["Exported by", file.exportedBy],
                ["SHA-256", file.sha256],
              ]}
            />
            <Panel
              title="Batch summary"
              values={[
                ["Payments", String(file.totalPayments)],
                ["Debit payments", String(file.debitCount)],
                ["Credit payments", String(file.creditCount)],
                ["Total debit", formatNachaCents(file.debitTotalCents)],
                ["Total credit", formatNachaCents(file.creditTotalCents)],
                ["Entry hash", file.entryHash],
              ]}
            />
            <section>
              <h3 className="text-sm font-semibold">Payments</h3>
              <div className="mt-2 overflow-x-auto rounded-md border border-slate-200 dark:border-slate-800">
                <table className="min-w-[620px] w-full text-left text-xs">
                  <thead className="bg-slate-50 text-slate-500 dark:bg-slate-900">
                    <tr>
                      <th className="px-3 py-2">Payment</th>
                      <th className="px-3 py-2">Reference</th>
                      <th className="px-3 py-2">Direction</th>
                      <th className="px-3 py-2 text-right">Amount</th>
                      <th className="px-3 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {file.payments.map((payment) => (
                      <tr
                        key={payment.id}
                        className="border-t border-slate-100 dark:border-slate-900"
                      >
                        <td className="px-3 py-2 font-mono">
                          {payment.id.slice(0, 8)}…
                        </td>
                        <td className="px-3 py-2">
                          {payment.externalReference ?? "—"}
                        </td>
                        <td className="px-3 py-2">{payment.direction}</td>
                        <td className="px-3 py-2 text-right">
                          {formatNachaCents(
                            payment.amountCents,
                            payment.currency,
                          )}
                        </td>
                        <td className="px-3 py-2">{payment.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function Panel({
  title,
  values,
}: {
  title: string;
  values: Array<[string, string]>;
}) {
  return (
    <section>
      <h3 className="text-sm font-semibold">{title}</h3>
      <dl className="mt-2 grid gap-2 rounded-md border border-slate-200 p-3 dark:border-slate-800 sm:grid-cols-2">
        {values.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-slate-500">{label}</dt>
            <dd className="mt-0.5 break-all font-medium">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
function Summary({ label, value }: { label: string; value: string }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
        {label}
      </p>
      <p className="mt-2 text-xl font-semibold tracking-tight tabular-nums">
        {value}
      </p>
    </section>
  );
}
function DateInput({
  label,
  ariaLabel,
  value,
  onChange,
}: {
  label: string;
  ariaLabel: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex-1 text-xs font-medium text-slate-500 dark:text-slate-400">
      {label}
      <input
        aria-label={ariaLabel}
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 block h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-800 dark:bg-slate-900"
      />
    </label>
  );
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
async function downloadFile(file: NachaFile) {
  const response = await fetch(
    `/api/nacha-files/${encodeURIComponent(file.id)}/download`,
  );
  if (!response.ok) return;
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = file.fileName;
  link.click();
  URL.revokeObjectURL(url);
}
function NachaFilesSkeleton() {
  return (
    <div className="space-y-5">
      <PageHeader
        title="NACHA Files"
        description="Loading outbound ACH batches."
      />
      <LoadingState label="Loading NACHA files" />
    </div>
  );
}
