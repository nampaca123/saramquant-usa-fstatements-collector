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
  stagingTableName,
  vacuumSql,
} from '../lib/athena-sql';

const MONEY_FIELDS = [
  'revenue',
  'operating_income',
  'net_income',
  'total_assets',
  'total_liabilities',
  'total_equity',
] as const;

export interface WriteResult {
  saved: number;
  coerced: number; // DECIMAL(20,2)/BIGINT 범위를 벗어나 null로 강제된 셀 수
}

@Injectable()
export class StatementWriterService {
  private readonly logger = new Logger(StatementWriterService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly duckdb: DuckDbClientService,
    private readonly s3: S3ClientService,
    private readonly athena: AthenaClientService,
  ) {}

  async upsertBatch(statements: FinancialStatement[]): Promise<WriteResult> {
    if (statements.length === 0) return { saved: 0, coerced: 0 };
    const runId = this.config.get<string>('app.runId')!;
    const db = this.config.get<string>('app.glueDb')!;
    const bucket = this.config.get<string>('app.bucket')!;
    const staging = stagingTableName(runId);

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

    const posixJsonl = jsonlPath.replace(/\\/g, '/');
    const posixParquet = parquetPath.replace(/\\/g, '/');
    // 전 수치 필드 VARCHAR로 읽고 TRY_CAST — XBRL 단위 오기재 등 범위 초과 값 하나가
    // COPY 전체(=런 전체)를 죽이지 않게 셀 단위로 null 강제
    const readJson = `read_json('${posixJsonl}', format='newline_delimited', columns={
        stock_id: 'BIGINT', fiscal_year: 'INTEGER', report_type: 'VARCHAR',
        revenue: 'VARCHAR', operating_income: 'VARCHAR', net_income: 'VARCHAR',
        total_assets: 'VARCHAR', total_liabilities: 'VARCHAR', total_equity: 'VARCHAR',
        shares_outstanding: 'VARCHAR'})`;
    const moneySelect = MONEY_FIELDS.map(
      (c) => `TRY_CAST(${c} AS DECIMAL(20,2)) AS ${c}`,
    ).join(',\n        ');

    await this.duckdb.run(`COPY (
      SELECT stock_id, fiscal_year, report_type,
        ${moneySelect},
        TRY_CAST(shares_outstanding AS BIGINT) AS shares_outstanding
      FROM ${readJson}
      ORDER BY stock_id, fiscal_year
    ) TO '${posixParquet}' (FORMAT PARQUET, COMPRESSION ZSTD)`);

    const coerceConds = [...MONEY_FIELDS.map((c) => `(${c} IS NOT NULL AND TRY_CAST(${c} AS DECIMAL(20,2)) IS NULL)`),
      `(shares_outstanding IS NOT NULL AND TRY_CAST(shares_outstanding AS BIGINT) IS NULL)`];
    const coerceRows = await this.duckdb.query(
      `SELECT ${coerceConds.map((c, i) => `count(*) FILTER (WHERE ${c}) AS c${i}`).join(', ')} FROM ${readJson}`,
    );
    const coerced = (coerceRows[0] ?? []).reduce<number>((a, v) => a + Number(v), 0);
    if (coerced > 0) this.logger.warn(`${coerced} cells out of range, coerced to null`);

    await this.s3.putObject(
      `staging/financial_statements/${runId}/statements.parquet`,
      readFileSync(parquetPath),
    );
    this.logger.log(`staging uploaded: ${statements.length} rows (run ${runId})`);

    try {
      await this.athena.execute(dropStagingSql(db, staging));
      await this.athena.execute(createStagingSql(db, staging, bucket, runId));
      await this.athena.execute(createIcebergTableSql(db, bucket));
      await this.athena.execute(mergeSql(db, staging));
      await this.athena.execute(optimizeSql(db));
      await this.athena.execute(vacuumSql(db));
    } finally {
      // 성공/실패 무관 staging 정리 — 남기면 만료된 prefix를 가리키는 좀비 테이블이 공유 Glue DB에 쌓인다
      try {
        await this.athena.execute(dropStagingSql(db, staging));
      } catch (err) {
        this.logger.warn(`staging cleanup failed (non-fatal): ${err}`);
      }
    }

    this.logger.log(`Merged ${statements.length} rows into ${db}.financial_statements`);
    return { saved: statements.length, coerced };
  }
}
