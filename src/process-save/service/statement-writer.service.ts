import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DATA_DIR } from '../../config';
import { AthenaClientService } from '../../aws/athena-client.service';
import { S3ClientService } from '../../aws/s3-client.service';
import { DuckDbClientService } from '../../database/lib/duckdb-client.service';
import { FinancialStatement } from './facts-parser.service';
import {
  createIcebergTableSql,
  createStagingSql,
  dropStagingSql,
  mergeSql,
  optimizeSql,
  vacuumSql,
} from '../lib/athena-sql';

@Injectable()
export class StatementWriterService {
  private readonly logger = new Logger(StatementWriterService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly duckdb: DuckDbClientService,
    private readonly s3: S3ClientService,
    private readonly athena: AthenaClientService,
  ) {}

  async upsertBatch(statements: FinancialStatement[]): Promise<number> {
    if (statements.length === 0) return 0;
    const runId = this.config.get<string>('app.runId')!;
    const db = this.config.get<string>('app.glueDb')!;
    const bucket = this.config.get<string>('app.bucket')!;

    const jsonlPath = join(DATA_DIR, 'statements.jsonl');
    const parquetPath = join(DATA_DIR, 'statements.parquet');

    const jsonl = statements
      .map((s) =>
        JSON.stringify({
          stock_id: s.stockId,
          fiscal_year: s.fiscalYear,
          report_type: s.reportType,
          revenue: s.revenue,
          operating_income: s.operatingIncome,
          net_income: s.netIncome,
          total_assets: s.totalAssets,
          total_liabilities: s.totalLiabilities,
          total_equity: s.totalEquity,
          shares_outstanding: s.sharesOutstanding,
        }),
      )
      .join('\n');
    await writeFile(jsonlPath, jsonl);

    // 로컬 Parquet 생성(zstd, 파일 내 정렬 stock_id·fiscal_year — calc 스펙 §2.3)
    const posixJsonl = jsonlPath.replace(/\\/g, '/');
    const posixParquet = parquetPath.replace(/\\/g, '/');
    await this.duckdb.run(`COPY (
      SELECT stock_id, fiscal_year, report_type,
        CAST(revenue AS DECIMAL(20,2)) AS revenue,
        CAST(operating_income AS DECIMAL(20,2)) AS operating_income,
        CAST(net_income AS DECIMAL(20,2)) AS net_income,
        CAST(total_assets AS DECIMAL(20,2)) AS total_assets,
        CAST(total_liabilities AS DECIMAL(20,2)) AS total_liabilities,
        CAST(total_equity AS DECIMAL(20,2)) AS total_equity,
        CAST(shares_outstanding AS BIGINT) AS shares_outstanding
      FROM read_json('${posixJsonl}', format='newline_delimited', columns={
        stock_id: 'BIGINT', fiscal_year: 'INTEGER', report_type: 'VARCHAR',
        revenue: 'VARCHAR', operating_income: 'VARCHAR', net_income: 'VARCHAR',
        total_assets: 'VARCHAR', total_liabilities: 'VARCHAR', total_equity: 'VARCHAR',
        shares_outstanding: 'BIGINT'})
      ORDER BY stock_id, fiscal_year
    ) TO '${posixParquet}' (FORMAT PARQUET, COMPRESSION ZSTD)`);

    await this.s3.putObject(
      `staging/financial_statements/${runId}/statements.parquet`,
      readFileSync(parquetPath),
    );
    this.logger.log(`staging uploaded: ${statements.length} rows (run ${runId})`);

    await this.athena.execute(dropStagingSql(db));
    await this.athena.execute(createStagingSql(db, bucket, runId));
    await this.athena.execute(createIcebergTableSql(db, bucket));
    await this.athena.execute(mergeSql(db));
    await this.athena.execute(optimizeSql(db));
    await this.athena.execute(vacuumSql(db));

    this.logger.log(`Merged ${statements.length} rows into ${db}.financial_statements`);
    return statements.length;
  }
}
