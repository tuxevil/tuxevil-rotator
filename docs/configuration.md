# Configuration

## Config File Location

Config files are stored in `~/.tuxevil-rotator/` by default. Override with:

```bash
export TUXEVIL_ROTATOR_DIR=/path/to/config

# Or CLI flag
tuxevil-rotator start --config-dir /path/to/config
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `TUXEVIL_ROTATOR_DIR` | Config directory path (default: `~/.tuxevil-rotator/`) |
| `DATABASE_URL` | Fallback PostgreSQL connection string |
| `TUXEVIL_ROTATOR_DATABASE_URL` | PostgreSQL connection string for Virtual Keys and Spend Logging |
| `TUXEVIL_ROTATOR_ENCRYPTION_KEY` | Secret used to encrypt OAuth refresh tokens at rest. A 64-character hexadecimal key is recommended. `ENCRYPTION_KEY` is accepted as a fallback. |
| `TUXEVIL_ROTATOR_ADMIN_TOKEN` | Admin token for dashboard/API access. If unset, a secure token is auto-generated on first run and saved to `.admin-token` |
| `TUXEVIL_ROTATOR_BIND_HOST` | Network interface to bind on (default: `0.0.0.0`; set to `127.0.0.1` for local-only) |
| `TUXEVIL_ROTATOR_MAX_BODY_BYTES` | Max accepted proxy request body size in bytes (default: `26214400` = 25 MiB) |
| `TUXEVIL_ROTATOR_LOG_LEVEL` | Log verbosity: `debug`, `info`, `warn`, `error`, `silent` (default: `info`) |
| `TUXEVIL_ROTATOR_LOG_RETENTION_DAYS` | Spend log retention in days (default: `30`) |
| `TUXEVIL_ROTATOR_QUOTA_USER_AGENT` | Override the User-Agent for quota API fetches |
| `TUXEVIL_ROTATOR_ANTIGRAVITY_VERSION` | Override the Antigravity version in quota fetch UA (default: `2.11.0`) |
| `TUXEVIL_ROTATOR_TELEMETRY` | Set to `off`, `false`, or `0` to disable anonymous telemetry |
| `TUXEVIL_ROTATOR_TELEMETRY_URL` | Custom HTTPS endpoint for telemetry (self-hosted receiver) |
| `ANTIGRAVITY_CLIENT_ID` | Your Google OAuth client ID (see [OAuth Setup](#oauth-client-credentials)) |
| `ANTIGRAVITY_CLIENT_SECRET` | Your Google OAuth client secret |
| `ANTIGRAVITY_REDIRECT_URI` | OAuth callback URI for hosted login (default: `http://localhost:51121/oauth-callback`) |
| `TUXEVIL_OPEN_BROWSER` | Set to `1`, `true`, or `yes` to open the CLI OAuth URL automatically. Disabled by default for headless environments. |

## OAuth Client Credentials

Existing installations continue to work with the legacy compatibility OAuth client. For new deployments, or when using hosted OAuth, register your own Google OAuth client:

```bash
export ANTIGRAVITY_CLIENT_ID="your-client-id"
export ANTIGRAVITY_CLIENT_SECRET="your-client-secret"
```

If either variable is missing, the rotator falls back to the legacy client and emits a one-time deprecation warning. Keep secrets in an environment manager or deployment secret store; do not commit them to the repository.

## Providers

The rotator routes through four provider families. Each account in `accounts.json`
carries credentials specifying its provider (default when absent: `google-antigravity`,
i.e. legacy configs).

| Provider | ID | Credential | Add accounts |
|----------|-----|------------|--------------|
| Google Antigravity | `google-antigravity` | OAuth refresh token (auto-discovered project) | `tuxevil-rotator login` |
| Ollama Cloud | `ollama` | Static API key from `ollama.com/settings/keys` (never expires) | `tuxevil-rotator login --provider ollama` |
| OpenAI Codex | `openai-codex` | ChatGPT OAuth refresh token, stored per provider credential | `tuxevil-rotator login --provider openai-codex` |
| OpenCode Zen | `opencode-zen` | Static API key from `opencode.ai/zen/v1` (never expires) | `tuxevil-rotator login --provider opencode-zen` |

Codex can also import an existing Codex CLI or compatible export without putting
tokens in shell history:

```bash
tuxevil-rotator login --provider openai-codex --import ~/.codex/auth.json
```

See [Codex integration](integrations/codex.md) for OAuth variables, model routing,
quota behavior, and the internal endpoints used by the provider.

Ollama Cloud models are exposed on the standard OpenAI/Anthropic-compatible routes:

- `POST /v1/chat/completions`, `/v1/responses`, and `/v1/messages` translate requests to
  the Ollama native `api/chat` endpoint and stream NDJSON deltas back as SSE (including
  `tool_calls` and usage in the final `[DONE]` chunk).
