export type NachaSubmissionStatus = "SUBMITTED" | "PENDING" | "FAILED";
export type NachaDateRange = "all" | "today" | "7d" | "30d" | "custom";

export type NachaPayment = {
  id: string;
  externalReference: string | null;
  direction: "DEBIT" | "CREDIT";
  amountCents: string;
  currency: string;
  status: string;
  exportedAt: string | null;
  createdAt: string;
  merchant: { merchantCode: string; displayName: string };
};

export type NachaFile = {
  id: string;
  fileName: string;
  createdAt: string;
  effectiveEntryDate: string;
  submissionStatus: NachaSubmissionStatus;
  totalPayments: number;
  totalAmountCents: string;
  debitCount: number;
  creditCount: number;
  debitTotalCents: string;
  creditTotalCents: string;
  entryHash: string;
  sha256: string;
  exportedBy: string;
  payments: NachaPayment[];
};

export type NachaFilesData = {
  merchant: { merchantCode: string; displayName: string } | null;
  data: NachaFile[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  summary: {
    filesGeneratedToday: number;
    paymentsExported: number;
    totalExportAmountCents: string;
    pendingSubmissionFiles: number;
  };
};

export type NachaFilesFilters = {
  merchantId?: string;
  search: string;
  status: "" | NachaSubmissionStatus;
  dateRange: NachaDateRange;
  startDate: string;
  endDate: string;
  page?: number;
};

export function parseNachaFilesData(value: unknown): NachaFilesData {
  if (
    !isRecord(value) ||
    !Array.isArray(value.data) ||
    !isRecord(value.summary)
  ) {
    throw new Error("The NACHA files response has an invalid format.");
  }
  if (!value.data.every(isNachaFile)) {
    throw new Error("The NACHA files response contains an invalid file.");
  }
  const summary = value.summary;
  if (
    typeof summary.filesGeneratedToday !== "number" ||
    typeof summary.paymentsExported !== "number" ||
    typeof summary.totalExportAmountCents !== "string" ||
    typeof summary.pendingSubmissionFiles !== "number"
  ) {
    throw new Error("The NACHA file summary has an invalid format.");
  }
  return {
    ...value,
    page: typeof value.page === "number" ? value.page : 1,
    pageSize: typeof value.pageSize === "number" ? value.pageSize : 25,
    total: typeof value.total === "number" ? value.total : value.data.length,
    totalPages: typeof value.totalPages === "number" ? value.totalPages : 1,
  } as NachaFilesData;
}

export function nachaFilesSearchParams(filters: NachaFilesFilters): string {
  const params = new URLSearchParams({ dateRange: filters.dateRange });
  if (filters.search.trim()) params.set("search", filters.search.trim());
  if (filters.merchantId) params.set("merchantId", filters.merchantId);
  if (filters.status) params.set("status", filters.status);
  if (filters.startDate) params.set("startDate", filters.startDate);
  if (filters.endDate) params.set("endDate", filters.endDate);
  if ((filters.page ?? 1) > 1) params.set("page", String(filters.page));
  return params.toString();
}

export function formatNachaCents(value: string, currency = "USD"): string {
  const amount = BigInt(value);
  const negative = amount < BigInt(0);
  const digits = (negative ? -amount : amount).toString().padStart(3, "0");
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const prefix = currency === "USD" ? "$" : `${currency} `;
  return `${negative ? "-" : ""}${prefix}${whole}.${digits.slice(-2)}`;
}

function isNachaFile(value: unknown): value is NachaFile {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.fileName === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.totalPayments === "number" &&
    typeof value.totalAmountCents === "string" &&
    (value.submissionStatus === "SUBMITTED" ||
      value.submissionStatus === "PENDING" ||
      value.submissionStatus === "FAILED") &&
    Array.isArray(value.payments)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
