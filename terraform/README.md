# Terraform for llmrun

This tree is bundled with the CLI and copied into each deployment's workspace
(`~/.llmrun/deployments/<name>/terraform/`) so every deployment gets isolated
local state. You normally don't run it by hand — the `llmrun` CLI drives it.

## Layout (per project convention)

- **`main/`** — the root module the CLI runs. Wires the modules together and
  exposes `instance_id` / `public_ip` outputs.
- **`modules/`** — one module per concern, each with its own `README.md`:
    - `network/` — egress-only security group (no inbound ports).
    - `iam/` — instance role/profile (SSM + tag-scoped self-stop).
    - `instance/` — the EC2 instance, AMI selection, and bootstrap user-data.
- **`tfvars/`** — generated per-deployment variable files. `example.tfvars.json`
  documents the shape; the CLI writes `<name>.tfvars.json` here at `up` time.

## Manual run (debugging)

```bash
cd main
terraform init
terraform apply -var-file=../tfvars/example.tfvars.json
```

Requires AWS credentials in the environment (the CLI sets `AWS_PROFILE` /
`AWS_REGION` for you).
