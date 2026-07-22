/*
 * Root module for a single llmrun deployment.
 *
 * Wires together the network (VPC + egress-only security group), IAM (SSM
 * access + self-stop), and instance (GPU/CPU model server) modules. Each
 * deployment is applied in its own copied workspace with isolated local state.
 */

provider "aws" {
    region = var.region
}

locals {
    common_tags = {
        Project = "llmrun"
        llmrun  = var.name
    }
}

module "network" {
    source = "../modules/network"

    name     = var.name
    az_index = var.az_index
    tags     = local.common_tags
}

module "iam" {
    source = "../modules/iam"

    name = var.name
    tags = local.common_tags
}

module "instance" {
    source = "../modules/instance"

    name                 = var.name
    instance_type        = var.instance_type
    disk_gb              = var.disk_gb
    subnet_id            = module.network.subnet_ids[var.az_index]
    security_group_id    = module.network.security_group_id
    iam_instance_profile = module.iam.instance_profile_name
    region               = var.region
    hf_repo              = var.hf_repo
    engine               = var.engine
    mode                 = var.mode
    remote_port          = var.remote_port
    idle_timeout_seconds = var.idle_timeout_seconds
    context_length       = var.context_length
    quantization         = var.quantization
    tool_call_parser     = var.tool_call_parser
    hf_token             = var.hf_token
    tags                 = local.common_tags
}
