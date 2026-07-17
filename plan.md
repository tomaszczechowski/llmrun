# llmrun — CLI for running open-source LLMs on AWS EC2

## Context

You want a CLI that lets a developer pick an open-source model from a catalog, spin up a
correctly-sized GPU EC2 instance on AWS (via Terraform), and get a **local `http://localhost/v1`
endpoint** to develop against — with automatic cost control (idle auto-stop) and secure access
(no public ports, no SSH keys). Proprietary models can optionally be routed to Bedrock later.

This document is a **design proposal only** — no code is written at this stage. It captures the
name recommendation, architecture, command surface, and a phased build plan, incorporating your
decisions:

- **vLLM** as the serving engine (native OpenAI-compatible API; multi-model-per-instance is a v2 goal).
- **localhost via AWS SSM port-forwarding** as the access model (also covers SSH — no bastion needed).
- **Cost preview + explicit user approval** before any instance is provisioned.
- **Configurable idle timeout** for auto-stop.
- **HuggingFace** as the primary model source.

---

## Name recommendation

**`llmrun`** — for both the CLI command and the NPM package.

- ✅ Available on NPM (verified: registry returns 404).
- ✅ Matches your existing directory name (`llmrun`).
- Short, typed as `llmrun <cmd>`, reads as "LLM run".
- Other verified-free candidates if you change your mind: `llmup`, `spinllm`, `llmbox`, `gpubox`, `boltllm`.

---

## What it is (one-line pitch)

> `llmrun` provisions a right-sized GPU EC2 instance, serves your chosen HuggingFace model with vLLM,
> and forwards it to `http://localhost:8000/v1` — auto-stopping when idle so you only pay while you use it.

Your app points at `http://localhost:8000/v1` with any OpenAI SDK and just works.

---

## Architecture overview

```
┌── Local machine ──────────────┐        ┌── AWS ───────────────────────────────┐
│                               │        │                                       │
│  llmrun CLI (Node/TS)         │        │  EC2 GPU instance (e.g. g6.xlarge)    │
│   ├─ reads models.yaml        │  SSM   │   ├─ vLLM serving OpenAI /v1          │
│   ├─ runs terraform apply ────┼────────┼──▶│   ├─ model pulled from HuggingFace   │
│   ├─ SSM port-forward :8000 ◀─┼────────┼──┤   └─ idle-monitor (systemd timer)   │
│   └─ cost preview + approve   │  (no   │   │        └─ self-stops when idle       │
│                               │  public│  Terraform state (local ~/.llmrun or   │
│  your app → localhost:8000/v1 │  ports)│  S3 backend)                           │
└───────────────────────────────┘        └───────────────────────────────────────┘
```

Key property: **no inbound security-group rules, no public IP, no SSH keypair**. All traffic
(inference + shell) rides through SSM over the instance's outbound connection to AWS. This is the
secure default and simultaneously satisfies the "SSH via Session Manager" requirement without a bastion.

---

## Command surface (proposed)

> **Two distinct names — don't confuse them:**
>
> - **Model alias** — the friendly name _you_ pick in `llmrun.yaml` for a HuggingFace repo. You set
>   `hf_repo: meta-llama/Llama-3.1-8B-Instruct` and can `alias: fast-8b` however you like. This is
>   what shows in the `llmrun up` picker. It names a _config_, not anything running.
> - **Instance name** = the `[name]` argument below. Each `llmrun up` creates a running **deployment**
>   whose name **defaults to the chosen model alias**, but can be overridden with `--name` (so you can
>   run the same model as two instances, e.g. `fast-8b-dev` and `fast-8b-test`). It's the handle for
>   lifecycle commands and maps to the Terraform workspace `~/.llmrun/<name>/`.
>
> `[name]` is **optional**: with one running deployment it's inferred; with several, omitting it opens
> an arrow-key picker.

