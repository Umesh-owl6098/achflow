"use client";

import Link from "next/link";
import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import {
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ErrorState,
  EmptyState,
  LoadingState,
} from "@/components/foundation/states";
import { StatusBadge } from "@/components/foundation/status-badge";
import { Button } from "@/components/ui/button";
import {
  DashboardData,
  formatUsd,
  parseDashboardData,
  statusTone,
} from "@/lib/dashboard";

async function loadDashboard(merchantId: string): Promise<DashboardData> {
  const query = merchantId
    ? `?merchantId=${encodeURIComponent(merchantId)}`
    : "";
  const response = await fetch(`/api/dashboard${query}`, {
    headers: { Accept: "application/json" },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error("Dashboard data is unavailable.");
  return parseDashboardData(body);
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

const summaryCards = [
  [
    "Payments today",
    (data: DashboardData) => String(data.summary.paymentsToday),
  ],
  [
    "Total amount today",
    (data: DashboardData) => formatUsd(data.summary.totalAmountCents),
  ],
  [
    "ACH debits today",
    (data: DashboardData) => formatUsd(data.summary.debitAmountCents),
  ],
  [
    "ACH credits today",
    (data: DashboardData) => formatUsd(data.summary.creditAmountCents),
  ],
  [
    "Submitted",
    (data: DashboardData) => String(data.summary.submittedPayments),
  ],
  ["Settled", (data: DashboardData) => String(data.summary.settledPayments)],
  ["Returned", (data: DashboardData) => String(data.summary.returnedPayments)],
] as const;

export function Dashboard() {
  const [merchantId, setMerchantId] = useState("");
  const query = useQuery({
    queryKey: ["dashboard", merchantId],
    queryFn: () => loadDashboard(merchantId),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
  const merchantsQuery = useQuery({
    queryKey: ["admin-merchants"],
    queryFn: loadMerchants,
  });
  if (query.isLoading) return <DashboardSkeleton />;
  if (query.isError)
    return (
      <ErrorState
        title="Dashboard unavailable"
        description="Live payment operations data could not be loaded."
        onRetry={() => void query.refetch()}
      />
    );
  const data = query.data;
  if (!data) return <DashboardSkeleton />;
  if (data.recentPayments.length === 0)
    return (
      <EmptyState
        title="No payments yet"
        description="Create a payment through the API to populate the live operations dashboard."
      />
    );

  const chartData = data.dailyVolume.map((day) => ({
    date: new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      timeZone: "UTC",
    }).format(new Date(`${day.date}T00:00:00Z`)),
    debit: Number(BigInt(day.debitAmountCents)) / 100,
    credit: Number(BigInt(day.creditAmountCents)) / 100,
  }));

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Live payment operations</h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Merchant activity and ACH lifecycle visibility.
          </p>
        </div>
        <label className="text-xs font-medium text-slate-500 dark:text-slate-400">
          Merchant scope
          <select
            aria-label="Merchant scope"
            value={merchantId}
            onChange={(event) => setMerchantId(event.target.value)}
            className="mt-1 block h-9 min-w-48 rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-900 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100"
          >
            <option value="">All merchants</option>
            {(merchantsQuery.data ?? []).map((merchant) => (
              <option key={merchant.id} value={merchant.id}>
                {merchant.displayName} ({merchant.merchantCode})
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
          <span>
            Updated{" "}
            {new Intl.DateTimeFormat("en-US", {
              hour: "numeric",
              minute: "2-digit",
            }).format(new Date(data.generatedAt))}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCw className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
            Refresh
          </Button>
        </div>
      </div>
      <section
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
        aria-label="Payment summary"
      >
        {summaryCards.map(([label, value]) => (
          <div
            key={label}
            className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950"
          >
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
              {label}
            </p>
            <p className="mt-2 text-xl font-semibold tracking-tight">
              {value(data)}
            </p>
          </div>
        ))}
      </section>
      <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950">
          <h3 className="text-sm font-semibold">Payment volume</h3>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Last seven UTC business days
          </p>
          <div
            className="mt-5 h-64"
            role="img"
            aria-label="Daily ACH debit and credit payment volume"
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={chartData}
                margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
              >
                <XAxis
                  dataKey="date"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 12 }}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 12 }}
                  tickFormatter={(value: number) => `$${value}`}
                />
                <Tooltip
                  formatter={(value: number) =>
                    `$${value.toLocaleString("en-US", { minimumFractionDigits: 2 })}`
                  }
                />
                <Bar
                  dataKey="debit"
                  name="Debit"
                  fill="#64748b"
                  radius={[3, 3, 0, 0]}
                />
                <Bar
                  dataKey="credit"
                  name="Credit"
                  fill="#0f766e"
                  radius={[3, 3, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950">
          <h3 className="text-sm font-semibold">Status distribution</h3>
          <div className="mt-4 space-y-3">
            {data.statusDistribution.map((item) => (
              <div
                className="flex items-center justify-between gap-3"
                key={item.status}
              >
                <StatusBadge tone={statusTone(item.status)}>
                  {item.status.replaceAll("_", " ")}
                </StatusBadge>
                <span className="text-sm font-medium tabular-nums">
                  {item.count}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950">
        <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <h3 className="text-sm font-semibold">Recent payments</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500 dark:bg-slate-900/60 dark:text-slate-400">
              <tr>
                {[
                  "Payment",
                  "Merchant",
                  "Reference",
                  "Direction",
                  "Amount",
                  "Status",
                  "Created",
                ].map((header) => (
                  <th className="px-4 py-3 font-medium" key={header}>
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.recentPayments.map((payment) => (
                <tr
                  className="border-t border-slate-100 dark:border-slate-900"
                  key={payment.id}
                >
                  <td className="px-4 py-3 font-mono text-xs">
                    <Link
                      className="text-slate-900 underline-offset-4 hover:underline dark:text-slate-100"
                      href={`/payments/${payment.id}`}
                    >
                      {payment.id.slice(0, 8)}…
                    </Link>
                  </td>
                  <td className="px-4 py-3">{payment.merchant.displayName}</td>
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
                    {new Intl.DateTimeFormat("en-US", {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    }).format(new Date(payment.createdAt))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6" aria-label="Loading dashboard">
      <div className="h-14 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-900" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 7 }, (_, index) => (
          <div
            className="h-24 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-900"
            key={index}
          />
        ))}
      </div>
      <LoadingState label="Loading live payment operations" />
    </div>
  );
}
