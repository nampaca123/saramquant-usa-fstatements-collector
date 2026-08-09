# usa-fstatements-collector AWS 마이그레이션 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SEC EDGAR 수집기를 Supabase/Railway에서 S3+Iceberg+Athena+Fargate(us-east-1)로 이전하고 콜드 수집을 완주한다.

**Architecture:** EventBridge(분기 4회) → 미니멀 SFN(Spot→OD 폴백) → Fargate 원샷 태스크(Node 24).
태스크가 DuckDB로 `saramquant.stocks`를 읽고, SEC zip을 파싱(기존 코드 불변)해 staging Parquet을
서울 버킷에 올린 뒤 Athena `MERGE INTO saramquant.financial_statements`를 직접 호출하고
`run-summary/usa_fstatements.json`을 기록한다. 스펙: `docs/superpowers/specs/2026-08-09-usa-fstatements-aws-migration-design.md`.

**Tech Stack:** NestJS 11(standalone context), `@duckdb/node-api`(httpfs/avro/iceberg 확장 베이크),
`@aws-sdk/client-{s3,glue,athena}`, Terraform(플랫, S3 backend + use_lockfile), GitHub Actions.

## Global Constraints

- **파서/다운로더 불변**: `src/fetch-edgar/*`, `facts-parser.service.ts`, `facts-reader.service.ts`는 수정 금지.
- 데이터 리전 `ap-northeast-2`(버킷 `saramquant-bucket`, Glue DB `saramquant`, Athena 워크그룹 `saramquant`), 컴퓨트 리전 `us-east-1`.
- MERGE 키 `(stock_id, fiscal_year, report_type)` + `market='US'`. `id` 컬럼 없음. 금액 `decimal(20,2)`, `shares_outstanding bigint`.
- 읽기는 DuckDB `iceberg_scan`만(Parquet 경로 직접 글롭 금지), 배치 쓰기는 Athena SQL만.
- 전 리소스 태그 `project=saramquant` (provider default_tags).
- Terraform 변수는 default 없이 validation 에러 메시지에 GitHub Variable명 명기. apply는 CI에서만.
- run-summary 포맷은 calc 스펙 §6.1(run_id/service/command/status/started_at_utc/written_at_utc/duration_ms/counts/cause).
- 로그 그룹은 Terraform 명시 생성, 보존 30일. 구조화 JSON 로그 런당 1줄.
- 커밋 메시지는 기존 컨벤션(`YYMMDD 소문자요약`) 유지, Co-Authored-By/Claude-Session 트레일러 포함.

---

### Task 1: 브랜치·STATUS 문서·의존성 정리

**Files:**
- Create: `docs/temp/STATUS.md`
- Modify: `package.json`
- Delete: `test/app.e2e-spec.ts`, `test/jest-e2e.json`, `src/api-key.guard.ts`, `src/database/lib/pool.ts`

**Interfaces:**
- Produces: 브랜치 `aws-migration`, 의존성 정리된 package.json (`pg`·`@nestjs/platform-express`·`uuid`·supertest류 제거, `@duckdb/node-api`·`@aws-sdk/client-s3`·`@aws-sdk/client-glue`·`@aws-sdk/client-athena`·`@aws-sdk/credential-providers` 추가)

- [ ] **Step 1: 브랜치 생성** — `git checkout -b aws-migration`
- [ ] **Step 2: STATUS.md 생성** — 진행 현황/세션 간 의존성(선행: `saramquant-tfstate` 버킷, Glue DB·워크그룹·`saramquant.stocks`는 calc 세션 소유)을 기록하는 단일 문서. 이후 매 Task 완료 시 갱신.
- [ ] **Step 3: 의존성 교체** — `npm uninstall pg @types/pg uuid @types/uuid @nestjs/platform-express supertest @types/supertest @types/express && npm install @duckdb/node-api @aws-sdk/client-s3 @aws-sdk/client-glue @aws-sdk/client-athena @aws-sdk/credential-providers`. `package.json`의 `test:e2e` 스크립트 제거.
- [ ] **Step 4: 파일 삭제** — `test/` 전체, `src/api-key.guard.ts`, `src/database/lib/pool.ts` 삭제 (후속 Task에서 참조 제거).
- [ ] **Step 5: 커밋** — `git add -A && git commit -m "260809 deps swap for aws migration"`

---

### Task 2: 원샷 러너 전환 (HTTP 서버 제거)

**Files:**
- Modify: `src/main.ts`, `src/app.module.ts`, `src/config.ts`
- Create: `src/pipeline-runner.service.ts`
- Delete: `src/app.controller.ts`

**Interfaces:**
- Consumes: 기존 `BulkDownloadService.download(): Promise<string>`, `TickerMapService.fetch()`, `StockListService.getActiveUsStocks(): Promise<StockEntry[]>`, `FactsReaderService.readAndParse(dataDir, stocks, tickerToCik, onProgress)`, `StatementWriterService.upsertBatch(statements): Promise<number>`
- Produces: `PipelineRunnerService.run(): Promise<'ok' | 'partial' | 'error'>`; `config.ts`의 `appConfig` 형태 `{ bucket, glueDb, athenaWorkgroup, dataRegion, runId, symbolLimit }`

- [ ] **Step 1: config.ts 교체**

```ts
import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  bucket: process.env.SARAMQUANT_S3_BUCKET_NAME ?? 'saramquant-bucket',
  glueDb: process.env.SARAMQUANT_GLUE_DB ?? 'saramquant',
  athenaWorkgroup: process.env.SARAMQUANT_ATHENA_WORKGROUP ?? 'saramquant',
  dataRegion: process.env.SARAMQUANT_DATA_REGION ?? 'ap-northeast-2',
  runId: process.env.RUN_ID ?? `local-${Date.now()}`,
  symbolLimit: parseInt(process.env.SYMBOL_LIMIT ?? '0', 10),
}));

export const SEC_USER_AGENT = 'SaramQuant nampaca123@gmail.com';
export const DATA_DIR = '/tmp/edgar';
```

