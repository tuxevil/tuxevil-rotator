# Adding Accounts

## Login Flow

Run `tuxevil-rotator login` (or `npm run login` from source) once per Google account:

1. A Google OAuth URL is printed to the terminal — open it in your browser
2. Complete the sign-in and grant permissions
3. With the default loopback redirect, the CLI receives the callback automatically and the browser page can close itself
4. Set `TUXEVIL_OPEN_BROWSER=1` to open the URL automatically. If the loopback port is unavailable, the CLI falls back to pasting the **full URL** from the browser's address bar

The tool automatically:
- Creates or updates the account store with the account credentials
- Configures `~/.pi/agent/auth.json` with proxy-managed credentials (for the Pi agent)

The account store is either `accounts.json` in the config directory or the
PostgreSQL database, depending on whether `TUXEVIL_ROTATOR_DATABASE_URL` is set.
When the rotator is installed as a systemd service, the `login` CLI command
auto-detects the service environment (including `TUXEVIL_ROTATOR_DATABASE_URL` and
the OAuth client from `EnvironmentFile=` drop-ins) so login always writes to the
same backend the running service reads from.

Re-running with the same email updates the existing entry.

> Note: if `login` reports the account as added but it doesn't appear on the
> dashboard / in `status`, the CLI and the service are usually pointing at
> different backends. Install the unit (see `sudo install` / the systemd setup)
> or set `TUXEVIL_ROTATOR_DATABASE_URL` explicitly so both use PostgreSQL.

## Ollama Cloud Accounts

Ollama Cloud uses a static API key that never expires (`ollama.com/settings/keys`):

```bash
tuxevil-rotator login --provider ollama
```

The command prompts for a label and pastes the API key. The account is stored with
`provider: "ollama"` and is immediately usable for any model in the Ollama cloud
catalog. No OAuth, no project binding, no key refresh needed.

## OpenAI Codex Accounts

OpenAI Codex uses ChatGPT OAuth (PKCE S256 + loopback callback) and runs in an
isolated provider pool — a Codex model never falls back to Google or Ollama
credentials:

```bash
tuxevil-rotator login --provider openai-codex
```

The CLI prints a one-shot `auth.openai.com` URL. With the default loopback
callback the CLI captures the redirect automatically; otherwise the operator
pastes the full callback URL back into the prompt. The dashboard page at
`/login-cli` exposes the same flow under the **OpenAI Codex** tab.

Existing Codex CLI auth exports can be imported instead of running the browser
flow:

```bash
tuxevil-rotator login --provider openai-codex --import ~/.codex/auth.json
```

The importer accepts the nested `{ "tokens": { ... } }` shape used by the Codex
CLI, `pi-ai`, `Hermes`, and provider-wrapped exports; it requires a
`refresh_token` and never writes access tokens to disk.

Codex accounts do not need a `projectId` or `tier`. The credential is stored
under `credentials: [{ provider: "openai-codex", refreshToken, providerAccountId
}]` on the same email row as any Antigravity or Ollama credential. See
[Codex integration](integrations/codex.md) for the OAuth variables, model
catalog, quota behaviour, and the internal endpoints used by the provider.

## OpenCode Zen Accounts

OpenCode Zen uses static API keys (`sk-...`) for free-tier model access (`opencode.ai/zen/v1`):

```bash
tuxevil-rotator login --provider opencode-zen
```

The CLI prompts for an optional email/label and your OpenCode Zen API key. The account is stored with
`provider: "opencode-zen"` (or added to an existing email row under `credentials: [{ provider: "opencode-zen", apiKey }]`) and is validated against the model catalog before saving. The dashboard page at `/login-cli` also includes an **OpenCode Zen** tab for web-based key entry.

Supported models: `big-pickle`, `mimo-v2.5-free`, `ling-3.0-flash-fin-free`, `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`, and `muse-spark-1.3-contributor-free`. Muse Spark 1.3 is forwarded through OpenCode Zen's `/responses` endpoint. Rate limits are tracked on a per-model basis to prevent temporary 429s on one model from blocking others.

## Migrating from the Legacy Ollama Rotator

If you previously ran the standalone `ollama-rotator` (config dir
`~/.ollama-rotator/`, keyed by `OLLAMA_ROTATOR_DIR`), its Ollama Cloud accounts
are picked up automatically on the first startup of this rotator: each entry is
imported tagged `provider: "ollama"`, duplicates by email are skipped, and
entries without an API key are ignored. Once the log shows
`Imported N Ollama Cloud account(s) from legacy ...`, you can retire
`~/.ollama-rotator/`.

To migrate manually into a fresh install without starting the service, copy each
entry from `~/.ollama-rotator/accounts.json` into the active `accounts.json` as
`{ "email", "provider": "ollama", "apiKey", "label?" }`.

