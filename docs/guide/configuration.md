# Configuration

## llmrun.yaml

Running `llmrun init` scaffolds an `llmrun.yaml` in the current directory. This file defines both the model catalog and the defaults for your project.

```yaml
defaults:
    aws_profile: default        # AWS CLI profile to use
    aws_region: eu-central-1    # AWS region to deploy into
    idle_timeout: 30m           # auto-stop after this much inactivity
    base_port: 8000             # local ports are allocated from here upward
    engine: vllm

models:
    - alias: fast-7b
      hf_repo: Qwen/Qwen2.5-7B-Instruct
      instance_type: g6.xlarge
      disk_gb: 100
      context_length: 8192
```

## Defaults

| Field          | Default         | Description                                              |
| -------------- | --------------- | -------------------------------------------------------- |
| `aws_profile`  | `default`       | AWS CLI profile (`~/.aws/credentials`)                   |
| `aws_region`   | —               | AWS region. Required — set it or pass `--region`         |
| `idle_timeout` | `30m`           | Auto-stop after inactivity. Formats: `30m`, `1h`, `90s` |
| `base_port`    | `8000`          | First local port. Each deployment gets the next free one |
| `engine`       | `vllm`          | Serving engine (only `vllm` supported in v0.1)           |

## Resolution order

Settings are resolved in this priority (highest first):

1. CLI flags (`--profile`, `--region`)
2. Environment variables (`AWS_PROFILE`, `AWS_REGION`)
3. `llmrun.yaml` `defaults` in the current directory
4. `~/.llmrun/config.json` global config
5. AWS CLI defaults

## Global config

```bash
llmrun config                           # show resolved config
llmrun config --set region=us-east-1   # set a value
```

Global config is stored at `~/.llmrun/config.json` and applies across all projects that don't have their own `llmrun.yaml`.

## Deployment state

Each deployment's state (instance ID, local port, region, profile, forward PID) is persisted at:

```
~/.llmrun/deployments/<name>/deployment.json
```

The Terraform workspace lives alongside it:

```
~/.llmrun/deployments/<name>/terraform/
```

`llmrun down` removes both.

## Custom home directory

By default llmrun stores all state under `~/.llmrun`. Override it with the `LLMRUN_HOME` environment variable:

```bash
export LLMRUN_HOME=/data/llmrun
```

This affects all paths — global config, deployment state, and Terraform workspaces. Useful for:

- Keeping state on a separate volume
- Running multiple isolated llmrun environments side by side
- CI/CD pipelines where writing to `$HOME` is undesirable

```bash
# run with a project-local state directory
LLMRUN_HOME=./.llmrun-state llmrun up
```