- [ ] **Step 2: PipelineRunnerService 작성** — `app.controller.ts`의 `runPipeline`을 이식(잡맵/uuid 제거, 진행은 Logger). 반환값과 counts는 Task 6에서 run-summary로 연결.

```ts
import { Injectable, Logger } from '@nestjs/common';
import { BulkDownloadService } from './fetch-edgar/service/bulk-download.service';
import { TickerMapService } from './fetch-edgar/service/ticker-map.service';
import { StockListService } from './database/service/stock-list.service';
import { FactsReaderService } from './process-save/service/facts-reader.service';
import { StatementWriterService } from './process-save/service/statement-writer.service';

export interface PipelineResult {
  status: 'ok' | 'partial' | 'error';
  counts: Record<string, { ok: number; failed: number }>;
  cause: string | null;
}

@Injectable()
export class PipelineRunnerService {
  private readonly logger = new Logger(PipelineRunnerService.name);

  constructor(
    private readonly bulkDownload: BulkDownloadService,
    private readonly tickerMap: TickerMapService,
    private readonly stockList: StockListService,
    private readonly factsReader: FactsReaderService,
    private readonly statementWriter: StatementWriterService,
  ) {}

  async run(): Promise<PipelineResult> {
    const dataDir = await this.bulkDownload.download();

    const [tickerToCik, stocks] = await Promise.all([
      this.tickerMap.fetch(),
      this.stockList.getActiveUsStocks(),
    ]);

    if (stocks.length === 0) {
      return {
        status: 'error',
        counts: { stocks: { ok: 0, failed: 0 } },
        cause: 'no active US stocks in saramquant.stocks (calc session dependency)',
      };
    }

    const { statements, matched, failed } = await this.factsReader.readAndParse(
      dataDir,
      stocks,
      tickerToCik,
      (parsed, total) => {
        if (parsed % 500 === 0) this.logger.log(`parsing ${parsed}/${total}`);
      },
    );

    const saved = await this.statementWriter.upsertBatch(statements);
    this.logger.log(`Done: ${saved} rows merged from ${matched} stocks, ${failed} failed`);
    return {
      status: failed > 0 ? 'partial' : 'ok',
      counts: {
        stocks: { ok: matched, failed },
        financial_statements: { ok: saved, failed: 0 },
      },
      cause: null,
    };
  }
}
```

- [ ] **Step 3: main.ts 교체**

```ts
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { PipelineRunnerService } from './pipeline-runner.service';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  let exitCode = 1;
  try {
    const result = await app.get(PipelineRunnerService).run();
    exitCode = result.status === 'error' ? 1 : 0;
  } catch (err) {
    Logger.error(`pipeline crashed: ${err}`, undefined, 'Bootstrap');
  } finally {
    await app.close();
  }
  process.exit(exitCode);
}
bootstrap();
```

(주의: Task 6에서 run-summary try/finally가 `PipelineRunnerService` 바깥 래퍼로 추가되면서 main.ts가 한 번 더 바뀐다 — 여기서는 골격만.)

- [ ] **Step 4: app.module.ts에서 controller/guard 제거, PipelineRunnerService 등록**

```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import appConfig from './config';
import { DatabaseModule } from './database/database.module';
import { FetchEdgarModule } from './fetch-edgar/fetch-edgar.module';
import { ProcessSaveModule } from './process-save/process-save.module';
import { PipelineRunnerService } from './pipeline-runner.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [appConfig] }),
    DatabaseModule,
    FetchEdgarModule,
    ProcessSaveModule,
  ],
  providers: [PipelineRunnerService],
})
export class AppModule {}
```

- [ ] **Step 5: app.controller.ts 삭제 후 빌드** — `npm run build` (이 시점에는 stock-list/statement-writer가 아직 pool.ts를 import하므로 실패한다 — Task 4·5의 선행 확인용. pool import 부분만 임시 주석이 아니라, Task 4·5를 같은 브랜치에서 이어서 진행하므로 **빌드 통과는 Task 5 말미가 기준**이다.)
- [ ] **Step 6: 커밋** — `git commit -am "260809 oneshot runner"`

---

### Task 3: AWS 공용 헬퍼 (자격증명·Athena·S3)

**Files:**
- Create: `src/aws/credentials.ts`, `src/aws/athena-client.service.ts`, `src/aws/s3-client.service.ts`, `src/aws/aws.module.ts`
- Modify: `src/app.module.ts` (AwsModule import)

**Interfaces:**
- Produces:
  - `resolveCredentials(): AwsCredentialIdentityProvider` — `SARAMQUANT_IAM_KEY_ACCESS/SECRET` 환경변수가 있으면(로컬) 그것을, 없으면(Fargate 태스크 롤) 기본 체인.
  - `AthenaClientService.execute(sql: string): Promise<void>` — 워크그룹 `saramquant`(ap-northeast-2)로 실행, 2초 폴링, FAILED/CANCELLED 시 StateChangeReason 포함 throw, 15분 상한.
  - `S3ClientService.putObject(key: string, body: Buffer | string, contentType?: string): Promise<void>` — 서울 리전, 버킷은 config.

- [ ] **Step 1: credentials.ts**

```ts
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types';

export function resolveCredentials(): AwsCredentialIdentityProvider {
  const accessKeyId = process.env.SARAMQUANT_IAM_KEY_ACCESS;
  const secretAccessKey = process.env.SARAMQUANT_IAM_KEY_SECRET;
  if (accessKeyId && secretAccessKey) {
    return async () => ({ accessKeyId, secretAccessKey });
  }
  return fromNodeProviderChain();
}
```

