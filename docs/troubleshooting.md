# Troubleshooting

## Account shows `flagged` status

Google detected potential abuse or a policy enforcement signal. The dashboard shows the account as **Quarantined**; review the exact error message on its card or in its drawer (`/dashboard/accounts/<email>`).

Flagged accounts are **quarantined** and cannot be re-enabled via `/api/enable/<email>` until the underlying provider-side block is resolved. Options:

- If the account was suspended, restore it from your Google Account settings and re-run `login`
- If the flag appears erroneous, wait for Google's enforcement window to pass
- Replace the account with a fresh one using `login`

## Account keeps getting disabled after 5 errors

The account has hit consecutive errors. Common causes:

- **Revoked OAuth consent** — the user removed the app from Google Account > Security > Third-party connections
- **Expired refresh token** — re-run `tuxevil-rotator login` for that account
- **Google account suspension** — check the account status in your Google Account settings

## Quota bars not showing

Quota data appears after the first poll cycle (up to 5 minutes after startup). Ensure:

1. Accounts have valid, non-expired tokens
2. The quota API is reachable (check logs for quota poll errors)
3. The account has been used in Antigravity IDE at least once (see [Activation Rule](adding-accounts.md#activation-rule))

## All accounts exhausted / 503 responses

- **Cooldown/circuit breaker**: The proxy returns `429` with `Retry-After` when it knows when accounts will recover. Clients must back off.
- **All disabled/flagged**: The proxy returns `503` when there is no known retry time. Check the dashboard for flagged or disabled accounts.
- **Daily budget hit**: Check if accounts have exceeded `dailyAccountStopRequests` (default 350/day). Resets at UTC midnight.

## Multiple agents on different models interfering

This should not happen — each model routes independently. Agent 1 using Gemini Pro and Agent 2 using Claude will each have their own active account assignment and won't affect each other's rotation. Verify both agents are using different model names.

## Proxy returns 401 to my agent

- If virtual keys are configured: ensure the agent is using a valid `rk-...` key in the `Authorization: Bearer` header
- If no virtual keys: any non-empty string works as the API key

## Dashboard keeps asking for the admin token

The dashboard signs in with a session cookie signed by the admin token, so it shows the sign-in screen again when:

- the admin token changed: every session signed with the old token stops working. Sign in with the current token (`TUXEVIL_ROTATOR_ADMIN_TOKEN`, or the generated one in `.admin-token` in the config directory), or set `TUXEVIL_ROTATOR_ADMIN_TOKEN` explicitly so it stays the same
- the 30-day session expired, or you signed out
- the browser blocks cookies for the rotator's host

## Dashboard actions fail with `403` behind a reverse proxy

Actions that change state (enable, restore, policy changes, …) are refused with *"Blocked: the request did not come from the dashboard's own origin"* when the rotator cannot confirm they came from the dashboard's own page. Browsers send `Sec-Fetch-Site` over HTTPS and to `localhost`; otherwise the rotator compares the request's `Origin` with its `Host` (or `X-Forwarded-Host`) header. Make the reverse proxy forward the original host, for example `proxy_set_header Host $host;` in nginx (see [Deployment](deployment.md#reverse-proxy-with-nginx)).

## Login fails at project discovery

Login now auto-provisions a Cloud Code companion project for new accounts via the same `onboardUser` flow the Antigravity IDE uses, and it tries the production endpoints before the sandbox one. If it still fails, the account has no project to bind at all:

1. Open that exact Google account in Antigravity IDE
2. Send one message to any model
3. Re-run `tuxevil-rotator login`

## Codex account disabled after `401` or `403`

OpenAI Codex handles auth failures differently from Google: a `401` or `403`
from `chatgpt.com/backend-api/codex` (or from the OAuth token endpoint) sets
`reloginRequired: true` on the affected credential only — Antigravity and Ollama
state are not touched. The same flag is set for OAuth errors with code
`invalid_grant` or `refresh_token_reused` (the one-time refresh token was
consumed by another client). The account's dashboard drawer shows the Codex
credential as rejected, with the reason, and the rotator stops routing Codex
requests through it until you re-authenticate:

```bash
tuxevil-rotator login --provider openai-codex
```

The CLI walks the same PKCE loopback flow as the initial setup. After the
refresh token is rotated, the account is automatically re-enabled. See the
[Codex integration guide](integrations/codex.md) for OAuth variables and the
internal endpoint layout.

## Codex quota bars not showing

Codex quota polling goes through `${CODEX_USAGE_URL}` (default
`https://chatgpt.com/backend-api/wham/usage`) with a 60 s cache and an 8 s
timeout. Bars appear after the first successful poll cycle, which can take up
to 5 minutes after startup. Common reasons they never appear:

1. The account has no `openai-codex` credential (login with
   `tuxevil-rotator login --provider openai-codex`).
2. The access token refresh is failing (`401`/`403` from the OAuth endpoint) —
   the credential is invalidated and quota polling stops. Re-authenticate as
   above.
3. The ChatGPT backend is unreachable from this host (corporate proxy, DNS
   block, IPv6-only egress). Override `CODEX_USAGE_URL` to a self-hosted
   receiver that proxies the same JSON, or open the egress to
   `chatgpt.com`.

A Codex quota bar can show `0% remaining` even on a brand-new account when the
plan does not include a Codex subscription; the rotator still routes the
request because the upstream will return its own error. Free-tier accounts may
also receive a `4xx` on `gpt-5.6-sol` specifically — that model is reserved for
paid plans and the rotator passes the upstream response back unchanged.

## Docker container can't write to data directory

On Linux, `docker-data` must be writable by UID 1000 (the `node` user inside the container):

```bash
sudo chown -R 1000:1000 docker-data
```

## Streaming responses feel slow (high TTFB)

This is a known limitation. The current compatibility adapter buffers the full upstream response before emitting SSE to the client. Native token-by-token streaming passthrough is on the roadmap. See [ROADMAP.md](../ROADMAP.md).

## Running `doctor` for diagnostics

```bash
tuxevil-rotator doctor
```

Validates `accounts.json`, checks local state files, lists backups, and warns when admin auth is not configured.
