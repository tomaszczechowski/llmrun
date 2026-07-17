output "instance_profile_name" {
  description = "Name of the instance profile to attach to the EC2 instance."
  value       = aws_iam_instance_profile.this.name
}

output "role_arn" {
  description = "ARN of the instance role."
  value       = aws_iam_role.this.arn
}
