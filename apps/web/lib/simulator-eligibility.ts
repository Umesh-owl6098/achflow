export type SimulatorDirection = "DEBIT" | "CREDIT" | "MIXED";

export type SimulatorMerchant = {
  id: string;
  merchantCode: string;
  displayName: string;
  status: "ACTIVE" | "SUSPENDED" | "CLOSED";
  allowAchDebit: boolean;
  allowAchCredit: boolean;
  perPaymentLimit: string;
  dailyAmountLimit: string;
  dailyUtilizedAmountCents: string;
  activeFundingCurrencies: string[];
};

export type SimulatorEligibilityConfig = {
  direction: SimulatorDirection;
  minimumAmountCents: number;
  maximumAmountCents: number;
  transactionCount: number;
  selectedMerchantCount: number;
  validationFailurePercent: number;
};

export type MerchantEligibility = {
  merchantId: string;
  eligible: boolean;
  safeMaximumAmountCents: number | null;
  reasons: string[];
};

export function merchantEligibility(
  merchant: SimulatorMerchant,
  config: SimulatorEligibilityConfig,
): MerchantEligibility {
  const reasons: string[] = [];
  const requiresDebit =
    config.direction === "DEBIT" || config.direction === "MIXED";
  const requiresCredit =
    config.direction === "CREDIT" || config.direction === "MIXED";
  const perPaymentLimit = BigInt(merchant.perPaymentLimit);
  const dailyAmountLimit = BigInt(merchant.dailyAmountLimit);
  const dailyUtilizedAmount = BigInt(merchant.dailyUtilizedAmountCents);
  const safeMaximum =
    perPaymentLimit < BigInt(config.maximumAmountCents)
      ? Number(perPaymentLimit)
      : config.maximumAmountCents;

  if (merchant.status !== "ACTIVE") {
    reasons.push("Merchant is not active.");
  }
  if (requiresDebit && !merchant.allowAchDebit) {
    reasons.push("ACH debit is not enabled.");
  }
  if (requiresCredit && !merchant.allowAchCredit) {
    reasons.push("ACH credit is not enabled.");
  }
  if (requiresCredit && !merchant.activeFundingCurrencies.includes("USD")) {
    reasons.push("An active USD funding account is required for ACH credit.");
  }

  const hasSuccessfulTraffic = config.validationFailurePercent < 100;
  if (
    hasSuccessfulTraffic &&
    BigInt(config.minimumAmountCents) > perPaymentLimit
  ) {
    reasons.push(
      `Minimum amount ${formatCents(config.minimumAmountCents)} exceeds its ${formatCents(perPaymentLimit)} per-payment limit.`,
    );
  }
  if (hasSuccessfulTraffic) {
    const paymentsForMerchant = Math.ceil(
      config.transactionCount / Math.max(1, config.selectedMerchantCount),
    );
    const requiredDailyCapacity =
      BigInt(config.minimumAmountCents) * BigInt(paymentsForMerchant);
    const remainingDailyCapacity = dailyAmountLimit - dailyUtilizedAmount;
    if (remainingDailyCapacity < requiredDailyCapacity) {
      reasons.push(
        `Remaining daily capacity ${formatCents(remainingDailyCapacity > 0n ? remainingDailyCapacity : 0n)} cannot cover ${paymentsForMerchant} payment${paymentsForMerchant === 1 ? "" : "s"} at the selected minimum.`,
      );
    }
  }

  return {
    merchantId: merchant.id,
    eligible: reasons.length === 0,
    safeMaximumAmountCents: reasons.length === 0 ? safeMaximum : null,
    reasons,
  };
}

export function formatCents(cents: bigint | number): string {
  const value = typeof cents === "number" ? BigInt(cents) : cents;
  const absolute = value > 0n ? value : 0n;
  return `$${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}
