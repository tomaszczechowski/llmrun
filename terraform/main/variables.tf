variable "name" {
  description = "Deployment name; used for resource names and tags."
  type        = string
}

variable "region" {
  description = "AWS region to deploy into."
  type        = string
}

variable "az_index" {
  description = "Index into the region's availability zones (0, 1, 2). Change to retry in a different AZ when capacity is unavailable."
  type        = number
  default     = 0
}

variable "instance_type" {
  description = "EC2 instance type (e.g. g6.xlarge for GPU, c7i.4xlarge for CPU fallback)."
  type        = string
}

variable "disk_gb" {
  description = "Root EBS volume size in GB (must fit the model weights + cache)."
  type        = number
  default     = 100
}

variable "hf_repo" {
  description = "HuggingFace model repo to serve (e.g. meta-llama/Llama-3.1-8B-Instruct)."
  type        = string
}

variable "engine" {
  description = "Serving engine: 'vllm' (GPU) or 'ollama' (CPU fallback)."
  type        = string
  default     = "vllm"
}

variable "mode" {
  description = "'gpu' or 'cpu'. Selects the AMI and how the model server is launched."
  type        = string
  default     = "gpu"
}

variable "remote_port" {
  description = "Port the model server listens on inside the instance."
  type        = number
  default     = 8000
}

variable "idle_timeout_seconds" {
  description = "Auto-stop the instance after this many seconds of inference inactivity."
  type        = number
  default     = 1800
}

variable "context_length" {
  description = "Max model context length (0 = engine default)."
  type        = number
  default     = 0
}

variable "quantization" {
  description = "Optional quantization to pass to the engine (e.g. awq). Empty = none."
  type        = string
  default     = ""
}

variable "tool_call_parser" {
  description = "vLLM --tool-call-parser (e.g. hermes). Empty = tool calling disabled."
  type        = string
  default     = ""
}

variable "hf_token" {
  description = "HuggingFace token for gated repos. Empty = anonymous."
  type        = string
  default     = ""
  sensitive   = true
}

variable "vllm_cpu_image" {
  description = "Docker image for the CPU vLLM container (engine=vllm, mode=cpu). Pinned by default — :latest is intentionally not used."
  type        = string
  default     = "vllm/vllm-openai-cpu:v0.28.0"
}

variable "vllm_cpu_kvcache_space" {
  description = "VLLM_CPU_KVCACHE_SPACE in GiB for the CPU vLLM container."
  type        = number
  default     = 16
}

variable "vllm_cpu_omp_threads_bind" {
  description = "VLLM_CPU_OMP_THREADS_BIND for the CPU vLLM container; empty = pin to all vCPUs."
  type        = string
  default     = ""
}
