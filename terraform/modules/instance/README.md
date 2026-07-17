# instance module

Launches the EC2 instance that serves the model and bootstraps it.

## AMI

- **`mode = "gpu"`** → AWS Deep Learning Base AMI (Ubuntu 22.04), which ships
  NVIDIA drivers, Docker, and the NVIDIA container toolkit — so the vLLM
  container can start without a slow driver install.
- **`mode = "cpu"`** → stock Ubuntu 22.04 (Docker is installed at boot).

## Bootstrap (user-data)

`templates/user-data.sh.tftpl` does the following on first boot:

1. Ensures the SSM agent is running (all access is via SSM).
2. Ensures Docker is available.
3. Installs a `llmrun-server` systemd service:
    - GPU: `vllm/vllm-openai` serving an OpenAI-compatible API on port 8000.
    - CPU: `ollama/ollama` (experimental fallback).
4. Installs a `llmrun-idle` systemd timer that stops the instance after
   `idle_timeout_seconds` of inactivity (via `poweroff`; the instance's
   shutdown behavior is `stop`, so disk + model cache are preserved).

The security group opens **no inbound ports**; the model is reached only through
an SSM port-forward established by the CLI.

## Key inputs

| Name                   | Description                            |
| ---------------------- | -------------------------------------- |
| `instance_type`        | EC2 instance type                      |
| `disk_gb`              | Root volume size (fit weights + cache) |
| `mode` / `engine`      | `gpu`+`vllm` or `cpu`+`ollama`         |
| `hf_repo`              | HuggingFace model to serve             |
| `idle_timeout_seconds` | Inactivity before auto-stop            |
| `hf_token`             | Token for gated repos (sensitive)      |

## Outputs

| Name          | Description        |
| ------------- | ------------------ |
| `instance_id` | EC2 instance id    |
| `public_ip`   | Public IP (egress) |
