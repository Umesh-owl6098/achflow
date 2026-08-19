import { describe, expect, it } from "vitest";
import {
  merchantEligibility,
  type SimulatorEligibilityConfig,
  type SimulatorMerchant,
} from "./simulator-eligibility";

const config: SimulatorEligibilityConfig = {
  direction: "CREDIT",
  minimumAmountCents: 100,
  maximumAmountCents: 1_000,
  transactionCount: 10,
  selectedMerchantCount: 1,
  validationFailurePercent: 0,
};

const merchant: SimulatorMerchant = {
  id: "merchant-1",
  merchantCode: "DEMO",
  displayName: "Demo merchant",
  status: "ACTIVE",
  allowAchDebit: true,
  allowAchCredit: true,
  perPaymentLimit: "500",
  dailyAmountLimit: "10000",
  dailyUtilizedAmountCents: "0",
  activeFundingCurrencies: ["USD"],
};

describe("merchantEligibility", () => {
  it("caps a valid merchant's safe maximum at its configured per-payment limit", () => {
    expect(merchantEligibility(merchant, config)).toMatchObject({
      eligible: true,
      safeMaximumAmountCents: 500,
    });
  });

  it("rejects a requested minimum above the merchant limit before a run is posted", () => {
    expect(
      merchantEligibility(merchant, { ...config, minimumAmountCents: 501 }),
    ).toMatchObject({
      eligible: false,
      reasons: [expect.stringContaining("$5.01 exceeds its $5.00")],
    });
  });

  it("requires the ACH direction and active USD funding needed for credit traffic", () => {
    expect(
      merchantEligibility(
        {
          ...merchant,
          allowAchCredit: false,
          activeFundingCurrencies: [],
        },
        config,
      ),
    ).toMatchObject({
      eligible: false,
      reasons: [
        "ACH credit is not enabled.",
        "An active USD funding account is required for ACH credit.",
      ],
    });
    expect(
      merchantEligibility(
        { ...merchant, allowAchDebit: false },
        { ...config, direction: "DEBIT" },
      ),
    ).toMatchObject({
      eligible: false,
      reasons: ["ACH debit is not enabled."],
    });
  });

  it("requires every selected merchant to be eligible independently", () => {
    expect(
      merchantEligibility(
        {
          ...merchant,
          dailyAmountLimit: "199",
          dailyUtilizedAmountCents: "100",
        },
        { ...config, transactionCount: 2, selectedMerchantCount: 2 },
      ),
    ).toMatchObject({ eligible: false });
  });

  it("keeps Development Legacy Merchant eligible and explains when a demo merchant needs funding", () => {
    expect(
      merchantEligibility(
        { ...merchant, merchantCode: "DEVELOPMENT_LEGACY" },
        { ...config, direction: "DEBIT" },
      ),
    ).toMatchObject({ eligible: true });
    expect(
      merchantEligibility(
        {
          ...merchant,
          merchantCode: "ACHFLOW_DEMO",
          activeFundingCurrencies: [],
        },
        config,
      ),
    ).toMatchObject({
      eligible: false,
      reasons: ["An active USD funding account is required for ACH credit."],
    });
  });

  it("keeps ACHFlow Demo Merchant eligible when its selected range is within its actual limit", () => {
    expect(
      merchantEligibility(
        {
          ...merchant,
          merchantCode: "1000008",
          displayName: "ACHFlow Demo Merchant",
          perPaymentLimit: "45",
        },
        {
          ...config,
          minimumAmountCents: 1,
          maximumAmountCents: 100,
        },
      ),
    ).toMatchObject({
      eligible: true,
      safeMaximumAmountCents: 45,
    });
  });
});
