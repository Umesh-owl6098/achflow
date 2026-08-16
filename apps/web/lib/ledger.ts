export type LedgerDateRange = "all" | "today" | "7d" | "30d" | "custom";

export type LedgerFilters = {
  merchantId?: string;
  search: string;
  entryType: string;
  dateRange: LedgerDateRange;
  startDate: string;
  endDate: string;
  minAmount: string;
  maxAmount: string;
};

export type LedgerRow = {
  id: string;
  entryKey: string;
  entryType: string;
  amountCents: string;
  debitAmountCents: string;
  creditAmountCents: string;
  balanceImpactCents: string;
  runningBalanceCents: string;
  createdAt: string;
  fundingAccountId: string;
  currency: string;
  merchant: { merchantCode: string; displayName: string };
  payment: {
    id: string;
    externalReference: string | null;
    direction: string;
    amountCents: string;
    currency: string;
    status: string;
  } | null;
  reservation: {
    amountCents: string;
    status: string;
    createdAt: string;
    releasedAt: string | null;
    settledAt: string | null;
    returnedAt: string | null;
    returnCode: string | null;
  } | null;
  status: string;
};

export type LedgerData = {
  merchant: { merchantCode: string; displayName: string } | null;
  data: LedgerRow[];
  summary: {
    totalCreditsCents: string;
    totalDebitsCents: string;
    netPositionCents: string;
    outstandingReservedAmountCents: string;
  };
};

export const ledgerEntryTypes = [
  "INITIAL_CREDIT",
  "RESERVATION",
  "RESERVATION_RELEASE",
  "SETTLEMENT",
  "DEBIT_POSTED",
  "CREDIT_POSTED",
  "RETURN",
  "REVERSAL",
  "ADJUSTMENT",
] as const;

export function parseLedgerData(value: unknown): LedgerData {
  if (
    !isRecord(value) ||
    !Array.isArray(value.data) ||
    !isRecord(value.summary) ||
    !value.data.every(isLedgerRow)
  ) {
    throw new Error("The ledger response has an invalid format.");
  }
  const summary = value.summary;
  if (
    ![
      summary.totalCreditsCents,
      summary.totalDebitsCents,
      summary.netPositionCents,
      summary.outstandingReservedAmountCents,
    ].every((item) => typeof item === "string")
  ) {
    throw new Error("The ledger summary has an invalid format.");
  }
  return value as LedgerData;
}

export function ledgerSearchParams(filters: LedgerFilters): string {
  const params = new URLSearchParams({ dateRange: filters.dateRange });
  if (filters.search.trim()) params.set("search", filters.search.trim());
  if (filters.merchantId) params.set("merchantId", filters.merchantId);
  if (filters.entryType) params.set("entryType", filters.entryType);
  if (filters.dateRange === "custom") {
    if (filters.startDate) params.set("startDate", filters.startDate);
    if (filters.endDate) params.set("endDate", filters.endDate);
  }
  const minimum = dollarsToCents(filters.minAmount);
  const maximum = dollarsToCents(filters.maxAmount);
  if (minimum !== null) params.set("minAmountCents", minimum);
  if (maximum !== null) params.set("maxAmountCents", maximum);
  return params.toString();
}

export function dollarsToCents(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d+(\.\d{0,2})?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  return (
    BigInt(whole) * BigInt(100) +
    BigInt(`${fraction}00`.slice(0, 2))
  ).toString();
}

export function formatCents(amountCents: string, currency = "USD"): string {
  const amount = BigInt(amountCents);
  const negative = amount < BigInt(0);
  const digits = (negative ? -amount : amount).toString().padStart(3, "0");
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = digits.slice(-2);
  const prefix = currency === "USD" ? "$" : `${currency} `;
  return `${negative ? "-" : ""}${prefix}${whole}.${fraction}`;
}

export function ledgerCsv(rows: LedgerRow[]): string {
  const headers = [
    "Timestamp",
    "Payment ID",
    "Merchant",
    "Entry Type",
    "Debit",
    "Credit",
    "Running Balance",
    "Status",
    "Entry Key",
  ];
  const records = rows.map((row) => [
    row.createdAt,
    row.payment?.id ?? "",
    row.merchant.displayName,
    row.entryType,
    row.debitAmountCents,
    row.creditAmountCents,
    row.runningBalanceCents,
    row.status,
    row.entryKey,
  ]);
  return [headers, ...records]
    .map((record) => record.map(csvCell).join(","))
    .join("\n");
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function isLedgerRow(value: unknown): value is LedgerRow {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.entryKey === "string" &&
    typeof value.entryType === "string" &&
    typeof value.amountCents === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.runningBalanceCents === "string" &&
    isRecord(value.merchant)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
