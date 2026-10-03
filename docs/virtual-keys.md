# Virtual Keys & Spend Logging

Virtual Keys and Spend Logging require PostgreSQL. See [Setting up PostgreSQL](integrations/setup-postgresql.md) for a one-command setup prompt you can paste into any AI agent.

Enable by setting:

```bash
export TUXEVIL_ROTATOR_DATABASE_URL="postgres://user:pass@localhost:5432/rotatordb"
```

## Virtual Keys

Virtual Keys (`rk-...`) let you issue scoped access credentials for individual agents, users, or teams — without sharing your admin token or Google account credentials.

### How They Work

- Format: `rk-{32 random hex chars}`
- Only the PBKDF2 hash is stored in the database — the raw key is shown once at generation time
- Each key can be restricted to specific models
- Each key tracks usage independently
- Once any virtual key exists, **all proxy requests require a valid key** (open mode disables automatically)

### Managing Keys

**Via Web UI** (`/dashboard/keys`):

The dashboard lists every key with its allowed models, status and last use, and lets you create keys (the raw key is shown once), change a key's allowed models, block or unblock it, and delete it.

![Virtual keys page](images/dashboard-keys.png)

**Via CLI:**

```bash
# List all virtual keys
tuxevil-rotator keys list

# Generate a new key scoped to specific models
tuxevil-rotator keys generate \
  --alias "cursor-agent" \
  --user-id "alice" \
  --models "gemini-3.6-flash-high,claude-sonnet-4-6"

# Restrict a key to one Codex model and one Ollama model
tuxevil-rotator keys generate \
  --alias "codex-only" \
  --user-id "bob" \
  --models "gpt-5.6-luna,minimax-m3"

# Delete a key by its hash
tuxevil-rotator keys delete <hash>
```

**Via REST API** (admin-authenticated):

```bash
# List keys
curl http://localhost:51200/api/keys \
  -H "Authorization: Bearer <admin-token>"

# Generate a key
curl -X POST http://localhost:51200/api/keys/generate \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"alias": "my-agent", "userId": "alice", "models": ["gemini-3.6-flash-high"]}'

# Update a key
curl -X PUT http://localhost:51200/api/keys/<hash> \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"alias": "renamed", "blocked": false}'

# Delete a key
curl -X DELETE http://localhost:51200/api/keys/<hash> \
  -H "Authorization: Bearer <admin-token>"
```

### Authenticating Requests with a Virtual Key

Pass the virtual key from any agent using any of these methods:

```bash
# Bearer header (standard — works with all OpenAI-compatible clients)
Authorization: Bearer rk-...

# Custom headers
x-rotator-key: rk-...
x-api-key: rk-...

# URL parameter (for clients that cannot set headers)
http://localhost:51200/v1/chat/completions?rotator_key=rk-...
```

### Team Setup Example

```
Developer A  →  rk-abc123  (Flash models only, 100 RPM)
Developer B  →  rk-def456  (All models)
CI Pipeline  →  rk-ghi789  (Flash low only)
              ↓
        tuxevil-rotator
              ↓
         Google Accounts (pooled)
```

A key's `--models` list filters across all provider pools by exact model name
or by comma-separated entries — Antigravity (`gemini-3.6-flash-high`,
`claude-opus-4-6-thinking`, `gpt-oss-120b-medium`), Ollama Cloud
(`gpt-oss:20b`, `gemma4:31b`, `minimax-m3`, `kimi-k3`), and the OpenAI Codex
pool (`gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.6-sol`) all use the same
mechanism. Requests for models outside the list return `403 model_not_allowed`
without consuming a Codex, Ollama, or Antigravity account.

## Spend Logging

When PostgreSQL is configured, every proxied request is recorded in a persistent audit trail.

### What Is Logged

| Field | Description |
|-------|-------------|
| Timestamp | Request start time |
| Model | Model name requested |
| Virtual key | Which key was used (hashed) |
| Account | Which Google account served the request (masked) |
| Input tokens | Prompt token count |
| Output tokens | Completion token count |
| TTFB | Time to first byte |
| Total duration | End-to-end latency |
| Cost (USD) | Estimated cost with 6-decimal precision |
| Request payload | Full prompt (sanitized: large base64 media replaced with `[inline-media: N bytes]`) |
| Response payload | Full completion, tool calls, thinking blocks |

### Request history in the dashboard (`/dashboard/requests?view=history`)

- **Filterable audit trail** by date range, model, virtual key and outcome; filters live in the URL so a view can be shared
- **Payload inspector** — expand a row to see the request body, the response and the metadata, each with a copy button
- **By key** — totals per virtual key for the same filters
- **Privacy mask** — the profile menu at the bottom of the sidebar (or `?mask=1`) redacts names, emails, keys and IP addresses
- **Cost breakdown** — per-request and aggregated list-price estimates

![Request history with the payload inspector open](images/dashboard-requests-history.png)

The **Live** view on the same page shows the most recent requests from memory and works without PostgreSQL. See the [Dashboard guide](dashboard.md#requests).

### REST API

```bash
# Query spend logs with filters
GET /api/spend/logs?from=2025-01-01&to=2025-01-31&model=gemini-3.6-flash-high

# Aggregated daily summary
GET /api/spend/summary

# Spend breakdown by virtual key
GET /api/spend/by-key
```

All spend endpoints require admin authentication.

### Retention

Logs are automatically cleaned up. Configure via:

```bash
export TUXEVIL_ROTATOR_LOG_RETENTION_DAYS=30   # default: 30 days for logs
# Daily aggregates are retained for 90 days
```
