"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import {
  ErrorState,
  LoadingState,
  EmptyState,
} from "@/components/foundation/states";
import { PageHeader } from "@/components/foundation/page-header";
import { StatusBadge } from "@/components/foundation/status-badge";
import { Button } from "@/components/ui/button";
import { formatUsd, statusTone } from "@/lib/dashboard";
import {
  parsePaymentDetails,
  timelineSteps,
  type PaymentDetails,
} from "@/lib/payment-details";

async function loadPayment(id: string): Promise<PaymentDetails> {
  const response = await fetch(`/api/payments/${id}`, {
    headers: { Accept: "application/json" },
  });
  const body: unknown = await response.json().catch(() => null);
  if (response.status === 404) throw new Error("NOT_FOUND");
  if (!response.ok) throw new Error("UNAVAILABLE");
  return parsePaymentDetails(body);
}
export function PaymentDetailsView({ paymentId }: { paymentId: string }) {
  const query = useQuery({
    queryKey: ["payment", paymentId],
    queryFn: () => loadPayment(paymentId),
  });
  if (query.isLoading) return <LoadingState label="Loading payment details" />;
  if (query.error instanceof Error && query.error.message === "NOT_FOUND")
    return (
      <EmptyState
        title="Payment not found"
        description="This payment is unavailable or you do not have access to it."
      />
    );
  if (query.isError || !query.data)
    return (
      <ErrorState
        title="Payment unavailable"
        description="Payment details could not be loaded."
        onRetry={() => void query.refetch()}
      />
    );
  const payment = query.data;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Payment details"
        description={payment.id}
        actions={
          <StatusBadge tone={statusTone(payment.status)}>
            {payment.status.replaceAll("_", " ")}
          </StatusBadge>
        }
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          <section className="grid gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 text-sm sm:grid-cols-2 dark:border-slate-800 dark:bg-slate-800">
            <Details label="Payment ID" value={payment.id} />
            <Details
              label="External reference"
              value={payment.externalReference ?? "—"}
            />
            <Details label="Merchant" value={payment.merchant.displayName} />
            <Details label="Direction" value={payment.direction} />
            <Details label="Amount" value={formatUsd(payment.amountCents)} />
            <Details label="Currency" value={payment.currency} />
            <Details label="Created" value={dateTime(payment.createdAt)} />
            <Details label="Last updated" value={dateTime(payment.updatedAt)} />
            <Details label="Idempotency key" value={payment.idempotencyKey} />
          </section>
          <Ledger entries={payment.ledgerSummary.entries} />
          <Outbox events={payment.outboxEvents} />
          <RawJson value={payment} />
        </div>
        <aside className="space-y-6">
          <Timeline payment={payment} />
          {payment.direction === "CREDIT" && payment.reservation ? (
            <Reservation reservation={payment.reservation} />
          ) : null}
        </aside>
      </div>
    </div>
  );
}
function Details({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white p-4 dark:bg-slate-950">
      <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
        {label}
      </p>
      <p className="mt-1 break-all font-medium">{value}</p>
    </div>
  );
}
function Timeline({ payment }: { payment: PaymentDetails }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <h2 className="text-sm font-semibold">Lifecycle</h2>
      <ol className="mt-4 space-y-4">
        {timelineSteps(payment).map((step) => (
          <li className="flex gap-3" key={step.label}>
            <span
              className={`mt-0.5 h-3 w-3 rounded-full ${step.at ? "bg-emerald-500" : "bg-slate-200 dark:bg-slate-700"}`}
            />
            <div>
              <p className="text-sm font-medium">{step.label}</p>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {step.at ? dateTime(step.at) : "Not completed"}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
function Reservation({
  reservation,
}: {
  reservation: NonNullable<PaymentDetails["reservation"]>;
}) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <h2 className="text-sm font-semibold">Funding reservation</h2>
      <div className="mt-4 space-y-3 text-sm">
        <Details
          label="Reserved amount"
          value={formatUsd(reservation.amount)}
        />
        <Details label="Status" value={reservation.status} />
        <Details label="Created" value={dateTime(reservation.createdAt)} />
      </div>
    </section>
  );
}
function Ledger({
  entries,
}: {
  entries: PaymentDetails["ledgerSummary"]["entries"];
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <h2 className="text-sm font-semibold">Ledger entries</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500 dark:bg-slate-900/60">
            <tr>
              <th className="px-4 py-3">Time</th>
              <th className="px-4 py-3">Entry type</th>
              <th className="px-4 py-3">Amount</th>
              <th className="px-4 py-3">Balance impact</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr
                className="border-t border-slate-100 dark:border-slate-900"
                key={entry.id}
              >
                <td className="px-4 py-3 text-slate-500">
                  {dateTime(entry.createdAt)}
                </td>
                <td className="px-4 py-3">{entry.entryType}</td>
                <td className="px-4 py-3">{formatUsd(entry.amount)}</td>
                <td className="px-4 py-3">
                  {impact(entry.entryType, entry.amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
function Outbox({ events }: { events: PaymentDetails["outboxEvents"] }) {
  return (
    <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <h2 className="text-sm font-semibold">Outbox events</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500 dark:bg-slate-900/60">
            <tr>
              <th className="px-4 py-3">Event type</th>
              <th className="px-4 py-3">Created</th>
              <th className="px-4 py-3">Delivered</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr
                className="border-t border-slate-100 dark:border-slate-900"
                key={event.id}
              >
                <td className="px-4 py-3">
                  <StatusBadge
                    tone={event.status === "PROCESSED" ? "success" : "pending"}
                  >
                    {event.eventType}
                  </StatusBadge>
                </td>
                <td className="px-4 py-3 text-slate-500">
                  {dateTime(event.createdAt)}
                </td>
                <td className="px-4 py-3 text-slate-500">
                  {event.processedAt ? dateTime(event.processedAt) : "Pending"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
function RawJson({ value }: { value: PaymentDetails }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const raw = JSON.stringify(value, null, 2);
  async function copy() {
    await navigator.clipboard.writeText(raw);
    setCopied(true);
  }
  return (
    <section className="rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-center justify-between p-4">
        <button
          className="text-sm font-semibold"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
        >
          Raw JSON
        </button>
        {open ? (
          <Button variant="outline" size="sm" onClick={() => void copy()}>
            {copied ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
            Copy
          </Button>
        ) : null}
      </div>
      {open ? (
        <pre className="max-h-96 overflow-auto border-t border-slate-200 bg-slate-50 p-4 text-xs dark:border-slate-800 dark:bg-slate-900">
          {raw}
        </pre>
      ) : null}
    </section>
  );
}
function impact(type: string, amount: string) {
  if (
    [
      "INITIAL_CREDIT",
      "CREDIT_POSTED",
      "RETURN",
      "REVERSAL",
      "ADJUSTMENT",
    ].includes(type)
  )
    return `+${formatUsd(amount)}`;
  if (type === "DEBIT_POSTED") return `-${formatUsd(amount)}`;
  return "Audit only";
}
function dateTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
