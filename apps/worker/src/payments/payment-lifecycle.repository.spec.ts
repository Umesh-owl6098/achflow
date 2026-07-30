import { PaymentStatus } from '@prisma/client';
import { WorkerPrismaService } from '../worker-prisma.service';
import {
  PaymentLifecycleRepository,
  ValidationResult,
} from './payment-lifecycle.repository';

const validResult: ValidationResult = {
  status: PaymentStatus.VALIDATED,
  code: null,
  message: null,
};

describe('PaymentLifecycleRepository', () => {
  it.each([PaymentStatus.VALIDATED, PaymentStatus.VALIDATION_FAILED])(
    'treats an already terminal %s payment as idempotent',
    async (status) => {
      const prisma = {
        payment: {
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
          findUnique: jest.fn().mockResolvedValue({ status }),
        },
        outboxEvent: { create: jest.fn() },
      };
      Object.assign(prisma, {
        $transaction: async (
          callback: (transaction: typeof prisma) => Promise<unknown>,
        ) => callback(prisma),
      });
      const repository = new PaymentLifecycleRepository(
        prisma as unknown as WorkerPrismaService,
      );

      await expect(
        repository.transitionFromReceived('pay-1', validResult),
      ).resolves.toBeUndefined();
    },
  );

  it('rejects an unsupported current status safely', async () => {
    const prisma = {
      payment: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findUnique: jest
          .fn()
          .mockResolvedValue({ status: PaymentStatus.SUBMITTED }),
      },
      outboxEvent: { create: jest.fn() },
    };
    Object.assign(prisma, {
      $transaction: async (
        callback: (transaction: typeof prisma) => Promise<unknown>,
      ) => callback(prisma),
    });
    const repository = new PaymentLifecycleRepository(
      prisma as unknown as WorkerPrismaService,
    );

    await expect(
      repository.transitionFromReceived('pay-1', validResult),
    ).rejects.toThrow('Payment is not eligible for validation');
  });
});
