# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
