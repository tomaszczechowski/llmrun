# Spec: CPU vLLM Fallback

## Goal

Make `cpu_fallback: { engine: vllm }` in `llmrun.yaml` actually provision a real CPU vLLM deployment instead of a broken GPU vLLM launch.

- Status: **implemented and verified live** (not yet committed) — typecheck/lint/`terraform validate`/templatefile renders + real `r8i.8xlarge` EC2 CPU instance serving `cyankiwi/Qwen3.8-27B-AWQ-INT4` via vLLM 0.28.0 (2026-09-06, see Live Test Results)
- Problem: user-data branched on `ENGINE` only. Any `engine: vllm` — including `mode: cpu` — launched `vllm/vllm-openai:latest` with `--gpus all` and `--gpu-memory-utilization 0.95`. On a CPU instance (r8i.8xlarge) there are no GPUs, so the container never worked.
- Activation path (unchanged): `llmrun up` → `resolveTarget()` → `checkGpuQuota()` (Service Quotas, G/P/vt family vCPU limit vs instance vCPUs) → on `fail`, interactive offer of the configured `cpu_fallback`. No time-based fallback exists: AZ capacity exhaustion aborts instead.

## Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| CPU image | Official `vllm/vllm-openai-cpu:latest`, overridable via `cpu_fallback.vllm.image` | vLLM publishes official CPU images/wheels (x86 since v0.17). The original draft proposed building a custom `llmrun/vllm-cpu` Dockerfile — no longer necessary. |
| YAML shape | `cpu_fallback.vllm: { image, kvcache_space, omp_threads_bind }` + `cpu_fallback.context_length` | Explicit typed fields instead of a generic `env:` map. `context_length` override needed because CPU KV cache lives in RAM: the 200k GPU context would pressure RAM on CPU (32k used for the 27B model). |
| OMP threads | Default: pin to all vCPUs (`0-<nproc-1>` at bootstrap); overridable | Correct default on any instance size; no hardcoded core counts. |
| RAM guard | `checkCpuRamFit()` warn in the pre-provisioning cost preview (weights + kvcache_space + 12 GB runtime vs instance memory) | Mirrors the existing GPU `checkVramFit` pattern; catches the "27B + big KV on small RAM" OOM before spending money. |
| Instance spec | `r8i.8xlarge` = 32 vCPU / 256 GiB / ~$2.2227/h (us-east-1) | Needed for the cost preview and the RAM check; CPU specs gained a `memoryGb` field. |

## Changes

- `src/lib/catalog.ts` — new `cpuVllmSchema` (`image`, `kvcache_space`, `omp_threads_bind`); `cpuFallbackSchema` gains `context_length` and `vllm`; exports `CpuVllm`.
- `src/lib/instances.ts` — `InstanceSpec.memoryGb?`; `r8i.8xlarge` added, `memoryGb` on all CPU specs; new `checkCpuRamFit()`.
- `src/commands/up.ts` — `ResolvedTarget` gains `contextLength?` / `cpuVllm?`; the fallback branch populates them; `context_length: target.contextLength ?? model.context_length`; new vars `vllm_cpu_image` / `vllm_cpu_kvcache_space` / `vllm_cpu_omp_threads_bind`; CPU RAM-fit warning + confirm in `previewCostAndConfirm`; fallback warning text distinguishes vllm vs ollama.
- `src/lib/terraform.ts` — `TerraformVars` gains the three `vllm_cpu_*` fields (optional; undefined values are stripped so TF defaults apply).
- `terraform/main/variables.tf` + `terraform/main/main.tf` — three new root vars (defaults: `vllm/vllm-openai-cpu:latest`, `16`, `""`), wired to the instance module.
- `terraform/modules/instance/variables.tf` + `main.tf` — same three vars; passed into `templatefile()`.
- `terraform/modules/instance/templates/user-data.sh.tftpl` — three-way branch:
  - `vllm` + `gpu` → unchanged GPU container
  - `vllm` + `cpu` → no `--device` flag at all (CPU platform auto-detected; `--device cpu` crash-loops on vLLM 0.28), `--ipc=host --security-opt seccomp=unconfined --cap-add SYS_NICE` (NUMA mempolicy inside Docker), no `--gpus`/`--gpu-memory-utilization`, `-e VLLM_CPU_KVCACHE_SPACE=<kvcache_space>`, `-e VLLM_CPU_OMP_THREADS_BIND=<bind>`
  - else → unchanged Ollama container
