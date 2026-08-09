import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3ClientService } from './aws/s3-client.service';
import type { PipelineResult } from './pipeline-runner.service';

// calc 스펙 §6.1 공통 포맷
export interface RunSummary {
  run_id: string;
  service: 'usa-fstatements';
  command: 'collect';
  status: 'ok' | 'partial' | 'error';
  started_at_utc: string;
  written_at_utc: string;
  duration_ms: number;
  counts: Record<string, { ok: number; failed: number }>;
  cause: string | null;
}

const SUMMARY_KEY = 'run-summary/usa_fstatements.json';

@Injectable()
export class RunSummaryService {
  private readonly logger = new Logger(RunSummaryService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly s3: S3ClientService,
  ) {}

  async write(startedAt: Date, result: PipelineResult): Promise<void> {
    const now = new Date();
    const summary: RunSummary = {
      run_id: this.config.get<string>('app.runId')!,
      service: 'usa-fstatements',
      command: 'collect',
      status: result.status,
      started_at_utc: startedAt.toISOString(),
      written_at_utc: now.toISOString(),
      duration_ms: now.getTime() - startedAt.getTime(),
      counts: result.counts,
      cause: result.cause,
    };
    // 실패 포함 런당 1레코드 — CloudWatch에도 같은 내용을 JSON 1줄로 남긴다
    this.logger.log(JSON.stringify({ event: 'run_summary', ...summary }));
    // 업로드 실패는 삼키지 않는다 — 호출자(runner)가 error로 승격해 알람 경로를 태운다
    await this.s3.putObject(SUMMARY_KEY, JSON.stringify(summary, null, 2), 'application/json');
  }
}
