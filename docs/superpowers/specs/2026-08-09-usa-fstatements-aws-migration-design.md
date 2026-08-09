# SaramQuant usa-fstatements-collector AWS 마이그레이션 설계 (2026-08-09)

Supabase(PostgreSQL) + Railway 기반의 미국 재무제표 수집기를 S3 + Iceberg + Athena + Fargate 기반으로
이전한다. calc-server 세션의 스펙(`saramquant-calc-server/docs/superpowers/specs/2026-08-09-aws-migration-design.md`,
이하 "calc 스펙")의 §2(스키마·파티셔닝)와 §8(타 서비스 계약)을 단일 기준으로 따른다.
회사 프로젝트(ontology-for-nabus-adtrigger)의 운영 패턴을 선례로 삼되 이 파이프라인의 규모
(단일 테이블, 분기 4회 실행, 행 ~5.5만)에 맞게 축소한다.

## 0. 범위와 완주 기준

- 이 문서는 usa-fstatements-collector 세션의 범위만 다룬다.
- 완주 기준(성공 조건):
  1. 콜드 수집이 AWS 위에서 완주하여 활성 US 전 종목의 재무제표가
     `saramquant.financial_statements`에 `market='US'`로 MERGE된다.
  2. `run-summary/usa_fstatements.json`이 `status: ok`로 기록된다 (calc `us-fs` 신선도 게이트 통과 가능 상태).
- **선행 의존성**: calc 세션이 `saramquant.stocks`를 채워둬야 종목 매칭이 가능하다.
  stocks가 비어 있으면 콜드 런은 blocked로 기록하고 대기한다.
- 기존 Supabase 데이터는 마이그레이션하지 않는다(콜드 수집 재완주로 채움).

## 1. 확정 사안 (사용자 결정 로그)

| 항목 | 결정 |
|---|---|
| 종목 목록 소스 | `saramquant.stocks`를 DuckDB `iceberg_scan`으로 읽기 (calc 스펙 §8.2, Supabase 의존 제거) |
| 공유 리소스 소유 | `saramquant-bucket`·Glue DB `saramquant`·Athena 워크그룹 `saramquant`·`saramquant-tfstate`는 타 세션/수동 소유. 이 레포는 참조만. tfstate 버킷이 없으면 최초 1회 수동 부트스트랩(§8.4의 "최초 1회 부트스트랩") |
| 배치 컴퓨트 | TS(NestJS) 코드 유지 + 원샷 러너 전환, EventBridge → 미니멀 SFN → Fargate Spot(실패 시 온디맨드 폴백), us-east-1 |
| 적재 방식 | 컨테이너가 staging Parquet 업로드 후 Athena `MERGE INTO` 직접 호출 (calc §2.5와 동일 패턴, SFN은 Spot/OD 래퍼만) |
| 스케줄 | 분기 4회, calc `us-fs`(4/7·5/22·8/21·11/21 03:00 KST) 24시간 전. HTTP 트리거/`USA_FS_COLLECTOR_AUTH_KEY` 폐지, 수동 재실행은 SFN 직접 실행 |
| 스키마 | calc 스펙 §2.3의 `financial_statements` 그대로 (id 제거, `market` string 추가, decimal(20,2), 파티션 `market`, 정렬 stock_id·fiscal_year) |
| 읽기 | 전부 DuckDB. Parquet 경로 직접 글롭 금지 (calc §2.1) |
| 태그 | 전 리소스 `default_tags`로 `project=saramquant` |
| CI/CD | GitHub Actions + 액션 시크릿(`SARAMQUANT_IAM_KEY_ACCESS/SECRET`), Terraform은 CI에서만 plan/apply |
| 네트워크 | 퍼블릭 서브넷 + IGW + us-east-1 S3 Gateway Endpoint. NAT/프라이빗 서브넷 없음 |
| 로그 | CloudWatch 구조화 로그(JSON 1줄/런) + S3 run-summary, 로그 그룹 명시 생성·보존 30일 |

## 2. 데이터 흐름

