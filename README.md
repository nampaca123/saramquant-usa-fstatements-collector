# saramquant-usa-fstatements-collector

SEC EDGAR의 `companyfacts.zip` 벌크 데이터에서 미국 상장기업(NYSE/NASDAQ) 재무제표를 추출해
SaramQuant 레이크하우스(`saramquant.financial_statements`, Iceberg)에 적재하는 배치 수집기.

## 아키텍처

```
EventBridge (분기 4회, calc us-fs 24h 전: UTC 4/5·5/20·8/19·11/19 18:00)
  └→ Step Functions saramquant-usa-fs-pipeline
       ├─ RunTaskSpot (Fargate Spot) ── Catch ─→ RunTaskOnDemand (Fargate)
       └→ 원샷 태스크 (us-east-1, Node 24, 2vCPU/4GB, 임시 스토리지 40GiB):
            1. DuckDB iceberg_scan → saramquant.stocks 활성 US 종목 로드
            2. SEC companyfacts.zip 다운로드(~1.3GB)·해제
            3. 종목별 재무 필드 추출 (FY 3개년 + 분기 8개)
            4. staging Parquet(zstd) → s3://saramquant-bucket/staging/financial_statements/<run_id>/
            5. Athena(ap-northeast-2): staging 재바인딩 → MERGE INTO financial_statements
               (키: stock_id+fiscal_year+report_type, market='US') → OPTIMIZE + VACUUM
            6. run-summary/usa_fstatements.json 기록 (calc us-fs 신선도 게이트 소비)
```

- 컴퓨트는 us-east-1(SEC 근접), 데이터는 ap-northeast-2(`saramquant-bucket`) — 서울로 가는 것은 수 MB뿐.
- 스키마·계약의 단일 기준: calc-server 스펙 §2·§8. 이 레포 스펙은
  `docs/superpowers/specs/2026-08-09-usa-fstatements-aws-migration-design.md`.

## 배포

- `main` push → `.github/workflows/deploy.yml`이 이미지 빌드(태그=Dockerfile+src 해시)·푸시 후
  Terraform apply. PR은 plan만. 로컬 apply는 `infra/tf` 래퍼가 차단(`make check`만 허용).
- 필요 GitHub 설정: 시크릿 `SARAMQUANT_IAM_KEY_ACCESS/SECRET`,
  변수 `SARAMQUANT_S3_BUCKET_NAME`·`SARAMQUANT_GLUE_DB`·`SARAMQUANT_ATHENA_WORKGROUP`·`SARAMQUANT_ALERT_EMAIL`.

## 수동 실행

```bash
aws stepfunctions start-execution --region us-east-1 \
  --state-machine-arn arn:aws:states:us-east-1:<account>:stateMachine:saramquant-usa-fs-pipeline \
  --name manual-$(date +%y%m%d-%H%M)
```

소량 테스트는 `aws ecs run-task`에 `SYMBOL_LIMIT` 환경 오버라이드(예: 20)를 준다.

## 운영

- 로그: CloudWatch `/saramquant/usa-fs-collector` (보존 30일), SFN 실행 히스토리 `/saramquant/usa-fs-sfn`.
- 실패 알람: SFN `ExecutionsFailed` → SNS 이메일.
- 부분 실패(일부 종목 파싱 실패)는 `status: partial`로 run-summary에 기록되고 exit 0.
  stocks가 비어 있으면 `status: error` + exit 1 (calc 의존성).
