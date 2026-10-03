# API Reference

## Authentication

**Admin routes** (`/api/*`) require one of:
- `Authorization: Bearer <token>`
- `X-Rotator-Admin-Token: <token>`
- `?token=<token>` (URL parameter)
- The dashboard session cookie (see below)

The admin token is auto-generated on first run and stored with the rotator's settings. Override with `TUXEVIL_ROTATOR_ADMIN_TOKEN`.

**Dashboard sessions.** The dashboard never keeps the admin token in the page. Opening `/dashboard?token=<token>` or signing in on the dashboard's login screen trades the token for an `HttpOnly`, `SameSite=Strict` session cookie valid for 30 days, and the token is removed from the URL. The cookie holds an HMAC signed with the admin token, so rotating the token signs every browser out. Requests authenticated only by the cookie that change state (`POST`, `PUT`, `DELETE`) must come from the dashboard's own origin (`Sec-Fetch-Site: same-origin`, or a matching `Origin`); otherwise they are refused with `403`. Signing out revokes that session on the server until the rotator restarts (rotate the admin token to invalidate sessions for good). Browsers send cookies to every port on a hostname, so other web services on the same host also receive the session cookie.

**Proxy routes** (`/v1/*`, `/v1internal:*`) run in open mode by default. Once at least one Virtual Key is created in PostgreSQL, all proxy routes require a valid `rk-...` key. See [Virtual Keys](virtual-keys.md).

---

## Dashboard Routes

The dashboard is a single-page app; every view has its own URL. The page shell is static and needs no token; all data comes from the admin API.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/dashboard` | Overview: routing health, model pools, items that need attention |
| `GET` | `/dashboard/accounts` | Accounts table (`?status=`, `?q=`, `?provider=`, `?sort=`, `?dir=`) |
| `GET` | `/dashboard/accounts/<email>` | Accounts table with that account's detail drawer open |
| `GET` | `/dashboard/requests` | Live request and event tail; `?view=history` for stored spend logs |
| `GET` | `/dashboard/usage` | Token usage, savings, latency and the activity heatmap (`?range=`) |
| `GET` | `/dashboard/keys` | Virtual key management |
| `GET` | `/dashboard/settings` | Routing controls and policy, benchmark, configuration file, appearance |
| `GET` | `/dashboard/logs` | Redirects to `/dashboard/requests?view=history` |
| `GET` | `/login` | Web-based account OAuth linking page |

Append `?mask=1` to any dashboard URL to open it with the privacy mask on.

---

## Admin API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/status` | JSON status: accounts, quotas, model routing, flags |
| `GET` | `/api/events` | SSE stream of the full `/api/status` payload on every change |
| `GET` | `/api/session` | `{ authenticated, authRequired }` for the current browser (no auth needed) |
| `POST` | `/api/session` | Body `{ "token": "…" }`; sets the dashboard session cookie |
| `DELETE` | `/api/session` | Revokes the dashboard session and clears its cookie |
| `GET` | `/api/dashboard/snapshot` | Dashboard overview plus the live request and event tails |
| `GET` | `/api/dashboard/stream` | SSE: a `snapshot` event, then only changes (`overview`, `accounts`, `requests`, `events`) |
| `GET` | `/api/dashboard/usage?range=1h\|6h\|24h\|7d\|30d` | Token buckets for the range, list prices per model, all-time totals, latency |
| `GET` | `/api/dashboard/usage/export?format=csv\|json` | Download the full token usage history |
| `GET` | `/api/dashboard/activity` | Requests per hour for the last 60 days |
| `POST` | `/api/enable/<email>` | Re-enable a disabled account |
| `POST` | `/api/settings/fresh-window-starts/on` | Allow opening new `idle`/fresh windows globally |
| `POST` | `/api/settings/fresh-window-starts/off` | Block opening new `idle`/fresh windows globally |
| `POST` | `/api/account-fresh-window-starts/<email>/on` | Allow one account to override the global fresh-window block |
| `POST` | `/api/account-fresh-window-starts/<email>/off` | Return one account to the global fresh-window policy |
| `POST` | `/api/self-update` | Trigger npm self-update to latest version |

