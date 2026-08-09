# 분기 4회 — calc us-fs 24시간 전 (locals.schedule_crons 주석 참조).
# 수동 재실행은 콘솔/CLI에서 SFN StartExecution.
resource "aws_cloudwatch_event_rule" "quarterly" {
  for_each            = local.schedule_crons
  name                = "${local.app_name}-${each.key}"
  schedule_expression = each.value
}

resource "aws_cloudwatch_event_target" "quarterly" {
  for_each = aws_cloudwatch_event_rule.quarterly
  rule     = each.value.name
  arn      = aws_sfn_state_machine.pipeline.arn
  role_arn = aws_iam_role.events.arn
}
