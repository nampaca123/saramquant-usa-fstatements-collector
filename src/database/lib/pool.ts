import { Injectable, OnModuleDestroy, Inject } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Pool, QueryResult } from 'pg';
import appConfig from '../../config';

@Injectable()
export class DatabasePool implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor(
    @Inject(appConfig.KEY) private cfg: ConfigType<typeof appConfig>,
  ) {
    this.pool = new Pool({
      connectionString: cfg.databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
    });
  }

  query(sql: string, params?: unknown[]): Promise<QueryResult> {
    return this.pool.query(sql, params);
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