- `GET /v1/models` lists the Ollama catalog (`owned_by: "ollama"`).
- When the `ollama` provider is enabled, the native `POST /api/chat` endpoint routes to it.

OpenAI Codex models are exposed on the same standard routes, but the pool is
isolated and runs in its own credential ring:

- `POST /v1/responses` is the primary native route: it sends a Responses
  payload directly to `${CODEX_BASE_URL}/responses`, defaults `store` to `false`,
  strips stateful fields (`previous_response_id`, `conversation`, `input_items`,
  `prompt_cache_key`, `background`, `max_output_tokens`, `stream_options`), and
  streams upstream Responses events back as SSE. `GET /v1/responses/<id>`,
  `DELETE /v1/responses/<id>`, `POST /v1/responses/<id>/cancel`, and
  `GET /v1/responses/<id>/input_items` are supported as well. Persisted
  Responses survive rotator restarts via `<configDir>/responses.json` with
  atomic writes and a 1.5 s debounce.
- `POST /v1/chat/completions` uses an explicit Chat ↔ Responses conversion for
  multimodal input, tools, reasoning, usage, and SSE chunks. Codex streaming
  is the only path that emits a single SSE delta per upstream event.
- `GET /v1/models` lists the Codex catalog (`owned_by: "openai-codex"`). The
  safe base catalog contains `gpt-5.6-terra` and `gpt-5.6-luna`; `gpt-5.6-sol`
  is also recognised but is reserved for paid Codex plans and may return an
  upstream `4xx` on free-tier accounts. Authenticated discovery can add more
  IDs that match the Codex pattern, but no cross-provider models exposed by
  the same endpoint are pulled in.

Optional Codex environment variables (defaults from
[`docs/integrations/codex.md`](integrations/codex.md)):

| Variable | Default |
|---|---|
| `CODEX_OAUTH_CLIENT_ID` | Codex CLI public client id |
| `CODEX_OAUTH_AUTHORIZE_URL` | `https://auth.openai.com/oauth/authorize` |
| `CODEX_OAUTH_TOKEN_URL` | `https://auth.openai.com/oauth/token` |
| `CODEX_OAUTH_REDIRECT_URI` | `http://localhost:1455/auth/callback` |
| `CODEX_OAUTH_CALLBACK_HOST` | `127.0.0.1` |
| `CODEX_OAUTH_CALLBACK_PORT` | `1455` |
| `CODEX_OAUTH_SCOPE` | `openid profile email offline_access` |
| `CODEX_BASE_URL` | `https://chatgpt.com/backend-api/codex` |
| `CODEX_USAGE_URL` | `https://chatgpt.com/backend-api/wham/usage` |

Model names are matched per provider: Codex models are sent only to Codex
credentials, Ollama models only to Ollama credentials, and Google models only to
Google credentials. There is no automatic cross-provider fallback — a Codex
request never lands on an Antigravity or Ollama account and vice versa.

## accounts.json

The main configuration file. Created automatically by the `login` command, and editable by hand or via the dashboard UI.

```json
{
  "proxyPort": 51200,
  "requestsPerRotation": 5,
  "rotateOnQuotaDrop": 20,
  "quotaPollIntervalMs": 300000,
  "maxConcurrentRequestsPerAccount": 5,
  "maxConcurrentRequestsPerProjectModel": 5,
  "projectCircuitBreaker429Threshold": 3,
  "projectCircuitBreakerWindowMs": 600000,
  "projectCircuitBreakerCooldownMs": 3600000,
  "modelCircuitBreaker429Threshold": 3,
  "modelCircuitBreakerCooldownMs": 21600000,
  "dailyAccountSlowRequests": 250,
  "dailyAccountStopRequests": 350,
  "dailyProjectSlowRequests": 900,
  "dailyProjectStopRequests": 1200,
  "slowModeJitterMinMs": 8000,
  "slowModeJitterMaxMs": 25000,
  "protectivePauseMs": 21600000,
  "useRequestCountRotationWhenQuotaUnknownOnly": true,
  "idempotencyEnabled": true,
  "idempotencyWindowMs": 2000,
  "streamRecoveryMaxRetries": 2,
  "compressionMode": "off",
  "accounts": [
    {
      "email": "user@gmail.com",
      "refreshToken": "1//...",
      "projectId": "project-abc123",
      "label": "user"
    }
  ]
}
```

## Config Fields Reference

