# OpenAI Codex provider

`openai-codex` is an isolated provider pool backed by ChatGPT OAuth. A Codex
model is never sent to Google Antigravity or Ollama; rotation can only choose
another eligible Codex credential.

## Login and import

Interactive login uses PKCE S256, a required OAuth `state`, a loopback callback,
an expiry timeout, and a manual callback paste fallback:

```bash
tuxevil-rotator login --provider openai-codex
```

The authenticated WebUI page at `/login-cli` also has an **OpenAI Codex** tab.
It starts the same PKCE flow and accepts the complete loopback callback URL;
the authorization code is exchanged server-side and only the refresh
credential is persisted.

Existing Codex CLI files can be imported from a path. The CLI accepts the nested
`{ "tokens": { ... } }` form and compatible flat/provider-wrapped exports. It
requires a `refresh_token`; access tokens are used only in memory and are never
written to `accounts.json` or printed.

```bash
tuxevil-rotator login --provider openai-codex --import ~/.codex/auth.json
```

One Codex credential is kept per email. An import with the same email but a
different `providerAccountId` is rejected instead of overwriting the existing
account.

## Configuration

Optional environment variables are available for deployments and tests:

| Variable | Default |
|---|---|
| `CODEX_OAUTH_CLIENT_ID` | Codex CLI public client id |
| `CODEX_OAUTH_AUTHORIZE_URL` | `https://auth.openai.com/oauth/authorize` |
| `CODEX_OAUTH_TOKEN_URL` | `https://auth.openai.com/oauth/token` |
| `CODEX_OAUTH_REDIRECT_URI` | `http://localhost:1455/auth/callback` |
| `CODEX_OAUTH_REDIRECT_HOST` | `localhost` (host used to build the default redirect URI) |
| `CODEX_OAUTH_CALLBACK_HOST` | `127.0.0.1` (loopback host the callback server binds to) |
| `CODEX_OAUTH_CALLBACK_PORT` | `1455` |
| `CODEX_OAUTH_SCOPE` | `openid profile email offline_access` |
| `CODEX_BASE_URL` | `https://chatgpt.com/backend-api/codex` (the proxy calls `${base}/responses` and `${base}/models`) |
| `CODEX_USAGE_URL` | `https://chatgpt.com/backend-api/wham/usage` (override for tests/self-hosted receivers) |

The persisted credential shape is:

```json
{
  "provider": "openai-codex",
  "refreshToken": "...",
  "providerAccountId": "...",
  "proxyUrl": "http://proxy.example:8080"
}
```

Refresh tokens are rotated and persisted atomically. Concurrent requests share
one refresh operation so an older one-time token is not reused. OAuth failures
such as `invalid_grant` and `refresh_token_reused` require re-authentication;
diagnostics omit token values. The forwarding path sends `Authorization: Bearer
<access_token>`, `chatgpt-account-id: <providerAccountId>` when known,
`OpenAI-Beta: responses=v1`, and `User-Agent: tuxevil-rotator/openai-codex` so
operators can identify rotator traffic in upstream logs.

## API and models

`/v1/responses` sends native Responses payloads to `${CODEX_BASE_URL}/responses`,
defaults `store` to `false`, removes references to persisted response items
(`previous_response_id`, `conversation`, `input_items`, `prompt_cache_key`,
`background`, `max_output_tokens`, `stream_options`), supports SSE streaming and
keeps upstream Responses events intact. `/v1/chat/completions` uses an explicit
Chat ↔ Responses conversion for multimodal input, tools, reasoning, usage, and
SSE chunks.

The safe base catalog includes the new `gpt-6-astra`, `gpt-6-sol`, and
`gpt-6-luna` models and retains the existing `gpt-5.6-sol`, `gpt-5.6-terra`,
and `gpt-5.6-luna` IDs. All base IDs
are exposed on `GET /v1/models`; upstream errors are forwarded unchanged.
The `gpt-5.6-sol` ID may return an error for accounts without access.
Authenticated discovery against `${CODEX_BASE_URL}/models` can add more IDs
that match `^gpt-(?:5(?:[.][0-9]+)?|6)(?:-[a-z0-9]+)+$`, filtering out other
providers exposed by that endpoint. A discovery failure leaves the base catalog
in place. Spend estimates use the published standard API rates per 1M text
tokens for short-context requests:

