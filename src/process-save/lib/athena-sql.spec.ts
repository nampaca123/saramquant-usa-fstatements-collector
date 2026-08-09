import {
  createIcebergTableSql,
  createStagingSql,
  dropStagingSql,
  mergeSql,
  optimizeSql,
  vacuumSql,
} from './athena-sql';

describe('athena-sql', () => {
  it('creates iceberg table partitioned by market with zstd', () => {
    const sql = createIcebergTableSql('saramquant', 'saramquant-bucket');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS saramquant.financial_statements');
    expect(sql).toContain('PARTITIONED BY (market)');
    expect(sql).toContain("'table_type'='ICEBERG'");
    expect(sql).toContain("'write_compression'='ZSTD'");
    expect(sql).toContain('s3://saramquant-bucket/warehouse/financial_statements');
    expect(sql).toContain('revenue decimal(20,2)');
    expect(sql).toContain('shares_outstanding bigint');
    expect(sql).not.toContain(' id ');
  });

  it('binds staging table to run-scoped location', () => {
    const sql = createStagingSql('saramquant', 'saramquant-bucket', 'run-42');
    expect(sql).toContain('financial_statements_staging_us');
    expect(sql).toContain('s3://saramquant-bucket/staging/financial_statements/run-42/');
    expect(sql).toContain('STORED AS PARQUET');
  });

  it('drops staging idempotently', () => {
    expect(dropStagingSql('saramquant')).toBe(
      'DROP TABLE IF EXISTS saramquant.financial_statements_staging_us',
    );
  });

  it('merges on natural key scoped to US market', () => {
    const sql = mergeSql('saramquant');
    expect(sql).toContain('MERGE INTO saramquant.financial_statements t');
    expect(sql).toContain("t.market = 'US'");
    expect(sql).toContain('t.stock_id = s.stock_id');
    expect(sql).toContain('t.fiscal_year = s.fiscal_year');
    expect(sql).toContain('t.report_type = s.report_type');
    expect(sql).toContain('WHEN MATCHED THEN UPDATE');
    expect(sql).toContain('WHEN NOT MATCHED THEN INSERT');
    expect(sql).toContain("VALUES ('US'");
  });

  it('optimize scopes to US partition and vacuum targets table', () => {
    expect(optimizeSql('saramquant')).toContain(
      "OPTIMIZE saramquant.financial_statements REWRITE DATA USING BIN_PACK WHERE market = 'US'",
    );
    expect(vacuumSql('saramquant')).toBe('VACUUM saramquant.financial_statements');
  });
});
