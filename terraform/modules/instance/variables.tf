variable "name" {
  description = "Deployment name."
  type        = string
}

variable "instance_type" {
  description = "EC2 instance type."
  type        = string
}

variable "disk_gb" {
  description = "Root volume size in GB."
  type        = number
}

variable "subnet_id" {
  description = "Subnet to launch the instance in."
  type        = string
}

variable "security_group_id" {
  description = "Egress-only security group id."
  type        = string
}

variable "iam_instance_profile" {
  description = "Instance profile name to attach."
  type        = string
}

variable "region" {
  description = "AWS region (passed to the bootstrap for self-stop calls)."
  type        = string
}

variable "hf_repo" {
  description = "HuggingFace model repo to serve."
  type        = string
}

variable "engine" {
  description = "Serving engine: 'vllm' or 'ollama'."
  type        = string
}

variable "mode" {
  description = "'gpu' or 'cpu'."
  type        = string
}

variable "remote_port" {
  description = "Port the model server listens on."
  type        = number
}

variable "idle_timeout_seconds" {
  description = "Auto-stop after this many seconds idle."
  type        = number
}

variable "context_length" {
  description = "Max context length (0 = engine default)."
  type        = number
  default     = 0
}

variable "quantization" {
  description = "Optional quantization; empty = none."
  type        = string
  default     = ""
}

variable "hf_token" {
  description = "HuggingFace token for gated repos; empty = anonymous."
  type        = string
  default     = ""
  sensitive   = true
}

variable "tags" {
  description = "Tags to apply."
  type        = map(string)
  default     = {}
}