- [ ] **Step 2: athena-client.service.ts** — `StartQueryExecutionCommand`(`WorkGroup`, `QueryExecutionContext: { Database: glueDb, Catalog: 'AwsDataCatalog' }`) → `GetQueryExecutionCommand` 폴링(2s, 최대 450회). 상태 SUCCEEDED 외 종료 상태면 `new Error(\`Athena query failed: ${reason}\nSQL: ${sql.slice(0, 300)}\`)`.
- [ ] **Step 3: s3-client.service.ts** — `PutObjectCommand({ Bucket: config.bucket, Key, Body })`.
- [ ] **Step 4: aws.module.ts** — `@Global()` 모듈로 두 서비스 export, app.module에 import.
- [ ] **Step 5: 커밋** — `git add src/aws && git commit -am "260809 aws helpers"`

---

### Task 4: DuckDB 클라이언트 + StockListService 교체

**Files:**
- Create: `src/database/lib/duckdb-client.service.ts`, `src/database/lib/glue-catalog.service.ts`
- Modify: `src/database/service/stock-list.service.ts`, `src/database/database.module.ts`

**Interfaces:**
- Consumes: `resolveCredentials()`, config(`dataRegion`, `glueDb`, `symbolLimit`)
- Produces:
  - `GlueCatalogService.metadataLocation(table: string): Promise<string>` — Glue GetTable → `Table.Parameters.metadata_location`, 없으면 throw.
  - `DuckDbClientService.query(sql: string): Promise<unknown[][]>` — 전역 연결 재사용, 호출마다 `CREATE OR REPLACE SECRET`(명시 키/토큰, REGION=ap-northeast-2).
  - `StockListService.getActiveUsStocks(): Promise<StockEntry[]>` — 인터페이스 불변(`{stockId, symbol}[]`), `symbolLimit > 0`이면 상위 N개만.

- [ ] **Step 1: duckdb-client.service.ts**

```ts
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api';
import { resolveCredentials } from '../../aws/credentials';

const EXTENSIONS = ['httpfs', 'avro', 'iceberg'];

@Injectable()
export class DuckDbClientService implements OnModuleDestroy {
  private connection: DuckDBConnection | null = null;

  constructor(private readonly config: ConfigService) {}

  private async connect(): Promise<DuckDBConnection> {
    if (!this.connection) {
      const instance = await DuckDBInstance.create(':memory:');
      const con = await instance.connect();
      const extDir = process.env.DUCKDB_EXTENSION_DIR;
      if (extDir) {
        await con.run(`SET extension_directory='${extDir}'`);
        await con.run('SET autoinstall_known_extensions=false');
        await con.run('SET autoload_known_extensions=false');
      }
      for (const ext of EXTENSIONS) await con.run(`LOAD ${ext}`);
      await con.run('SET http_retries=2');
      this.connection = con;
    }
    await this.mintSecret(this.connection);
    return this.connection;
  }

  private async mintSecret(con: DuckDBConnection): Promise<void> {
    const creds = await resolveCredentials()();
    const region = this.config.get<string>('app.dataRegion');
    const token = creds.sessionToken ?? '';
    await con.run(
      `CREATE OR REPLACE SECRET s3sec (TYPE s3, KEY_ID '${creds.accessKeyId}', ` +
        `SECRET '${creds.secretAccessKey}', SESSION_TOKEN '${token}', REGION '${region}')`,
    );
  }

  async query(sql: string): Promise<unknown[][]> {
    const con = await this.connect();
    const reader = await con.runAndReadAll(sql);
    return reader.getRows();
  }

  async run(sql: string): Promise<void> {
    const con = await this.connect();
    await con.run(sql);
  }

  onModuleDestroy(): void {
    this.connection?.closeSync();
    this.connection = null;
  }
}
```

(`@duckdb/node-api` 실제 메서드명이 다르면 — 예: `closeSync` 부재 — 설치된 버전의 타입 선언 기준으로 맞춘다. 단위는 절대 하드코딩 금지: `http_timeout`은 버전별 초/ms 단위가 달라 **설정하지 않는다**.)

- [ ] **Step 2: glue-catalog.service.ts** — `GlueClient({ region: dataRegion, credentials: resolveCredentials() })`, `GetTableCommand({ DatabaseName: glueDb, Name: table })`. `metadata_location` 부재 시 `throw new Error(\`${table}: metadata_location missing — not an Iceberg table?\`)`.
- [ ] **Step 3: stock-list.service.ts 교체**

```ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DuckDbClientService } from '../lib/duckdb-client.service';
import { GlueCatalogService } from '../lib/glue-catalog.service';

export interface StockEntry {
  stockId: number;
  symbol: string;
}

@Injectable()
export class StockListService {
  constructor(
    private readonly duckdb: DuckDbClientService,
    private readonly glue: GlueCatalogService,
    private readonly config: ConfigService,
  ) {}

  async getActiveUsStocks(): Promise<StockEntry[]> {
    const meta = await this.glue.metadataLocation('stocks');
    const rows = await this.duckdb.query(
      `SELECT id, symbol FROM iceberg_scan('${meta}')
       WHERE market IN ('US_NYSE', 'US_NASDAQ') AND is_active = true`,
    );
    const stocks = rows.map((r) => ({ stockId: Number(r[0]), symbol: String(r[1]) }));
    const limit = this.config.get<number>('app.symbolLimit') ?? 0;
    return limit > 0 ? stocks.slice(0, limit) : stocks;
  }
}
```

- [ ] **Step 4: database.module.ts** — `DatabasePool` 제거, `DuckDbClientService`/`GlueCatalogService` 등록·export.
- [ ] **Step 5: 커밋** — `git commit -am "260809 duckdb stock list"`

---

### Task 5: StatementWriterService 교체 (staging Parquet → Athena MERGE)

**Files:**
- Create: `src/process-save/lib/athena-sql.ts`, `src/process-save/lib/athena-sql.spec.ts`
- Modify: `src/process-save/service/statement-writer.service.ts`, `src/process-save/process-save.module.ts`

