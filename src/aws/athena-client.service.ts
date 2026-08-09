import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  StopQueryExecutionCommand,
} from '@aws-sdk/client-athena';
import { resolveCredentials } from './credentials';

const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 1350; // 45분 — SFN 상태 타임아웃(7200s)보다 넉넉히 짧게
// Iceberg 낙관적 커밋 충돌(calc KR MERGE와 동시 실행 등)은 재실행으로 자가 복구된다
const RETRYABLE = /ICEBERG_COMMIT_ERROR|CONCURRENT/i;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [30_000, 60_000];

@Injectable()
export class AthenaClientService {
  private readonly logger = new Logger(AthenaClientService.name);
  private readonly client: AthenaClient;

  constructor(private readonly config: ConfigService) {
    this.client = new AthenaClient({
      region: this.config.get<string>('app.dataRegion'),
      credentials: resolveCredentials(),
    });
  }

  async execute(sql: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.executeOnce(sql);
        return;
      } catch (err) {
        if (attempt < MAX_ATTEMPTS && RETRYABLE.test(String(err))) {
          const wait = BACKOFF_MS[attempt - 1];
          this.logger.warn(`retryable athena failure (attempt ${attempt}), backing off ${wait}ms`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        throw err;
      }
    }
  }

  private async executeOnce(sql: string): Promise<void> {
    const started = await this.client.send(
      new StartQueryExecutionCommand({
        QueryString: sql,
        WorkGroup: this.config.get<string>('app.athenaWorkgroup'),
        QueryExecutionContext: {
          Catalog: 'AwsDataCatalog',
          Database: this.config.get<string>('app.glueDb'),
        },
      }),
    );
    const queryId = started.QueryExecutionId!;

    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const res = await this.client.send(
        new GetQueryExecutionCommand({ QueryExecutionId: queryId }),
      );
      const state = res.QueryExecution?.Status?.State;
      if (state === 'SUCCEEDED') return;
      if (state === 'FAILED' || state === 'CANCELLED') {
        const reason = res.QueryExecution?.Status?.StateChangeReason ?? state;
        throw new Error(`Athena query ${state}: ${reason}\nSQL: ${sql.slice(0, 300)}`);
      }
    }

    // 클라이언트만 죽고 쿼리가 서버에서 계속 돌면 폴백 재실행과 MERGE가 겹친다 — 반드시 취소
    try {
      await this.client.send(new StopQueryExecutionCommand({ QueryExecutionId: queryId }));
      this.logger.warn(`query ${queryId} cancelled after client timeout`);
    } catch (err) {
      this.logger.error(`failed to cancel query ${queryId}: ${err}`);
    }
    throw new Error(`Athena query timed out after 45m (cancelled)\nSQL: ${sql.slice(0, 300)}`);
  }
}
