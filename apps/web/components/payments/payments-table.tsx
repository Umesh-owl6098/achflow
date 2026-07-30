"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Search,
} from "lucide-react";
import {
  ErrorState,
  EmptyState,
  LoadingState,
} from "@/components/foundation/states";
import { StatusBadge } from "@/components/foundation/status-badge";
import { Button } from "@/components/ui/button";
import { formatUsd, statusTone } from "@/lib/dashboard";
import {
  paymentListSearchParams,
  paymentStatuses,
  parsePaymentListResponse,
  type PaymentListFilters,
  type PaymentListResponse,
} from "@/lib/payments";

const initialFilters: PaymentListFilters = {
  search: "",
  status: "",
  direction: "",
  dateRange: "30d",
  startDate: "",
  endDate: "",
  sortBy: "createdAt",
  sortOrder: "desc",
  page: 1,
};

async function loadPayments(
  filters: PaymentListFilters,
): Promise<PaymentListResponse> {
  const response = await fetch(
    `/api/payments?${paymentListSearchParams(filters)}`,
    {
      headers: { Accept: "application/json" },
    },
  );
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error("Payment data is unavailable.");
  return parsePaymentListResponse(body);
}

function useDebouncedValue(value: string, delay = 300): string {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedValue(value), delay);
    return () => window.clearTimeout(timer);
  }, [delay, value]);
  return debouncedValue;
}

