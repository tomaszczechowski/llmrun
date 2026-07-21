# Troubleshooting

Common issues encountered when running llmrun, with actionable fixes.

## Diagnosing problems with `llmrun logs`

`llmrun logs` is the first command to run when something isn't working. It tails the vLLM service journal directly from the instance over SSM — no SSH key needed.

```sh
llmrun logs                  # if only one deployment is running
llmrun logs <name>           # for a specific deployment
```

### What to look for

**Model still downloading** — first boot pulls weights from HuggingFace (can take 5–20 min depending on model size). Normal output looks like:

```
Downloading shards: 100%|██████████| 8/8 [04:23<00:00]
Loading weights took 3.94 seconds
```

**Model loaded, server starting** — after weights load, vLLM allocates KV cache and starts the HTTP server. Look for:

```
INFO:     Application startup complete.
```

This is the signal that the endpoint is ready to accept requests.

**KV cache error** — not enough GPU memory for the requested context length:

```
ValueError: To serve at least one request with the model's max seq len (32768),
8.0 GiB KV cache is needed, which is larger than the available KV cache memory (0.58 GiB).
```

→ See [KV cache too small](#vllm-crashes-on-startup-kv-cache-too-small) below.

**Gated model / missing token**:

```
huggingface_hub.errors.RepositoryNotFoundError: 401 Client Error
```

→ See [Gated HuggingFace repos](#model-download-stalls-or-fails-gated-huggingface-repo) below.

**Service crash-looping** — if the service exits and systemd keeps restarting it, you'll see repeating blocks ending in:

```
systemd[1]: llmrun-server.service: Main process exited, code=exited, status=1/FAILURE
systemd[1]: llmrun-server.service: Failed with result 'exit-code'.
systemd[1]: Restarting llmrun-server.service
```

The root cause is always in the lines just before the first `FAILURE` line.

### Checking deployment status

```sh
llmrun ls
```

Shows all deployments with their current state (`provisioning`, `running`, `stopped`, `no-instance`) and the local endpoint URL.

---

## vLLM crashes on startup — KV cache too small

**Symptom**

```
ValueError: To serve at least one request with the model's max seq len (32768),
8.0 GiB KV cache is needed, which is larger than the available KV cache memory (0.58 GiB).
```

**Cause**

GPU VRAM is almost entirely consumed by the model weights, leaving no room for the KV cache. This happens when a large model (e.g. 32B) is deployed on a single-GPU instance (e.g. `g5.2xlarge`, 24 GB VRAM) with a high `context_length`.

For reference, Qwen2.5-32B AWQ uses ~18 GB of weights. After vLLM's memory profiling pass (which peaks higher due to activations), only ~0.58 GB is left for the KV cache — too little to serve even one request at 32k context.

**Fix**

Reduce `context_length` in `llmrun.yaml` to match what the GPU can actually support:

```yaml
models:
  - alias: qwen-32b-awq
    instance_type: g5.2xlarge
    context_length: 2048        # safe for 24 GB VRAM with a 32B AWQ model
    quantization: awq
```

Then re-provision: `llmrun down <name>` → `llmrun up`.

The error message tells you the exact maximum (`estimated maximum model length is 2384`) — stay below that value.

**VRAM requirements by context length** (approximate, 32B AWQ model):

| Context length | KV cache needed | Min VRAM |
|---|---|---|
| 2 048 | ~0.5 GB | 24 GB (`g5.2xlarge`) |
| 8 192 | ~2 GB | 24 GB (`g5.2xlarge`) — tight |
| 32 768 | ~8 GB | 32+ GB (`g5.12xlarge` or larger) |

For 32k+ context with a 32B model, use a multi-GPU instance such as `g5.12xlarge` (4× A10G, 96 GB VRAM).

**GPU VRAM by instance** — includes the multi-GPU `g4dn.12xlarge` which is often more available than `g5` instances:

| Instance | GPU | Total VRAM | Good for |
|---|---|---|---|
| `g4dn.xlarge` – `g4dn.8xlarge` | 1× T4 | 16 GB | Models up to ~7B (fp16) or ~13B (AWQ) |
| `g4dn.12xlarge` | 4× T4 | **64 GB** | 32B AWQ with full context — good g5 alternative |
| `g5.2xlarge` / `g6.2xlarge` | 1× A10G / L4 | 24 GB | 32B AWQ, short context (≤ 2k) |
| `g5.12xlarge` / `g6.12xlarge` | 4× A10G / L4 | 96 GB | 32B AWQ with full 32k context |
| `g6e.2xlarge` | 1× L40S | 48 GB | 32B fp16, or 70B AWQ |
| `p4d.24xlarge` | 8× A100 40 GB | 320 GB | Very large models, long context |

::: tip g5 capacity constrained?
`g4dn.12xlarge` (4× T4, 64 GB) is a practical fallback — it's an older GPU but widely available and fits 32B AWQ models comfortably. llmrun automatically enables tensor parallelism across all 4 GPUs.
:::

---

## CUDA out of memory during model loading

**Symptom**

```
torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 136.00 MiB.
GPU 0 has a total capacity of 14.56 GiB of which 79.81 MiB is free.
```

**Cause**

The model weights alone exceed the GPU's VRAM. Unlike the KV cache error above (which happens after weights load), this crash occurs during loading itself. Common trigger: using a `g4dn` instance (T4, 16 GB) for a model that needs more VRAM than that.

For example, Qwen2.5-32B-AWQ needs ~22 GB just for weights — it cannot fit on any single-GPU `g4dn` instance (16 GB each).

**Fix**

Use an instance with more VRAM, or switch to a smaller model:

| Want to run | Minimum instance | Notes |
|---|---|---|
| 7B AWQ | `g4dn.xlarge` (16 GB) | |
| 13B AWQ | `g4dn.2xlarge` (16 GB) | tight |
| 32B AWQ | `g4dn.12xlarge` (4× T4, 64 GB) | good fallback when g5 unavailable |
| 32B AWQ | `g5.2xlarge` (A10G, 24 GB) | short context only (≤ 2k) |
| 70B AWQ | `g6e.2xlarge` (L40S, 48 GB) | |

Update the `instance_type` in `llmrun.yaml` and re-provision with `llmrun down` + `llmrun up`.

---

## No EC2 capacity in the selected region / AZ

**Symptom**

Terraform hangs on `aws_instance.this: Still creating... [Xm elapsed]` for several minutes without the instance appearing in the AWS console.

**Cause**

AWS has no On-Demand capacity for the requested instance type in the target Availability Zone at this moment. The Terraform AWS provider retries silently, so the apply hangs rather than failing immediately.

**What llmrun does automatically**

llmrun checks which AZs offer the instance type before provisioning, then retries across all available AZs (up to 3). Each attempt times out after 4 minutes. If all AZs are exhausted, the partial infrastructure is automatically cleaned up.

**Manual fixes**

- Wait 15–60 minutes and try again — AWS capacity is transient and usually recovers.
- Try a different region: set `aws_region` in `llmrun.yaml` or pass `--region <region>`.
- Switch to a more available instance type. `g5` capacity is often constrained — `g4dn.12xlarge` (4× T4, 64 GB) is a widely available alternative that fits 32B AWQ models with full context length.

---

## No default VPC in the region

**Symptom**

```
Error: no matching EC2 VPC found
  with data.aws_vpc.default
```

**Cause**

Some AWS accounts or regions don't have a default VPC (it may have been deleted, or never existed in a non-primary region).

**Fix**

llmrun creates its own dedicated VPC per deployment, so this should not occur with the current version. If you see this error, you are likely running an older version. Upgrade:

```sh
npm install -g llmrun@latest
```

Then re-provision after `llmrun down <name>`.

---

## SSM agent not connected — TargetNotConnected

**Symptom**

```
An error occurred (TargetNotConnected) when calling the StartSession operation:
i-0abc123 is not connected.
```

**Cause**

The SSM agent on the instance lost its connection to the AWS SSM service. Common triggers:

- The instance is still starting up (SSM registers ~60 s after "running").
- The vLLM service crash-looped and caused memory pressure that killed the SSM agent.
- The instance auto-stopped (idle timeout triggered because vLLM wasn't serving requests while crash-looping).
- Transient network issue inside the VPC.

**Fix**

Check the instance state first:

```sh
llmrun ls
```

- If **provisioning / starting** — wait 1–2 minutes for SSM to register.
- If **stopped** — the idle monitor likely triggered. Restart with `llmrun start <name>`.
- If **running** but still not connecting — stop and start the instance to force the SSM agent to re-register:

```sh
llmrun stop <name>
llmrun start <name>
```

---

## Port forward drops after instance restart or service change

**Symptom**

```sh
curl http://localhost:8001/v1/models
curl: (52) Empty reply from server
```

**Cause**

The SSM port-forward process runs locally and is not automatically re-established when the remote instance restarts or the service is reloaded. The connection appears open (curl connects) but the remote end drops the session.

**Fix**

Re-establish the forward:

```sh
llmrun connect <name>
```

---

## Instance auto-stops unexpectedly

**Symptom**

The instance stops on its own shortly after being provisioned, before you have had a chance to use it.

**Cause**

The idle monitor runs on the instance and stops it after `idle_timeout` seconds with no inference activity. If vLLM fails to start (e.g. due to a KV cache error), there are never any requests — the monitor sees the instance as idle and stops it.

**Fix**

1. Fix the underlying vLLM issue first (usually `context_length` too high — see above).
2. Increase the `idle_timeout` in `llmrun.yaml` if you need more time for the model to load on first boot:

```yaml
defaults:
  idle_timeout: 60m
```

---

## Model download stalls or fails (gated HuggingFace repo)

**Symptom**

vLLM logs show a 401/403 error or the model download hangs indefinitely:

```
huggingface_hub.errors.RepositoryNotFoundError: 401 Client Error
```

**Cause**

The HuggingFace model requires a token (gated repo such as Llama, Mistral, Gemma). The `HF_TOKEN` environment variable was not set.

**Fix**

Add `hf_token_env` to the model entry in `llmrun.yaml`:

```yaml
models:
  - alias: llama-8b
    hf_repo: meta-llama/Llama-3.1-8B-Instruct
    hf_token_env: HF_TOKEN        # reads from this env var at provision time
```

Then export the token before running `llmrun up`:

```sh
export HF_TOKEN=hf_...
llmrun up
```

Accept the model's license on [huggingface.co](https://huggingface.co) first if you haven't already.

---

## GPU quota is zero in the target region

**Symptom**

```
✖ GPU quota check: On-Demand G and VT instances quota is 0 vCPUs in eu-central-1.
```

**Cause**

Fresh AWS accounts have a default quota of 0 vCPUs for GPU instance families (G, P). This is a hard account-level limit, separate from capacity availability.

**Fix**

Request a quota increase through the AWS Service Quotas console. `llmrun doctor` prints the direct link for your region and instance family. GPU quota increases require manual AWS review and can take 1–3 business days.

While waiting, you can use the CPU fallback if configured, or switch to a region where your account already has GPU quota.

---

## ENOTEMPTY error after `llmrun down`

**Symptom**

```
Destroy complete! Resources: 4 destroyed.
✖ ENOTEMPTY, Directory not empty: /Users/you/.llmrun/deployments/my-model
```

**Cause**

macOS Finder silently writes `.DS_Store` files into directories as soon as they are opened. If Finder touches the deployment workspace between Node.js scanning and deleting it, the directory appears non-empty and the removal fails.

**Fix**

This is fixed in the current version — `llmrun down` now falls back to a shell `rm -rf` when Node's recursive delete races with `.DS_Store` writes.

If you hit it on an older version, delete the leftover directory manually:

```sh
rm -rf ~/.llmrun/deployments/<name>
```

---

## Something else?

If your issue isn't covered here, please [open an issue on GitHub](https://github.com/tomaszczechowski/llmrun/issues/new) with:

- The command you ran (`llmrun up`, `llmrun start`, etc.)
- The error message or relevant log output (`llmrun logs <name>`)
- Your instance type and region
- Output of `llmrun doctor`
