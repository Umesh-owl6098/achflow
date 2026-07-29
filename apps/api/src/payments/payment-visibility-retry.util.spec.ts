import {
  findPaymentWithVisibilityRetry,
  paymentVisibilityRetryDelaysMs,
} from './payment-visibility-retry.util';

describe('findPaymentWithVisibilityRetry', () => {
  it('returns a payment without waiting when it is visible immediately', async () => {
    const payment = { id: 'pay-1' };
    const findPayment = jest.fn().mockResolvedValue(payment);
    const wait = jest.fn().mockResolvedValue(undefined);

    await expect(
      findPaymentWithVisibilityRetry(findPayment, wait),
    ).resolves.toBe(payment);

    expect(findPayment).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('retries using bounded delays until the payment is visible', async () => {
    const payment = { id: 'pay-1' };
    const findPayment = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(payment);
    const wait = jest.fn().mockResolvedValue(undefined);

    await expect(
      findPaymentWithVisibilityRetry(findPayment, wait),
    ).resolves.toBe(payment);

    expect(findPayment).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenNthCalledWith(1, paymentVisibilityRetryDelaysMs[0]);
    expect(wait).toHaveBeenNthCalledWith(2, paymentVisibilityRetryDelaysMs[1]);
  });
});