**Interfaces:**
- Consumes: `DuckDbClientService.run()`, `S3ClientService.putObject()`, `AthenaClientService.execute()`, config(`bucket`, `glueDb`, `runId`), `FinancialStatement`(기존: `stockId:number, fiscalYear:number, reportType:'Q1'|'Q2'|'Q3'|'FY', revenue:string|null, …, sharesOutstanding:number|null`)
- Produces: `StatementWriterService.upsertBatch(statements): Promise<number>` — 인터페이스 불변. `athenaSql` 순수 함수들: `createIcebergTableSql(db, bucket)`, `dropStagingSql(db)`, `createStagingSql(db, bucket, runId)`, `mergeSql(db)`, `optimizeSql(db)`, `vacuumSql(db)`.

- [ ] **Step 1: athena-sql.spec.ts 작성 (실패 확인)** — 각 빌더가 키 조각을 포함하는지 검증:

```ts
import { createIcebergTableSql, createStagingSql, mergeSql } from './athena-sql';

describe('athena-sql', () => {
  it('creates iceberg table partitioned by market with zstd', () => {
    const sql = createIcebergTableSql('saramquant', 'saramquant-bucket');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS saramquant.financial_statements');
    expect(sql).toContain("PARTITIONED BY (market)");
    expect(sql).toContain("'table_type'='ICEBERG'");
    expect(sql).toContain("'write_compression'='ZSTD'");
    expect(sql).toContain('s3://saramquant-bucket/warehouse/financial_statements');
    expect(sql).toContain('revenue decimal(20,2)');
  });

  it('binds staging table to run-scoped location', () => {
    const sql = createStagingSql('saramquant', 'saramquant-bucket', 'run-42');
    expect(sql).toContain('financial_statements_staging_us');
    expect(sql).toContain('s3://saramquant-bucket/staging/financial_statements/run-42/');
    expect(sql).toContain('STORED AS PARQUET');
  });

  it('merges on natural key scoped to US market', () => {
    const sql = mergeSql('saramquant');
    expect(sql).toContain('MERGE INTO saramquant.financial_statements');
    expect(sql).toContain("t.market = 'US'");
    expect(sql).toContain('t.stock_id = s.stock_id');
    expect(sql).toContain('WHEN MATCHED THEN UPDATE');
    expect(sql).toContain('WHEN NOT MATCHED THEN INSERT');
  });
});
```

Run: `npx jest athena-sql` → FAIL (모듈 없음).

- [ ] **Step 2: athena-sql.ts 구현**

```ts
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
```

- [ ] **Step 3: 테스트 통과 확인** — `npx jest athena-sql` → PASS
- [ ] **Step 4: statement-writer.service.ts 교체** — 흐름: JSONL 기록(/tmp/edgar/statements.jsonl, snake_case) → DuckDB `COPY(read_json → CAST/ORDER BY stock_id, fiscal_year) TO parquet(zstd)` → S3 업로드 → Athena 순차 실행(drop staging → create staging → create iceberg if not exists → merge → optimize → vacuum).

```ts
import { writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
// ...
async upsertBatch(statements: FinancialStatement[]): Promise<number> {
  if (statements.length === 0) return 0;
  const runId = this.config.get<string>('app.runId')!;
  const db = this.config.get<string>('app.glueDb')!;
  const bucket = this.config.get<string>('app.bucket')!;

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
  await writeFile('/tmp/edgar/statements.jsonl', jsonl);

  await this.duckdb.run(`COPY (
    SELECT stock_id, fiscal_year, report_type,
      CAST(revenue AS DECIMAL(20,2)) AS revenue,
      CAST(operating_income AS DECIMAL(20,2)) AS operating_income,
      CAST(net_income AS DECIMAL(20,2)) AS net_income,
      CAST(total_assets AS DECIMAL(20,2)) AS total_assets,
      CAST(total_liabilities AS DECIMAL(20,2)) AS total_liabilities,
      CAST(total_equity AS DECIMAL(20,2)) AS total_equity,
      CAST(shares_outstanding AS BIGINT) AS shares_outstanding
    FROM read_json('/tmp/edgar/statements.jsonl', format='newline_delimited', columns={
      stock_id: 'BIGINT', fiscal_year: 'INTEGER', report_type: 'VARCHAR',
      revenue: 'VARCHAR', operating_income: 'VARCHAR', net_income: 'VARCHAR',
      total_assets: 'VARCHAR', total_liabilities: 'VARCHAR', total_equity: 'VARCHAR',
      shares_outstanding: 'BIGINT'})
    ORDER BY stock_id, fiscal_year
  ) TO '/tmp/edgar/statements.parquet' (FORMAT PARQUET, COMPRESSION ZSTD)`);

  await this.s3.putObject(
    `staging/financial_statements/${runId}/statements.parquet`,
    readFileSync('/tmp/edgar/statements.parquet'),
  );

  await this.athena.execute(dropStagingSql(db));
  await this.athena.execute(createStagingSql(db, bucket, runId));
  await this.athena.execute(createIcebergTableSql(db, bucket));
  await this.athena.execute(mergeSql(db));
  await this.athena.execute(optimizeSql(db));
  await this.athena.execute(vacuumSql(db));

  this.logger.log(`Merged ${statements.length} rows into ${db}.financial_statements`);
  return statements.length;
}
```

- [ ] **Step 5: 전체 빌드/테스트** — `npm run build && npx jest` → PASS (이 시점부터 레포에 pg 참조 0)
- [ ] **Step 6: 커밋** — `git commit -am "260809 athena staging writer"`

---

### Task 6: run-summary + 러너 통합

**Files:**
- Create: `src/run-summary.service.ts`, `src/pipeline-runner.service.spec.ts`
- Modify: `src/pipeline-runner.service.ts`, `src/main.ts`, `src/app.module.ts`

**Interfaces:**
- Produces: `RunSummaryService.write(summary): Promise<void>` — `run-summary/usa_fstatements.json` PutObject + 동일 JSON을 Logger 1줄. 포맷(calc §6.1):

```ts
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
```

- `PipelineRunnerService.runWithSummary(): Promise<'ok' | 'partial' | 'error'>` — try/finally로 성공·실패 무관 run-summary 1건 기록.

