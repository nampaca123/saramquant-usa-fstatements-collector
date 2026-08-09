terraform {
  required_version = ">= 1.10"

  # 공유 state 버킷(saramquant-tfstate)을 리포별 key로 나눠 쓴다.
  # use_lockfile: S3 조건부 쓰기 네이티브 락 — DynamoDB 락 테이블 불필요.
  backend "s3" {
    bucket       = "saramquant-tfstate"
    key          = "usa-fstatements/terraform.tfstate"
    region       = "ap-northeast-2"
    encrypt      = true
    use_lockfile = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}
