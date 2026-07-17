# iam module

Creates the EC2 instance role and instance profile for a deployment.

Permissions granted:

- **`AmazonSSMManagedInstanceCore`** (managed policy) — lets the instance
  register with Systems Manager so Session Manager can be used for shell access,
  port forwarding, and log tailing. This is what removes the need for SSH keys,
  a bastion, or inbound ports.
- **Self-stop** — `ec2:StopInstances` scoped by the `Project=llmrun` resource
  tag, plus `ec2:DescribeInstances`. This lets the on-instance idle monitor stop
  the instance it runs on when the model has been idle past the timeout.

## Inputs

| Name   | Description                          | Type          |
| ------ | ------------------------------------ | ------------- |
| `name` | Deployment name (role/profile names) | `string`      |
| `tags` | Tags applied to created resources    | `map(string)` |

## Outputs

| Name                    | Description                                |
| ----------------------- | ------------------------------------------ |
| `instance_profile_name` | Instance profile to attach to the instance |
| `role_arn`              | ARN of the instance role                   |
