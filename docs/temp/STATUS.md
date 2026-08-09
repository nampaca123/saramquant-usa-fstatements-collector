# usa-fstatements-collector AWS 마이그레이션 현황

> 세션 간 소통·맥락 유지용 단일 문서. 매 Task 완료 시 갱신.
> 스펙: `docs/superpowers/specs/2026-08-09-usa-fstatements-aws-migration-design.md`
> 계획: `docs/superpowers/plans/2026-08-09-aws-migration.md`
> 기준 계약: calc 스펙 §2·§8 (`saramquant-calc-server/docs/superpowers/specs/2026-08-09-aws-migration-design.md`)

## 진행 상태 (2026-08-09)

| Task | 상태 |
|---|---|
| P1 브랜치·STATUS·의존성 | 진행 중 |
| P2–P6 코드 전환 | 대기 |
| P7 Dockerfile | 대기 |
| P8–P10 Terraform | 대기 |
| P11 CI/CD·배포 | 대기 |
| P12 스모크 | 대기 |
| P13 콜드 완주 | 대기 |

## 타 세션 의존성 (선행 조건)

| 항목 | 소유 | 상태 (마지막 확인) |
|---|---|---|
| `s3://saramquant-tfstate` (Terraform state) | 공유 — 최초 부트스트랩 1회 | **미존재** (2026-08-09 버킷 목록에 없음) → P11에서 없으면 이 세션이 부트스트랩 |
| Glue DB `saramquant` | calc 세션 | 미확인 |
| Athena 워크그룹 `saramquant` | calc 세션 | 미확인 |
| `saramquant.stocks` (US 종목 채워짐) | calc 세션 | 미확인 — 콜드 런의 필수 선행 |
| `saramquant.financial_statements` DDL | calc 소유, 이 레포는 CREATE IF NOT EXISTS 멱등 | — |

## 이 세션이 타 세션에 전달할 사항

- (완주 후) `financial_statements` US 행 적재 완료 여부, `run-summary/usa_fstatements.json` 위치.
- 스케줄: UTC 4/5·5/20·8/19·11/19 18:00 (calc us-fs 24h 전).
- tfstate 버킷을 이 세션이 부트스트랩했다면 그 사실.

## 주요 결정/이슈 로그

- 2026-08-09: 설계 승인(사용자). 분기 4회 스케줄 + 컨테이너 내 Athena MERGE(1안). 리뷰는 최종 1회만(사용자 지시).
- Dockerfile 베이스를 node:24-alpine → node:24-slim으로 변경 예정(@duckdb/node-api musl 프리빌트 리스크).
