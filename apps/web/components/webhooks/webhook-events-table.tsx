"use client";

import { useDeferredValue, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
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
import { deliveryTone, type DeliveryStatus } from "@/lib/webhooks";

type Event = {
  id: string;
  eventId: string;
  eventType: string;
  paymentId: string | null;
  status: DeliveryStatus;
  attemptCount: number;
  responseStatus: number | null;
  lastErrorCode: string | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  lastAttemptAt: string | null;
  endpoint: { id: string; url: string };
  merchant: { merchantCode: string; displayName: string };
  payload: unknown;
};
type Data = { data: Event[] };
async function load(query: string) {
  const r = await fetch(`/api/webhooks/deliveries?${query}`, {
    headers: { Accept: "application/json" },
  });
  const b: unknown = await r.json().catch(() => null);
  if (!r.ok) throw new Error("Webhook deliveries are unavailable.");
  return b as Data;
}
export function WebhookEventsTable({
  embedded = false,
}: {
  embedded?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [type, setType] = useState("");
  const [date, setDate] = useState("30d");
  const [selected, setSelected] = useState<Event | null>(null);
  const params = new URLSearchParams({
    search: useDeferredValue(search),
    status,
    eventType: type,
    dateRange: date,
  });
  const q = useQuery({
    queryKey: ["webhook-events", params.toString()],
    queryFn: () => load(params.toString()),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
  if (q.isLoading) return <LoadingState label="Loading webhook events" />;
  if (q.isError)
    return (
      <ErrorState
        title="Webhook events unavailable"
        description="Delivery history could not be loaded."
        onRetry={() => void q.refetch()}
      />
    );
  const events = q.data?.data ?? [];
  return (
    <div className="space-y-5">
      {!embedded ? (
        <PageHeader
          title="Webhook Events"
          description="Delivery operations refresh every 10 seconds while this page is open."
        />
      ) : null}
      <Filters
        search={search}
        setSearch={setSearch}
        status={status}
        setStatus={setStatus}
        type={type}
        setType={setType}
        date={date}
        setDate={setDate}
      />
      {events.length === 0 ? (
        <EmptyState
          title="No webhook events"
          description="Lifecycle and test deliveries will appear here once they are queued."
        />
      ) : (
        <section className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
          <table className="w-full min-w-[1000px] text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-900">
              <tr>
                <th className="p-3">Event ID</th>
                <th>Merchant</th>
                <th>Event type</th>
                <th>Payment ID</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Created at</th>
                <th>Delivered at</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr
                  key={event.id}
                  tabIndex={0}
                  onClick={() => setSelected(event)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") setSelected(event);
                  }}
                  className="cursor-pointer border-t border-slate-100 hover:bg-slate-50 dark:border-slate-900 dark:hover:bg-slate-900"
                >
                  <td className="p-3 font-mono text-xs">
                    {event.eventId.slice(0, 12)}…
                  </td>
                  <td>{event.merchant.displayName}</td>
                  <td>{event.eventType}</td>
                  <td className="font-mono text-xs">
                    {event.paymentId?.slice(0, 12) ?? "—"}
                  </td>
                  <td>
                    <StatusBadge tone={deliveryTone(event.status)}>
                      {event.status}
                    </StatusBadge>
                  </td>
                  <td>{event.attemptCount}</td>
                  <td>{format(event.createdAt)}</td>
                  <td>{event.deliveredAt ? format(event.deliveredAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <EventDrawer event={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
function Filters(p: {
  search: string;
  setSearch: (v: string) => void;
  status: string;
  setStatus: (v: string) => void;
  type: string;
  setType: (v: string) => void;
  date: string;
  setDate: (v: string) => void;
}) {
  return (
    <section className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 md:grid-cols-4 dark:border-slate-800 dark:bg-slate-950">
      <label className="relative md:col-span-2">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
        <input
          aria-label="Search webhook payment ID"
          value={p.search}
          onChange={(e) => p.setSearch(e.target.value)}
          placeholder="Search payment or event ID"
          className="h-9 w-full rounded-md border border-slate-200 bg-slate-50 pl-9 pr-3 text-sm dark:border-slate-800 dark:bg-slate-900"
        />
      </label>
      <select
        aria-label="Webhook status"
        value={p.status}
        onChange={(e) => p.setStatus(e.target.value)}
        className="h-9 rounded-md border px-2 dark:bg-slate-900"
      >
        <option value="all">All statuses</option>
        <option value="PENDING">Pending</option>
        <option value="DELIVERED">Delivered</option>
        <option value="FAILED">Failed</option>
      </select>
      <select
        aria-label="Webhook date range"
        value={p.date}
        onChange={(e) => p.setDate(e.target.value)}
        className="h-9 rounded-md border px-2 dark:bg-slate-900"
      >
        <option value="all">All time</option>
        <option value="today">Today</option>
        <option value="7d">Last 7 days</option>
        <option value="30d">Last 30 days</option>
      </select>
      <select
        aria-label="Webhook event type"
        value={p.type}
        onChange={(e) => p.setType(e.target.value)}
        className="h-9 rounded-md border px-2 md:col-span-2 dark:bg-slate-900"
      >
        <option value="">All event types</option>
        <option value="payment.created">Payment created</option>
        <option value="payment.validated">Payment validated</option>
        <option value="payment.reserved">Payment reserved</option>
        <option value="payment.submitted">Payment submitted</option>
        <option value="payment.settled">Payment settled</option>
        <option value="payment.returned">Payment returned</option>
        <option value="webhook.test">Webhook test</option>
      </select>
    </section>
  );
}
function EventDrawer({
  event,
  onClose,
}: {
  event: Event | null;
  onClose: () => void;
}) {
  const copy = (v: string) => void navigator.clipboard.writeText(v);
  return (
    <Dialog
      open={Boolean(event)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[100dvh] max-w-2xl overflow-y-auto sm:ml-auto sm:h-screen sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Webhook delivery</DialogTitle>
        </DialogHeader>
        {event ? (
          <div className="space-y-4 text-sm">
            <Detail
              label="Event ID"
              value={event.eventId}
              copy={() => copy(event.eventId)}
            />
            <Detail
              label="Merchant"
              value={`${event.merchant.displayName} (${event.merchant.merchantCode})`}
            />
            <Detail label="Endpoint URL" value={event.endpoint.url} />
            <Detail
              label="Response status"
              value={event.responseStatus?.toString() ?? "No response"}
            />
            <Detail label="Attempt count" value={String(event.attemptCount)} />
            <Detail label="Created" value={format(event.createdAt)} />
            <Detail
              label="Delivered"
              value={
                event.deliveredAt ? format(event.deliveredAt) : "Not delivered"
              }
            />
            <section>
              <p className="mb-1 font-medium">Request headers</p>
              <pre className="overflow-auto rounded bg-slate-100 p-3 text-xs dark:bg-slate-900">
                {JSON.stringify(
                  {
                    "Content-Type": "application/json",
                    "X-ACHFlow-Event-Id": event.eventId,
                    "X-ACHFlow-Timestamp": "generated per attempt",
                    "X-ACHFlow-Signature": "v1=<HMAC>",
                  },
                  null,
                  2,
                )}
              </pre>
            </section>
            <section>
              <div className="mb-1 flex items-center justify-between">
                <p className="font-medium">Request payload</p>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => copy(JSON.stringify(event.payload, null, 2))}
                >
                  <Copy className="mr-1 h-3 w-3" />
                  Copy payload
                </Button>
              </div>
              <pre className="overflow-auto rounded bg-slate-100 p-3 text-xs dark:bg-slate-900">
                {JSON.stringify(event.payload, null, 2)}
              </pre>
            </section>
            <section>
              <p className="mb-1 font-medium">Retry history</p>
              <p>
                {event.attemptCount} completed attempt
                {event.attemptCount === 1 ? "" : "s"}; latest response{" "}
                {event.responseStatus ?? event.lastErrorCode ?? "pending"}.
              </p>
              {event.nextAttemptAt ? (
                <p className="text-amber-600">
                  Next attempt: {format(event.nextAttemptAt)}
                </p>
              ) : null}
            </section>
            <Button disabled title="Retry coming soon">
              Retry coming soon
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
function Detail({
  label,
  value,
  copy,
}: {
  label: string;
  value: string;
  copy?: () => void;
}) {
  return (
    <div>
      <p className="text-xs text-slate-500">{label}</p>
      <div className="flex gap-2">
        <p className="break-all font-medium">{value}</p>
        {copy ? (
          <Button size="sm" variant="ghost" onClick={copy}>
            <Copy className="h-3 w-3" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
function format(v: string) {
  return new Date(v).toLocaleString();
}
