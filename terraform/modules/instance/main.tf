/*
 * Instance module: the GPU (or CPU-fallback) EC2 instance that serves the model.
 *
 * AMI selection:
 *   - gpu mode → AWS Deep Learning Base AMI (Ubuntu 22.04) which ships NVIDIA
 *     drivers, Docker, and the NVIDIA container toolkit, so first boot is fast.
 *   - cpu mode → stock Ubuntu 22.04.
 *
 * The bootstrap (user-data) installs the model server as a systemd service and
 * an idle-monitor timer that self-stops the instance. No inbound ports; access
 * is via SSM.
 */

data "aws_ami" "gpu" {
  count       = var.mode == "gpu" ? 1 : 0
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 22.04)*"]
  }
  filter {
    name   = "architecture"
    values = ["x86_64"]
  }
}

data "aws_ami" "cpu" {
  count       = var.mode == "cpu" ? 1 : 0
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }
  filter {
    name   = "architecture"
    values = ["x86_64"]
  }
}

locals {
  ami_id = var.mode == "gpu" ? data.aws_ami.gpu[0].id : data.aws_ami.cpu[0].id

  user_data = templatefile("${path.module}/templates/user-data.sh.tftpl", {
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
    vllm_cpu_image       = var.vllm_cpu_image
    vllm_cpu_kvcache_space     = var.vllm_cpu_kvcache_space
    vllm_cpu_omp_threads_bind  = var.vllm_cpu_omp_threads_bind
  })
}

resource "aws_instance" "this" {
  ami                         = local.ami_id
  instance_type               = var.instance_type
  subnet_id                   = var.subnet_id
  vpc_security_group_ids      = [var.security_group_id]
  iam_instance_profile        = var.iam_instance_profile
  associate_public_ip_address = true
  user_data                   = local.user_data

  # Stop (don't terminate) on OS shutdown so the idle monitor's `poweroff`
  # fallback preserves the disk and model cache.
  instance_initiated_shutdown_behavior = "stop"

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  root_block_device {
    volume_size = var.disk_gb
    volume_type = "gp3"
    encrypted   = true
  }

  # Fail fast when the AZ has no capacity so the CLI can retry the next AZ
  # rather than hanging silently for the provider's default 10-minute retry window.
  timeouts {
    create = "4m"
  }

  tags = merge(var.tags, { Name = "llmrun-${var.name}" })
}
