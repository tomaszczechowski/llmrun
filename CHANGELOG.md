# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- SSM port-forward lifecycle: forwards are now managed by process group, because the session-manager-plugin child (which owns the local port and the SSM session) outlives the recorded `aws` parent. `llmrun start`/`connect` no longer report a tunnel as dead (or rekill a healthy one) when only the parent pid is gone, and `llmrun doctor` now finds and kills orphaned forwarders left behind by previous runs that otherwise hold a local port and answer connections with nothing.
- `llmrun connect` now waits for model readiness after establishing the tunnel, so one command yields a queryable endpoint instead of a live tunnel to a still-loading model.
- Studio: time-series chart axes now draw gridlines (`stroke`).

### Changed

- "Model did not become healthy in time" messages on `llmrun start`/`up` now note the forward is up (the model may simply still be loading) and point to `llmrun connect` as the re-wait path.

## [1.0.6] - 2026-09-09

### Fixed

- npm package no longer ships the local terraform `.terraform` directory (AWS provider binary) — `npm i llmrun` download dropped from ~142 MB back to ~0.15 MB.

## [1.0.5] - 2026-09-09

### Changed

- Docs site migrated from VitePress to Fumadocs (Next.js) with a refreshed look (hero/OG assets, icons); fixed images and links across the docs.
- CPU vLLM default image pinned to `vllm/vllm-openai-cpu:v0.28.0` (the release verified live with the AWQ INT4 model). `:latest` is no longer the default — an untested future pull could silently change model behavior (especially for quantized models). Override with `cpu_fallback.vllm.image` only after testing the version.
- Starter template `fast-7b` example: `context_length` raised to 16384 and `tool_call_parser: hermes` added.

### Added

- CPU vLLM fallback: `cpu_fallback` now supports `engine: vllm`, which provisions a CPU-only instance running the official `vllm/vllm-openai-cpu` image (CPU platform is auto-detected — no device flags), with `--ipc=host`, `VLLM_CPU_KVCACHE_SPACE`, and `VLLM_CPU_OMP_THREADS_BIND` tuning.
- `cpu_fallback` options: `context_length` (CPU-only context override) and a `vllm` tuning block (`image`, `kvcache_space`, `omp_threads_bind`).
- `r8i.8xlarge` instance spec (32 vCPU / 256 GB) and a pre-provisioning RAM-fit warning for CPU vLLM deployments.

### Fixed

- `engine: vllm` on a CPU instance no longer launches the GPU container with `--gpus all` / `--gpu-memory-utilization` — the user-data bootstrap now branches on engine + mode (GPU vLLM, CPU vLLM, Ollama).
- `llmrun up` now aborts early when the instance type is not offered in the region (AZ pre-check) instead of burning ~4 minutes per AZ on a guaranteed "unsupported configuration" failure.

## [1.0.4] - 2026-09-03

### Added

- Kilo Code integration guide in the docs.

### Fixed

- `llmrun status`: renamed a local `info` variable that shadowed the UI `info` helper, made the STATE column fall back to `unknown` when state cannot be resolved, and printed the footer hint via the `info` helper.

## [1.0.3] - 2026-09-02

### Changed

- Qwen 3 (including Coder) now uses the `qwen3_xml` tool-call parser instead of `hermes`/`qwen3`. Qwen 2.5 continues to use `hermes`. Updated the model catalog, troubleshooting guide, and starter template accordingly.

## [1.0.2] - 2026-09-02

### Added

- `templates/llmrun.yaml` starter catalog template committed to the repo, with a `.gitignore` exception (`!templates/llmrun.yaml`) so it stays tracked.
- Per-model configuration reference in the docs, covering required fields (`alias`, `hf_repo`, `instance_type`, `disk_gb`) and optional fields (`context_length`, `quantization`, `tool_call_parser`, `hf_token_env`, `idle_timeout`).

## [1.0.1] - 2026-08-03

### Changed

- Updated service version with the version from `package.json`

## [1.0.0] - 2026-08-03

### Added

- Full CLI with commands to provision, manage, and connect to vLLM/Ollama deployments on AWS EC2
- Model catalog with predefined instances and configurations
- OpenAI-compatible API endpoint over AWS SSM port forwarding
- Integration documentation for Continue, Cursor, Cline, Aider, Open WebUI, OpenClaw, and OpenCode
- Troubleshooting guide covering common issues and optimization tips
- VitePress documentation site with GitHub Pages deployment
- GitHub Actions CI/CD workflow for docs builds
- Support for multiple AWS profiles and regions
- Per-model configuration in `llmrun.yaml` catalog
- GPU quota validation and instance sizing recommendations
- VRAM fit checking and context length guidance
- Deployment state tracking and lifecycle management
- SSM-based secure access without public IP exposure
