import {
  createIcebergTableSql,
  createStagingSql,
  dropStagingSql,
  mergeSql,
  optimizeSql,
  stagingTableName,
  vacuumSql,
} from './athena-sql';

describe('athena-sql', () => {
  it('scopes staging table name to run and sanitizes for glue', () => {
    expect(stagingTableName('run-42')).toBe('financial_statements_staging_us_run_42');
    expect(stagingTableName('Cold-260810')).toBe('financial_statements_staging_us_cold_260810');
    expect(stagingTableName('a.b:c/d')).toBe('financial_statements_staging_us_a_b_c_d');
  });

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
    const t = stagingTableName('run-42');
    const sql = createStagingSql('saramquant', t, 'saramquant-bucket', 'run-42');
    expect(sql).toContain(`CREATE EXTERNAL TABLE saramquant.${t}`);
    expect(sql).toContain('s3://saramquant-bucket/staging/financial_statements/run-42/');
    expect(sql).toContain('STORED AS PARQUET');
  });

  it('drops staging idempotently', () => {
    expect(dropStagingSql('saramquant', 'financial_statements_staging_us_run_42')).toBe(
      'DROP TABLE IF EXISTS saramquant.financial_statements_staging_us_run_42',
    );
  });

  it('merges on natural key scoped to US market', () => {
    const sql = mergeSql('saramquant', 'financial_statements_staging_us_run_42');
    expect(sql).toContain('MERGE INTO saramquant.financial_statements t');
    expect(sql).toContain('USING saramquant.financial_statements_staging_us_run_42 s');
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