- [ ] **Step 1: 실패 테스트 작성** — `pipeline-runner.service.spec.ts`: 파이프라인이 throw해도 summary가 `status:'error'`로 기록되는지, 성공 시 `ok`/`partial` 매핑 검증 (의존 서비스 전부 jest mock).

```ts
it('writes error summary when pipeline throws', async () => {
  bulkDownload.download.mockRejectedValue(new Error('boom'));
  const status = await runner.runWithSummary();
  expect(status).toBe('error');
  expect(runSummary.write).toHaveBeenCalledWith(
    expect.objectContaining({ status: 'error', cause: expect.stringContaining('boom') }),
  );
});
```

- [ ] **Step 2: 실행해 실패 확인** — `npx jest pipeline-runner`
- [ ] **Step 3: 구현** — `runWithSummary()`가 `run()`을 감싸고 started/written/duration/counts/cause를 채워 `RunSummaryService.write` 호출. main.ts는 `runWithSummary()` 호출로 변경, `'error'`면 exit 1.
- [ ] **Step 4: 테스트 통과 확인** — `npx jest` → PASS, `npm run build` → PASS
- [ ] **Step 5: 커밋** — `git commit -am "260809 run summary"`

---

### Task 7: Dockerfile (배치 이미지 + DuckDB 확장 베이크)

**Files:**
- Modify: `Dockerfile`

**Interfaces:**
- Produces: `node:24-slim` 기반 이미지(musl 미지원 리스크 회피 — alpine에서 변경), `DUCKDB_EXTENSION_DIR=/opt/duckdb/extensions`에 httpfs/avro/iceberg 베이크 + **빌드 시 오프라인 LOAD 검증**(실패 시 빌드 중단), `unzip` 포함, CMD 원샷.

- [ ] **Step 1: Dockerfile 교체**

```dockerfile
FROM node:24-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig*.json nest-cli.json ./
COPY src/ ./src/
RUN npm run build

FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends unzip ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
ENV DUCKDB_EXTENSION_DIR=/opt/duckdb/extensions
# 확장을 빌드 시점에 굽고 곧바로 오프라인 로드를 검증한다 — 실패하면 빌드가 죽는다
RUN node -e "const{DuckDBInstance}=require('@duckdb/node-api');(async()=>{const i=await DuckDBInstance.create(':memory:');const c=await i.connect();await c.run(\"SET extension_directory='/opt/duckdb/extensions'\");for(const e of['httpfs','avro','iceberg'])await c.run('INSTALL '+e);})().catch(e=>{console.error(e);process.exit(1)})" \
 && node -e "const{DuckDBInstance}=require('@duckdb/node-api');(async()=>{const i=await DuckDBInstance.create(':memory:');const c=await i.connect();await c.run(\"SET extension_directory='/opt/duckdb/extensions'\");await c.run('SET autoinstall_known_extensions=false');await c.run('SET autoload_known_extensions=false');for(const e of['httpfs','avro','iceberg'])await c.run('LOAD '+e);console.log('offline load ok')})().catch(e=>{console.error(e);process.exit(1)})"
CMD ["node", "dist/main.js"]
```

- [ ] **Step 2: 로컬 빌드 검증** — `docker build -t usa-fs-collector:dev .` → `offline load ok` 출력 확인. (Docker 데몬이 없으면 CI 첫 빌드에서 검증하고 STATUS.md에 기록.)
- [ ] **Step 3: 커밋** — `git commit -am "260809 batch dockerfile duckdb bake"`

---

### Task 8: Terraform 골격 (backend·provider·vpc·ecr) + 로컬 가드

**Files:**
- Create: `infra/backend.tf`, `infra/providers.tf`, `infra/variables.tf`, `infra/locals.tf`, `infra/vpc.tf`, `infra/ecr.tf`, `infra/outputs.tf`, `infra/tf`, `Makefile`

**Interfaces:**
- Produces: `local.app_name = "saramquant-usa-fs"`, `local.data_region = "ap-northeast-2"`, VPC `10.43.0.0/16` 퍼블릭 서브넷 2개(us-east-1a/b), SG `egress-only`, ECR `saramquant-usa-fs-collector`(최근 3개 라이프사이클). 변수: `bucket_name`·`glue_db`·`athena_workgroup`·`alert_email`·`image_tag` (전부 default 없음 + validation에 GitHub 변수명 명기).

- [ ] **Step 1: backend.tf / providers.tf**

```hcl
terraform {
  required_version = ">= 1.10"
  backend "s3" {
    bucket       = "saramquant-tfstate"
    key          = "usa-fstatements/terraform.tfstate"
    region       = "ap-northeast-2"
    encrypt      = true
    use_lockfile = true
  }
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

provider "aws" {
  region = "us-east-1"
  default_tags {
    tags = { project = "saramquant", service = "usa-fstatements-collector" }
  }
}
```

- [ ] **Step 2: variables.tf** — 5개 변수, 예:

```hcl
variable "bucket_name" {
  type = string
  validation {
    condition     = length(var.bucket_name) > 0
    error_message = "bucket_name required (GitHub Variable SARAMQUANT_S3_BUCKET_NAME)."
  }
}
```

(`glue_db` ← `SARAMQUANT_GLUE_DB`, `athena_workgroup` ← `SARAMQUANT_ATHENA_WORKGROUP`, `alert_email` ← `SARAMQUANT_ALERT_EMAIL`, `image_tag` ← CI가 계산한 `TF_VAR_image_tag`)

