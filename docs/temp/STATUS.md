# usa-fstatements-collector AWS 마이그레이션 현황

> 세션 간 소통·맥락 유지용 단일 문서. 매 Task 완료 시 갱신.
> 스펙: `docs/superpowers/specs/2026-08-09-usa-fstatements-aws-migration-design.md`
> 계획: `docs/superpowers/plans/2026-08-09-aws-migration.md`
> 기준 계약: calc 스펙 §2·§8 (`saramquant-calc-server/docs/superpowers/specs/2026-08-09-aws-migration-design.md`)

## 진행 상태 (2026-08-09)

| Task | 상태 |
|---|---|
| P1–P6 코드 전환 (원샷 러너, DuckDB stocks, Athena MERGE, run-summary) | **완료** |
| P7 Dockerfile (node:24-slim, 확장 베이크) | **완료** (CI 빌드에서 오프라인 LOAD 검증됨) |
| P8–P10 Terraform (VPC·ECS·IAM·SFN·EventBridge·SNS) | **완료** |
| P11 CI/CD·배포 | **완료** — PR #1 머지, main apply 성공 (2026-08-09 14:05 KST) |
| P12 스모크 | **차단** — calc 세션의 Glue DB·워크그룹·stocks 대기 (모니터 가동 중) |
| P13 콜드 완주 | 대기 |

배포된 리소스: SFN `saramquant-usa-fs-pipeline`(us-east-1), ECS 클러스터 `saramquant-usa-fs`(FARGATE+SPOT),
태스크 정의 rev1 (2vCPU/4GB/40GiB), ECR 이미지 `0e6670b33357`, EventBridge 4규칙(q1–q4), SNS 알람.

## 타 세션 의존성 (선행 조건)

| 항목 | 소유 | 상태 (마지막 확인) |
|---|---|---|
| `s3://saramquant-tfstate` (Terraform state) | 공유 — 최초 부트스트랩 1회 | **존재** (2026-08-09 14:00 KST 확인 — 타 세션이 부트스트랩) |
| Glue DB `saramquant` | calc 세션 | **미존재** (2026-08-09 14:00 확인) — 스모크/콜드 런 차단 요인 |
| Athena 워크그룹 `saramquant` | calc 세션 | **미존재** (동일 시점) |
| `saramquant.stocks` (US 종목 채워짐) | calc 세션 | 미존재 — 콜드 런의 필수 선행 |
| `saramquant.financial_statements` DDL | calc 소유, 이 레포는 CREATE IF NOT EXISTS 멱등 | — |

## 이 세션이 타 세션에 전달할 사항

- (완주 후) `financial_statements` US 행 적재 완료 여부, `run-summary/usa_fstatements.json` 위치.
- 스케줄: UTC 4/5·5/20·8/19·11/19 18:00 (calc us-fs 24h 전).
- tfstate 버킷을 이 세션이 부트스트랩했다면 그 사실.

## 주요 결정/이슈 로그

- 2026-08-09: 설계 승인(사용자). 분기 4회 스케줄 + 컨테이너 내 Athena MERGE(1안). 리뷰는 최종 1회만(사용자 지시).
- Dockerfile 베이스를 node:24-alpine → node:24-slim으로 변경 예정(@duckdb/node-api musl 프리빌트 리스크).
