/*
 * Network module: an egress-only security group.
 *
 * There are NO inbound rules — the instance is never reachable from the
 * internet. All access (inference + shell) is via AWS SSM over the instance's
 * outbound connection. Egress is open so the agent can reach SSM endpoints and
 * the model can be pulled from HuggingFace / container registries.
 */

resource "aws_security_group" "this" {
  name        = "llmrun-${var.name}"
  description = "llmrun ${var.name}: egress-only, access via SSM"
  vpc_id      = var.vpc_id

  egress {
    description = "Allow all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, { Name = "llmrun-${var.name}" })
}