| Command                            | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `llmrun models`                    | List models from merged catalog (bundled + local), with instance type & est. cost/hr.                                                                                                                                                                                                                                                                                                                                                                                         |
| `llmrun up [--name <instance>]`    | **Always** shows the interactive picker of model aliases from `llmrun.yaml` (arrow-key select — no typing a model name by hand) → **show cost estimate → confirm** → `terraform apply` → wait for vLLM health → start port-forward. Instance name defaults to the selected model alias; `--name` overrides it to run the same model as a separate instance.                                                                                                                   |
| `llmrun stop [name]`               | Stop the instance (keeps EBS/model cache; fast restart, low cost).                                                                                                                                                                                                                                                                                                                                                                                                            |
| `llmrun start [name]`              | Restart a stopped instance and re-forward.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `llmrun down [name]`               | `terraform destroy` — tear everything down.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `llmrun ls` / `status`             | Show running/stopped deployments, each with its **local URL/port**, connection state, uptime, accrued cost estimate, and idle timer.                                                                                                                                                                                                                                                                                                                                          |
| `llmrun connect [name] [--all]`    | (Re)establish an SSM port-forward for a deployment on **its own local port**. Multiple deployments forward **concurrently** — no need to disconnect one to reach another. `--all` forwards every running deployment at once.                                                                                                                                                                                                                                                  |
| `llmrun disconnect [name] [--all]` | Tear down the local port-forward(s) without stopping the instance.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `llmrun ssh [name]`                | Open an SSM shell session on the instance.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `llmrun logs [name]`               | Tail vLLM logs over SSM.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `llmrun init`                      | Scaffold an editable `llmrun.yaml` (defaults + sample models) into the current folder. Single entry point — no separate `catalog init`.                                                                                                                                                                                                                                                                                                                                       |
| `llmrun config`                    | Show/edit resolved config (AWS profile, region, default idle timeout, state backend, base port).                                                                                                                                                                                                                                                                                                                                                                              |
| `llmrun doctor`                    | Preflight check: verifies `terraform` & `aws` CLIs are installed and version-ok, AWS credentials/region configured, SSM Session Manager plugin present, and **checks the G/P (GPU) vCPU service quota** for the selected instance's family. Prints actionable fixes for anything missing. **Also runs automatically in the background at the start of `up` and `start`** — aborts with the doctor report if a hard prerequisite is missing. See the GPU-quota handling below. |

---

## Model catalog (YAML)

**Resolution order** (later overrides earlier): bundled defaults → `~/.llmrun/models.yaml` →
`./llmrun.yaml` in the cwd. This makes the list "editable in the local folder" as requested.

```yaml
# llmrun.yaml
defaults:
    aws_profile: default # which AWS CLI/SDK profile to use (override: --profile / env AWS_PROFILE)
    region: eu-central-1
    idle_timeout: 30m # configurable auto-stop (per-model override allowed)
    base_port: 8000 # local ports auto-allocated from here per deployment
    engine: vllm

models:
    - alias: fast-8b # YOUR chosen CLI name (shown in the picker)
      hf_repo: meta-llama/Llama-3.1-8B-Instruct # the HuggingFace model (only source supported)
      engine: vllm
      instance_type: g6.xlarge # right-sized GPU
      disk_gb: 100
      context_length: 8192
      # quantization: awq                       # optional
      # hf_token_env: HF_TOKEN                  # for gated repos

    - alias: qwen-32b
      hf_repo: Qwen/Qwen2.5-32B-Instruct
      instance_type: g6e.2xlarge
      disk_gb: 200
      context_length: 32768
```

Every model comes from **HuggingFace** (`hf_repo`) — that's the only source. **AWS profile & region** live in `defaults` (`aws_profile`, `region`) so a repo's `llmrun.yaml` pins
which account it targets. Resolution order (highest first): `--profile`/`--region` flags → `AWS_PROFILE`/
`AWS_REGION` env → `llmrun.yaml` defaults → AWS CLI default. `doctor` reports the effective profile/region.

