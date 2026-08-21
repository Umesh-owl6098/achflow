"use client";

import { FormEvent, KeyboardEvent, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmationDialog } from "@/components/foundation/confirmation-dialog";
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from "@/components/foundation/states";
import { PageHeader } from "@/components/foundation/page-header";
import { StatusBadge } from "@/components/foundation/status-badge";

type MerchantStatus = "ACTIVE" | "SUSPENDED" | "CLOSED";
type Merchant = {
  id: string;
  merchantCode: string;
  displayName: string;
  status: MerchantStatus;
  createdAt: string;
  paymentCount: number;
  totalProcessedVolumeCents: string;
  webhookEndpointCount: number;
  postedBalanceCents: string;
  reservedBalanceCents: string;
  availableBalanceCents: string;
};
type MerchantDetail = Merchant & {
  legalName: string;
  updatedAt: string;
  apiKey: { id: string; createdAt: string } | null;
  funding: {
    accountCount: number;
    postedBalanceCents: string;
    reservedBalanceCents: string;
    availableBalanceCents: string;
  };
  totalProcessedVolumeCents: string;
  paymentStatusBreakdown: Record<string, number>;
  recentPayments: Array<{
    id: string;
    status: string;
    direction: string;
    amountCents: string;
    currency: string;
    createdAt: string;
  }>;
  webhookEndpoints: Array<{
    id: string;
    url: string;
    isActive: boolean;
    createdAt: string;
  }>;
};
type MerchantListResponse = { data: Merchant[] };
type CreatedMerchant = { merchant: Merchant; apiKey: string };
type SortKey = "createdAt" | "totalProcessedVolumeCents" | "paymentCount";

const PAGE_SIZE = 25;

function formatMoney(value: string): string {
  const cents = BigInt(value);
  const absolute = cents < 0n ? -cents : cents;
  return `${cents < 0n ? "-" : ""}$${(absolute / 100n).toString()}.${(
    absolute % 100n
  )
    .toString()
    .padStart(2, "0")}`;
}

function statusTone(status: MerchantStatus): "success" | "pending" | "failure" {
  return status === "ACTIVE"
    ? "success"
    : status === "SUSPENDED"
      ? "pending"
      : "failure";
}

async function adminApi<T>(path: string, init?: RequestInit): Promise<T> {
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
    const message =
      typeof body === "object" && body !== null && "message" in body
        ? String(body.message)
        : "Merchant request failed.";
    throw new Error(message);
  }
  return body as T;
}

