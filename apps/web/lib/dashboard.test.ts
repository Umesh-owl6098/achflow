import { describe, expect, it } from "vitest";
import {
  dashboardChartSeries,
  formatCompactChartCents,
  formatChartCents,
  formatUtcChartDay,
  formatUsd,
  parseDashboardData,
  statusTone,
} from "./dashboard";

const dashboard = {
  summary: {
    paymentsToday: 0,
    totalAmountCents: "0",
    debitAmountCents: "0",
    creditAmountCents: "0",
    submittedPayments: 0,
    settledPayments: 0,
    returnedPayments: 0,
  },
  dailyVolume: [],
  statusDistribution: [],
  recentPayments: [],
  generatedAt: "2026-07-30T00:00:00.000Z",
};

describe("dashboard utilities", () => {
  it("keeps today's transaction count and exact amount data separate from a historical outlier", () => {
    expect(
      dashboardChartSeries([
        {
          date: "2026-08-16",
          debitCount: 0,
          creditCount: 1,
          totalCount: 1,
          debitAmountCents: "0",
          creditAmountCents: "100370",
          totalAmountCents: "100370",
        },
        {
          date: "2026-08-22",
          debitCount: 20,
          creditCount: 20,
          totalCount: 40,
          debitAmountCents: "100",
          creditAmountCents: "120",
          totalAmountCents: "220",
        },
      ]),
    ).toEqual([
      {
        date: "2026-08-16",
        debitCount: 0,
        creditCount: 1,
        totalCount: 1,
        debitCents: 0,
        creditCents: 100370,
        totalCents: 100370,
      },
      {
        date: "2026-08-22",
        debitCount: 20,
        creditCount: 20,
        totalCount: 40,
        debitCents: 100,
        creditCents: 120,
        totalCents: 220,
      },
    ]);
    expect(formatChartCents(100)).toBe("$1.00");
    expect(formatChartCents(120)).toBe("$1.20");
    expect(formatChartCents(220)).toBe("$2.20");
    expect(formatCompactChartCents(100370)).toBe("$1K");
    expect(formatUtcChartDay("2026-08-22", "2026-08-22")).toBe("Today");
  });
  it("formats cents as USD", () => expect(formatUsd("2500")).toBe("$25.00"));
  it("maps ACH statuses to dashboard badge tones", () => {
    expect(statusTone("SETTLED")).toBe("success");
    expect(statusTone("RETURNED")).toBe("failure");
    expect(statusTone("SUBMITTED")).toBe("pending");
  });
  it("parses a valid dashboard response and rejects malformed data", () => {
    expect(parseDashboardData(dashboard).summary.paymentsToday).toBe(0);
    expect(() => parseDashboardData({})).toThrow("invalid format");
  });
});
