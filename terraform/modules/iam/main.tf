/*
 * IAM module: the instance role/profile.
 *
 * Grants:
 *   - AmazonSSMManagedInstanceCore  → Session Manager (shell, port-forward, logs)
 *   - self-stop                     → the on-instance idle monitor can stop the
 *                                     instance it runs on (scoped by the
 *                                     Project=llmrun resource tag)
 */

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "this" {
  name               = "llmrun-${var.name}"
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.this.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "self_stop" {
  # DescribeInstances does not support resource-level permissions.
  statement {
    sid       = "Describe"
    actions   = ["ec2:DescribeInstances"]
    resources = ["*"]
  }

  # Allow stopping only instances tagged as part of llmrun.
  statement {
    sid       = "SelfStop"
    actions   = ["ec2:StopInstances"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/Project"
      values   = ["llmrun"]
    }
  }
}

resource "aws_iam_role_policy" "self_stop" {
  name   = "llmrun-self-stop"
  role   = aws_iam_role.this.id
  policy = data.aws_iam_policy_document.self_stop.json
}

resource "aws_iam_instance_profile" "this" {
  name = "llmrun-${var.name}"
  role = aws_iam_role.this.name
  tags = var.tags
}