```
EventBridge (분기 4회, UTC 4/5·5/20·8/19·11/19 18:00 = us-fs 24h 전)
  └→ SFN saramquant-usa-fs-pipeline
       ├─ RunTaskSpot (ecs:runTask.sync, FARGATE_SPOT, 상태 단위 TimeoutSeconds)
       │    ├─ Retry: 일시 오류 1회
       │    └─ Catch → RunTaskOnDemand (FARGATE) → 실패 시 Fail
       └→ Fargate 태스크 (us-east-1, Node 24):
            1. Glue GetTable → metadata_location → DuckDB iceberg_scan으로
               saramquant.stocks에서 활성 US 종목 로드 (ap-northeast-2 크로스 리전, 수 MB)
            2. SEC companyfacts.zip 다운로드/해제 (기존 코드 불변, /tmp/edgar)
            3. FactsParser로 종목별 재무 필드 추출 (기존 코드 불변)
            4. DuckDB로 staging Parquet(zstd) 생성 →
               s3://saramquant-bucket/staging/financial_statements/<run_id>/ 업로드
            5. Athena(ap-northeast-2, 워크그룹 saramquant):
               staging 외부 테이블 재바인딩(DROP/CREATE, run_id 위치) →
               CREATE TABLE IF NOT EXISTS financial_statements (calc §2.3 DDL, 멱등) →
               MERGE INTO saramquant.financial_statements (US 행만) →
               OPTIMIZE ... REWRITE DATA + VACUUM
            6. try/finally: run-summary/usa_fstatements.json 기록 (calc §6.1 포맷)
               + CloudWatch JSON 로그 1줄
```

- MERGE 키: `(stock_id, fiscal_year, report_type)` + `market='US'` 조건. 기존 `ON CONFLICT DO UPDATE`와 동등.
- staging 테이블은 Glue DB `saramquant`의 `financial_statements_staging_us` 하나를 run마다
  DROP/CREATE로 위치만 갈아끼운다 (동시 실행 없음 — 스케줄 분기 4회 + 수동).
- 크로스 리전: 컴퓨트 us-east-1 ↔ 데이터 ap-northeast-2. SEC 다운로드(수 GB)는 us-east-1 로컬,
  서울로 가는 것은 staging Parquet 수 MB뿐이라 전송 비용 무시 가능. Athena/Glue API는 리전 지정 SDK 호출.

## 3. 코드 변경 범위 (안정성 최우선 — 파서/다운로더 불변)

| 파일 | 변경 |
|---|---|
| `src/main.ts` | HTTP 서버 → `NestFactory.createApplicationContext` 원샷 러너. 파이프라인 완료 시 exit 0, 실패 시 exit 1 |
| `src/app.controller.ts`, `src/api-key.guard.ts` | 삭제 (HTTP/잡맵/인증 폐지) |
| `src/config.ts` | Supabase URL 제거. 신규: 버킷명, Glue DB, Athena 워크그룹, 데이터 리전(ap-northeast-2) |
| `src/database/lib/pool.ts` | 삭제 (`pg` 의존 제거) |
| `src/database/service/stock-list.service.ts` | DuckDB `iceberg_scan` 기반으로 교체 (동일 인터페이스: `{id, symbol}[]` 반환) |
| `src/process-save/service/statement-writer.service.ts` | pg upsert → staging Parquet 작성 + S3 업로드 + Athena MERGE/OPTIMIZE/VACUUM |
| `src/fetch-edgar/*`, `src/process-save/service/facts-parser.service.ts`, `facts-reader.service.ts` | **불변** |
| 신규 `src/run-summary.service.ts` (또는 유사) | run-summary 기록 + 구조화 로그 |
| `package.json` | `pg`·`@nestjs/platform-express` 계열 제거 가능한 범위에서 정리, `@duckdb/node-api`, `@aws-sdk/client-s3/athena/glue` 추가 |
| `Dockerfile` | 서버 → 배치 이미지. DuckDB 확장(httpfs, avro, iceberg) 빌드 시 베이크 + 오프라인 LOAD 검증, unzip 유지 |

- 파서 로직·필드 매핑·최근 3개년/8분기 규칙·동시성 50·SEC 스로틀은 손대지 않는다.
- `stocks` 읽기 쿼리 의미 유지: `market IN ('US_NYSE','US_NASDAQ') AND is_active = true`.
- DuckDB 연결 규약(회사 프로젝트 선례): `autoinstall/autoload=false` + 명시 LOAD,
  `CREATE OR REPLACE SECRET`(태스크 롤 자격증명), `http_retries=2`, `http_timeout` 단축.

## 4. 인프라 (이 레포 소유, us-east-1)

평면 Terraform `infra/` (모듈/워크스페이스 없음):