| Model | Input | Cached input | Output |
| --- | ---: | ---: | ---: |
| `gpt-6-astra` | $10.00 | $1.00 | $50.00 |
| `gpt-6-sol` | $2.00 | $0.20 | $10.00 |
| `gpt-6-luna` | $0.10 | $0.01 | $0.50 |

The spend logger estimates from aggregate input/output usage; it does not apply
cached-input discounts, long-context multipliers, or tool-call charges. These
API-equivalent estimates do not represent Codex subscription quota billing.
See the [OpenAI API pricing page](https://developers.openai.com/api/docs/pricing).

`POST /v1/responses` supports the full Responses lifecycle:

- `POST /v1/responses` — create
- `GET /v1/responses/<id>` — retrieve
- `DELETE /v1/responses/<id>` — delete
- `POST /v1/responses/<id>/cancel` — cancel
- `GET /v1/responses/<id>/input_items` — list input items

Persisted Responses survive rotator restarts: the in-memory Responses store is
mirrored to `<configDir>/responses.json` with atomic writes and a 1.5 s debounce
(`responses-store.ts`), so an in-flight Codex conversation can resume across
restarts. Corrupt files are moved aside to `.corrupt-<ts>.bak` on startup.

## Quotas and internal dependencies

Quota polling is best-effort against the internal endpoint
`GET ${CODEX_USAGE_URL}` (default `https://chatgpt.com/backend-api/wham/usage`,
overridable for tests/self-hosting). It is cached for 60 seconds, throttled to
one upstream call every 250 ms, and times out after eight seconds. The worst of
the primary and secondary windows controls selection; Spark rows are preserved
when exposed, and a `bankedResetCredits` count is exposed when the endpoint
returns it. The pool exposes two quota keys on `/api/status`:
`openai-codex` (primary Codex quota bucket) and `openai-codex-spark` (Spark
plan bucket when present).

Before a Codex timer is started, the usage endpoint may report a reset more
than `29d 23h 55m` away. The rotator treats that value as an idle sentinel,
offers the pool's kickstart action, and sends the minimal request through
`gpt-5.6-luna`. A reset at or below that threshold is treated as a real active
timer.

Failure handling is provider-local:

- `401` or `403` invalidates only the Codex credential and surfaces a
  `reloginRequired` signal so the operator is prompted to re-authenticate.
- `429` applies a Codex-local cooldown and lets the next eligible Codex account
  serve the request. `usage_limit_reached` honors the provider's
  `resets_in_seconds`/`resets_at` window; generic rate limits use `Retry-After`
  with a 60 s fallback and a 30 min cap.
- Google Antigravity and Ollama state is never modified by these failures.

The OAuth host and backend endpoints are internal/no-garantizados and may change.
Not part of this first HTTP/SSE implementation: Codex WebSocket transport,
`background: true` mode, the `conversation` and `prompt_cache_key` Responses
fields, and automatic cross-provider fallback (a Codex model is never sent to a
Google or Ollama credential).

## Operator smoke test

After authenticating a real account, the operator can verify without logging
tokens:

```bash
curl http://127.0.0.1:51200/v1/models | jq '.data[] | select(.owned_by == "openai-codex")'

curl http://127.0.0.1:51200/v1/responses \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-5.6-luna","input":"Reply with one word.","store":false}'
```

Check that:

- The model list includes the Codex entries with `owned_by: "openai-codex"`.
- The `X-Rotator-*` response headers identify a Codex account email (masked)
  and `providerId: "openai-codex"`.
- A streaming request returns `Content-Type: text/event-stream` with
  `event: response.*` chunks.

Stop and re-authenticate (`tuxevil-rotator login --provider openai-codex`) if
the provider reports `401`, `403`, `invalid_grant`, or `refresh_token_reused`;
the account is flagged and excluded from rotation until re-login succeeds.
