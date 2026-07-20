# Docs

## Prerequisites

Before installing llmrun you need:

- **Node.js ≥ 20**
- **[Terraform](https://developer.hashicorp.com/terraform/install)** — used to provision EC2 instances
- **[AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)** with credentials configured (`aws configure` or SSO)
- **[AWS Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)** — for the SSM port-forward that exposes the local endpoint

Run `llmrun doctor` at any time to check all of these automatically.

## Install

::: code-group

```bash [npm]
npm install -g llmrun
```

```bash [pnpm]
pnpm add -g llmrun
```

```bash [yarn]
yarn global add llmrun
```

```bash [bun]
bun add -g llmrun
```

:::

## Quick start

```bash
# 1. Scaffold a catalog in the current folder
llmrun init

# 2. Verify all prerequisites
llmrun doctor

# 3. See what models are available
llmrun models

# 4. Pick a model, approve the cost estimate, provision and connect
llmrun up
```

After `llmrun up` completes, the model is available at `http://localhost:8000/v1` — a full OpenAI-compatible endpoint.

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen/Qwen2.5-7B-Instruct",
    "messages": [{ "role": "user", "content": "Hello!" }]
  }'
```

## Lifecycle

```bash
llmrun ls               # see all deployments, their local URL and connection state
llmrun logs             # tail the vLLM server logs
llmrun stop             # stop the instance (keeps EBS + model cache, ~$0.10/day)
llmrun start            # restart and re-forward
llmrun down             # destroy everything (terraform destroy)
```

## AWS setup

llmrun needs an AWS account with:

- IAM permissions to create EC2 instances, IAM roles, and security groups
- GPU vCPU quota in your target region — fresh accounts often have a limit of 0 for G/P instance families

Check quota and get a link to request an increase:

```bash
llmrun doctor
```

::: tip First run takes longer
On first boot the instance downloads the model weights from HuggingFace and loads them into GPU memory. A 7B model takes ~5 minutes; a 32B model can take 20–30 minutes. Subsequent `llmrun start` commands skip the download — weights are cached on the EBS volume.
:::
