# Model Catalog

## Anatomy of a catalog entry

```yaml
models:
    - alias: fast-7b                        # your CLI-friendly label (shown in picker)
      hf_repo: Qwen/Qwen2.5-7B-Instruct    # HuggingFace model to serve with vLLM
      instance_type: g6.xlarge              # EC2 instance type
      disk_gb: 100                          # EBS volume size (model weights are cached here)
      context_length: 8192                  # vLLM --max-model-len
      # quantization: awq                   # optional: awq, gptq, fp8
      # hf_token_env: HF_TOKEN             # env var holding your HF token (gated repos)
      # idle_timeout: 1h                    # per-model override of the global default
```

All models are served from **HuggingFace** via vLLM's OpenAI-compatible server.

## VRAM sizing

vLLM loads the full model into GPU memory. A rough rule:

- **fp16 (default):** ~2 GB per 1B parameters — a 7B model needs ~14 GB, 32B needs ~64 GB
- **AWQ / GPTQ (4-bit):** ~0.6 GB per 1B parameters — a 32B model fits in ~20 GB
- **fp8 / int8:** ~1 GB per 1B parameters

`llmrun up` warns you before provisioning if the model likely won't fit the instance.

### Common instance / model pairings

| Instance | GPU | VRAM | Fits |
| --- | --- | --- | --- |
| `g6.xlarge` | 1× L4 | 24 GB | 7B fp16, 13B fp16 |
| `g5.2xlarge` | 1× A10G | 24 GB | 7B fp16, 13B fp16 |
| `g6e.2xlarge` | 1× L40S | 48 GB | 32B AWQ, 13B fp16 |
| `g6e.12xlarge` | 4× L40S | 192 GB | 32B fp16, 70B AWQ |

## Gated models

For models that require accepting HuggingFace terms (e.g. `meta-llama/*`), set your token:

```bash
export HF_TOKEN=hf_...
```

Then reference the env var in the catalog:

```yaml
- alias: llama-8b
  hf_repo: meta-llama/Llama-3.1-8B-Instruct
  instance_type: g6.xlarge
  disk_gb: 100
  hf_token_env: HF_TOKEN
```

## Multi-GPU models

For large models that need multiple GPUs, pick a multi-GPU instance. llmrun automatically detects the number of GPUs on boot and passes `--tensor-parallel-size N` to vLLM:

```yaml
- alias: qwen-32b
  hf_repo: Qwen/Qwen2.5-32B-Instruct
  instance_type: g6e.12xlarge   # 4× L40S = 192 GB total VRAM
  disk_gb: 200
  context_length: 32768
```

## CPU fallback

For small models, you can define a CPU fallback that runs via Ollama when GPU quota is unavailable:

```yaml
- alias: fast-7b
  hf_repo: Qwen/Qwen2.5-7B-Instruct
  instance_type: g6.xlarge
  disk_gb: 100
  cpu_fallback:
      instance_type: c7i.4xlarge
      engine: ollama
      max_params: 16B
```

`llmrun doctor` checks GPU quota automatically before provisioning and offers the CPU fallback if quota is zero.

## Running multiple models at once

Each `llmrun up` creates an independent deployment on its own local port:

```
llmrun up   # picks fast-7b → localhost:8000/v1
llmrun up   # picks qwen-32b-awq → localhost:8001/v1
```

Use `llmrun ls` to see all running endpoints and `llmrun connect --all` to re-establish all forwards after a restart.
