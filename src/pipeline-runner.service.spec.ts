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

  it('maps failed>0 to partial and writes counts', async () => {
    bulkDownload.download.mockResolvedValue('/tmp/edgar');
    tickerMap.fetch.mockResolvedValue(new Map());
    stockList.getActiveUsStocks.mockResolvedValue([{ stockId: 1, symbol: 'AAPL' }]);
    factsReader.readAndParse.mockResolvedValue({ statements: [{}], matched: 1, failed: 2 });
    statementWriter.upsertBatch.mockResolvedValue(1);
    const status = await runner.runWithSummary();
    expect(status).toBe('partial');
    const [, result] = runSummary.write.mock.calls[0];
    expect(result.counts.stocks).toEqual({ ok: 1, failed: 2 });
    expect(result.counts.financial_statements).toEqual({ ok: 1, failed: 0 });
  });

  it('maps clean run to ok', async () => {
    bulkDownload.download.mockResolvedValue('/tmp/edgar');
    tickerMap.fetch.mockResolvedValue(new Map());
    stockList.getActiveUsStocks.mockResolvedValue([{ stockId: 1, symbol: 'AAPL' }]);
    factsReader.readAndParse.mockResolvedValue({ statements: [{}], matched: 1, failed: 0 });
    statementWriter.upsertBatch.mockResolvedValue(11);
    await expect(runner.runWithSummary()).resolves.toBe('ok');
  });
});