- [ ] **Step 3: locals.tf / vpc.tf / ecr.tf / outputs.tf** — locals: `app_name`, `data_region = "ap-northeast-2"`, `azs = ["us-east-1a", "us-east-1b"]`. VPC: IGW, `map_public_ip_on_launch = true` 퍼블릭 서브넷 2, 단일 라우트 테이블, us-east-1 S3 Gateway Endpoint, egress-only SG(인바운드 없음). ECR: `image_tag_mutability = "IMMUTABLE"` 대신 MUTABLE(해시 태그라 충돌 없음), 라이프사이클 `imageCountMoreThan 3` expire, `scan_on_push`.
- [ ] **Step 4: `infra/tf` 래퍼 + Makefile** — 회사 프로젝트 이식: CI(`GITHUB_ACTIONS` 미설정) 밖에서 `plan/apply/destroy/refresh/import/state/force-unlock/taint/untaint` 차단. `make check` = `cd infra && terraform init -backend=false -input=false && terraform fmt -check -recursive && terraform validate`.
- [ ] **Step 5: 검증** — `make check` → PASS (fmt/validate만, 백엔드 미접촉)
- [ ] **Step 6: 커밋** — `git add infra Makefile && git commit -m "260809 terraform skeleton"`

---

### Task 9: Terraform ECS·IAM·로그

**Files:**
- Create: `infra/ecs.tf`, `infra/iam.tf`, `infra/logs.tf`

**Interfaces:**
- Consumes: Task 8의 locals/variables/vpc/ecr
- Produces: ECS 클러스터 `saramquant-usa-fs`(capacity providers FARGATE·FARGATE_SPOT 연결), 태스크 정의 `saramquant-usa-fs-collector`(x86_64, 2048 CPU/4096 MB, ephemeral 40GiB, 컨테이너명 `collector`), 로그 그룹 `/saramquant/usa-fs-collector`(30일), 태스크 롤·실행 롤. SFN(Task 10)이 참조할 ARN들.

- [ ] **Step 1: logs.tf** — `aws_cloudwatch_log_group` 2개: `/saramquant/usa-fs-collector`, `/saramquant/usa-fs-sfn`, `retention_in_days = 30`.
- [ ] **Step 2: ecs.tf** — 클러스터 + `aws_ecs_cluster_capacity_providers`(FARGATE, FARGATE_SPOT) + 태스크 정의:

```hcl
resource "aws_ecs_task_definition" "collector" {
  family                   = "${local.app_name}-collector"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 2048
  memory                   = 4096
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"   # Fargate Spot은 ARM 미지원
  }
  ephemeral_storage { size_in_gib = 40 } # companyfacts.zip 해제 공간
  execution_role_arn = aws_iam_role.execution.arn
  task_role_arn      = aws_iam_role.task.arn
  container_definitions = jsonencode([{
    name      = "collector"
    image     = "${aws_ecr_repository.collector.repository_url}:${var.image_tag}"
    essential = true
    environment = [
      { name = "SARAMQUANT_S3_BUCKET_NAME", value = var.bucket_name },
      { name = "SARAMQUANT_GLUE_DB", value = var.glue_db },
      { name = "SARAMQUANT_ATHENA_WORKGROUP", value = var.athena_workgroup },
      { name = "SARAMQUANT_DATA_REGION", value = local.data_region },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.collector.name
        awslogs-region        = "us-east-1"
        awslogs-stream-prefix = "collector"
      }
    }
  }])
}
```

- [ ] **Step 3: iam.tf** — 3개 역할(인라인 정책):
  - `execution`: 관리형 `AmazonECSTaskExecutionRolePolicy`.
  - `task`: S3(버킷 ARN `ListBucket`·`GetBucketLocation` + 오브젝트 ARN `staging/*`·`warehouse/*`·`run-summary/*`·`athena-results/*`에 Get/Put/Delete — **Iceberg는 GetObject만으론 부족, ListBucket 필수**), Glue(`GetDatabase/GetTable/GetTables/CreateTable/DeleteTable/UpdateTable` — catalog·`database/${var.glue_db}`·`table/${var.glue_db}/*` ARN, 리전 `ap-northeast-2`), Athena(`StartQueryExecution/GetQueryExecution/StopQueryExecution` — 워크그룹 ARN).
  - `sfn`: `ecs:RunTask/StopTask/DescribeTasks`(태스크 정의 ARN — `aws_ecs_task_definition.collector.arn_without_revision` 와일드카드 `*` 부가), `iam:PassRole`(task·execution 롤, `iam:PassedToService = ecs-tasks.amazonaws.com`), `.sync` 관리형 규칙(`events:PutRule/PutTargets/DescribeRule` on `rule/StepFunctionsGetEventsForECSTaskRule`), SFN 로깅 ALL용 `logs:CreateLogDelivery` 등 8종(`resources = ["*"]` — AWS 규정상 스코프 불가).
- [ ] **Step 4: 검증·커밋** — `make check` → `git add infra && git commit -m "260809 terraform ecs iam"`

---

### Task 10: Terraform SFN·EventBridge·모니터링

**Files:**
- Create: `infra/sfn.tf`, `infra/sfn/pipeline.asl.json`, `infra/eventbridge.tf`, `infra/monitoring.tf`

**Interfaces:**
- Consumes: Task 9의 클러스터/태스크 정의/역할/로그 그룹
- Produces: SFN `saramquant-usa-fs-pipeline`(로깅 ALL), EventBridge cron 4규칙, SNS 토픽+이메일 구독, `ExecutionsFailed` 알람.

- [ ] **Step 1: pipeline.asl.json** — templatefile 변수: `cluster_arn`, `task_def_arn`, `subnet_ids`, `sg_id`:

