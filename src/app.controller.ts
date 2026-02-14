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
import { v4 as uuid } from 'uuid';
import { ApiKeyGuard } from './api-key.guard';
import { BulkDownloadService } from './fetch-edgar/service/bulk-download.service';
import { TickerMapService } from './fetch-edgar/service/ticker-map.service';
import { StockListService } from './database/service/stock-list.service';
import { FactsReaderService } from './process-save/service/facts-reader.service';
import { StatementWriterService } from './process-save/service/statement-writer.service';

interface JobProgress {
  phase: string;
  parsed?: number;
  total?: number;
}

interface JobStatus {
  jobId: string;
  status: 'processing' | 'completed' | 'failed';
  progress?: JobProgress;
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
    private readonly factsReader: FactsReaderService,
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

  private updateProgress(jobId: string, phase: string, parsed?: number, total?: number): void {
    const job = jobs.get(jobId);
    if (job) job.progress = { phase, parsed, total };
  }

  private async runPipeline(jobId: string): Promise<void> {
    this.updateProgress(jobId, 'downloading');
    const dataDir = await this.bulkDownload.download();

    this.updateProgress(jobId, 'loading metadata');
    const [tickerToCik, stocks] = await Promise.all([
      this.tickerMap.fetch(),
      this.stockList.getActiveUsStocks(),
    ]);

    if (stocks.length === 0) {
      this.logger.warn('No active US stocks in DB');
      this.completeJob(jobId, 0, 0);
      return;
    }

    this.updateProgress(jobId, 'parsing', 0, stocks.length);
    const { statements, matched, failed } = await this.factsReader.readAndParse(
      dataDir,
      stocks,
      tickerToCik,
      (parsed, total) => this.updateProgress(jobId, 'parsing', parsed, total),
    );

    this.updateProgress(jobId, 'writing to DB');
    const saved = await this.statementWriter.upsertBatch(statements);
    this.logger.log(`Done: ${saved} saved from ${matched} stocks, ${failed} failed`);
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
