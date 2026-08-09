resource "aws_sns_topic" "alerts" {
  name = "${local.app_name}-alerts"
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_cloudwatch_metric_alarm" "sfn_failed" {
  alarm_name          = "${local.app_name}-executions-failed"
  alarm_description   = "usa-fstatements pipeline execution failed (spot+ondemand both)"
  namespace           = "AWS/States"
  metric_name         = "ExecutionsFailed"
  dimensions          = { StateMachineArn = aws_sfn_state_machine.pipeline.arn }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching" # 분기 배치 — 대부분의 시간에 데이터 없음
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# 태스크 자체가 못 뜨는 경우(이미지 pull 실패 등)도 SFN 실패로 수렴하므로 알람은 위 하나로 충분
