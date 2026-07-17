output "instance_id" {
  description = "EC2 instance id."
  value       = aws_instance.this.id
}

output "public_ip" {
  description = "Public IP address (outbound reachability only)."
  value       = aws_instance.this.public_ip
}
