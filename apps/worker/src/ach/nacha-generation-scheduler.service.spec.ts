import { NachaFileGeneratorService } from './nacha-file-generator.service';
import { NachaGenerationSchedulerService } from './nacha-generation-scheduler.service';
import { WorkerConfigService } from '../worker-config.service';

const config = (enabled?: string) =>
  new WorkerConfigService({
    DATABASE_URL: 'postgresql://worker:worker@localhost:5432/worker',
    ...(enabled === undefined ? {} : { NACHA_GENERATION_ENABLED: enabled }),
  });

const generatedFile = (totalEntries: number) => ({
  file: '9'.repeat(94),
  metadata: {
    id: 'nacha-file-1',
    totalEntries,
    debitTotalCents: BigInt(0),
    creditTotalCents: BigInt(0),
    entryHash: '0',
  },
});

describe('NachaGenerationSchedulerService', () => {
  it('does nothing when generation is absent or explicitly disabled', async () => {
    const generator = { generateAll: jest.fn() };
    for (const enabled of [undefined, 'false']) {
      const service = new NachaGenerationSchedulerService(
        generator as unknown as NachaFileGeneratorService,
        config(enabled),
      );
      await expect(service.processOnce()).resolves.toEqual({
        status: 'DISABLED',
        fileCount: 0,
        paymentCount: 0,
      });
    }
    expect(generator.generateAll).not.toHaveBeenCalled();
  });

  it('invokes the existing generator and reports exported files and payments', async () => {
    const generator = {
      generateAll: jest
        .fn()
        .mockResolvedValue([generatedFile(2), generatedFile(3)]),
    };
    const service = new NachaGenerationSchedulerService(
      generator as unknown as NachaFileGeneratorService,
      config('true'),
    );

    await expect(service.processOnce()).resolves.toEqual({
      status: 'COMPLETED',
      fileCount: 2,
      paymentCount: 5,
    });
    expect(generator.generateAll).toHaveBeenCalledTimes(1);
    expect(generator.generateAll).toHaveBeenCalledWith(expect.any(Date));
  });

  it('completes without creating files when no payments are eligible', async () => {
    const generator = { generateAll: jest.fn().mockResolvedValue([]) };
    const service = new NachaGenerationSchedulerService(
      generator as unknown as NachaFileGeneratorService,
      config('true'),
    );

    await expect(service.processOnce()).resolves.toEqual({
      status: 'COMPLETED',
      fileCount: 0,
      paymentCount: 0,
    });
  });

  it('does not overlap executions within one worker instance', async () => {
    let resolveGeneration:
      ((value: ReturnType<typeof generatedFile>[]) => void) | undefined;
    const generator = {
      generateAll: jest.fn(
        () =>
          new Promise<ReturnType<typeof generatedFile>[]>((resolve) => {
            resolveGeneration = resolve;
          }),
      ),
    };
    const service = new NachaGenerationSchedulerService(
      generator as unknown as NachaFileGeneratorService,
      config('true'),
    );

    const first = service.processOnce();
    await expect(service.processOnce()).resolves.toEqual({
      status: 'SKIPPED',
      fileCount: 0,
      paymentCount: 0,
    });
    expect(generator.generateAll).toHaveBeenCalledTimes(1);

    resolveGeneration?.([generatedFile(1)]);
    await expect(first).resolves.toEqual({
      status: 'COMPLETED',
      fileCount: 1,
      paymentCount: 1,
    });
  });

  it('runs subsequent ticks after a completed generation without duplicating its result', async () => {
    const generator = {
      generateAll: jest
        .fn()
        .mockResolvedValueOnce([generatedFile(1)])
        .mockResolvedValueOnce([]),
    };
    const service = new NachaGenerationSchedulerService(
      generator as unknown as NachaFileGeneratorService,
      config('true'),
    );

    await service.processOnce();
    await expect(service.processOnce()).resolves.toEqual({
      status: 'COMPLETED',
      fileCount: 0,
      paymentCount: 0,
    });
    expect(generator.generateAll).toHaveBeenCalledTimes(2);
  });
});
