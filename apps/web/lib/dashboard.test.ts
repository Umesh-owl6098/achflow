import { describe, expect, it } from "vitest";
import {
  dashboardChartSeries,
  formatChartCents,
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
  it("maps current-day debit and credit cents to the chart without double conversion", () => {
    expect(
      dashboardChartSeries([
        {
          date: "2026-08-22",
          debitAmountCents: "25",
          creditAmountCents: "30",
          totalAmountCents: "55",
        },
      ]),
    ).toEqual([{ date: "2026-08-22", debitCents: 25, creditCents: 30 }]);
    expect(formatChartCents(25)).toBe("$0.25");
    expect(formatChartCents(30)).toBe("$0.30");
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
