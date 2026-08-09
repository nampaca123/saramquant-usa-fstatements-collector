# 외부 입력 = GitHub Variables/Secrets에 반드시 등록해야 하는 값 (default 없음 → 미설정 시 CI 실패).
# 시스템 고정값은 locals.tf 참조.

variable "bucket_name" {
  type = string
  validation {
    condition     = length(var.bucket_name) > 0
    error_message = "bucket_name required (GitHub Variable SARAMQUANT_S3_BUCKET_NAME)."
  }
}

variable "glue_db" {
  type = string
  validation {
    condition     = length(var.glue_db) > 0
    error_message = "glue_db required (GitHub Variable SARAMQUANT_GLUE_DB)."
  }
}

variable "athena_workgroup" {
  type = string
  validation {
    condition     = length(var.athena_workgroup) > 0
    error_message = "athena_workgroup required (GitHub Variable SARAMQUANT_ATHENA_WORKGROUP)."
  }
}

variable "alert_email" {
  type = string
  validation {
    condition     = length(var.alert_email) > 0
    error_message = "alert_email required (GitHub Variable SARAMQUANT_ALERT_EMAIL)."
  }
}

variable "image_tag" {
  type = string
  validation {
    condition     = length(var.image_tag) > 0
    error_message = "image_tag required (CI가 Dockerfile+src 해시로 계산해 TF_VAR_image_tag로 주입)."
  }
}