export function MerchantsManager() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<MerchantStatus | "all">("all");
  const [sort, setSort] = useState<SortKey>("createdAt");
  const [descending, setDescending] = useState(true);
  const [page, setPage] = useState(1);
  const [selectedMerchantId, setSelectedMerchantId] = useState<string | null>(
    null,
  );
  const [createOpen, setCreateOpen] = useState(false);
  const queryClient = useQueryClient();
  const merchantsQuery = useQuery({
    queryKey: ["admin-merchants"],
    queryFn: () => adminApi<MerchantListResponse>("/api/admin/merchants"),
  });
  const allMerchants = merchantsQuery.data?.data ?? [];
  const merchants = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = allMerchants.filter(
      (merchant) =>
        (status === "all" || merchant.status === status) &&
        (!needle ||
          `${merchant.displayName} ${merchant.merchantCode} ${merchant.id}`
            .toLowerCase()
            .includes(needle)),
    );
    return [...filtered].sort((left, right) => {
      const comparison =
        sort === "createdAt"
          ? new Date(left.createdAt).getTime() -
            new Date(right.createdAt).getTime()
          : sort === "paymentCount"
            ? left.paymentCount - right.paymentCount
            : BigInt(left.totalProcessedVolumeCents) >
                BigInt(right.totalProcessedVolumeCents)
              ? 1
              : BigInt(left.totalProcessedVolumeCents) <
                  BigInt(right.totalProcessedVolumeCents)
                ? -1
                : 0;
      return descending ? -comparison : comparison;
    });
  }, [allMerchants, descending, search, sort, status]);
  const totalPages = Math.max(1, Math.ceil(merchants.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageMerchants = merchants.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ["admin-merchants"] });

  if (merchantsQuery.isLoading)
    return <LoadingState label="Loading merchants" />;
  if (merchantsQuery.isError)
    return (
      <ErrorState
        title="Merchants unavailable"
        description="Control-plane merchant data could not be loaded."
        onRetry={() => void merchantsQuery.refetch()}
      />
    );

  const totalVolume = allMerchants
    .reduce(
      (sum, merchant) => sum + BigInt(merchant.totalProcessedVolumeCents),
      0n,
    )
    .toString();
  const resetPage = () => setPage(1);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Merchants"
        description="Control-plane merchant configuration, payment volume, funding, and API access."
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Create merchant
          </Button>
        }
      />

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          label="Total merchants"
          value={String(allMerchants.length)}
        />
        <SummaryCard
          label="Active merchants"
          value={String(
            allMerchants.filter((merchant) => merchant.status === "ACTIVE")
              .length,
          )}
        />
        <SummaryCard
          label="Suspended merchants"
          value={String(
            allMerchants.filter((merchant) => merchant.status === "SUSPENDED")
              .length,
          )}
        />
        <SummaryCard
          label="Total processed volume"
          value={formatMoney(totalVolume)}
        />
      </section>

      <section className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950 md:flex-row">
        <label className="relative flex-1">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <input
            aria-label="Search merchants"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              resetPage();
            }}
            placeholder="Search merchant name or ID"
            className="h-9 w-full rounded-md border border-slate-200 bg-slate-50 pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-slate-400 dark:border-slate-700 dark:bg-slate-900"
          />
        </label>
        <select
          aria-label="Merchant status"
          value={status}
          onChange={(event) => {
            setStatus(event.target.value as MerchantStatus | "all");
            resetPage();
          }}
          className="h-9 rounded-md border border-slate-200 px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
        >
          <option value="all">All statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="SUSPENDED">Suspended</option>
          <option value="CLOSED">Disabled</option>
        </select>
        <select
          aria-label="Merchant sort"
          value={sort}
          onChange={(event) => setSort(event.target.value as SortKey)}
          className="h-9 rounded-md border border-slate-200 px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
        >
          <option value="createdAt">Created date</option>
          <option value="totalProcessedVolumeCents">Processed volume</option>
          <option value="paymentCount">Payment count</option>
        </select>
        <Button
          variant="outline"
          aria-label="Toggle sort order"
          onClick={() => setDescending((current) => !current)}
        >
          {descending ? "Descending" : "Ascending"}
        </Button>
      </section>

      {merchants.length === 0 ? (
        <EmptyState
          title="No merchants found"
          description="Try another search term or change the status filter."
        />
      ) : (
        <section className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
          <table className="w-full min-w-[1220px] text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-900">
              <tr>
                <th className="p-3 font-medium">Merchant name</th>
                <th className="p-3 font-medium">Merchant ID</th>
                <th className="p-3 font-medium">Status</th>
                <th className="p-3 font-medium">Available balance</th>
                <th className="p-3 font-medium">Reserved balance</th>
                <th className="p-3 font-medium">Payment count</th>
                <th className="p-3 font-medium">Processed volume</th>
                <th className="p-3 font-medium">Webhooks</th>
                <th className="p-3 font-medium">Created at</th>
              </tr>
            </thead>
            <tbody>
              {pageMerchants.map((merchant) => (
                <MerchantRow
                  key={merchant.id}
                  merchant={merchant}
                  onOpen={() => setSelectedMerchantId(merchant.id)}
                />
              ))}
            </tbody>
          </table>
        </section>
      )}

      <footer className="flex items-center justify-between text-sm text-slate-500">
        <span>
          {merchants.length} merchant{merchants.length === 1 ? "" : "s"} · page{" "}
          {currentPage} of {totalPages}
        </span>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={currentPage === 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            Previous
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={currentPage === totalPages}
            onClick={() =>
              setPage((current) => Math.min(totalPages, current + 1))
            }
          >
            Next
          </Button>
        </div>
      </footer>

      <CreateMerchantDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={refresh}
      />
      <MerchantDrawer
        merchantId={selectedMerchantId}
        onClose={() => setSelectedMerchantId(null)}
        onChanged={() => {
          refresh();
          void queryClient.invalidateQueries({
            queryKey: ["admin-merchant", selectedMerchantId],
          });
        }}
      />
    </div>
  );
}