- `llmrun.yaml` (local, gitignored) — `qwen-3.8-27B-awq-g6` gains: `cpu_fallback: { r8i.8xlarge, engine: vllm, quantization: awq, max_params: 32B, context_length: 32768, vllm: { kvcache_space: 16, omp_threads_bind: "0-31" } }`.
- `templates/llmrun.yaml` — starter-template comments document the vllm fallback options.
- Docs: `docs/content/docs/guide/model-catalog.mdx` (CPU fallback section rewritten: engines, full YAML, CPU sizing) and `configuration.mdx` (`cpu_fallback` row in the per-model table). `CHANGELOG.md` — `[Unreleased]` Added/Fixed.

## Templatefile Escaping Gotcha (verified empirically, TF 1.9.5)

`$$` unescapes to a literal `$` **only when followed by `{`**. A `$$(` sequence passes through as `$$( ` unchanged. So in `.tftpl`:

- `$$(command)` → correct for shell command substitution
- `$${SHELL_VAR}` → correct for shell variables
- `${tf_var}` → templatefile interpolation (values from `templatefile(...)` locals)

The first draft used `NPROC=$$(nproc)` / `LAST=$$$((NPROC - 1))`, which rendered broken (`$$(nproc)`); fixed to single-`$` forms.

## Verification

- `pnpm run typecheck` — pass
- `pnpm run lint` — pass, no new warnings (4 pre-existing padding warnings, same set before/after)
- `terraform init -backend=false && terraform validate` in `terraform/main` — valid
- Render test: scratch module calling `templatefile()` with all vars, for all three branches (vllm+cpu, vllm+gpu, ollama+cpu); all outputs pass `bash -n`
- CPU render spot-check: `--device cpu`, `vllm/vllm-openai-cpu:latest`, `VLLM_CPU_KVCACHE_SPACE="16"`, `OMP_BIND` pinned to `0-31`, zero `--gpus`/`--gpu-memory-utilization` in the vllm+cpu branch

## Idle-Monitor Stale-Timestamp Bug (2026-09-09, fixed — not yet committed)