| Field | Default | Description |
|-------|---------|-------------|
| `proxyPort` | `51200` | Port the proxy listens on |
| `bindHost` | `0.0.0.0` | Interface to bind on. For local-only use, set to `127.0.0.1` |
| `routingPolicy` | `timer-first` | Routing policy: `timer-first`, `tier-first`, `quota-first`, `hybrid`, `sequential-quota`, or `sticky-quota` |
| `requestsPerRotation` | `5` | Max per-model requests before attempting request-count rotation |
| `rotateOnQuotaDrop` | `20` | Rotate when a model's quota drops this many %. Set to `0` to disable |
| `quotaPollIntervalMs` | `300000` | Quota poll interval in ms (5 minutes) |
| `maxConcurrentRequestsPerAccount` | `5` | Max simultaneous requests allowed per account across model pools. Overflow waits in a FIFO queue for up to 300 seconds |
| `maxConcurrentRequestsPerProjectModel` | `5` | Max simultaneous requests allowed across accounts sharing the same `projectId` for the same quota model |
| `projectCircuitBreaker429Threshold` | `3` | Unique accounts from the same `projectId` that must hit provider `429` before pausing that project/model |
| `projectCircuitBreakerWindowMs` | `600000` | Rolling window for the project/model `429` circuit breaker |
| `projectCircuitBreakerCooldownMs` | `3600000` | Minimum project/model pause after the circuit breaker trips |
| `modelCircuitBreaker429Threshold` | `3` | Unique accounts across all projects that must hit provider `429` for the same quota model before pausing that model globally |
| `modelCircuitBreakerCooldownMs` | `21600000` | Minimum model-wide pause after the global model circuit breaker trips |
| `dailyAccountSlowRequests` | `250` | Daily upstream attempts per account before slow-mode jitter starts |
| `dailyAccountStopRequests` | `350` | Daily upstream attempts per account before routing stops for that account until the next UTC day |
| `dailyProjectSlowRequests` | `900` | Daily upstream attempts per `projectId` before slow-mode jitter starts |
| `dailyProjectStopRequests` | `1200` | Daily upstream attempts per `projectId` before routing stops for that project until the next UTC day |
| `slowModeJitterMinMs` | `8000` | Minimum slow-mode delay before upstream request |
| `slowModeJitterMaxMs` | `25000` | Maximum slow-mode delay before upstream request |
| `protectivePauseMs` | `21600000` | Global routing pause after a serious provider enforcement signal (6 hours) |
| `useRequestCountRotationWhenQuotaUnknownOnly` | `true` | Use request-count rotation only until quota telemetry exists for the request's model. Set to `false` to keep rotating by request count even with known quotas |
| `tokenBucketEnabled` | `false` | Enables the local per-account request bucket used by `hybrid` policy |
| `tokenBucketMaxTokens` | `50` | Bucket capacity when enabled |
| `tokenBucketRefillPerMinute` | `6` | Refill speed when enabled |
| `tokenBucketInitialTokens` | `50` | Startup fill level when enabled |
| `idempotencyEnabled` | `true` | Deduplicate identical in-flight requests and short-window retries |
| `idempotencyWindowMs` | `2000` | Retention window for completed idempotent request results |
| `streamRecoveryMaxRetries` | `2` | Maximum account rotations for upstream failures before the response is flushed |
| `compressionMode` | `off` | Prompt compression mode: `off`, `lite`, `rtk`, or `rtk+lite`. Can be overridden by the `X-Rotator-Compression` request header |

Existing configuration files keep explicit concurrency values. To enable the
five-requests-per-account pool on an installation that already sets either
concurrency field to `1`, change both fields to `5`; the new defaults only apply
when those fields are absent.

With five eligible accounts on distinct projects and both fields set to `5`,
requests are assigned one per account in repeated layers up to 25 active
Antigravity streams combined across Gemini and Claude. Request 26 and later wait
in arrival order until capacity is released or 300 seconds elapse.

## Account Fields

| Field | Description |
|-------|-------------|
| `email` | Account email (auto-filled by login) |
| `provider` | `google-antigravity` (default/legacy), `ollama`, or `openai-codex` — selects the credential fields required and upstream routing |
| `refreshToken` | Google OAuth refresh token (auto-filled by `login`, Google accounts only) |
| `projectId` | Google Cloud project ID discovered during login (Google accounts only) |
| `projectSource` | Optional metadata: `google` when discovered from Google, `manual` if edited by hand |
| `apiKey` | Ollama Cloud API key (Ollama accounts only; never expires, see `ollama.com/settings/keys`) |
| `codexRefreshToken` / `codexAccountId` | Legacy Codex fields read and migrated into `credentials`; prefer `credentials[].refreshToken` and `credentials[].providerAccountId` |
| `label` | Display name on the dashboard (auto-filled, defaults to email username) |
| `tier` | Optional: `ultra`, `pro`, `plus`, `free`, or `unknown` — used by `tier-first` and `hybrid` routing policies |

```json
{
  "email": "my-ollama-user@example.com",
  "provider": "ollama",
  "apiKey": "ok-...",
  "label": "ollama-cloud"
}
```

## Automatic Migration from the Legacy Rotator

