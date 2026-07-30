import type { PaymentDirection, PaymentStatus } from "./payments";

export type PaymentDetails = {
  id: string;
  idempotencyKey: string;
  externalReference: string | null;
  direction: PaymentDirection;
  amountCents: string;
  currency: string;
  status: PaymentStatus;
  createdAt: string;
  updatedAt: string;
  validatedAt: string | null;
  merchant: { merchantCode: string; displayName: string };
  reservation: {
    id: string;
    amount: string;
    status: string;
    fundingAccountId: string;
    createdAt: string;
    releasedAt: string | null;
    settledAt: string | null;
    returnedAt: string | null;
    returnCode: string | null;
  } | null;
  ledgerSummary: {
    entries: Array<{
      id: string;
      entryKey: string;
      entryType: string;
      amount: string;
      createdAt: string;
    }>;
    postedBalance: string;
    activeReservedAmount: string;
    availableBalance: string;
  };
  outboxEvents: Array<{
    id: string;
    eventType: string;
    status: string;
    attempts: number;
    createdAt: string;
    processedAt: string | null;
  }>;
};

export function parsePaymentDetails(value: unknown): PaymentDetails {
  if (
    !isRecord(value) ||
    !isRecord(value.payment) ||
    !isRecord(value.ledgerSummary) ||
    !Array.isArray(value.outboxEvents)
  )
    throw new Error("The payment details response has an invalid format.");
  const payment = value.payment;
  if (
    typeof payment.id !== "string" ||
    typeof payment.amountCents !== "string" ||
    typeof payment.status !== "string" ||
    !isRecord(payment.merchant)
  )
    throw new Error(
      "The payment details response contains an invalid payment.",
    );
  return {
    ...payment,
    reservation: isRecord(value.reservation)
      ? (value.reservation as PaymentDetails["reservation"])
      : null,
    ledgerSummary: value.ledgerSummary as PaymentDetails["ledgerSummary"],
    outboxEvents: value.outboxEvents as PaymentDetails["outboxEvents"],
  } as PaymentDetails;
}

export function timelineSteps(payment: PaymentDetails) {
  const eventTime = (eventType: string) =>
    payment.outboxEvents.find((event) => event.eventType === eventType)
      ?.createdAt ?? null;
  const steps = [
    {
      label: "RECEIVED",
      at: eventTime("PAYMENT_RECEIVED") ?? payment.createdAt,
    },
    {
      label: "VALIDATED",
      at: payment.validatedAt ?? eventTime("PAYMENT_VALIDATED"),
    },
    { label: "SUBMITTED", at: eventTime("PAYMENT_SUBMITTED") },
    {
      label: "SETTLED",
      at: payment.reservation?.settledAt ?? eventTime("PAYMENT_SETTLED"),
    },
  ];
  if (payment.status === "RETURNED")
    steps.push({
      label: "RETURNED",
      at: payment.reservation?.returnedAt ?? eventTime("PAYMENT_RETURNED"),
    });
  if (payment.status === "VALIDATION_FAILED")
    steps.push({
      label: "VALIDATION FAILED",
      at: eventTime("PAYMENT_VALIDATION_FAILED"),
    });
  return steps;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
