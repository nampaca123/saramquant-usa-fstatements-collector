import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
} from '@aws-sdk/client-athena';
import { resolveCredentials } from './credentials';

const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 450; // 15분

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
    throw new Error(`Athena query timed out after 15m\nSQL: ${sql.slice(0, 300)}`);
  }
}