- Symptom: `llmrun start qwen-3.8-27B-awq-g6` (the live-tested CPU deployment) restarted the `r8i.8xlarge`, SSM + port-forward came up, then "Model did not become healthy in time" — the instance self-powered-off ~5 min after boot (`StateReason: Client.InstanceInitiatedShutdown`; SSM session died ~10 min after `LaunchTime`).
- Root cause: the idle monitor's `last_active` file (`/var/lib/llmrun/last_active`) persists on the root EBS across stop/start. At boot, the first timer tick (OnBootSec=5min) compared `now - last` — where `last` was from the previous boot's session — against `IDLE_SECONDS`; a pre-boot timestamp always exceeds the timeout, so a restarted instance powered itself off before vLLM could load the model.
- Fix (`user-data.sh.tftpl`): clamp `last` to the current boot time (`boot` was already computed for the usage ledger's `lasttick` boundary), mirroring that existing pattern. A fresh boot now starts a fresh idle window; legitimate idle-stop within a boot is unchanged. Verified with a rendered-template simulation: stale pre-boot timestamp → stays up; 2h idle this boot → powers off; first boot (no state file) → stays up.
- Note: the monitor is baked into `/opt/llmrun/idle-monitor.sh` at first boot, so existing instances need re-provisioning (`llmrun down` + `llmrun up`) to pick up the fix.

## Follow-ups

- Primary (non-fallback) CPU model entries still impossible: `resolveTarget()` hardcodes `mode: "gpu"` for the main target. Intentional for now; a `mode: cpu` model field would be the natural extension if CPU becomes a first-class production backend.
- Default CPU image pinned to `vllm/vllm-openai-cpu:v0.28.0` (2026-09-09) — the exact release live-tested above (vLLM 0.28.0). `:latest` is intentionally no longer the default: a future untested pull could silently change model behavior (quantized models first). The GPU path (`vllm/vllm-openai:latest` in `user-data.sh.tftpl`) is still unpinned — same reasoning applies.
- Nothing committed yet.

## Live Test Results (2026-09-06)

First real `llmrun up` run with the new code (GPU quota failed → CPU fallback offered → `r8i.8xlarge` provisioned):

- AMI/Docker path worked: stock Ubuntu, Docker installed, `vllm/vllm-openai-cpu:latest` pulled, systemd unit came up (Description "llmrun model server (vLLM, CPU)" — confirms the new branch ran).
- **Bug found: quantization mismatch crash-loop.** `cpu_fallback.quantization: awq` was passed as `--quantization awq`, but `cyankiwi/Qwen3.8-27B-AWQ-INT4` declares `quantization_config: compressed-tensors` in its `config.json`. vLLM (0.28.0) validates `model config quantization == --quantization` and aborts:
  `Value error, Quantization method specified in the model config (compressed-tensors) does not match the quantization method specified in the quantization argument (awq)`.
- **Fix:** drop the `quantization` field from the config — vLLM auto-detects the method from the model config (this is also what the working GPU deployment does). CPU backend does support compressed-tensors W4A16 INT4 (merged PR vllm-project/vllm#38219, in v0.28.0).
- **Second crash, `--device cpu` (fixed):** with quantization gone, the server got further and died in `arg_utils._resolve_device_ids`: `ValueError: Non-integer device ID 'cpu' is not supported by cpu.` The CPU *platform* is auto-detected correctly on the CPU-only image, but vLLM 0.28 routes the `--device` value into `device_ids`, and the CPU base platform's `device_control_id_to_physical_device_id` does `int(device_id)` — no device flag is needed (or allowed as a string) on CPU. Fix: removed `--device cpu` from the user-data template's vllm+cpu branch (`EXTRA_ARGS=""`). Note: the model resolves as `Qwen3_5ForConditionalGeneration` (a VLM architecture) — untested on CPU; if the next crash is "architecture not supported", that's the next layer.
- Docs/template comments updated: `quantization` is "rarely needed; a mismatched value crashes".
- Re-provision required for the fix (the unit file bakes the flags at bootstrap): `llmrun down qwen-3.8-27B-awq-g6` → `llmrun up`.
- **SUCCESS (2026-09-06, ~20:15 UTC):** re-provisioned `r8i.8xlarge` (ip-10-0-1-132) with the fixed flags — vLLM 0.28.0 loaded `cyankiwi/Qwen3.8-27B-AWQ-INT4` (VLM arch `Qwen3_5ForConditionalGeneration` works on CPU, GDN linear-attention falls back to Triton kernels) with `CPUWNA16LinearKernel for CompressedTensorsWNA16` (quantization auto-detected from config.json, as intended) and 32 OMP threads bound. Server reached "Application startup complete"; `GET /health` and `POST /v1/chat/completions` return 200 (generation ~2–4 tok/s — plausible for 27B AWQ on 32 vCPU). CPU fallback path is fully functional end-to-end.
- **NUMA follow-up (template only, next provision):** logs showed `get_mempolicy: Operation not permitted` / `numa_migrate_pages failed` — the documented consequence of Docker lacking `SYS_NICE`/seccomp for NUMA mempolicy. Added `--security-opt seccomp=unconfined --cap-add SYS_NICE` to the vllm+cpu `docker run` (matches official vLLM CPU docker examples). The currently running instance predates this; it works fine but has weaker NUMA placement until re-provisioned. OMP default stays `0-<nproc-1>` (all vCPUs) — the docs-recommended `auto` can shrink core usage on single-rank multi-socket boxes, so it's only usable via explicit `vllm_cpu_omp_threads_bind`.

## Cost Table Extension (2026-09-06)

`src/lib/instances.ts` `INSTANCE_SPECS` expanded for the CPU fallback path (us-east-1 on-demand, verified against AWS pricing sites): c7i.12xlarge ($2.142/96 GB), m7i.8xlarge ($1.6128/128 GB), r7i.2xlarge ($0.5292/64 GB), r7i.4xlarge ($1.0584/128 GB), r7i.8xlarge ($2.1168/256 GB), r8i.2xlarge ($0.5557/64 GB), r8i.4xlarge ($1.1114/128 GB), r8i.12xlarge ($3.3341/384 GB). Note: R-family is 1:8 vCPU:RAM (r7i.8xlarge = 256 GiB, not 512). Docs gained a "CPU fallback instances" table in `model-catalog.mdx` with per-instance fit guidance (~0.7 GB/1B params for AWQ 4-bit + 16 GB KV + ~12 GB runtime).
