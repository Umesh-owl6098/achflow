import { describe, expect, it } from "vitest";
import { dollarsToCents, formatCents, ledgerCsv } from "./ledger";

describe("ledger utilities", () => {
  it("converts decimal filter amounts without using number money values", () => {
    expect(dollarsToCents("25.05")).toBe("2505");
    expect(dollarsToCents("1000000000000000.01")).toBe("100000000000000001");
    expect(dollarsToCents("invalid")).toBeNull();
    expect(formatCents("-2505")).toBe("-$25.05");
  });

  it("creates a quoted CSV export for visible ledger rows", () => {
    const csv = ledgerCsv([
      {
        id: "ledger-1",
        entryKey: "entry-key",
        entryType: "CREDIT_POSTED",
        amountCents: "2500",
        debitAmountCents: "0",
        creditAmountCents: "2500",
        balanceImpactCents: "2500",
        runningBalanceCents: "10000",
        createdAt: "2026-07-30T12:00:00.000Z",
        fundingAccountId: "funding-1",
        currency: "USD",
        merchant: { merchantCode: "DEMO", displayName: "Demo, Merchant" },
        payment: {
          id: "payment-1",
          externalReference: "invoice-001",
          direction: "CREDIT",
          amountCents: "2500",
          currency: "USD",
          status: "SETTLED",
        },
        reservation: null,
        status: "SETTLED",
      },
    ]);

    expect(csv).toContain('"Timestamp","Payment ID","Merchant"');
    expect(csv).toContain('"Demo, Merchant"');
    expect(csv).toContain('"entry-key"');
  });
});