### Virtual Key Management (requires PostgreSQL)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/keys` | List all virtual keys |
| `POST` | `/api/keys/generate` | Generate a new virtual key |
| `GET` | `/api/keys/<hash>` | Retrieve details for a virtual key |
| `PUT` | `/api/keys/<hash>` | Update alias, models, or blocked state |
| `DELETE` | `/api/keys/<hash>` | Delete a virtual key |

### Spend Logging (requires PostgreSQL)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/spend/logs` | Query spend logs with filters and pagination |
| `GET` | `/api/spend/summary` | Aggregated daily spend summary |
| `GET` | `/api/spend/by-key` | Spend breakdown by virtual key |

---

## Proxy Routes

### OpenAI-Compatible

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/models` | List available models. Each entry includes an `owned_by` field marking its provider (`google-antigravity`, `ollama`, or `openai-codex`). |
| `POST` | `/v1/chat/completions` | Chat completions (streaming and non-streaming) |
| `POST` | `/v1/responses` | OpenAI Responses API (for Codex-style agents; persisted Codex Responses survive restarts via `<configDir>/responses.json`) |
| `GET` | `/v1/responses/<id>` | Retrieve a stored Responses result |
| `DELETE` | `/v1/responses/<id>` | Delete a stored Responses result |
| `POST` | `/v1/responses/<id>/cancel` | Cancel an in-progress Responses result |
| `GET` | `/v1/responses/<id>/input_items` | List stored input items for a Responses result |

### Anthropic-Compatible

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/messages` | Anthropic Messages API (streaming and non-streaming) |

### Native Antigravity

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1internal:streamGenerateContent` | Native Antigravity proxy (used by Pi agent) |
| `POST` | `/v1internal:<code-assist-action>` | Allowlisted Code Assist passthrough: `loadCodeAssist`, `fetchAvailableModels`, `onboardUser`, `listExperiments`, `countTokens`, `retrieveUserQuota`, or `retrieveUserQuotaSummary` |

Code Assist operations are forwarded only by the Google Antigravity provider. Project-scoped
operations use the active account's configured `projectId`; the client cannot override it and
there is no shared-project fallback. Other `/v1internal:*` operations are rejected.

---

## Query Parameters

### `/api/spend/logs`

| Parameter | Type | Description |
|-----------|------|-------------|
| `from` | `YYYY-MM-DD` | Start date filter |
| `to` | `YYYY-MM-DD` | End date filter |
| `model` | string | Filter by model name |
| `key` | string | Filter by virtual key hash |
| `limit` | integer | Max results (default: 100) |
| `offset` | integer | Pagination offset |

### `/api/dashboard/stream`

Server-sent events for the dashboard. The first event is `snapshot` (the same body as `/api/dashboard/snapshot`). After that the server compares each new rotator state with the previous one and sends only what changed:

- `overview` — the top-level overview sections that changed (routing health, breakers, controls, traffic, …)
- `accounts` — `{ upsert, remove, order? }`: changed accounts, removed emails, and the new order when it changed
- `requests` / `events` — entries that were not sent before, newest first, each with an increasing `id`

Countdowns are sent as absolute timestamps (`nextRetryAt`, `nextRefillAt`, breaker `until`), so an idle rotator sends nothing but a keep-alive comment every 25 seconds. Use `/api/events` if you need the full status on every change.

### `/api/status`

Returns full JSON status including:
- Routing state and health
- All accounts with quota bars, timers, and status
- Per-model active account assignments
- Circuit breaker states
- Daily budget counters
- Token usage statistics
- Per-provider quota keys: Antigravity `claude` / `gemini`, Ollama `monthly`, Codex `openai-codex` (and `openai-codex-spark` when the endpoint exposes it)
