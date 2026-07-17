output "security_group_id" {
  description = "Id of the egress-only security group."
  value       = aws_security_group.this.id
}
