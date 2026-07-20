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

## Note on tool / function calling

Agentic modes (Cline agent, Cursor Composer, etc.) require the model to support tool calling, and vLLM must be launched with `--enable-auto-tool-choice`. This is not enabled by default in v0.1. Plain chat and autocomplete work without it.
