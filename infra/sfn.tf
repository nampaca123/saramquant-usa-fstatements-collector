resource "aws_sfn_state_machine" "pipeline" {
  name     = "${local.app_name}-pipeline"
  role_arn = aws_iam_role.sfn.arn

  definition = templatefile("${path.module}/sfn/pipeline.asl.json", {
    cluster_arn  = aws_ecs_cluster.main.arn
    task_def_arn = aws_ecs_task_definition.collector.arn
    subnet_ids   = jsonencode(aws_subnet.public[*].id)
    sg_id        = aws_security_group.task.id
  })

  logging_configuration {
    log_destination        = "${aws_cloudwatch_log_group.sfn.arn}:*"
    include_execution_data = true
    level                  = "ALL"
  }

  depends_on = [aws_iam_role_policy.sfn_perms]
}
