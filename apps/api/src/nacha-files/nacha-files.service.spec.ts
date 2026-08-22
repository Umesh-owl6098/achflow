import { NachaFilesService } from './nacha-files.service';

describe('NachaFilesService reporting dates', () => {
  afterEach(() => jest.useRealTimers());

  it('counts files generated today within one UTC reporting day only', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-22T00:01:00.000Z'));
    const countQueries: Array<{ where: unknown }> = [];
    const prisma = {
      achFile: {
        findMany: jest.fn().mockReturnValue({}),
        count: jest.fn((query: { where: unknown }) => {
          countQueries.push(query);
          return {};
        }),
        aggregate: jest.fn().mockReturnValue({}),
      },
      $transaction: jest.fn().mockResolvedValue([
        [],
        0,
        {
          _sum: {
            totalEntries: null,
            debitTotalCents: null,
            creditTotalCents: null,
          },
        },
        1,
        0,
      ]),
    };
    const service = new NachaFilesService(prisma as never);

    const result = await service.listAdmin({ dateRange: 'all' });

    expect(result.summary.filesGeneratedToday).toBe(1);
    expect(countQueries[1]).toEqual({
      where: {
        AND: [
          {},
          {
            createdAt: {
              gte: new Date('2026-08-22T00:00:00.000Z'),
              lt: new Date('2026-08-23T00:00:00.000Z'),
            },
          },
        ],
      },
    });
  });

  it('uses UTC boundaries for the today filter across midnight', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-22T00:01:00.000Z'));
    const findQueries: Array<{ where: unknown }> = [];
    const prisma = {
      achFile: {
        findMany: jest.fn((query: { where: unknown }) => {
          findQueries.push(query);
          return {};
        }),
        count: jest.fn().mockReturnValue({}),
        aggregate: jest.fn().mockReturnValue({}),
      },
      $transaction: jest.fn().mockResolvedValue([
        [],
        0,
        {
          _sum: {
            totalEntries: null,
            debitTotalCents: null,
            creditTotalCents: null,
          },
        },
        0,
        0,
      ]),
    };
    const service = new NachaFilesService(prisma as never);

    await service.listAdmin({ dateRange: 'today' });

    expect(findQueries[0]).toEqual(
      expect.objectContaining({
        where: {
          createdAt: {
            gte: new Date('2026-08-22T00:00:00.000Z'),
            lt: new Date('2026-08-23T00:00:00.000Z'),
          },
        },
      }),
    );
  });
});
