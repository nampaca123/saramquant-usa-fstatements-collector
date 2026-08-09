resource "aws_ecr_repository" "collector" {
  name = local.ecr_repo_name

  image_scanning_configuration {
    scan_on_push = true
  }
}

# 해시 태그 이미지가 소스 변경마다 누적된다 — 최근 3개만 유지
resource "aws_ecr_lifecycle_policy" "collector" {
  repository = aws_ecr_repository.collector.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep last 3 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 3
      }
      action = { type = "expire" }
    }]
  })
}
