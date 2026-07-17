output "instance_id" {
  description = "EC2 instance id for this deployment."
  value       = module.instance.instance_id
}

output "public_ip" {
  description = "Public IP (used only for outbound reachability; no inbound ports are open)."
  value       = module.instance.public_ip
}
