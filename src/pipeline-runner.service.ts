import { Injectable, Logger } from '@nestjs/common';
import { BulkDownloadService } from './fetch-edgar/service/bulk-download.service';
import { TickerMapService } from './fetch-edgar/service/ticker-map.service';
import { StockListService } from './database/service/stock-list.service';
import { FactsReaderService } from './process-save/service/facts-reader.service';
import { StatementWriterService } from './process-save/service/statement-writer.service';
import { RunSummaryService } from './run-summary.service';

export interface PipelineResult {
  status: 'ok' | 'partial' | 'error';
  counts: Record<string, { ok: number; failed: number }>;
  cause: string | null;
}

@Injectable()
export class PipelineRunnerService {
  private readonly logger = new Logger(PipelineRunnerService.name);

  constructor(
    private readonly bulkDownload: BulkDownloadService,
    private readonly tickerMap: TickerMapService,
    private readonly stockList: StockListService,
    private readonly factsReader: FactsReaderService,
    private readonly statementWriter: StatementWriterService,
    private readonly runSummary: RunSummaryService,
  ) {}

  async runWithSummary(): Promise<PipelineResult['status']> {
    const startedAt = new Date();
    let result: PipelineResult = { status: 'error', counts: {}, cause: 'not started' };
    try {
      result = await this.run();
    } catch (err) {
      result = { status: 'error', counts: {}, cause: String(err) };
      this.logger.error(`pipeline crashed: ${err}`);
    } finally {
      await this.runSummary.write(startedAt, result);
    }
    return result.status;
  }

  private async run(): Promise<PipelineResult> {
    const dataDir = await this.bulkDownload.download();

    const [tickerToCik, stocks] = await Promise.all([
      this.tickerMap.fetch(),
      this.stockList.getActiveUsStocks(),
    ]);

    if (stocks.length === 0) {
      return {
        status: 'error',
        counts: { stocks: { ok: 0, failed: 0 } },
        cause: 'no active US stocks in saramquant.stocks (calc session dependency)',
      };
    }

    const { statements, matched, failed } = await this.factsReader.readAndParse(
      dataDir,
      stocks,
      tickerToCik,
      (parsed, total) => {
        if (parsed % 500 === 0) this.logger.log(`parsing ${parsed}/${total}`);
      },
    );

    const saved = await this.statementWriter.upsertBatch(statements);
    this.logger.log(`Done: ${saved} rows merged from ${matched} stocks, ${failed} failed`);
    return {
      status: failed > 0 ? 'partial' : 'ok',
      counts: {
        stocks: { ok: matched, failed },
        financial_statements: { ok: saved, failed: 0 },
      },
      cause: null,
    };
  }
}
