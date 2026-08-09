resource "aws_ecs_cluster" "main" {
  name = local.app_name
}

# SFN이 CapacityProviderStrategy로 RunTask 하려면 클러스터에 CP가 연결돼 있어야 한다
resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]
}

resource "aws_ecs_task_definition" "collector" {
  family                   = "${local.app_name}-collector"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 2048
  memory                   = 4096

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64" # Fargate Spot은 ARM 미지원
  }

  # companyfacts.zip(수 GB) 압축 해제 공간
  ephemeral_storage {
    size_in_gib = 40
  }

  execution_role_arn = aws_iam_role.execution.arn
  task_role_arn      = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name      = "collector"
    image     = "${aws_ecr_repository.collector.repository_url}:${var.image_tag}"
    essential = true
    environment = [
      { name = "SARAMQUANT_S3_BUCKET_NAME", value = var.bucket_name },
      { name = "SARAMQUANT_GLUE_DB", value = var.glue_db },
      { name = "SARAMQUANT_ATHENA_WORKGROUP", value = var.athena_workgroup },
      { name = "SARAMQUANT_DATA_REGION", value = local.data_region },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.collector.name
        awslogs-region        = "us-east-1"
        awslogs-stream-prefix = "collector"
      }
    }
  }])
}