Each entry maps
**your chosen alias → a HuggingFace model → serving engine → required instance type/disk**. The
`alias` is a free-form CLI-friendly label you control; `hf_repo` is the real model. This is the core
of your "list of models and needed EC2 instance defined in yaml" requirement. When you `llmrun up`
and select an alias, the running instance is named after that alias by default (override with `--name`).

---

## Component design

### 1. Terraform layer

- Bundle `.tf` templates inside the package; render per-run into a workspace under `~/.llmrun/<name>/`.
- CLI shells out to the user's `terraform` binary (detect & version-check; document install).
- **State**: default local state in `~/.llmrun/`; optional S3 + DynamoDB backend via `llmrun config` for teams.
- Resources: EC2 GPU instance, IAM instance profile (SSM + optional Bedrock), SG with **egress-only**,
  EBS volume sized from catalog, user-data bootstrap. No key pair, no inbound rules.

### 2. Instance bootstrap (user-data / cloud-init)

- Install NVIDIA drivers + container runtime (or use a GPU-ready AMI / Deep Learning AMI to cut boot time).
- Pull the model from **HuggingFace** (respecting `hf_token_env` for gated repos), cache on EBS.
- Launch **vLLM** with the OpenAI-compatible server on an internal port.
- Install the **idle-monitor** systemd timer.

### 3. Auto-stop (idle monitor)

- systemd timer on the box checks time since the last inference request (from vLLM metrics/access log).
- If idle beyond `idle_timeout` (configurable, per-model or global) → `aws ec2 stop-instances` on self
  (instance shutdown behavior = `stop`, so EBS + model cache persist for fast `llmrun start`).
- **Phase 2 backstop**: optional CloudWatch low-GPU-utilization alarm as a safety net.

### 4. Access & exposure (SSM)

- `aws ssm start-session --document AWS-StartPortForwardingSession` maps `localhost:<port> → instance:8000`.
- Gives a stable `http://localhost:<port>/v1` for any OpenAI-compatible client.
- **Per-deployment local port** — each deployment is assigned its own local port (auto-allocated from a
  base, e.g. 8000, 8001, 8002; overridable via `--port` or a catalog default). The port is recorded in
  the deployment's state so it's stable across `connect`/`disconnect`. Running **3 models at once** means
  three simultaneous forwards (`localhost:8000/v1`, `localhost:8001/v1`, `localhost:8002/v1`) — you do
  **not** disconnect one to use another. `llmrun ls` shows each deployment's local URL.
- Each forward runs as a background process the CLI tracks (PID in state) so `disconnect`/`connect` are clean.
- Same SSM channel powers `llmrun ssh` and `llmrun logs`. **No bastion, no public URL, no keys.**

### 5. Cost preview & approval (your requirement)

- Before `terraform apply`, compute an estimate from the instance type's on-demand price
  (bundled price table per region, refreshable via the AWS Pricing API) × expected usage.
- Show: instance type, $/hr, est. $/day if left running, and the idle-timeout safety note.
- Require explicit confirmation (or `--yes` to skip). `llmrun status` shows accrued estimate too.

### 6. GPU quota handling & CPU fallback

- `doctor` (and the auto-preflight on `up`/`start`) queries the **Service Quotas API** for the running
  On-Demand G/P vCPU limit in the target region and compares it against the vCPUs the selected
  instance type needs.
- **If quota is 0 or insufficient**, the CLI does not just fail — it prints clear guidance:
    - The exact quota that's short and by how much.
    - A direct **Service Quotas increase-request link** (deep-linked to the right quota code/region) and a
      note that G/P increases are a manual AWS review (contact AWS Support / account team; can take time).
    - An offer to **fall back to a CPU instance** for eligible models: catalog entries flagged
      CPU-capable (small/quantized, guarded by a **`max_params` limit, e.g. ≤ 16B**) can be served on a
      general-purpose instance (e.g. `c7i`/`m7i`) via a CPU-capable engine (llama.cpp/GGUF or vLLM-CPU).
      Clearly labeled as **much slower — for functional dev/testing, not throughput**, with its own cost
      estimate. Models above the parameter cap are refused with an explanation.
