# llmrun

> Run open-source LLMs on AWS EC2 from your terminal. Pick a model, spin up a
> right-sized GPU instance (Terraform), serve it with vLLM, and get a local
> OpenAI-compatible endpoint over AWS SSM — auto-stopping when idle so you only
> pay while you use it.

Your app points at `http://localhost:8000/v1` with any OpenAI SDK and just works.

## Why

- 📋 **Editable catalog** — `llmrun.yaml` maps a friendly alias → a HuggingFace
  repo → the GPU instance needed to serve it.
- 💸 **Cost preview + approval** before anything is provisioned.
- 🔒 **Local access over AWS SSM** — no public IP, no open ports, no SSH keys.
- ⏹️ **Configurable idle auto-stop** — the instance stops itself when idle.
- 🩺 **`llmrun doctor`** preflight (CLIs, credentials, GPU quota) that also runs
  automatically before `up` / `start`, with a CPU fallback for small models when
  GPU quota is unavailable.

## Requirements

- Node.js ≥ 20 and [pnpm](https://pnpm.io)
- [Terraform](https://developer.hashicorp.com/terraform/install)
- [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
  with the
  [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)
- AWS credentials configured (`aws configure` or SSO)

## Install (development)

```bash
pnpm install
pnpm build
node dist/cli.js --help
# or during development:
pnpm dev -- --help
```

## Quick start

```bash
llmrun init                 # scaffold llmrun.yaml
llmrun doctor               # check prerequisites
llmrun models               # list the catalog
llmrun up                   # pick a model → approve cost → provision → connect
llmrun ls                   # see deployments, local URLs, connection state
llmrun logs                 # tail the model server
llmrun stop                 # stop (keeps disk + model cache)
llmrun start                # resume
llmrun down                 # destroy everything
```

## Commands

| Command                    | Purpose                                                   |
| -------------------------- | --------------------------------------------------------- |
| `llmrun init`              | Scaffold an editable `llmrun.yaml`.                       |
| `llmrun doctor`            | Check terraform, aws, SSM plugin, credentials, region.    |
| `llmrun models`            | List the merged catalog with instance types + cost.       |
| `llmrun up`                | Pick a model, preview cost, provision, connect.           |
| `llmrun ls` / `status`     | List deployments with state, local URL, connection.       |
| `llmrun stop [name]`       | Stop the instance (keeps disk + model cache).             |
| `llmrun start [name]`      | Restart a stopped deployment and re-forward.              |
| `llmrun down [name]`       | Destroy a deployment (`terraform destroy`).               |
| `llmrun connect [name] -a` | (Re)establish port-forward(s); multiple run concurrently. |
| `llmrun disconnect [name]` | Tear down port-forward(s) without stopping.               |
| `llmrun ssh [name]`        | Open an SSM shell.                                        |
| `llmrun logs [name]`       | Tail the model server logs over SSM.                      |
| `llmrun config`            | Show/edit global config (`~/.llmrun/config.json`).        |

`[name]` is a deployment (one running instance). It defaults to the chosen model
alias; override with `llmrun up --name <instance>` to run the same model twice.
Omit `[name]` and llmrun infers the single deployment or shows a picker.

## Configuration

Precedence (highest first): CLI flags → environment (`AWS_PROFILE` /
`AWS_REGION`) → `llmrun.yaml` `defaults` → `~/.llmrun/config.json` → AWS CLI
default.

See `llmrun.yaml` after `llmrun init` for the model catalog format.

## Status

Phase 1 (MVP). Bedrock routing, a public HTTPS URL option, an S3 state backend,
and multi-model-per-instance serving are planned for later phases.

## License

Apache-2.0
