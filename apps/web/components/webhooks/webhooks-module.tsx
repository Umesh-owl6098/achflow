"use client";

import { useState } from "react";
import { PageHeader } from "@/components/foundation/page-header";
import { WebhookEventsTable } from "./webhook-events-table";
import { WebhooksManager } from "./webhooks-manager";

export function WebhooksModule() {
  const [tab, setTab] = useState<"endpoints" | "events">("endpoints");
  return (
    <div className="space-y-5">
      <PageHeader
        title="Webhooks"
        description="Manage encrypted endpoint configuration and inspect every delivery from one workspace."
      />
      <div
        role="tablist"
        aria-label="Webhook sections"
        className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1 dark:border-slate-800 dark:bg-slate-900"
      >
        <button
          role="tab"
          aria-selected={tab === "endpoints"}
          onClick={() => setTab("endpoints")}
          className={`rounded-md px-3 py-1.5 text-sm font-medium ${tab === "endpoints" ? "bg-white shadow-sm dark:bg-slate-800" : "text-slate-500"}`}
        >
          Endpoints
        </button>
        <button
          role="tab"
          aria-selected={tab === "events"}
          onClick={() => setTab("events")}
          className={`rounded-md px-3 py-1.5 text-sm font-medium ${tab === "events" ? "bg-white shadow-sm dark:bg-slate-800" : "text-slate-500"}`}
        >
          Delivery Events
        </button>
      </div>
      {tab === "endpoints" ? (
        <WebhooksManager embedded />
      ) : (
        <WebhookEventsTable embedded />
      )}
    </div>
  );
}