- Catalog fields supporting this: an optional `cpu_fallback` block per model (CPU instance type,
  quantization, `max_params` guard). GPU remains the default path.

### 7. Bedrock (Phase 2, optional)

- v1 is **HuggingFace-only**. If Bedrock is added later it would be a _separate_ catalog concept
  (e.g. a distinct `bedrock:` section with a `bedrock_model_id`), not a `source` on HF entries —
  the HF model entries stay clean.
- Such entries would route through a small local **OpenAI→Bedrock proxy** so the app keeps hitting the
  _same_ `localhost/v1` endpoint regardless of EC2 vs Bedrock. Unified DX. IAM profile gets scoped
  `bedrock:InvokeModel` when used.

---

## Recommended tech stack

- **Language**: TypeScript on Node (matches NPM distribution; ship as a `bin`).
- **CLI framework**: `commander` or `oclif` (oclif if you expect many subcommands + plugins).
- **Prompts**: `@inquirer/prompts` for the interactive model picker & confirmations.
- **AWS**: shell out to `aws` CLI for SSM (simplest for `start-session`); AWS SDK v3 for describe/pricing/status.
- **IaC**: Terraform (HCL templates shipped in-package). CDKTF is an alternative but adds weight.
- **Config/catalog**: `yaml` + `zod` for schema validation of `llmrun.yaml`.

---

## Phased roadmap

- **Phase 1 (MVP)**: catalog YAML + picker → cost approval → Terraform provision → HF+vLLM bootstrap →
  SSM port-forward to localhost → `stop`/`start`/`down`/`status` → configurable idle auto-stop.
- **Phase 2**: Bedrock unification proxy; CloudWatch alarm backstop; S3 state backend for teams;
  `--public` HTTPS URL option (ALB + ACM + token) for sharing.
- **Phase 3 (your v2 idea)**: multiple models / multi-agent serving on a single instance
  (vLLM multi-model or router), per-model routing on one endpoint.

---

## Open considerations / risks

- **GPU quota**: fresh AWS accounts often have 0 vCPU quota for G/P instances. Handled by `doctor` +
  the auto-preflight, with an increase-request link and a CPU fallback for ≤16B models — see
  "GPU quota handling & CPU fallback" above. Worth also calling out in docs.
- **Cold start**: driver install + multi-GB model download can take minutes; a prebaked AMI
  (Deep Learning AMI or a custom one) dramatically improves `up` time — consider for Phase 2.
- **Gated HF models**: need `HF_TOKEN`; surface a clear prompt when a repo is gated.
- **Terraform dependency**: users must have `terraform` + `aws` CLIs installed & credentials configured.
  Handled by `llmrun doctor`, which also runs automatically as a background preflight on `up`/`start`.
- **Cost accuracy**: on-demand price tables drift; treat estimates as approximate and note spot as a future option.

---

## Verification (once built)

Since this is a design proposal, "verification" here means how we'd validate the MVP end-to-end:

1. `llmrun doctor` reports missing prerequisites with fixes; a broken setup blocks `up`/`start`
   via the automatic background preflight.
2. `llmrun init` writes an editable `llmrun.yaml` (defaults incl. `aws_profile`/`region` + sample
   models); edits are picked up.
3. `llmrun up` shows the interactive model list from `llmrun.yaml` (no model name typed); after
   selection it shows a cost estimate, waits for approval, provisions, and ends with a reachable
   `http://localhost:8000/v1`.
4. `curl http://localhost:8000/v1/models` and a chat completion return valid responses.
5. Leave it idle past `idle_timeout` → instance auto-stops; `llmrun status` reflects "stopped".
6. `llmrun start` resumes quickly (model cache persisted); `llmrun ssh` opens an SSM shell.
7. `llmrun down` runs `terraform destroy` and leaves no orphaned resources (verify in console).

```

```
