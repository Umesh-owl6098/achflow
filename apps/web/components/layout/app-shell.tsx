"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import {
  Bell,
  Building2,
  ChevronDown,
  CreditCard,
  FileText,
  Gauge,
  Landmark,
  Menu,
  Search,
  Settings,
  Webhook,
  X,
} from "lucide-react";
import { StatusBadge } from "@/components/foundation/status-badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { environmentLabel } from "@/lib/environment";
import { ThemeToggle } from "./theme-toggle";

const navigation = [
  { href: "/", label: "Dashboard", icon: Landmark },
  { href: "/payments", label: "Payments", icon: CreditCard },
  { href: "/ledger", label: "Ledger", icon: FileText },
  { href: "/nacha-files", label: "NACHA Files", icon: FileText },
  { href: "/webhooks", label: "Webhooks", icon: Webhook },
  { href: "/merchants", label: "Merchants", icon: Building2 },
  { href: "/simulator", label: "Simulator", icon: Gauge },
  { href: "/settings", label: "Settings", icon: Settings },
];

const pageTitles: Record<string, string> = {
  "/": "Dashboard",
  "/payments": "Payments",
  "/ledger": "Ledger",
  "/nacha-files": "NACHA Files",
  "/webhooks": "Webhooks",
  "/merchants": "Merchants",
  "/simulator": "Transaction simulator",
  "/settings": "Settings",
};

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const title = pageTitles[pathname] ?? "ACHFlow";
  const environment = environmentLabel(process.env.NODE_ENV);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-950 dark:bg-slate-950 dark:text-slate-100">
      {mobileOpen ? (
        <button
          className="fixed inset-0 z-40 bg-slate-950/30 lg:hidden"
          aria-label="Close navigation"
          onClick={() => setMobileOpen(false)}
        />
      ) : null}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 w-64 flex-col border-r border-slate-200 bg-white px-3 py-4 transition-transform dark:border-slate-800 dark:bg-slate-950 lg:flex lg:translate-x-0",
          mobileOpen ? "flex translate-x-0" : "hidden -translate-x-full",
        )}
        aria-label="Primary navigation"
      >
        <div className="flex items-center justify-between px-2">
          <Link
            href="/"
            className="flex items-center gap-2"
            onClick={() => setMobileOpen(false)}
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-slate-900 text-xs font-bold text-white dark:bg-slate-100 dark:text-slate-900">
              A
            </span>
            <span className="text-sm font-semibold tracking-tight">
              ACHFlow
            </span>
          </Link>
          <Button
            className="lg:hidden"
            variant="ghost"
            size="icon"
            aria-label="Close navigation"
            onClick={() => setMobileOpen(false)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <nav className="mt-7 space-y-1">
          {navigation.map(({ href, label, icon: Icon }) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                onClick={() => setMobileOpen(false)}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-slate-500",
                  active
                    ? "bg-slate-100 text-slate-950 dark:bg-slate-900 dark:text-white"
                    : "text-slate-600 hover:bg-slate-50 hover:text-slate-950 dark:text-slate-400 dark:hover:bg-slate-900 dark:hover:text-white",
                )}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto border-t border-slate-200 px-2 pt-4 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
          Operations console
        </div>
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-slate-200 bg-white/95 px-4 backdrop-blur dark:border-slate-800 dark:bg-slate-950/95 sm:px-6">
          <Button
            className="lg:hidden"
            variant="ghost"
            size="icon"
            aria-label="Open navigation"
            onClick={() => setMobileOpen(true)}
          >
            <Menu className="h-5 w-5" />
          </Button>
          <h1 className="min-w-0 text-sm font-semibold text-slate-950 dark:text-white">
            {title}
          </h1>
          <div className="relative ml-auto hidden max-w-sm flex-1 md:block">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
              aria-hidden="true"
            />
            <input
              aria-label="Search operations console"
              placeholder="Search payments, merchants, or files"
              className="h-9 w-full rounded-md border border-slate-200 bg-slate-50 pl-9 pr-3 text-sm outline-none placeholder:text-slate-400 focus:border-slate-400 focus:ring-2 focus:ring-slate-200 dark:border-slate-800 dark:bg-slate-900 dark:focus:border-slate-600 dark:focus:ring-slate-800"
            />
          </div>
          <StatusBadge
            tone={environment === "Production" ? "pending" : "success"}
          >
            {environment}
          </StatusBadge>
          <ThemeToggle />
          <Button variant="ghost" size="icon" aria-label="Notifications">
            <Bell className="h-4 w-4" />
          </Button>
          <button
            className="flex items-center gap-2 rounded-md p-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
            aria-label="Open user menu"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200">
              OP
            </span>
            <ChevronDown
              className="hidden h-4 w-4 text-slate-500 sm:block"
              aria-hidden="true"
            />
          </button>
        </header>
        <main className="mx-auto w-full max-w-7xl p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
