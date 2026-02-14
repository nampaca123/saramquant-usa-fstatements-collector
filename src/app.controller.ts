import {
  Controller,
  Post,
  Get,
  Param,
  HttpCode,
  HttpStatus,
  UseGuards,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { v4 as uuid } from 'uuid';
import { ApiKeyGuard } from './api-key.guard';
import { BulkDownloadService } from './fetch-edgar/service/bulk-download.service';
import { TickerMapService } from './fetch-edgar/service/ticker-map.service';
import { StockListService } from './database/service/stock-list.service';
import { FactsParserService } from './process-save/service/facts-parser.service';
import { StatementWriterService } from './process-save/service/statement-writer.service';
import type { FinancialStatement } from './process-save/service/facts-parser.service';

interface JobStatus {
  jobId: string;
  status: 'processing' | 'completed' | 'failed';
  result?: { success: number; failed: number };
  error?: string;
}

const jobs = new Map<string, JobStatus>();

@Controller('usa-financial-statements')
export class AppController {
  private readonly logger = new Logger(AppController.name);

  constructor(
    private readonly bulkDownload: BulkDownloadService,
    private readonly tickerMap: TickerMapService,
    private readonly stockList: StockListService,
    private readonly factsParser: FactsParserService,
    private readonly statementWriter: StatementWriterService,
  ) {}

  @Post('collect')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(ApiKeyGuard)
  collect(): JobStatus {
    const jobId = uuid();
    const status: JobStatus = { jobId, status: 'processing' };
    jobs.set(jobId, status);

    this.runPipeline(jobId).catch((err) => {
      this.logger.error(`Job ${jobId} failed: ${err}`);
      const job = jobs.get(jobId);
      if (job) {
        job.status = 'failed';
        job.error = String(err);
      }
    });

    return status;
  }

  @Get('status/:jobId')
  getStatus(@Param('jobId') jobId: string): JobStatus {
    const job = jobs.get(jobId);
    if (!job) throw new NotFoundException(`Job ${jobId} not found`);
    return job;
  }

  @Get('health')
  health() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  private async runPipeline(jobId: string): Promise<void> {
    const dataDir = await this.bulkDownload.download();

    const [tickerToCik, stocks] = await Promise.all([
      this.tickerMap.fetch(),
      this.stockList.getActiveUsStocks(),
    ]);

    if (stocks.length === 0) {
      this.logger.warn('No active US stocks in DB');
      this.completeJob(jobId, 0, 0);
      return;
    }

    const allStatements: FinancialStatement[] = [];
    let matched = 0;
    let failed = 0;

    for (let i = 0; i < stocks.length; i++) {
      const { stockId, symbol } = stocks[i];
      const cik = tickerToCik.get(symbol.toUpperCase());
      if (!cik) continue;

      try {
        const filePath = join(dataDir, `CIK${String(cik).padStart(10, '0')}.json`);
        const raw = await readFile(filePath, 'utf-8').catch(() => null);
        if (!raw) continue;

        const facts = JSON.parse(raw);
        const stmts = this.factsParser.extractFromFacts(stockId, facts);
        allStatements.push(...stmts);
        matched++;
      } catch (err) {
        this.logger.warn(`Skip ${symbol} (${stockId}): ${err}`);
        failed++;
      }

      if ((i + 1) % 1000 === 0) {
        this.logger.log(
          `Parsed ${i + 1}/${stocks.length} stocks, ${allStatements.length} stmts`,
        );
      }
    }

    const saved = await this.statementWriter.upsertBatch(allStatements);
    this.logger.log(
      `Done: ${saved} saved from ${matched} stocks, ${failed} failed`,
    );
    this.completeJob(jobId, saved, failed);
  }

  private completeJob(jobId: string, success: number, failed: number): void {
    const job = jobs.get(jobId);
    if (job) {
      job.status = 'completed';
      job.result = { success, failed };
    }
  }
}
