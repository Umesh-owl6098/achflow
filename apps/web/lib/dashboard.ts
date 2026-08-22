export type PaymentDirection = "DEBIT" | "CREDIT";

export type DashboardSummary = {
  paymentsToday: number;
  totalAmountCents: string;
  debitAmountCents: string;
  creditAmountCents: string;
  submittedPayments: number;
  settledPayments: number;
  returnedPayments: number;
};

export type DailyVolume = {
  date: string;
  debitAmountCents: string;
  creditAmountCents: string;
  totalAmountCents: string;
};

export type StatusDistribution = { status: string; count: number };

export type RecentPayment = {
  id: string;
  merchant: { merchantCode: string; displayName: string };
  externalReference: string | null;
  direction: PaymentDirection;
  status: string;
  amountCents: string;
  currency: string;
  createdAt: string;
};

export type DashboardData = {
  summary: DashboardSummary;
  dailyVolume: DailyVolume[];
  statusDistribution: StatusDistribution[];
  recentPayments: RecentPayment[];
  generatedAt: string;
};

export type DashboardChartPoint = {
  date: string;
  debitCents: number;
  creditCents: number;
};

export function dashboardChartSeries(
  dailyVolume: DailyVolume[],
): DashboardChartPoint[] {
  return dailyVolume.map((day) => ({
    date: day.date,
    debitCents: Number(BigInt(day.debitAmountCents)),
    creditCents: Number(BigInt(day.creditAmountCents)),
  }));
}

export function formatChartCents(value: number): string {
  return `$${(value / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function parseDashboardData(value: unknown): DashboardData {
  if (
    !isRecord(value) ||
    !isRecord(value.summary) ||
    !Array.isArray(value.dailyVolume) ||
    !Array.isArray(value.statusDistribution) ||
    !Array.isArray(value.recentPayments) ||
    typeof value.generatedAt !== "string"
  ) {
    throw new Error("The dashboard response has an invalid format.");
  }
  const summary = value.summary;
  if (
    ![
      summary.paymentsToday,
      summary.submittedPayments,
      summary.settledPayments,
      summary.returnedPayments,
    ].every((item) => typeof item === "number") ||
    ![
      summary.totalAmountCents,
      summary.debitAmountCents,
      summary.creditAmountCents,
    ].every((item) => typeof item === "string")
  ) {
    throw new Error("The dashboard summary has an invalid format.");
  }
  return value as DashboardData;
}

export function formatUsd(amountCents: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number(BigInt(amountCents)) / 100);
}

export function statusTone(
  status: string,
): "success" | "pending" | "failure" | "neutral" {
  if (["SETTLED", "VALIDATED"].includes(status)) return "success";
  if (["RETURNED", "VALIDATION_FAILED", "FAILED", "CANCELLED"].includes(status))
    return "failure";
  if (["RECEIVED", "PENDING", "PROCESSING", "SUBMITTED"].includes(status))
    return "pending";
  return "neutral";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
