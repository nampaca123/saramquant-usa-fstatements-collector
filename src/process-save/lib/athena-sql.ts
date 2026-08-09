// financial_statements 스키마·MERGE 키의 단일 소스는 calc 스펙 §2.3 —
// 컬럼 추가/삭제/개명 금지 (market은 §2.2 예외 2번의 파티션 키)
const MONEY_COLS = [
  'revenue',
  'operating_income',
  'net_income',
  'total_assets',
  'total_liabilities',
  'total_equity',
] as const;

const moneyDdl = MONEY_COLS.map((c) => `${c} decimal(20,2)`).join(',\n  ');

export function createIcebergTableSql(db: string, bucket: string): string {
  return `CREATE TABLE IF NOT EXISTS ${db}.financial_statements (
  market string,
  stock_id bigint,
  fiscal_year int,
  report_type string,
  ${moneyDdl},
  shares_outstanding bigint,
  created_at timestamp
)
PARTITIONED BY (market)
LOCATION 's3://${bucket}/warehouse/financial_statements/'
TBLPROPERTIES ('table_type'='ICEBERG', 'format'='parquet', 'write_compression'='ZSTD')`;
}

export function dropStagingSql(db: string): string {
  return `DROP TABLE IF EXISTS ${db}.financial_statements_staging_us`;
}

export function createStagingSql(db: string, bucket: string, runId: string): string {
  return `CREATE EXTERNAL TABLE ${db}.financial_statements_staging_us (
  stock_id bigint,
  fiscal_year int,
  report_type string,
  ${moneyDdl},
  shares_outstanding bigint
)
STORED AS PARQUET
LOCATION 's3://${bucket}/staging/financial_statements/${runId}/'`;
}

export function mergeSql(db: string): string {
  const updates = MONEY_COLS.map((c) => `${c} = s.${c}`).join(', ');
  const cols = MONEY_COLS.join(', ');
  const sVals = MONEY_COLS.map((c) => `s.${c}`).join(', ');
  return `MERGE INTO ${db}.financial_statements t
USING ${db}.financial_statements_staging_us s
ON t.market = 'US' AND t.stock_id = s.stock_id
  AND t.fiscal_year = s.fiscal_year AND t.report_type = s.report_type
WHEN MATCHED THEN UPDATE SET ${updates}, shares_outstanding = s.shares_outstanding
WHEN NOT MATCHED THEN INSERT
  (market, stock_id, fiscal_year, report_type, ${cols}, shares_outstanding, created_at)
  VALUES ('US', s.stock_id, s.fiscal_year, s.report_type, ${sVals}, s.shares_outstanding,
          CAST(current_timestamp AS timestamp))`;
}

export function optimizeSql(db: string): string {
  return `OPTIMIZE ${db}.financial_statements REWRITE DATA USING BIN_PACK WHERE market = 'US'`;
}

export function vacuumSql(db: string): string {
  return `VACUUM ${db}.financial_statements`;
}
