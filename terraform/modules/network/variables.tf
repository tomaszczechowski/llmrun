variable "name" {
    description = "Deployment name."
    type        = string
}

variable "az_index" {
    description = "Index into the region's AZ list for the instance subnet (0, 1, or 2)."
    type        = number
    default     = 0
}

variable "tags" {
    description = "Tags to apply to created resources."
    type        = map(string)
    default     = {}
}
