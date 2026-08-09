import { PipelineRunnerService } from './pipeline-runner.service';

describe('PipelineRunnerService.runWithSummary', () => {
  const bulkDownload = { download: jest.fn() };
  const tickerMap = { fetch: jest.fn() };
  const stockList = { getActiveUsStocks: jest.fn() };
  const factsReader = { readAndParse: jest.fn() };
  const statementWriter = { upsertBatch: jest.fn() };
  const runSummary = { write: jest.fn() };

  const runner = new PipelineRunnerService(
    bulkDownload as never,
    tickerMap as never,
    stockList as never,
    factsReader as never,
    statementWriter as never,
    runSummary as never,
  );

  const stubHappyPath = (matched: number, failed: number, stockCount = matched + failed) => {
    bulkDownload.download.mockResolvedValue('/tmp/edgar');
    tickerMap.fetch.mockResolvedValue(new Map());
    stockList.getActiveUsStocks.mockResolvedValue(
      Array.from({ length: stockCount }, (_, i) => ({ stockId: i + 1, symbol: `S${i}` })),
    );
    factsReader.readAndParse.mockResolvedValue({ statements: [{}], matched, failed });
    statementWriter.upsertBatch.mockResolvedValue({ saved: 11, coerced: 0 });
  };

  beforeEach(() => {
    jest.resetAllMocks();
    runSummary.write.mockResolvedValue(undefined);
  });

  it('writes error summary when pipeline throws', async () => {
    bulkDownload.download.mockRejectedValue(new Error('boom'));
    const status = await runner.runWithSummary();
    expect(status).toBe('error');
    expect(runSummary.write).toHaveBeenCalledTimes(1);
    const [, result] = runSummary.write.mock.calls[0];
    expect(result.status).toBe('error');
    expect(result.cause).toContain('boom');
  });

  it('returns error when no active US stocks (calc dependency)', async () => {
    bulkDownload.download.mockResolvedValue('/tmp/edgar');
    tickerMap.fetch.mockResolvedValue(new Map());
    stockList.getActiveUsStocks.mockResolvedValue([]);
    const status = await runner.runWithSummary();
    expect(status).toBe('error');
    const [, result] = runSummary.write.mock.calls[0];
    expect(result.cause).toContain('no active US stocks');
  });

  it('tolerates failure rate at or below 1% as ok', async () => {
    stubHappyPath(5900, 10); // 0.17%
    await expect(runner.runWithSummary()).resolves.toBe('ok');
  });

  it('maps failure rate above 1% to partial', async () => {
    stubHappyPath(50, 50); // 50%
    const status = await runner.runWithSummary();
    expect(status).toBe('partial');
    const [, result] = runSummary.write.mock.calls[0];
    expect(result.counts.stocks).toEqual({ ok: 50, failed: 50 });
    expect(result.cause).toContain('parse failure rate');
  });

  it('escalates run-summary upload failure to error', async () => {
    stubHappyPath(100, 0);
    runSummary.write.mockRejectedValue(new Error('s3 down'));
    await expect(runner.runWithSummary()).resolves.toBe('error');
  });

  it('maps clean run to ok and records coerced cells', async () => {
    stubHappyPath(100, 0);
    statementWriter.upsertBatch.mockResolvedValue({ saved: 11, coerced: 3 });
    await expect(runner.runWithSummary()).resolves.toBe('ok');
    const [, result] = runSummary.write.mock.calls[0];
    expect(result.counts.financial_statements).toEqual({ ok: 11, failed: 3 });
  });
});
