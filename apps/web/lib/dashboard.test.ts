import { describe, expect, it } from "vitest";
import { formatUsd, parseDashboardData, statusTone } from "./dashboard";

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
