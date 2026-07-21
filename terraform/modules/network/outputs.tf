output "security_group_id" {
    description = "Id of the egress-only security group."
    value       = aws_security_group.this.id
}

output "subnet_ids" {
    description = "Ids of all public subnets (one per AZ)."
    value       = aws_subnet.this[*].id
}