```json
{
  "Comment": "usa-fstatements collector: Fargate Spot with on-demand fallback",
  "StartAt": "RunTaskSpot",
  "States": {
    "RunTaskSpot": {
      "Type": "Task",
      "Resource": "arn:aws:states:::ecs:runTask.sync",
      "TimeoutSeconds": 7200,
      "Parameters": {
        "Cluster": "${cluster_arn}",
        "TaskDefinition": "${task_def_arn}",
        "CapacityProviderStrategy": [{ "CapacityProvider": "FARGATE_SPOT", "Weight": 1 }],
        "NetworkConfiguration": {
          "AwsvpcConfiguration": {
            "Subnets": ${subnet_ids},
            "SecurityGroups": ["${sg_id}"],
            "AssignPublicIp": "ENABLED"
          }
        },
        "Overrides": {
          "ContainerOverrides": [{
            "Name": "collector",
            "Environment": [{ "Name": "RUN_ID", "Value.$": "$$.Execution.Name" }]
          }]
        }
      },
      "Retry": [{ "ErrorEquals": ["ECS.AmazonECSException"], "MaxAttempts": 1, "IntervalSeconds": 60 }],
      "Catch": [{ "ErrorEquals": ["States.ALL"], "ResultPath": "$.spot_error", "Next": "RunTaskOnDemand" }],
      "End": true
    },
    "RunTaskOnDemand": {
      "Type": "Task",
      "Resource": "arn:aws:states:::ecs:runTask.sync",
      "TimeoutSeconds": 7200,
      "Parameters": {
        "Cluster": "${cluster_arn}",
        "TaskDefinition": "${task_def_arn}",
        "CapacityProviderStrategy": [{ "CapacityProvider": "FARGATE", "Weight": 1 }],
        "NetworkConfiguration": {
          "AwsvpcConfiguration": {
            "Subnets": ${subnet_ids},
            "SecurityGroups": ["${sg_id}"],
            "AssignPublicIp": "ENABLED"
          }
        },
        "Overrides": {
          "ContainerOverrides": [{
            "Name": "collector",
            "Environment": [{ "Name": "RUN_ID", "Value.$": "$$.Execution.Name" }]
          }]
        }
      },
      "End": true
    }
  }
}
```

- [ ] **Step 2: sfn.tf** — `aws_sfn_state_machine`: `definition = templatefile(...)`(subnet_ids는 `jsonencode(aws_subnet.public[*].id)`), `logging_configuration { level = "ALL", include_execution_data = true, log_destination = "${aws_cloudwatch_log_group.sfn.arn}:*" }`.
- [ ] **Step 3: eventbridge.tf** — EventBridge 역할(`states:StartExecution`) + 4규칙 for_each: calc `us-fs`(4/7·5/22·8/21·11/21 03:00 KST) 24시간 전 = KST 전날 03:00 = UTC 이틀 전 18:00:

```hcl
locals {
  # calc us-fs (KST 4/7·5/22·8/21·11/21 03:00) 24h 전 실행: KST 4/6·5/21·8/20·11/20 03:00 = UTC 전날 18:00
  schedule_crons = {
    q1 = "cron(0 18 5 4 ? *)"
    q2 = "cron(0 18 20 5 ? *)"
    q3 = "cron(0 18 19 8 ? *)"
    q4 = "cron(0 18 19 11 ? *)"
  }
}
```

- [ ] **Step 4: monitoring.tf** — SNS 토픽 + `aws_sns_topic_subscription`(email = var.alert_email) + 알람:

```hcl
resource "aws_cloudwatch_metric_alarm" "sfn_failed" {
  alarm_name          = "${local.app_name}-executions-failed"
  namespace           = "AWS/States"
  metric_name         = "ExecutionsFailed"
  dimensions          = { StateMachineArn = aws_sfn_state_machine.pipeline.arn }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
```

- [ ] **Step 5: 검증·커밋** — `make check` → `git add infra && git commit -m "260809 terraform sfn eventbridge"`

---

### Task 11: CI/CD 워크플로우 + GitHub 변수 + tfstate 부트스트랩

**Files:**
- Create: `.github/workflows/deploy.yml`

**Interfaces:**
- Consumes: GitHub 시크릿 `SARAMQUANT_IAM_KEY_ACCESS/SECRET`(등록됨), 신규 Variables(SARAMQUANT_S3_BUCKET_NAME, SARAMQUANT_GLUE_DB, SARAMQUANT_ATHENA_WORKGROUP, SARAMQUANT_ALERT_EMAIL)
- Produces: PR=plan / main push=apply 파이프라인

- [ ] **Step 1: GitHub Variables 등록** (`GH_CONFIG_DIR=C:/Users/a/.config/gh-personal` 필수):

```bash
GH_CONFIG_DIR=C:/Users/a/.config/gh-personal gh variable set SARAMQUANT_S3_BUCKET_NAME -b saramquant-bucket -R nampaca123/saramquant-usa-fstatements-collector
# 동일하게 SARAMQUANT_GLUE_DB=saramquant, SARAMQUANT_ATHENA_WORKGROUP=saramquant, SARAMQUANT_ALERT_EMAIL=nampaca123@gmail.com
```

- [ ] **Step 2: tfstate 버킷 확인/부트스트랩** — `aws s3api head-bucket --bucket saramquant-tfstate` (SARAMQUANT 키 사용). 없으면 1회 부트스트랩(ap-northeast-2, 퍼블릭 차단, AES256, 버저닝 없음 — calc 스펙 §8.4의 "최초 1회 부트스트랩") 후 STATUS.md에 기록해 타 세션에 공유.
- [ ] **Step 3: deploy.yml 작성**

