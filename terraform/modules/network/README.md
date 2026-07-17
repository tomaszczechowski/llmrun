# network module

Creates the security group for an llmrun deployment.

- **Egress-only**: all outbound traffic is allowed (so the SSM agent can reach
  AWS and the model can be downloaded); there are **no inbound rules**.
- The instance is therefore never reachable directly from the internet — all
  access happens through AWS Systems Manager (SSM) Session Manager.

## Inputs

| Name     | Description                            | Type          |
| -------- | -------------------------------------- | ------------- |
| `name`   | Deployment name (used in SG name/tags) | `string`      |
| `vpc_id` | VPC to create the security group in    | `string`      |
| `tags`   | Tags applied to the security group     | `map(string)` |

## Outputs

| Name                | Description                          |
| ------------------- | ------------------------------------ |
| `security_group_id` | Id of the egress-only security group |
