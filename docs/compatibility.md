# Compatibility Adapters

The proxy exposes three API formats on top of the native Google Antigravity endpoint. The native `/v1internal:streamGenerateContent` route used by Pi is unaffected. The same three formats also serve Ollama Cloud and the isolated OpenAI Codex pool; routing is provider-aware and a request never crosses pool boundaries.

## Available Models

```bash
curl http://localhost:51200/v1/models
```

| Model | Family | `owned_by` | Notes |
|-------|--------|------------|-------|
| `gemini-3.8-flash-high` | Gemini 3.8 Flash | `google-antigravity` | High reasoning level |
| `gemini-3.8-flash-medium` | Gemini 3.8 Flash | `google-antigravity` | Medium reasoning level |
| `gemini-3.8-flash-low` | Gemini 3.8 Flash | `google-antigravity` | Low reasoning level |
| `gemini-3.7-flash-tiered` | Gemini 3.7 Flash | `google-antigravity` | Adaptive reasoning level |
| `gemini-3.6-flash-high` | Gemini 3.6 Flash | `google-antigravity` | High thinking budget |
| `gemini-3.6-flash-medium` | Gemini 3.6 Flash | `google-antigravity` | Medium thinking budget |
| `gemini-3.6-flash-low` | Gemini 3.6 Flash | `google-antigravity` | Low thinking budget |
| `gemini-3.6-flash-tiered` | Gemini 3.6 Flash | `google-antigravity` | Auto-selects tier based on quota |
| `gemini-3.1-pro-high` | Gemini 3.1 Pro | `google-antigravity` | |
| `gemini-3.1-pro-low` | Gemini 3.1 Pro | `google-antigravity` | |
| `claude-sonnet-4-6` | Claude | `google-antigravity` | Via Antigravity |
| `claude-opus-4-6-thinking` | Claude | `google-antigravity` | Via Antigravity, with thinking |
| `gpt-oss-120b-medium` | GPT-OSS | `google-antigravity` | Via Antigravity |
| `gpt-5.6-terra` | GPT-5.6 | `openai-codex` | Safe base catalog, via Codex OAuth |
| `gpt-5.6-luna` | GPT-5.6 | `openai-codex` | Safe base catalog, via Codex OAuth |
| `gpt-5.6-sol` | GPT-5.6 | `openai-codex` | Reserved for paid Codex plans; upstream may reject on free-tier accounts |
| `gpt-6-astra` | GPT-6 | `openai-codex` | Current GPT-6 model, via Codex OAuth |
| `gpt-6-sol` | GPT-6 | `openai-codex` | Current GPT-6 model, via Codex OAuth |
| `gpt-6-luna` | GPT-6 | `openai-codex` | Current GPT-6 model, via Codex OAuth |
| `big-pickle`, `mimo-v2.5-free`, `ling-3.0-flash-fin-free`, `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`, `muse-spark-1.3-contributor-free` | OpenCode Zen | `opencode-zen` | Free-tier models via OpenCode Zen API (`https://opencode.ai/zen/v1`); Muse Spark 1.3 uses `/responses` |
| `gpt-oss:20b`, `gpt-oss:120b`, `gemma4:31b`, `kimi-k3`, `minimax-m3`, `deepseek-v4-pro`, ... | Ollama Cloud | `ollama` | Catalog fetched at startup from `https://ollama.com/api/tags` |

Short aliases (e.g. `gemini-3.6-flash`, `gemini-3.1-pro`, `claude-sonnet`) are also accepted and resolve to sensible defaults. Gemini 3.8 uses the exact `-low`, `-medium`, or `-high` Antigravity model ID.

---

## OpenAI Chat Completions

**Endpoint:** `POST /v1/chat/completions`

```bash
curl http://localhost:51200/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gemini-3.8-flash-high",
    "messages": [{"role": "user", "content": "Say pong"}],
    "stream": false
  }'
```

**Supported features:**
- Text chat (streaming and non-streaming)
- `system`, `user`, `assistant`, `developer`, and `model` roles
- Tool/function calling (`tools`, `tool_choice`)
- Image input (base64 data URL: `image_url.url = data:image/...;base64,...`)
- Native reasoning visibility as `reasoning_content` chunks (models with thinking enabled)
- Request normalization (non-array messages, legacy `prompt`/`input` fields, raw native requests)

---

## OpenAI Responses API

**Endpoint:** `POST /v1/responses`

For Codex-style agentic systems that use the OpenAI Responses API. The same
path is used by Antigravity (with `store: false`), Ollama Cloud, and the
isolated OpenAI Codex pool — the proxy picks the pool from the requested model
and never crosses pool boundaries.

```bash
curl http://localhost:51200/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gemini-3.8-flash-high",
    "input": [{"role": "user", "content": [{"type": "input_text", "text": "Say pong"}]}],
    "stream": false
  }'
```

For Codex agents, point the request at a Codex model and the proxy forwards to
`${CODEX_BASE_URL}/responses` with `OpenAI-Beta: responses=v1`:

```bash
curl http://localhost:51200/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-5.6-luna",
    "input": "Reply with one word.",
    "stream": true,
    "store": false
  }'
```

**Supported operations:**
- `POST /v1/responses` — create
- `GET /v1/responses/<id>` — retrieve
- `DELETE /v1/responses/<id>` — delete
- `POST /v1/responses/<id>/cancel` — cancel
- `GET /v1/responses/<id>/input_items` — list input items

**Supported tool types:** `type: "function"` only. Built-in tools (`web_search`, `file_search`, `computer`, `code_interpreter`) are rejected explicitly with a clear error.

**Persistence:** Codex Responses are mirrored to `<configDir>/responses.json`
with atomic writes and a 1.5 s debounce (`responses-store.ts`), so an in-flight
Codex conversation can resume across rotator restarts. Corrupt files are moved
aside to `.corrupt-<ts>.bak` on startup. Antigravity and Ollama Responses
remain in-memory only.

---

## Anthropic Messages API

**Endpoint:** `POST /v1/messages`

```bash
curl http://localhost:51200/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{
    "model": "claude-sonnet-4-6",
    "system": "Be terse.",
    "messages": [{"role": "user", "content": "Say pong"}],
    "max_tokens": 128,
    "stream": false
  }'
```

**Supported features:**
- Text chat (streaming and non-streaming)
- Tool use (`tool_use` / `tool_result` content block format)
- Parallel tool calls (batched into a single turn, results properly grouped)
- Image input (base64 source: `type=image`, `source.type=base64`)
- Thinking blocks exposed as `thinking_delta` chunks

---

## Feature Matrix

| Feature | OpenAI Chat | OpenAI Responses | Anthropic Messages |
|---------|:-----------:|:----------------:|:-----------------:|
| Text chat | ✓ | ✓ | ✓ |
| Streaming | ✓ | ✓ | ✓ |
| Tool/function calling | ✓ | ✓ (function only) | ✓ |
| Image input | ✓ | — | ✓ |
| Thinking/reasoning blocks | ✓ | ✓ | ✓ |
| Multi-turn conversations | ✓ | ✓ | ✓ |
| Parallel tool calls | ✓ | ✓ | ✓ |
| System/developer role | ✓ | ✓ | ✓ |

> **Note:** Streaming mode emits one compatible final delta (full buffer passthrough). Native token-by-token passthrough is not yet implemented. See [ROADMAP.md](../ROADMAP.md).
>
> **Codex streaming:** the Codex adapter keeps upstream Responses events intact (one `event: response.*` SSE event per upstream chunk), so streaming is the only path where Codex delivers true incremental output to the client. Chat Completions over Codex still emits the single-buffer passthrough described above.
