"use client";
import { FormEvent, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Plus, Power, Search, Send, Trash2 } from "lucide-react";
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
import { ConfirmationDialog } from "@/components/foundation/confirmation-dialog";
import { StatusBadge } from "@/components/foundation/status-badge";
import {
  deliveryTone,
  parseWebhooks,
  type WebhookDelivery,
  type WebhookEndpoint,
  type WebhooksResponse,
} from "@/lib/webhooks";

async function api(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      (body as { message?: string } | null)?.message ??
        "Webhook request failed.",
    );
  return body;
}
export function WebhooksManager({ embedded = false }: { embedded?: boolean }) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<WebhookEndpoint | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [archivedEndpointIds, setArchivedEndpointIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [deletingEndpointId, setDeletingEndpointId] = useState<string | null>(
    null,
  );
  const deleteInFlight = useRef(new Set<string>());
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["webhooks", search, status],
    queryFn: async () =>
      parseWebhooks(
        await api(`/api/webhooks?${new URLSearchParams({ search, status })}`),
      ),
  });
  const refresh = () =>
    void client.invalidateQueries({ queryKey: ["webhooks"] });
  const removeEndpoint = async (endpoint: WebhookEndpoint) => {
    if (deleteInFlight.current.has(endpoint.id)) return;
    deleteInFlight.current.add(endpoint.id);
    setDeletingEndpointId(endpoint.id);
    setNotice(null);
    try {
      const result = (await api(`/api/webhooks/${endpoint.id}`, {
        method: "DELETE",
      })) as DeleteWebhookEndpointResult;
      if (result.deleted) {
        setArchivedEndpointIds((current) => {
          const next = new Set(current);
          next.delete(endpoint.id);
          return next;
        });
        setNotice("Webhook endpoint deleted.");
        if (selected?.id === endpoint.id) setSelected(null);
      } else if (result.disabled) {
        setArchivedEndpointIds((current) => new Set(current).add(endpoint.id));
        setNotice(
          "Webhook endpoint has delivery history, so it was disabled instead of deleted.",
        );
      } else {
        throw new Error("Webhook endpoint removal returned an invalid result.");
      }
      await client.invalidateQueries({ queryKey: ["webhooks"] });
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Webhook endpoint could not be removed.",
      );
    } finally {
      deleteInFlight.current.delete(endpoint.id);
      setDeletingEndpointId(null);
    }
  };
  if (query.isLoading)
    return <LoadingState label="Loading webhook endpoints" />;
  if (query.isError)
    return (
      <ErrorState
        title="Webhooks unavailable"
        description="Endpoint configuration could not be loaded."
        onRetry={() => void query.refetch()}
      />
    );
  const data = query.data as WebhooksResponse;
  const totalDeliveriesToday = data.data
    .flatMap((endpoint) => endpoint.deliveries)
    .filter(
      (delivery) =>
        new Date(delivery.createdAt).toDateString() ===
        new Date().toDateString(),
    ).length;
  return (
    <div className="space-y-5">
      {!embedded ? (
        <PageHeader
          title="Webhooks"
          description="Secure merchant endpoints and durable delivery operations."
          actions={
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Add endpoint
            </Button>
          }
        />
      ) : (
        <div className="flex justify-end">
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Add endpoint
          </Button>
        </div>
      )}
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card label="Active endpoints" value={data.summary.active} />
        <Card label="Disabled endpoints" value={data.summary.disabled} />
        <Card label="Failed deliveries" value={data.summary.failedDeliveries} />
        <Card label="Total deliveries today" value={totalDeliveriesToday} />
      </section>
      <section className="flex flex-wrap gap-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950">
        <label className="relative min-w-60 flex-1">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <input
            aria-label="Search webhook endpoints"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search endpoint URL"
            className="h-9 w-full rounded-md border border-slate-200 bg-slate-50 pl-9 pr-3 text-sm dark:border-slate-800 dark:bg-slate-900"
          />
        </label>
        <select
          aria-label="Webhook endpoint status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="h-9 rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-800 dark:bg-slate-900"
        >
          <option value="all">All endpoints</option>
          <option value="active">Active</option>
          <option value="disabled">Disabled</option>
        </select>
      </section>
      {notice ? (
        <p
          role="status"
          className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200"
        >
          {notice}
        </p>
      ) : null}
      {data.data.length === 0 ? (
        <EmptyState
          title="No webhook endpoints"
          description="Add an endpoint to receive signed payment lifecycle notifications."
        />
      ) : (
        <section className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
          <table className="w-full min-w-[1040px] text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-900">
              <tr>
                <th className="p-3">Endpoint</th>
                <th>State</th>
                <th>Deliveries</th>
                <th>Last delivery</th>
                <th>Success rate</th>
                <th>Failure rate</th>
                <th className="p-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.data.map((endpoint) => (
                <tr
                  key={endpoint.id}
                  className="border-t border-slate-100 dark:border-slate-900"
                >
                  <td className="p-3">
                    <p className="font-medium">{endpoint.url}</p>
                    <p className="font-mono text-xs text-slate-500">
                      {endpoint.id}
                    </p>
                  </td>
                  <td>
                    <StatusBadge
                      tone={endpoint.isActive ? "success" : "neutral"}
                    >
                      {archivedEndpointIds.has(endpoint.id)
                        ? "ARCHIVED"
                        : endpoint.isActive
                          ? "ACTIVE"
                          : "DISABLED"}
                    </StatusBadge>
                  </td>
                  <td>{endpoint.deliveries.length}</td>
                  <td>
                    {endpoint.deliveries[0]
                      ? new Date(
                          endpoint.deliveries[0].deliveredAt ??
                            endpoint.deliveries[0].createdAt,
                        ).toLocaleString()
                      : "—"}
                  </td>
                  <td>{rate(endpoint.deliveries, "DELIVERED")}</td>
                  <td>{rate(endpoint.deliveries, "FAILED")}</td>
                  <td className="p-3">
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setSelected(endpoint)}
                        aria-label={`View ${endpoint.url}`}
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          void api(`/api/webhooks/${endpoint.id}/test`, {
                            method: "POST",
                          }).then(refresh)
                        }
                        aria-label={`Test ${endpoint.url}`}
                      >
                        <Send className="h-4 w-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          void api(`/api/webhooks/${endpoint.id}`, {
                            method: "PATCH",
                            body: JSON.stringify({
                              isActive: !endpoint.isActive,
                            }),
                          }).then(refresh)
                        }
                        aria-label={`Toggle ${endpoint.url}`}
                      >
                        <Power className="h-4 w-4" />
                      </Button>
                      <ConfirmationDialog
                        trigger={
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Remove ${endpoint.url}`}
                            title="Remove endpoint"
                            disabled={deletingEndpointId === endpoint.id}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        }
                        title="Remove webhook endpoint"
                        description="Remove this webhook endpoint? Endpoints with delivery history are retained and disabled for audit purposes."
                        confirmLabel="Remove endpoint"
                        onConfirm={() => void removeEndpoint(endpoint)}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <EndpointDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSubmit={async (url, signingSecret) => {
          await api("/api/webhooks", {
            method: "POST",
            body: JSON.stringify({ url, signingSecret }),
          });
          setCreateOpen(false);
          refresh();
        }}
      />
      <DeliveryDialog endpoint={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

type DeleteWebhookEndpointResult = {
  deleted: boolean;
  disabled: boolean;
};
function Card({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
    </div>
  );
}
function EndpointDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  onSubmit: (url: string, secret: string) => Promise<void>;
}) {
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      setError("");
      await onSubmit(url, secret);
      setUrl("");
      setSecret("");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Webhook could not be created.",
      );
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add webhook endpoint</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <input
            required
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/webhooks/achflow"
            className="h-10 w-full rounded-md border px-3 dark:bg-slate-900"
          />
          <input
            required
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="Signing secret"
            className="h-10 w-full rounded-md border px-3 dark:bg-slate-900"
          />
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          <Button type="submit">Save encrypted endpoint</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
function DeliveryDialog({
  endpoint,
  onClose,
}: {
  endpoint: WebhookEndpoint | null;
  onClose: () => void;
}) {
  const deliveries = useQuery({
    queryKey: ["webhook-deliveries", endpoint?.id],
    enabled: Boolean(endpoint),
    queryFn: async () =>
      (
        (await api(`/api/webhooks/${endpoint?.id}/deliveries`)) as {
          data: WebhookDelivery[];
        }
      ).data,
  });
  return (
    <Dialog
      open={Boolean(endpoint)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Delivery history</DialogTitle>
        </DialogHeader>
        {deliveries.isLoading ? (
          <LoadingState label="Loading deliveries" />
        ) : (
          <div className="max-h-[60vh] space-y-3 overflow-auto">
            <section className="rounded border border-slate-200 p-3 text-sm dark:border-slate-800">
              <p className="font-medium">Endpoint configuration</p>
              <p className="mt-1 text-slate-500">
                Signing secret is encrypted at rest and is not returned after
                creation. Authorization headers and event subscriptions are not
                configured for this endpoint.
              </p>
            </section>
            {deliveries.data?.map((d) => (
              <article key={d.id} className="rounded border p-3">
                <div className="flex justify-between">
                  <div>
                    <StatusBadge tone={deliveryTone(d.status)}>
                      {d.status}
                    </StatusBadge>
                    <span className="ml-2 text-sm font-medium">
                      {d.eventType}
                    </span>
                  </div>
                  <span>{d.responseStatus ?? "No response"}</span>
                </div>
                <p className="mt-2 text-xs text-slate-500">
                  Attempts {d.attemptCount} ·{" "}
                  {new Date(d.createdAt).toLocaleString()}
                </p>
                {d.lastErrorCode ? (
                  <p className="text-sm text-red-600">{d.lastErrorCode}</p>
                ) : null}
                <details className="mt-2">
                  <summary className="cursor-pointer text-sm">
                    View payload
                  </summary>
                  <pre className="mt-2 overflow-auto rounded bg-slate-100 p-2 text-xs dark:bg-slate-900">
                    {JSON.stringify(d.payload, null, 2)}
                  </pre>
                </details>
              </article>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
function rate(deliveries: WebhookDelivery[], status: "DELIVERED" | "FAILED") {
  if (!deliveries.length) return "—";
  return `${Math.round((deliveries.filter((delivery) => delivery.status === status).length / deliveries.length) * 100)}%`;
}
