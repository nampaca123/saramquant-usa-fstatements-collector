provider "aws" {
  region = "us-east-1"

  default_tags {
    tags = {
      project = "saramquant"
      service = "usa-fstatements-collector"
    }
  }
}

data "aws_caller_identity" "current" {}
