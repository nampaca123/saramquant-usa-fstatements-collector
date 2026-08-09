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

// 파싱 실패율이 이 이하면 ok — 소비자(calc us-fs 게이트)는 status!=='ok'를 전부 리젝트하므로,
// 6천 종목 중 낱개 실패로 분기 전체 펀더멘털이 멈추지 않게 허용 오차를 둔다
const PARTIAL_THRESHOLD = 0.01;

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
    }
    try {
      await this.runSummary.write(startedAt, result);
    } catch (err) {
      // 서머리가 없으면 calc 게이트가 스테일 파일을 읽고 무음 리젝트한다 — error로 승격해 알람 경로를 태운다
      this.logger.error(`run-summary upload failed: ${err}`);
      if (result.status !== 'error') return 'error';
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

    const { saved, coerced } = await this.statementWriter.upsertBatch(statements);
    this.logger.log(`Done: ${saved} rows merged from ${matched} stocks, ${failed} failed`);

    const failRate = failed / Math.max(matched + failed, 1);
    return {
      status: failRate > PARTIAL_THRESHOLD ? 'partial' : 'ok',
      counts: {
        stocks: { ok: matched, failed },
        // SEC 티커맵에 없어 매칭 자체가 안 된 종목 — failed와 별개로 가시화
        ticker_match: { ok: matched, failed: Math.max(stocks.length - matched - failed, 0) },
        financial_statements: { ok: saved, failed: coerced },
      },
      cause: failRate > PARTIAL_THRESHOLD ? `parse failure rate ${(failRate * 100).toFixed(1)}%` : null,
    };
  }
}
