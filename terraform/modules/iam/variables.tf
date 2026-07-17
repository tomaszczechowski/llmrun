variable "name" {
  description = "Deployment name (used in role/profile names)."
  type        = string
}

variable "tags" {
  description = "Tags to apply to created resources."
  type        = map(string)
  default     = {}
}
