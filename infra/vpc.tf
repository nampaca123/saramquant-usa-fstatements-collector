# NAT 없는 퍼블릭 서브넷 구조 — 분기 4회 배치에 NAT($33/월) 상시 비용은 불합리.
# 인바운드는 SG에서 전면 차단(퍼블릭 IP가 있어도 접속 경로 없음).

resource "aws_vpc" "main" {
  cidr_block           = local.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = local.app_name }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = { Name = local.app_name }
}

resource "aws_subnet" "public" {
  count                   = length(local.azs)
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(local.vpc_cidr, 4, count.index)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = true

  tags = { Name = "${local.app_name}-public-${count.index}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "${local.app_name}-public" }
}

resource "aws_route_table_association" "public" {
  count          = length(local.azs)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# us-east-1 S3(SEC zip 캐시 등 로컬 리전 트래픽)용 게이트웨이 엔드포인트 — 시간당 요금 없음.
# 서울 버킷 트래픽은 IGW 경유(staging Parquet 수 MB라 전송 비용 무시 가능).
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.us-east-1.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.public.id]

  tags = { Name = "${local.app_name}-s3" }
}

resource "aws_security_group" "task" {
  name        = "${local.app_name}-task"
  description = "usa-fs collector task - egress only"
  vpc_id      = aws_vpc.main.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.app_name}-task" }
}