On startup, the rotator checks for the predecessor product's account store
(`~/.ollama-rotator/accounts.json`, or the `OLLAMA_ROTATOR_DIR` override) and
imports any Ollama Cloud accounts found there into the active account store —
tagged `provider: "ollama"`, preserving `label`/`tier`/`type`. Accounts whose
email already exists are skipped (never overwritten), and entries without an
API key are ignored with a warning. The import runs before the account list is
loaded, so migrated accounts are usable on the very first boot.

## Model Configuration Overrides

You can override per-model output token limits and thinking budgets via `modelSpecs` in `accounts.json`:

```json
{
  "modelSpecs": {
    "gemini-3.6-flash-high": {
      "maxOutputTokens": 65536,
      "thinkingBudget": 8192
    }
  }
}
```

## Model Aliases

Remap model names to upstream model names via `modelAliases` in `accounts.json`:

```json
{
  "modelAliases": {
    "my-fast-model": "gemini-3.6-flash-high",
    "my-smart-model": "gemini-3.1-pro-low"
  }
}
```

## Effort-Based Model Routing

Route a client-facing alias model (such as `gemini-3.8-flash`) to concrete Antigravity target models based on the request's `reasoning_effort` via `effortRouting` in `accounts.json`:

```json
{
  "effortRouting": {
    "gemini-3.8-flash": {
      "defaultEffort": "medium",
      "targets": {
        "low": "gemini-3.8-flash-low",
        "medium": "gemini-3.8-flash-medium",
        "high": "gemini-3.8-flash-high"
      }
    }
  }
}
```

### Matching and Default Semantics

- **Opt-in**: if `effortRouting` is absent, `null`, or `{}`, no effort routing occurs and models behave as standard.
- **Alias matching**: client request models match configured aliases case-insensitively.
- **Effort selection**: requests with a recognized effort value (matched case-insensitively against `targets` keys) dispatch to the mapped concrete target. Requests without effort, with empty/unrecognized effort, or from surfaces that do not pass effort (such as `/v1/messages`) route to `defaultEffort` (defaults to `"medium"` if omitted). The effective default effort must exist in `targets`.
- **Precedence**: `effortRouting` takes precedence for its configured alias names. After effort resolution to a concrete target, operator `modelAliases` and `modelSpecs` overrides continue to apply to that resolved target. An alias name cannot be defined in both `modelAliases` and `effortRouting` simultaneously. Chaining (an effort routing target equaling another effort routing alias) is not supported.
- **Non-Google provider collision constraint**: aliases and targets must be Google Antigravity-dispatchable models. Statically known Codex, OpenCode Zen, or Ollama catalog IDs may not be used as effort-routing aliases or targets. If an alias or target later matches a dynamically discovered Ollama model, the proxy logs a runtime warning and keeps the existing provider precedence.
- **Catalog visibility**: when configured, `/v1/models` advertises the alias and soft-hides its configured concrete targets. The alias inherits catalog metadata from its default effort target. The native `/v1beta/models` catalog retains concrete models and does not substitute effort aliases, because native `/v1beta` and `/v1internal` requests forward model IDs unchanged. Direct requests to concrete targets remain functional.
- **Virtual key scoping**: virtual key authorization runs on the raw request model pre-translation. A virtual key scoped to `gemini-3.8-flash` authorizes the bare alias and all suffixed concrete variants through substring matching. A key scoped specifically to a concrete variant such as `gemini-3.8-flash-high` will reject requests specifying the bare alias. Once an alias is configured, the dashboard picker hides concrete targets. Create or update virtual keys scoped to concrete targets through the API.

## Audio Transcription & Live Streaming

The rotator provides OpenAI-compatible audio transcription and bidirectional live streaming powered by the local Antigravity Language Server observer model (`models/proactive-observer-v10`).

### Endpoints

- `POST /v1/audio/transcriptions`: OpenAI-compatible multipart audio transcription.
  - Form fields: `file` (audio file), `model` (default: `models/proactive-observer-v10` or alias `whisper-1`), `response_format` (`json`, `text`, `verbose_json`), `prompt`, `language`.
  - Supported audio formats: `.wav`, `.mp3`, `.m4a`, `.webm`, `.ogg`, `.flac`, `.pcm`.
- `GET /ws`, `/ws/audio`, `/v1/listen`, `/v1/audio/transcriptions/stream`: Bidirectional WebSocket streaming endpoint (RFC 6455).
  - Streams binary 16kHz PCM audio chunks in real-time.
  - Emits JSON events: `system_status`, `antigravity_ready`, `antigravity_transcript` (with TTFT and interim/final text), and `antigravity_complete`.

### Low-Latency Headers

For real-time voice and streaming applications, client requests can bypass artificial safety jitter delays:

- `X-Skip-Safety-Jitter: true`
- `X-Live-Request: true`

