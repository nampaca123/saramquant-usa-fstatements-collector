output "state_machine_arn" {
  value = aws_sfn_state_machine.pipeline.arn
}

output "ecr_repository_url" {
  value = aws_ecr_repository.collector.repository_url
}

output "cluster_arn" {
  value = aws_ecs_cluster.main.arn
}
