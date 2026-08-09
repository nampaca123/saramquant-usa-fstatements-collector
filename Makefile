# 로컬 검증 전용 — 백엔드(공유 state) 미접촉
check:
	cd infra && terraform init -backend=false -input=false >/dev/null && terraform fmt -check -recursive && terraform validate

.PHONY: check