## Web-Based Login

The rotator includes a web-based OAuth login flow at `/login`. This is useful for:
- Hosted deployments where CLI access is inconvenient
- Users who prefer a browser-only workflow

The dashboard's **Add account** button (top bar, Accounts page, Settings, or <kbd>⌘K</kbd>) opens `/login` in a new tab when hosted OAuth is configured, and `/login-cli` otherwise.

Set `ANTIGRAVITY_REDIRECT_URI` to the HTTPS callback registered in your OAuth client for hosted deployments.

## Activation Rule

New accounts usually get a companion project bound automatically during login: if `loadCodeAssist` returns no project yet, the tool provisions one through the same `onboardUser` flow the Antigravity IDE uses. In rare cases Google still has no project to bind (e.g. the account was never onboarded to Code Assist at all). If login fails at project discovery:

1. Open that exact Google account in Antigravity IDE
2. Send one message to any model
3. Re-run `tuxevil-rotator login`

## Account Management from Dashboard

The dashboard's **Accounts** page (`/dashboard/accounts`) shows every account as a card or in a compact list, with its status, quota per model and reset timers, health and last error. From an account's **⋯** menu or its drawer (`/dashboard/accounts/<email>`) you can:
- Re-enable a disabled account, or restore a quarantined one to rotation
- Disable or quarantine an account
- Start an idle quota window, or always allow fresh windows for that account
- Set the account tier (`ultra`, `pro`, `plus`, `free`)
- Remove the account

See the [Dashboard guide](dashboard.md#accounts) for the full page.

## Account Fields in accounts.json

```json
{
  "email": "user@gmail.com",
  "refreshToken": "1//...",
  "projectId": "project-abc123",
  "projectSource": "google",
  "label": "my-account",
  "tier": "pro"
}
```

| Field | Description |
|-------|-------------|
| `email` | Account email (auto-filled by login) |
| `provider` | Legacy field: `google-antigravity` (default), `ollama`, `openai-codex`, or `opencode-zen`. New accounts use `credentials[]` instead. |
| `refreshToken` | Legacy Google OAuth refresh token (auto-filled by `login`, Google accounts only) |
| `projectId` | Google Cloud project ID discovered during login (Google accounts only) |
| `projectSource` | Optional metadata: `google` when discovered from Google, `manual` if edited by hand |
| `apiKey` | API key (Ollama Cloud, OpenCode Zen; never expires) |
| `codexRefreshToken` / `codexAccountId` | Legacy Codex fields; prefer `credentials[]` (see below) |
| `credentials[].provider` | `google-antigravity`, `ollama`, `openai-codex`, or `opencode-zen`. Selects the credential fields required and upstream routing. |
| `credentials[].refreshToken` | OAuth refresh token for the credential's provider (Antigravity, Codex) |
| `credentials[].providerAccountId` | ChatGPT account id from the Codex OAuth identity claim (Codex only) |
| `credentials[].proxyUrl` | Optional provider-scoped egress proxy: `http://`, `https://`, `socks5://`, or `socks5h://`. Credentials may be embedded in the URL. |
| `label` | Display name on the dashboard (defaults to email username) |
| `tier` | Optional: `ultra`, `pro`, `plus`, `free`, or `unknown` |

For accounts that use more than one provider, configure the proxy on the matching
credential so network identities stay separate:

```json
{
  "email": "user@gmail.com",
  "credentials": [
    {
      "provider": "google-antigravity",
      "refreshToken": "1//...",
      "projectId": "project-abc123",
      "proxyUrl": "socks5h://proxy-user:proxy-password@127.0.0.1:1080"
    },
    {
      "provider": "ollama",
      "apiKey": "ollama-key",
      "proxyUrl": "http://127.0.0.1:8080"
    },
    {
      "provider": "openai-codex",
      "refreshToken": "codex-rt-...",
      "providerAccountId": "acct-codex",
      "proxyUrl": "http://127.0.0.1:8081"
    }
  ]
}
```

Dispatchers are reused per configured proxy URL and closed during graceful shutdown.
The proxy is selected from stored account configuration only; incoming request headers
cannot choose or override it. The implementation opens ordinary HTTP/SOCKS5 egress
connections and does not install a CA, intercept TLS, or expose a MITM endpoint.

## Token Auto-Refresh

OAuth tokens are refreshed automatically before expiry. No manual token management is needed. If a token cannot be refreshed (revoked consent, expired session), the account is disabled and the error, with a suggested fix, is shown on its dashboard card and drawer.

## Donating an Account

If you want to contribute quota to the project's development and testing, see the [Contributing](../CONTRIBUTING.md) guide for instructions on how to safely share an account.
