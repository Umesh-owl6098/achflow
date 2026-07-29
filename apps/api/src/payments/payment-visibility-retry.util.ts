import { Payment } from '@prisma/client';

export const paymentVisibilityRetryDelaysMs = [10, 25, 50] as const;

type Sleep = (delayMs: number) => Promise<void>;

const sleep: Sleep = (delayMs) =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

export async function findPaymentWithVisibilityRetry(
  findPayment: () => Promise<Payment | null>,
  wait: Sleep = sleep,
): Promise<Payment | null> {
  let payment = await findPayment();

  if (payment) {
    return payment;
  }

  for (const delayMs of paymentVisibilityRetryDelaysMs) {
    await wait(delayMs);
    payment = await findPayment();

    if (payment) {
      return payment;
    }
  }

  return null;
}
