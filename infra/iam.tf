locals {
  account_id = data.aws_caller_identity.current.account_id
  bucket_arn = "arn:aws:s3:::${var.bucket_name}"
}

# ── 실행 롤: ECR pull + 로그 (인프라 계정) ───────────────────────────
data "aws_iam_policy_document" "ecs_tasks_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.app_name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# ── 태스크 롤: 데이터 접근 (S3·Glue·Athena) ─────────────────────────
resource "aws_iam_role" "task" {
  name               = "${local.app_name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

data "aws_iam_policy_document" "task_perms" {
  # Iceberg는 GetObject만으론 부족 — 매니페스트 목록 조회에 ListBucket 필요 (버킷 ARN + 객체 ARN 둘 다)
  statement {
    sid       = "S3BucketMeta"
    actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
    resources = [local.bucket_arn]
  }

  # 쓰기/삭제는 이 수집기 소유 prefix만 — warehouse/* 전체를 열면 calc 소유 테이블까지 지울 수 있다.
  # 멀티파트 액션은 테이블이 커져 Athena/OPTIMIZE가 멀티파트 업로드로 전환될 때 필요.
  statement {
    sid = "S3OwnPrefixesRW"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
    ]
    resources = [
      "${local.bucket_arn}/warehouse/financial_statements/*",
      "${local.bucket_arn}/staging/financial_statements/*",
      "${local.bucket_arn}/athena-results/*",
    ]
  }

  # stocks는 읽기 전용 (DuckDB iceberg_scan)
  statement {
    sid       = "S3StocksReadOnly"
    actions   = ["s3:GetObject"]
    resources = ["${local.bucket_arn}/warehouse/stocks/*"]
  }

  # run-summary는 자기 파일 하나에만 쓰기 — calc의 신선도 게이트 파일 덮어쓰기 차단
  statement {
    sid       = "S3RunSummaryOwnFile"
    actions   = ["s3:PutObject"]
    resources = ["${local.bucket_arn}/run-summary/usa_fstatements.json"]
  }

  # Glue 카탈로그(서울) — stocks metadata_location 조회 + staging DROP/CREATE + Iceberg 커밋
  statement {
    sid = "GlueCatalog"
    actions = [
      "glue:GetDatabase",
      "glue:GetTable",
      "glue:GetTables",
      "glue:CreateTable",
      "glue:DeleteTable",
      "glue:UpdateTable",
    ]
    resources = [
      "arn:aws:glue:${local.data_region}:${local.account_id}:catalog",
      "arn:aws:glue:${local.data_region}:${local.account_id}:database/${var.glue_db}",
      "arn:aws:glue:${local.data_region}:${local.account_id}:table/${var.glue_db}/*",
    ]
  }

  statement {
    sid = "AthenaWorkgroup"
    actions = [
      "athena:StartQueryExecution",
      "athena:GetQueryExecution",
      "athena:StopQueryExecution",
    ]
    resources = [
      "arn:aws:athena:${local.data_region}:${local.account_id}:workgroup/${var.athena_workgroup}",
    ]
  }
}

resource "aws_iam_role_policy" "task_perms" {
  name   = "data-access"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task_perms.json
}

# ── SFN 롤: RunTask + PassRole + .sync 관리형 규칙 + 로깅 ───────────
data "aws_iam_policy_document" "sfn_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "sfn" {
  name               = "${local.app_name}-sfn"
  assume_role_policy = data.aws_iam_policy_document.sfn_trust.json
}

data "aws_iam_policy_document" "sfn_perms" {
  statement {
    sid       = "RunCollectorTask"
    actions   = ["ecs:RunTask", "ecs:StopTask", "ecs:DescribeTasks"]
    resources = ["${aws_ecs_task_definition.collector.arn_without_revision}:*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.main.arn]
    }
  }

  # DescribeTasks/StopTask는 task ARN 대상이라 별도 허용 필요
  statement {
    sid       = "TrackTasks"
    actions   = ["ecs:DescribeTasks", "ecs:StopTask"]
    resources = ["arn:aws:ecs:us-east-1:${local.account_id}:task/${aws_ecs_cluster.main.name}/*"]
  }

  statement {
    sid       = "PassTaskRoles"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.task.arn, aws_iam_role.execution.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }

  # .sync 통합은 이 관리형 EventBridge 규칙으로 태스크 종료를 수신 — 없으면 런타임 실패
  statement {
    sid     = "SyncCallbackManagedRule"
    actions = ["events:PutRule", "events:PutTargets", "events:DescribeRule"]
    resources = [
      "arn:aws:events:us-east-1:${local.account_id}:rule/StepFunctionsGetEventsForECSTaskRule",
    ]
  }

  # level=ALL 로깅 필수 권한 — 리소스 스코프 불가(AWS 규정)
  statement {
    sid = "StateMachineLogDelivery"
    actions = [
      "logs:CreateLogDelivery",
      "logs:GetLogDelivery",
      "logs:UpdateLogDelivery",
      "logs:DeleteLogDelivery",
      "logs:ListLogDeliveries",
      "logs:PutResourcePolicy",
      "logs:DescribeResourcePolicies",
      "logs:DescribeLogGroups",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "sfn_perms" {
  name   = "pipeline"
  role   = aws_iam_role.sfn.id
  policy = data.aws_iam_policy_document.sfn_perms.json
}

# ── EventBridge 롤: 스케줄 → SFN 실행 ──────────────────────────────
data "aws_iam_policy_document" "events_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "events" {
  name               = "${local.app_name}-events"
  assume_role_policy = data.aws_iam_policy_document.events_trust.json
}

data "aws_iam_policy_document" "events_perms" {
  statement {
    actions   = ["states:StartExecution"]
    resources = [aws_sfn_state_machine.pipeline.arn]
  }
}

resource "aws_iam_role_policy" "events_perms" {
  name   = "start-execution"
  role   = aws_iam_role.events.id
  policy = data.aws_iam_policy_document.events_perms.json
}
