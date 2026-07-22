# Coding Assistants

llmrun exposes a standard OpenAI-compatible API, so any tool that supports a custom OpenAI base URL will work. You need three values:

| Setting | Value |
| --- | --- |
| **Base URL** | `http://localhost:8000/v1` (check `llmrun ls` for your port) |
| **API key** | Any non-empty string — vLLM doesn't validate it, e.g. `sk-local` |
| **Model** | The `hf_repo` value from your catalog, e.g. `Qwen/Qwen2.5-7B-Instruct` |

Get the exact model name the server reports:

```bash
curl -s http://localhost:8000/v1/models | jq -r '.data[].id'
```

::: tip Forward must be active
`llmrun ls` must show `FWD=yes` for the deployment. If it shows `no`, run `llmrun connect` first.
:::

## Continue (VS Code / JetBrains)

In `.continue/config.json`:

```json
{
    "models": [
        {
            "title": "llmrun — fast-7b",
            "provider": "openai",
            "model": "Qwen/Qwen2.5-7B-Instruct",
            "apiBase": "http://localhost:8000/v1",
            "apiKey": "sk-local"
        }
    ]
}
```

## Cursor

**Settings → Models → Add model**

- Provider: OpenAI Compatible
- Base URL: `http://localhost:8000/v1`
- API Key: `sk-local`
- Model name: `Qwen/Qwen2.5-7B-Instruct`

## Cline / Roo (VS Code)

In the Cline sidebar → Settings:

- API Provider: **OpenAI Compatible**
- Base URL: `http://localhost:8000/v1`
- API Key: `sk-local`
- Model ID: `Qwen/Qwen2.5-7B-Instruct`

## Aider

```bash
aider \
  --openai-api-base http://localhost:8000/v1 \
  --openai-api-key sk-local \
  --model openai/Qwen/Qwen2.5-7B-Instruct
```

## Open WebUI

**Admin Panel → Settings → Connections → Add OpenAI connection**

- URL: `http://localhost:8000/v1`
- API Key: `sk-local`

## OpenClaw

The fastest way to wire up OpenClaw is its non-interactive onboarding command — point it at your `llmrun` deployment's base URL and model:

```bash
openclaw onboard \
  --non-interactive \
  --mode local \
  --auth-choice vllm \
  --custom-base-url "http://localhost:8001/v1" \
  --custom-api-key "vllm-local" \
  --custom-model-id "Qwen/Qwen3-8B-AWQ" \
  --accept-risk --install-daemon --skip-health
```

Swap `--custom-base-url` and `--custom-model-id` for the port and model reported by `llmrun ls`. `--skip-health` skips the startup health check, so use it when you know the deployment isn't up yet; drop it once the server is running to catch connection issues early.

Alternatively, OpenClaw's config is JSON5. Add `llmrun` as a custom provider:

```json5
{
    models: {
        providers: {
            vllm: {
                baseUrl: "http://localhost:8000/v1",
                apiKey: "${VLLM_API_KEY}",
                api: "openai-completions",
                models: [
                    {
                        id: "Qwen/Qwen2.5-7B-Instruct",
                        name: "llmrun — fast-7b",
                    },
                ],
            },
        },
    },
    agents: {
        defaults: {
            model: { primary: "vllm/Qwen/Qwen2.5-7B-Instruct" },
        },
    },
}
```

```bash
export VLLM_API_KEY=sk-local   # vLLM doesn't validate it, any non-empty value works
```

Verify the provider is reachable:

```bash
openclaw models list --provider vllm
```

::: tip Agent mode needs `tool_call_parser`
OpenClaw's agent mode sends `tool_choice: "auto"`, which vLLM rejects with:

```
400 "auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set
```

unless the model was launched with those flags. Set `tool_call_parser` (e.g. `hermes` for Qwen models) on the model entry in `llmrun.yaml` and re-provision — see [Tool / function calling](./model-catalog.md#tool-function-calling).

Some Qwen/vLLM combinations only return structured tool calls when the request forces `tool_choice: "required"`. If agent mode still misbehaves after enabling the parser, force it per-model in OpenClaw's config:

```json5
{
    agents: {
        defaults: {
            models: {
                "vllm/Qwen/Qwen2.5-7B-Instruct": {
                    params: { extra_body: { tool_choice: "required" } },
                },
            },
        },
    },
}
```
:::

## Note on tool / function calling

Agentic modes (Cline agent, Cursor Composer, etc.) require the model to support tool calling, and vLLM must be launched with `--enable-auto-tool-choice` and a matching `--tool-call-parser`. This is off by default — set `tool_call_parser` on the model entry in `llmrun.yaml` to enable it. See [Tool / function calling](./model-catalog.md#tool-function-calling) for the parser to use per model family. Plain chat and autocomplete work without it.
