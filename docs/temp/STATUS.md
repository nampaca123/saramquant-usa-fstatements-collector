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
| P12 스모크 | **완료** — 2차(smoke2-260810, 20종목 제한): 18종목/71행 MERGE, status ok, 3분 4초 |
| P13 콜드 완주 | **완료** — cold-260810 (SFN→Fargate Spot, 폴백 없음): 5,879종목 매칭/0 실패, **45,810행 MERGE**, 4.5분, run-summary ok. Athena 검증 45,810행/4,672종목, DuckDB 소비 경로 확인(KR 19,505행과 파티션 공존 정상) |

### P12 1차 스모크 소견 (2026-08-09 15:07 UTC, run_id=smoke-260810)
- `status:error, cause:"no active US stocks"` — **수집기 결함 아님.** calc 세션이 stocks를
  "전체 DELETE→소량 INSERT" 사이클로 테스트 중이라, 읽은 시점의 current snapshot이 records=0였음
  (스냅샷 히스토리로 확인). 현재 3행 수준.
- 활성 US ≥100이 2회 연속(10분 간격) 관측되면 스모크 재실행 예정. 모니터 가동 중.
- calc 세션 참고: 운영 스케줄상 겹침 없음(우리 18:00 UTC vs calc us 00:00/kr 09:00 UTC).
  다만 stocks가 MERGE(스펙 §2.3)가 아닌 delete-all 패턴으로 계속 쓰이면 읽기 시점 레이스가 생기니 확인 요망.

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

## 이 세션이 타 세션에 전달할 사항 (2026-08-10 완주 시점)

- **콜드 완주 완료**: `saramquant.financial_statements`에 US 45,810행(4,672종목) 적재됨.
  `run-summary/usa_fstatements.json`이 `status: ok`로 기록되어 calc `us-fs` 신선도 게이트 통과 가능.
- 스케줄: UTC 4/5·5/20·8/19·11/19 18:00 (calc us-fs 24h 전). 실행당 약 5분 소요.
- `financial_statements` 테이블은 이 세션이 `CREATE TABLE IF NOT EXISTS`로 생성했음
  (calc 스펙 §2.3 DDL 그대로: 파티션 market, decimal(20,2), created_at timestamp).
  calc의 KR 행(19,505행)과 정상 공존 확인됨.
- calc 세션 참고: stocks 테이블이 delete-all→insert 사이클로 재작성되는 동안 읽으면
  0행 스냅샷에 걸릴 수 있음(2026-08-09 스모크 1차에서 실제 발생). 운영 스케줄상 겹침은 없음.

## 주요 결정/이슈 로그

- 2026-08-09: 설계 승인(사용자). 분기 4회 스케줄 + 컨테이너 내 Athena MERGE(1안). 리뷰는 최종 1회만(사용자 지시).
- Dockerfile 베이스를 node:24-alpine → node:24-slim으로 변경 예정(@duckdb/node-api musl 프리빌트 리스크).
