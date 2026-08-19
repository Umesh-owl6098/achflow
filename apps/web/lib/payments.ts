export type PaymentDirection = "DEBIT" | "CREDIT";

export type PaymentStatus =
  | "RECEIVED"
  | "VALIDATED"
  | "SUBMITTED"
  | "SETTLED"
  | "RETURNED"
  | "VALIDATION_FAILED";

export type PaymentListItem = {
  id: string;
  merchant: { merchantCode: string; displayName: string };
  externalReference: string | null;
  direction: PaymentDirection;
  amountCents: string;
  currency: string;
  status: PaymentStatus;
  createdAt: string;
  updatedAt: string;
};

export type PaymentListResponse = {
  data: PaymentListItem[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

export type PaymentListFilters = {
  search: string;
  status: "" | PaymentStatus;
  direction: "" | PaymentDirection;
  dateRange: "today" | "7d" | "30d" | "custom";
  startDate: string;
  endDate: string;
  sortBy: "createdAt" | "amountCents" | "status";
  sortOrder: "asc" | "desc";
  page: number;
};

export const paymentStatuses: PaymentStatus[] = [
  "RECEIVED",
  "VALIDATED",
  "SUBMITTED",
  "SETTLED",
  "RETURNED",
  "VALIDATION_FAILED",
];

export function parsePaymentListResponse(value: unknown): PaymentListResponse {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error("The payments response has an invalid format.");
  }
  const numericFields = [
    value.page,
    value.limit,
    value.total,
    value.totalPages,
  ];
  if (!numericFields.every((item) => typeof item === "number")) {
    throw new Error("The payments response has an invalid pagination format.");
  }
  if (!value.data.every(isPaymentListItem)) {
    throw new Error("The payments response contains an invalid payment.");
  }
  return value as PaymentListResponse;
}

export function paymentListSearchParams(filters: PaymentListFilters): string {
  const params = new URLSearchParams({
    dateRange: filters.dateRange,
    sortBy: filters.sortBy,
    sortOrder: filters.sortOrder,
    page: String(filters.page),
    limit: "25",
  });
  if (filters.search) params.set("search", filters.search);
  if (filters.status) params.set("status", filters.status);
  if (filters.direction) params.set("direction", filters.direction);
  if (filters.startDate) params.set("startDate", filters.startDate);
  if (filters.endDate) params.set("endDate", filters.endDate);
  return params.toString();
}

function isPaymentListItem(value: unknown): value is PaymentListItem {
  if (!isRecord(value) || !isRecord(value.merchant)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.merchant.merchantCode === "string" &&
    typeof value.merchant.displayName === "string" &&
    (typeof value.externalReference === "string" ||
      value.externalReference === null) &&
    (value.direction === "DEBIT" || value.direction === "CREDIT") &&
    typeof value.amountCents === "string" &&
    typeof value.currency === "string" &&
    paymentStatuses.includes(value.status as PaymentStatus) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
