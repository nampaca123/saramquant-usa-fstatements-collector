# 로그 그룹은 자동 생성에 맡기지 않고 명시 생성 — 자동 생성분은 보존 기간이 "만료 없음"이라 비용 누수
resource "aws_cloudwatch_log_group" "collector" {
  name              = "/saramquant/usa-fs-collector"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "sfn" {
  name              = "/saramquant/usa-fs-sfn"
  retention_in_days = 30
}