function MerchantRow({
  merchant,
  onOpen,
}: {
  merchant: Merchant;
  onOpen: () => void;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLTableRowElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen();
    }
  };
  return (
    <tr
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={onKeyDown}
      className="cursor-pointer border-t border-slate-100 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-500 dark:border-slate-800 dark:hover:bg-slate-900"
    >
      <td className="p-3 font-medium">{merchant.displayName}</td>
      <td className="p-3 font-mono text-xs text-slate-500">{merchant.id}</td>
      <td className="p-3">
        <StatusBadge tone={statusTone(merchant.status)}>
          {merchant.status}
        </StatusBadge>
      </td>
      <td className="p-3">{formatMoney(merchant.availableBalanceCents)}</td>
      <td className="p-3">{formatMoney(merchant.reservedBalanceCents)}</td>
      <td className="p-3">{merchant.paymentCount}</td>
      <td className="p-3">{formatMoney(merchant.totalProcessedVolumeCents)}</td>
      <td className="p-3">{merchant.webhookEndpointCount}</td>
      <td className="p-3">
        {new Date(merchant.createdAt).toLocaleDateString()}
      </td>
    </tr>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
    </div>
  );
}

function SecretReveal({
  apiKey,
  onDismiss,
}: {
  apiKey: string;
  onDismiss: () => void;
}) {
  return (
    <section className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
      <p className="font-semibold">Copy the merchant API key now</p>
      <p className="mt-1 text-xs">
        This key cannot be retrieved again after you close this dialog.
      </p>
      <code className="mt-3 block break-all rounded border border-amber-200 bg-white p-2 text-xs dark:border-amber-900 dark:bg-slate-950">
        {apiKey}
      </code>
      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          onClick={() => void navigator.clipboard.writeText(apiKey)}
        >
          <Copy className="mr-1 h-3.5 w-3.5" /> Copy key
        </Button>
        <Button size="sm" variant="outline" onClick={onDismiss}>
          I have saved it
        </Button>
      </div>
    </section>
  );
}

function CreateMerchantDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const close = () => {
    setApiKey(null);
    setError(null);
    onClose();
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    const form = new FormData(event.currentTarget);
    try {
      const result = await adminApi<CreatedMerchant>("/api/admin/merchants", {
        method: "POST",
        body: JSON.stringify({
          merchantCode: String(form.get("merchantCode") ?? ""),
          legalName: String(form.get("legalName") ?? ""),
          displayName: String(form.get("displayName") ?? ""),
          ...(String(form.get("perPaymentLimit") ?? "").trim()
            ? { perPaymentLimit: String(form.get("perPaymentLimit")) }
            : {}),
          ...(String(form.get("dailyAmountLimit") ?? "").trim()
            ? { dailyAmountLimit: String(form.get("dailyAmountLimit")) }
            : {}),
          status: String(form.get("status") ?? "ACTIVE"),
          allowAchDebit: form.get("allowAchDebit") === "on",
          allowAchCredit: form.get("allowAchCredit") === "on",
        }),
      });
      setApiKey(result.apiKey);
      onCreated();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Unable to create merchant.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(value) => !value && close()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create merchant</DialogTitle>
        </DialogHeader>
        {apiKey ? (
          <SecretReveal apiKey={apiKey} onDismiss={close} />
        ) : (
          <form className="space-y-3" onSubmit={submit}>
            <Field
              name="displayName"
              label="Merchant name"
              placeholder="Northstar Paper"
            />
            <Field
              name="legalName"
              label="Legal name"
              placeholder="Northstar Paper LLC"
            />
            <Field
              name="merchantCode"
              label="Merchant code"
              placeholder="NORTHSTAR"
            />
            <div className="grid grid-cols-2 gap-3">
              <Field
                name="perPaymentLimit"
                label="Per-payment limit (cents)"
                placeholder="10000"
                inputMode="numeric"
                required={false}
              />
              <Field
                name="dailyAmountLimit"
                label="Daily limit (cents)"
                placeholder="100000"
                inputMode="numeric"
                required={false}
              />
            </div>
            <label className="grid gap-1 text-sm">
              <span>Initial status</span>
              <select
                name="status"
                defaultValue="ACTIVE"
                className="h-9 rounded-md border border-slate-200 bg-white px-2 dark:border-slate-700 dark:bg-slate-900"
              >
                <option value="ACTIVE">Active</option>
                <option value="SUSPENDED">Suspended</option>
                <option value="CLOSED">Disabled</option>
              </select>
            </label>
            <fieldset className="flex gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input name="allowAchDebit" type="checkbox" defaultChecked />{" "}
                ACH debit
              </label>
              <label className="flex items-center gap-2">
                <input name="allowAchCredit" type="checkbox" defaultChecked />{" "}
                ACH credit
              </label>
            </fieldset>
            <p className="text-xs text-slate-500">
              Funding accounts are configured separately after merchant
              creation.
            </p>
            {error ? (
              <p role="alert" className="text-sm text-red-600">
                {error}
              </p>
            ) : null}
            <Button disabled={isSubmitting}>
              {isSubmitting ? "Creating…" : "Create and reveal API key"}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Field({
  name,
  label,
  placeholder,
  inputMode,
  required = true,
}: {
  name: string;
  label: string;
  placeholder: string;
  inputMode?: "numeric";
  required?: boolean;
}) {
  return (
    <label className="grid gap-1 text-sm">
      <span>{label}</span>
      <input
        required={required}
        name={name}
        placeholder={placeholder}
        inputMode={inputMode}
        className="h-9 rounded-md border border-slate-200 bg-white px-2 dark:border-slate-700 dark:bg-slate-900"
      />
    </label>
  );
}

function MerchantDrawer({
  merchantId,
  onClose,
  onChanged,
}: {
  merchantId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [newKey, setNewKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const detailsQuery = useQuery({
    queryKey: ["admin-merchant", merchantId],
    enabled: Boolean(merchantId),
    queryFn: () =>
      adminApi<MerchantDetail>(`/api/admin/merchants/${merchantId}`),
  });
  const close = () => {
    setNewKey(null);
    setActionError(null);
    onClose();
  };
  const updateStatus = async (nextStatus: MerchantStatus) => {
    if (!merchantId) return;
    setActionError(null);
    try {
      await adminApi(`/api/admin/merchants/${merchantId}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus }),
      });
      onChanged();
    } catch (reason) {
      setActionError(
        reason instanceof Error
          ? reason.message
          : "Unable to update merchant status.",
      );
    }
  };
  const rotateKey = async () => {
    if (!merchantId) return;
    setActionError(null);
    try {
      const result = await adminApi<{ apiKey: string }>(
        `/api/admin/merchants/${merchantId}/api-key/rotate`,
        { method: "POST" },
      );
      setNewKey(result.apiKey);
      onChanged();
    } catch (reason) {
      setActionError(
        reason instanceof Error
          ? reason.message
          : "Unable to rotate the API key.",
      );
    }
  };
  const detail = detailsQuery.data;
  return (
    <Dialog
      open={Boolean(merchantId)}
      onOpenChange={(value) => !value && close()}
    >
      <DialogContent className="max-h-[100dvh] max-w-2xl overflow-y-auto sm:left-auto sm:right-0 sm:top-0 sm:h-screen sm:w-[min(42rem,100%-1rem)] sm:max-w-none sm:translate-x-0 sm:translate-y-0 sm:rounded-none">
        <DialogHeader>
          <DialogTitle>Merchant details</DialogTitle>
        </DialogHeader>
        {detailsQuery.isLoading ? (
          <LoadingState label="Loading merchant details" />
        ) : null}
        {detailsQuery.isError ? (
          <ErrorState
            title="Merchant unavailable"
            description="Merchant details could not be loaded."
            onRetry={() => void detailsQuery.refetch()}
          />
        ) : null}
        {detail ? (
          <div className="space-y-5 text-sm">
            <section className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold">{detail.displayName}</h3>
                <p className="mt-1 text-slate-500">
                  {detail.legalName} · {detail.merchantCode}
                </p>
                <p className="mt-1 font-mono text-xs text-slate-500">
                  {detail.id}
                </p>
              </div>
              <StatusBadge tone={statusTone(detail.status)}>
                {detail.status}
              </StatusBadge>
            </section>
            <section className="grid grid-cols-2 gap-3">
              <Metric
                label="Available balance"
                value={formatMoney(detail.funding.availableBalanceCents)}
              />
              <Metric
                label="Reserved balance"
                value={formatMoney(detail.funding.reservedBalanceCents)}
              />
              <Metric
                label="Processed volume"
                value={formatMoney(detail.totalProcessedVolumeCents)}
              />
              <Metric
                label="Funding accounts"
                value={String(detail.funding.accountCount)}
              />
            </section>
            <section className="space-y-1">
              <p className="font-medium">API key metadata</p>
              <p className="text-slate-500">
                {detail.apiKey
                  ? `Key created ${new Date(detail.apiKey.createdAt).toLocaleString()}`
                  : "No API key has been issued."}{" "}
                Existing raw keys are never displayed.
              </p>
            </section>
            {newKey ? (
              <SecretReveal apiKey={newKey} onDismiss={() => setNewKey(null)} />
            ) : null}
            <section className="flex flex-wrap gap-2">
              <ConfirmationDialog
                trigger={<Button variant="outline">Activate</Button>}
                title="Activate merchant"
                description="Confirm merchant activation."
                confirmLabel="Activate"
                onConfirm={() => void updateStatus("ACTIVE")}
              />
              <ConfirmationDialog
                trigger={<Button variant="outline">Suspend</Button>}
                title="Suspend merchant"
                description="Suspended merchants cannot initiate payment operations."
                confirmLabel="Suspend"
                onConfirm={() => void updateStatus("SUSPENDED")}
              />
              <ConfirmationDialog
                trigger={<Button variant="destructive">Disable</Button>}
                title="Disable merchant"
                description="Disabled merchants cannot initiate payment operations."
                confirmLabel="Disable"
                onConfirm={() => void updateStatus("CLOSED")}
              />
              <ConfirmationDialog
                trigger={
                  <Button variant="outline">
                    <KeyRound className="mr-1 h-4 w-4" />
                    Rotate API key
                  </Button>
                }
                title="Rotate API key"
                description="The prior merchant key will stop working immediately."
                confirmLabel="Rotate"
                onConfirm={() => void rotateKey()}
              />
            </section>
            {actionError ? (
              <p role="alert" className="text-sm text-red-600">
                {actionError}
              </p>
            ) : null}
            <section>
              <p className="font-medium">Payment status breakdown</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {Object.entries(detail.paymentStatusBreakdown).length ? (
                  Object.entries(detail.paymentStatusBreakdown).map(
                    ([status, count]) => (
                      <span
                        key={status}
                        className="rounded border px-2 py-1 text-xs"
                      >
                        {status}: {count}
                      </span>
                    ),
                  )
                ) : (
                  <span className="text-slate-500">No payments</span>
                )}
              </div>
            </section>
            <section>
              <p className="font-medium">Recent payments</p>
              {detail.recentPayments.length ? (
                <div className="mt-2 space-y-2">
                  {detail.recentPayments.map((payment) => (
                    <div
                      key={payment.id}
                      className="rounded border border-slate-200 p-2 dark:border-slate-800"
                    >
                      <p className="font-mono text-xs">{payment.id}</p>
                      <p className="text-slate-500">
                        {payment.direction} · {formatMoney(payment.amountCents)}{" "}
                        {payment.currency} · {payment.status}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-1 text-slate-500">No recent payments.</p>
              )}
            </section>
            <section>
              <p className="font-medium">Webhook endpoints</p>
              {detail.webhookEndpoints.length ? (
                <div className="mt-2 space-y-2">
                  {detail.webhookEndpoints.map((endpoint) => (
                    <div
                      key={endpoint.id}
                      className="flex items-center justify-between rounded border border-slate-200 p-2 dark:border-slate-800"
                    >
                      <span className="truncate pr-2">{endpoint.url}</span>
                      <StatusBadge
                        tone={endpoint.isActive ? "success" : "neutral"}
                      >
                        {endpoint.isActive ? "ACTIVE" : "DISABLED"}
                      </StatusBadge>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-1 text-slate-500">No webhook endpoints.</p>
              )}
            </section>
            <p className="text-xs text-slate-500">
              Created {new Date(detail.createdAt).toLocaleString()} · Updated{" "}
              {new Date(detail.updatedAt).toLocaleString()}
            </p>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 font-medium">{value}</p>
    </div>
  );
}