export function PaymentsTable() {
  const router = useRouter();
  const [filters, setFilters] = useState(initialFilters);
  const debouncedSearch = useDebouncedValue(filters.search);
  const queryFilters = {
    ...filters,
    search: debouncedSearch,
    ...(filters.dateRange === "custom" &&
    (!filters.startDate || !filters.endDate)
      ? { dateRange: "30d" as const }
      : {}),
  };
  const query = useQuery({
    queryKey: ["payments", queryFilters],
    queryFn: () => loadPayments(queryFilters),
  });

  function updateFilters(update: Partial<PaymentListFilters>) {
    setFilters((current) => ({
      ...current,
      ...update,
      page: update.page ?? 1,
    }));
  }

  function toggleSort(sortBy: PaymentListFilters["sortBy"]) {
    setFilters((current) => ({
      ...current,
      sortBy,
      sortOrder:
        current.sortBy === sortBy && current.sortOrder === "desc"
          ? "asc"
          : "desc",
      page: 1,
    }));
  }

  if (query.isLoading) return <PaymentsSkeleton />;
  if (query.isError)
    return (
      <ErrorState
        title="Payments unavailable"
        description="Live payment data could not be loaded."
        onRetry={() => void query.refetch()}
      />
    );
  const data = query.data;
  if (!data) return <PaymentsSkeleton />;

  return (
    <div className="space-y-5">
      <section className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950 lg:grid-cols-[minmax(0,1fr)_10rem_10rem_9rem]">
        <label className="relative block lg:col-span-1">
          <span className="sr-only">Search payments</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={filters.search}
            onChange={(event) => updateFilters({ search: event.target.value })}
            placeholder="Search payment, reference, merchant"
            className="h-9 w-full rounded-md border border-slate-200 bg-slate-50 pl-9 pr-3 text-sm outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-200 dark:border-slate-800 dark:bg-slate-900 dark:focus:border-slate-600 dark:focus:ring-slate-800"
          />
        </label>
        <label className="text-xs font-medium text-slate-500 dark:text-slate-400">
          Status
          <select
            aria-label="Status filter"
            value={filters.status}
            onChange={(event) =>
              updateFilters({
                status: event.target.value as PaymentListFilters["status"],
              })
            }
            className="mt-1 block h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-900 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100"
          >
            <option value="">All statuses</option>
            {paymentStatuses.map((status) => (
              <option key={status} value={status}>
                {status.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-slate-500 dark:text-slate-400">
          Direction
          <select
            aria-label="Direction filter"
            value={filters.direction}
            onChange={(event) =>
              updateFilters({
                direction: event.target
                  .value as PaymentListFilters["direction"],
              })
            }
            className="mt-1 block h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-900 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100"
          >
            <option value="">All directions</option>
            <option value="DEBIT">Debit</option>
            <option value="CREDIT">Credit</option>
          </select>
        </label>
        <label className="text-xs font-medium text-slate-500 dark:text-slate-400">
          Date
          <select
            aria-label="Date range filter"
            value={filters.dateRange}
            onChange={(event) =>
              updateFilters({
                dateRange: event.target
                  .value as PaymentListFilters["dateRange"],
              })
            }
            className="mt-1 block h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-900 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100"
          >
            <option value="today">Today</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        {filters.dateRange === "custom" ? (
          <div className="flex gap-3 lg:col-span-4">
            <label className="flex-1 text-xs font-medium text-slate-500 dark:text-slate-400">
              From
              <input
                aria-label="Custom start date"
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
                aria-label="Custom end date"
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
          title="No payments found"
          description="Try adjusting the search or filters to find matching payment activity."
        />
      ) : (
        <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[940px] text-left text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 dark:bg-slate-900/60 dark:text-slate-400">
                <tr>
                  <th className="px-4 py-3 font-medium">Payment</th>
                  <th className="px-4 py-3 font-medium">Merchant</th>
                  <th className="px-4 py-3 font-medium">External reference</th>
                  <th className="px-4 py-3 font-medium">Direction</th>
                  <SortableHeader
                    label="Amount"
                    active={filters.sortBy === "amountCents"}
                    direction={filters.sortOrder}
                    onClick={() => toggleSort("amountCents")}
                  />
                  <SortableHeader
                    label="Status"
                    active={filters.sortBy === "status"}
                    direction={filters.sortOrder}
                    onClick={() => toggleSort("status")}
                  />
                  <SortableHeader
                    label="Created"
                    active={filters.sortBy === "createdAt"}
                    direction={filters.sortOrder}
                    onClick={() => toggleSort("createdAt")}
                  />
                  <th className="px-4 py-3 font-medium">Last updated</th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((payment) => (
                  <tr
                    key={payment.id}
                    tabIndex={0}
                    onClick={() => router.push(`/payments/${payment.id}`)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        router.push(`/payments/${payment.id}`);
                      }
                    }}
                    className="cursor-pointer border-t border-slate-100 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-500 dark:border-slate-900 dark:hover:bg-slate-900/50"
                  >
                    <td className="px-4 py-3 font-mono text-xs">
                      <Link
                        className="text-slate-900 underline-offset-4 hover:underline dark:text-slate-100"
                        href={`/payments/${payment.id}`}
                      >
                        {payment.id.slice(0, 8)}…
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      {payment.merchant.displayName}
                    </td>
                    <td className="px-4 py-3 text-slate-500 dark:text-slate-400">
                      {payment.externalReference ?? "—"}
                    </td>
                    <td className="px-4 py-3">{payment.direction}</td>
                    <td className="px-4 py-3 font-medium">
                      {formatUsd(payment.amountCents)}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge tone={statusTone(payment.status)}>
                        {payment.status.replaceAll("_", " ")}
                      </StatusBadge>
                    </td>
                    <td className="px-4 py-3 text-slate-500 dark:text-slate-400">
                      {formatDate(payment.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-slate-500 dark:text-slate-400">
                      {formatDate(payment.updatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination data={data} onPage={(page) => updateFilters({ page })} />
        </section>
      )}
      {query.isFetching ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Updating payments…
        </p>
      ) : null}
    </div>
  );
}

function SortableHeader({
  label,
  active,
  direction,
  onClick,
}: {
  label: string;
  active: boolean;
  direction: "asc" | "desc";
  onClick: () => void;
}) {
  const Icon = direction === "asc" ? ArrowUp : ArrowDown;
  return (
    <th className="px-4 py-3 font-medium">
      <button
        onClick={onClick}
        className="inline-flex items-center gap-1 outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
      >
        {label}
        {active ? (
          <Icon
            className="h-3.5 w-3.5"
            aria-label={`${label} sorted ${direction === "asc" ? "ascending" : "descending"}`}
          />
        ) : null}
      </button>
    </th>
  );
}

function Pagination({
  data,
  onPage,
}: {
  data: PaymentListResponse;
  onPage: (page: number) => void;
}) {
  const previousDisabled = data.page <= 1;
  const nextDisabled = data.page >= data.totalPages;
  return (
    <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-sm dark:border-slate-800">
      <p className="text-slate-500 dark:text-slate-400">
        {data.total} payment{data.total === 1 ? "" : "s"} · Page {data.page} of{" "}
        {Math.max(data.totalPages, 1)}
      </p>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          aria-label="Previous page"
          disabled={previousDisabled}
          onClick={() => onPage(data.page - 1)}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-label="Next page"
          disabled={nextDisabled}
          onClick={() => onPage(data.page + 1)}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function PaymentsSkeleton() {
  return (
    <div className="space-y-5" aria-label="Loading payments">
      <LoadingState label="Loading payment operations" />
      <div className="h-72 animate-pulse rounded-lg border border-slate-200 bg-slate-100 dark:border-slate-800 dark:bg-slate-900" />
    </div>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