| 리소스 | 내용 |
|---|---|
| VPC | `10.43.0.0/16`, 퍼블릭 서브넷 2개(2 AZ — Fargate Spot 가용성), IGW, us-east-1 S3 Gateway Endpoint, 인바운드 전면 차단(egress only) SG |
| ECS | 클러스터 1, 태스크 정의: x86_64, 2 vCPU / 4GB, ephemeral 40GB(zip 해제 공간), `assignPublicIp` |
| ECR | `usa-fs-collector` 리포 1, 라이프사이클 최근 3개, scan_on_push |
| SFN | `saramquant-usa-fs-pipeline` (RunTaskSpot → Catch → RunTaskOnDemand), 로깅 ALL |
| EventBridge | cron 4규칙 (UTC 4/5·5/20·8/19·11/19 18:00) → SFN StartExecution |
| CloudWatch | 로그 그룹 명시 생성(`/saramquant/usa-fs-collector`, SFN 로그), 보존 30일. `ExecutionsFailed >= 1` 알람 → SNS → 이메일 |
| IAM | 태스크 롤(데이터): 서울 버킷의 `staging/*`·`warehouse/*`·`run-summary/*`·`athena-results/*` prefix + 버킷 ARN(ListBucket, Iceberg 매니페스트용), Glue `saramquant` DB/테이블, Athena 워크그룹 `saramquant`. 실행 롤(인프라): ECR pull + 로그. SFN 롤: RunTask + PassRole(두 롤) + 관리형 이벤트 규칙. EventBridge 롤: StartExecution |
| 백엔드 | `s3://saramquant-tfstate`, key `usa-fstatements/terraform.tfstate`, `use_lockfile = true` |

- 공유 리소스(서울 버킷, Glue DB, Athena 워크그룹, tfstate 버킷)는 이 레포 Terraform이 만들지 않는다.
  Athena 워크그룹·Glue DB가 calc 세션 배포 전이면 콜드 런이 실패하므로 STATUS.md에 의존성으로 기록.
- `default_tags`: `project = "saramquant"`, `service = "usa-fstatements-collector"`.
- `infra/tf` 래퍼(CI 밖 plan/apply/destroy 차단) + `make check`(init -backend=false, fmt, validate).

## 5. CI/CD (`.github/workflows/deploy.yml` 단일 파일)

1. 트리거: PR = plan only / main push = plan+apply / workflow_dispatch. `concurrency.cancel-in-progress: false`.
2. `make check` → 자격증명(시크릿 `SARAMQUANT_IAM_KEY_ACCESS/SECRET`, us-east-1) → `aws sts get-caller-identity` 검증.
3. `terraform apply -target=aws_ecr_repository.collector` (main만) → 이미지 빌드/푸시
   (태그 = Dockerfile+`src/` 전체 md5 12자리, ECR에 태그 존재 시 스킵) → `terraform plan -out=tfplan` → `apply tfplan` (main만).
4. GitHub Variables 신규: `SARAMQUANT_S3_BUCKET_NAME`(plain 이름 `saramquant-bucket` — 기존 URL 형식 변수와 별도),
   `SARAMQUANT_GLUE_DB`(`saramquant`), `SARAMQUANT_ATHENA_WORKGROUP`(`saramquant`), 알람 수신 이메일.
   변수는 default 없는 Terraform 변수 + validation 에러 메시지에 GitHub 변수명 명기.
5. 제거되는 환경변수: `SUPABASE_DB_TRANSACTION_POOLER_URL`, `USA_FS_COLLECTOR_AUTH_KEY`, `PORT`.

## 6. 에러 처리 / 운영

- Spot 실패는 단순 Catch → 온디맨드 재실행 (런당 비용이 작아 증거 기반 분류 생략 — calc §3과 동일 판단).
  같은 태스크 정의를 쓰고 capacity provider만 다르다. 재실행은 1회.
- SFN 상태 단위 `TimeoutSeconds`(Spot 7200s / OD 7200s)로 침묵 타임아웃 방지.
- 부분 실패(일부 종목 파싱 실패/티커 미매칭)는 기존처럼 스킵하고 counts에 기록, `status: partial`.
  MERGE 자체가 실패하면 `status: error` + exit 1 → SFN Catch/알람.
- run-summary는 try/finally에서 항상 기록(실패 포함 런당 1건). 신선도 판정은 `written_at_utc` 기준(calc §6.1).
- 진행 현황·세션 간 전달 사항은 `docs/temp/STATUS.md` 단일 문서로 유지.

## 7. 테스트

- 파서 단위 테스트: 기존 로직 불변이므로 대표 CIK JSON 픽스처로 추출 결과 스냅샷 확인(회귀 방지).
- staging→MERGE 스모크: 소수 심볼 화이트리스트(`SYMBOL_LIMIT` 유사 env)로 축소 실행 후
  DuckDB로 결과 행 검증 → 이후 전체 콜드 런.
- ASL/Terraform: `make check` + PR plan.

## 8. 비용 (월, 대략)

- Fargate Spot 분기 4회 × 1–2h × 2vCPU/4GB ≈ $0.2 미만/월 평균
- Athena MERGE 스캔(수 MB) + S3 + CloudWatch ≈ $1 미만
- 합계 ≈ **월 $1 안팎** (Railway 상시 서버 완전 제거)
