locals {
  app_name    = "saramquant-usa-fs"
  data_region = "ap-northeast-2" # 데이터 레이크(버킷·Glue·Athena)는 서울, 컴퓨트만 us-east-1
  vpc_cidr    = "10.43.0.0/16"
  azs         = ["us-east-1a", "us-east-1b"] # 2 AZ — Fargate Spot 가용성 확보

  ecr_repo_name = "saramquant-usa-fs-collector"

  # calc us-fs(KST 4/7·5/22·8/21·11/21 03:00) 24h 전 실행:
  # KST 4/6·5/21·8/20·11/20 03:00 = UTC 전날 18:00
  schedule_crons = {
    q1 = "cron(0 18 5 4 ? *)"
    q2 = "cron(0 18 20 5 ? *)"
    q3 = "cron(0 18 19 8 ? *)"
    q4 = "cron(0 18 19 11 ? *)"
  }
}