```yaml
name: deploy
on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: terraform-state-${{ github.repository }}
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  deploy:
    if: github.repository == 'nampaca123/saramquant-usa-fstatements-collector'
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: infra } }
    env:
      TF_VAR_bucket_name: ${{ vars.SARAMQUANT_S3_BUCKET_NAME }}
      TF_VAR_glue_db: ${{ vars.SARAMQUANT_GLUE_DB }}
      TF_VAR_athena_workgroup: ${{ vars.SARAMQUANT_ATHENA_WORKGROUP }}
      TF_VAR_alert_email: ${{ vars.SARAMQUANT_ALERT_EMAIL }}
    steps:
      - uses: actions/checkout@v4
      - uses: hashicorp/setup-terraform@v3
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.SARAMQUANT_IAM_KEY_ACCESS }}
          aws-secret-access-key: ${{ secrets.SARAMQUANT_IAM_KEY_SECRET }}
          aws-region: us-east-1
      - name: Verify identity
        run: aws sts get-caller-identity
      - name: Check (fmt/validate, no backend)
        run: |
          terraform init -backend=false -input=false
          terraform fmt -check -recursive
          terraform validate
      - name: Compute image tag  # Dockerfile+src 전체 해시 — 소스 변경이 태그에 안 잡히면 새 코드가 영구 미배포된다
        working-directory: .
        run: |
          TAG=$( { cat Dockerfile package.json; find src -type f | sort | xargs cat; } | md5sum | cut -c1-12 )
          echo "TF_VAR_image_tag=$TAG" >> "$GITHUB_ENV"
          echo "IMAGE_TAG=$TAG" >> "$GITHUB_ENV"
      - name: Terraform init
        run: terraform init -input=false
      - name: Pre-create ECR (main only)
        if: github.ref == 'refs/heads/main' && github.event_name == 'push'
        run: terraform apply -input=false -auto-approve -target=aws_ecr_repository.collector
      - name: Build & push image (main only)
        if: github.ref == 'refs/heads/main' && github.event_name == 'push'
        working-directory: .
        run: |
          REPO=$(aws ecr describe-repositories --repository-names saramquant-usa-fs-collector --query 'repositories[0].repositoryUri' --output text)
          if aws ecr describe-images --repository-name saramquant-usa-fs-collector --image-ids imageTag="$IMAGE_TAG" >/dev/null 2>&1; then
            echo "image $IMAGE_TAG already pushed, skipping"; exit 0
          fi
          aws ecr get-login-password | docker login --username AWS --password-stdin "${REPO%%/*}"
          docker build -t "$REPO:$IMAGE_TAG" .
          docker push "$REPO:$IMAGE_TAG"
      - name: Terraform plan
        run: terraform plan -input=false -out=tfplan
      - name: Terraform apply (main only)
        if: github.ref == 'refs/heads/main' && github.event_name == 'push'
        run: terraform apply -input=false tfplan
```

- [ ] **Step 4: 커밋·푸시·PR** — `git add .github && git commit -m "260809 deploy workflow"` → `git push -u origin aws-migration` → PR 생성(개인 gh 설정 사용) → PR의 plan 잡 통과 확인.
- [ ] **Step 5: 머지** — plan 검토 후 자율 머지 → main push의 apply 잡 모니터링 (`gh run watch`). 실패 시 로그로 원인 수정 후 재푸시(반복).

---

### Task 12: 스모크 실행 (SYMBOL_LIMIT) → 검증

**Files:** 없음 (운영 절차)

**Interfaces:**
- Consumes: 배포된 SFN, `saramquant.stocks` (calc 세션 의존 — 비어 있으면 STATUS.md에 blocked 기록 후 대기)
- Produces: `saramquant.financial_statements`에 소량 US 행, `run-summary/usa_fstatements.json`

- [ ] **Step 1: 선행 확인** — Athena `SELECT count(*) FROM saramquant.stocks WHERE market IN ('US_NYSE','US_NASDAQ') AND is_active = true` (SARAMQUANT 키, ap-northeast-2). 0이면 blocked 기록·대기.
- [ ] **Step 2: 스모크 실행** — SFN 실행을 CLI로 시작하되 `SYMBOL_LIMIT=20` 오버라이드는 태스크 정의에 없으므로, `aws ecs run-task`를 직접 호출해 `SYMBOL_LIMIT=20` 환경 오버라이드로 1회 실행 (또는 SFN input을 안 쓰는 대신 이 1회만 수동 run-task).
- [ ] **Step 3: 검증** — CloudWatch 로그에서 단계 로그·에러 확인, Athena: `SELECT count(*), count(DISTINCT stock_id) FROM saramquant.financial_statements WHERE market='US'` 및 샘플 5행 눈검증(fiscal_year 3개년/8분기 범위, decimal 값 정상). `run-summary` JSON 다운로드해 포맷·status 확인.
- [ ] **Step 4: STATUS.md 갱신·커밋**

---

### Task 13: 콜드 완주 + 마무리

**Files:**
- Modify: `docs/temp/STATUS.md`, (필요시) `README.md` 신규

**Interfaces:**
- Produces: 완주 기준 충족 — 활성 US 전 종목 MERGE + run-summary `ok`

- [ ] **Step 1: 콜드 실행** — `aws stepfunctions start-execution --state-machine-arn <arn> --name cold-$(date +%s)` (us-east-1). `describe-execution` 폴링으로 완료 대기 (1–2h 예상).
- [ ] **Step 2: 실패 시 디버깅 루프** — CloudWatch 로그·SFN 실행 히스토리로 원인 파악(IAM 갭이면 iam.tf 수정 → PR → 머지 → 재실행). Spot 중단이면 OD 폴백이 자동으로 처리했는지 확인.
- [ ] **Step 3: 최종 검증** — Athena count(수천 종목 × ≤11행), calc 게이트 조건(`status=='ok' && age<72h`) 충족 확인, DuckDB 로컬에서 `iceberg_scan` 1회 읽기 확인(소비자 경로 검증).
- [ ] **Step 4: 문서 마무리** — STATUS.md에 완주 기록 + calc/gateway 세션 전달사항(테이블 생성됨, run-summary 위치, 스케줄), README.md에 아키텍처 1페이지. 커밋·푸시.

---

## Self-Review 결과

- 스펙 §2(데이터 흐름) → Task 4·5·6·10, §3(코드 변경) → Task 1–6, §4(인프라) → Task 8–10, §5(CI/CD) → Task 11, §6(운영) → Task 6·10, §7(테스트) → Task 5·6·12, 완주 기준 → Task 12·13. 갭 없음.
- 타입 일관성: `StockEntry {stockId, symbol}` 유지, `FinancialStatement` 필드는 기존 파서 산출물 그대로(revenue 등 string|null), athena-sql 함수 시그니처 Task 5 정의와 사용처 일치.
- 플레이스홀더 없음 확인. Athena/DuckDB API 상세는 설치 버전 기준으로 조정 가능함을 해당 스텝에 명시.
