# Dashboard

The rotator serves a web dashboard at `/dashboard` on the proxy port (by default `http://localhost:51200/dashboard`). It is a single-page app bundled in memory when the rotator starts, so there is no separate build step, and it updates live over a server-sent event stream.

![Overview](../dashboard.png)

## Signing in

The sign-in screen asks for the admin token: `TUXEVIL_ROTATOR_ADMIN_TOKEN`, or the token generated on first run and saved to `.admin-token` (see [Configuration](configuration.md#environment-variables)). A link of the form `/dashboard?token=<token>` signs in directly.

Either way the token is exchanged for a session cookie that lasts 30 days, and the token is removed from the address bar; the dashboard never stores the token itself. Rotating the admin token signs every browser out. **Sign out** (in the profile menu, Settings → About, or <kbd>⌘K</kbd>) revokes that session on the server until the rotator restarts.

Behind a reverse proxy, forward the original `Host` header (see [Deployment](deployment.md#reverse-proxy-with-nginx)); otherwise actions that change state are refused with `403`. The [API reference](api-reference.md#authentication) describes the cookie in detail.

## Getting around

- **Top bar**: the live connection status, a sidebar toggle, **+** to add an account, the search box, and a bell that lists everything that needs you (the same list as the Overview's **Needs you** panel).
- **Sidebar**: Overview, Accounts, Models, Playground, Requests, Usage and Virtual keys, with Settings at the bottom. The toggle expands it to show labels. The avatar at the foot opens the profile menu: theme, privacy mask, command palette and sign out.
- **Command palette**: <kbd>⌘K</kbd> (<kbd>Ctrl</kbd>+<kbd>K</kbd>) jumps to any page or account (search by name, email, provider or status) and runs quick actions: add an account, switch theme, toggle the privacy mask, expand the sidebar, export usage as CSV, sign out.
- <kbd>/</kbd> focuses the current page's search box, or opens the palette on pages without one.
- **Links**: every page, filter, sort order and open account drawer is part of the URL, so a link opens exactly the same view. The URL scheme is listed in the [API reference](api-reference.md#dashboard-routes).
- **Phones**: the sidebar becomes a slide-over sheet and the account drawer a bottom sheet.
- **Updates**: when a newer release is available a banner links to the changelog and offers **Update now** (see [Updating](deployment.md#updating)).

## Status vocabulary

Every page uses the same labels. The value in parentheses is what `/api/status` reports.

| Account status | Meaning |
|---|---|
| **Serving** (`active`) | The current routing target for at least one model |
| **Ready** (`ready`) | Healthy and available, waiting for its turn |
| **Cooling down** (`cooldown`) | Waiting out a provider rate-limit window; comes back on its own |
| **Out of quota** (`exhausted`) | Stopped by a [daily safety budget](how-it-works.md#daily-safety-budgets) until the next UTC day |
| **Erroring** (`error`) | Recent requests failed; review the error before it escalates to Disabled |
| **Disabled** (`disabled`) | Out of service after repeated errors or by an operator; re-enable once fixed |
| **Quarantined** (`flagged`) | Flagged by the provider or quarantined by an operator; excluded from routing until restored |
| **Off** (`off`) | Every provider on the account is turned off on the [Models page](#models); it stays signed in and gets no traffic |

| Routing state | Meaning |
|---|---|
| **Routing healthy** (`healthy`) | Requests are being served |
| **All accounts busy** (`busy`) | Every routable account is at its concurrency limit |
| **Waiting for cooldowns** (`cooldown_wait`) | No account is free; routing resumes when a cooldown ends |
| **Routing paused** (`paused`) | A protective pause is holding all traffic |
| **Routing stopped** (`stopped`) | No account can serve requests |

Quota bars stay neutral and turn amber when a pool drops below 20% and red when it is empty. A quota window that has not started is shown as **Idle — no window running**, with a **Start** button that opens it (see [Fresh Windows](how-it-works.md#fresh-windows)).

## Overview

The Overview answers whether routing works and for how long:

- **Routing**: the routing state, how many accounts can serve, and requests and tokens over the last hour. Below it, counts of accounts that can serve (Serving or Ready), are cooling down and need attention, and the total requests served.
- **Needs you**: rejected Codex credentials, quarantined, erroring and disabled accounts, open circuit breakers, models no account can serve, protective pauses and security warnings, each with an action to inspect or fix it. Lower-priority notes are collapsed under **Show notes**.
- **Models**: one row per quota pool (Claude, Gemini, Codex, Ollama session and weekly, OpenCode) with the pooled quota left across accounts in service (weighted by tier), the account serving it (the one whose status reads **Serving**), the next accounts in line with the policy's pick for the next rotation first, the next reset, and how long the quota lasts at the current rate. A pool is marked **Running low**, **Empty** or **Blocked** (breaker open, or no account with quota).
- **Recent problems**: failed requests and error events since the rotator started.
- **Controls**: the **Allow fresh windows** and **Auto-warmup** switches, applied to every account immediately.

Expanding a model row shows the routing decision for that pool: the active policy and, for every candidate account, its status, quota, health, score and why it was selected, eligible or rejected.

![Model routing decisions](images/dashboard-models.png)

## Accounts

![Accounts](images/dashboard-accounts.png)

Accounts are shown as cards or as a compact sortable list; the toggle next to the search box switches between them and the choice is remembered in the browser.

- **Filters**: All, Can serve, Cooling down and Needs attention (including accounts with a rejected Codex credential), plus a provider filter, a sort order (account, status, quota, health, requests, last used) and a search box. They are kept in the URL (`?status=`, `?provider=`, `?sort=`, `?dir=`, `?q=`).
- **Cards** show the status, providers and tier, which models the account is serving, the quota per pool with its reset countdown (or **Start** for an idle window), requests, health and last use. Erroring, disabled and quarantined accounts also show the last error, and the last two a **Re-enable** or **Restore** button.
- **Actions**: the **⋯** menu on each card or row has Open details, Re-enable, Restore to rotation, Disable, Quarantine, Always allow fresh windows (or Follow global fresh-window policy) and Remove account.
- **Add account** opens the provider sign-in page in a new tab: `/login` when hosted OAuth is configured, otherwise `/login-cli`, which walks through the CLI flow. See [Adding Accounts](adding-accounts.md).

### Account drawer

Clicking an account opens its drawer at `/dashboard/accounts/<email>`.

![Account drawer](images/dashboard-account-drawer.png)

- **Status** with an explanation, the tier selector (used by `tier-first` and `hybrid` routing), and **More** for every action in the menu above.
- **Last error** with a suggested fix, plus per-model and per-provider cooldowns and rejected provider credentials (for example a Codex credential that needs a new login).
- **Quota**: each pool's remaining quota, its window (5-hour, 7-day, monthly pool, or idle) and when it resets.
- **Routing**: the decision and score for each model, and the health-score breakdown (quota minus the error, cooldown and availability penalties; see [Health Scoring](how-it-works.md#health-scoring)).
- **Limits and activity**: total requests and requests since the last rotation, last use, daily account and project budgets, requests in flight against the concurrency cap, the fresh-window setting and the access token state.

## Models

The Models page decides which providers serve traffic and which models clients can call. Changes apply immediately and are saved in the configuration file.

- **Providers**: one row per provider with its accounts (and how many can serve now), how many of its models are on, pooled quota and status: **Healthy**, **Needs sign-in** (a credential was rejected), **No account can serve**, **Not connected** or **Off**.
  - **Order**: when more than one provider lists the same model id, the provider higher in the list gets the request. Drag a row, or use **Move up** and **Move down** in its **⋯** menu. A provider none of whose accounts is in service (disabled, quarantined or switched off) is skipped for the next one that lists the id.
  - **Routing switch**: turning a provider off stops all traffic to it, including benchmarks and warm-up requests. Its accounts stay signed in and keep reporting quota; models only it lists leave `/v1/models`, and a model another provider also lists moves to that provider.
- **Effort routing**: model IDs such as `gemini-3.8-flash` that send each request to an effort variant (`-low`, `-medium`, `-high`) based on the effort it asks for. Each row shows its levels with the default marked, a status (**Live**, a level that is off, **Hidden** when its default model is off or another provider owns the ID, or **Off**), requests in the last hour across its variants, and a switch that turns the ID off. Families of effort variants that no route uses yet are suggested with **Set up**. See [Effort-Based Model Routing](configuration.md#effort-based-model-routing).
- **Models**: one row per model id, with the providers that list it in routing order, its context window, quota pool and requests in the last hour. Filter by **On**, **Off**, **Shared** (listed by more than one provider), **Waiting for review** or **Effort routing** (variants an effort-routed ID uses, tagged with their level), by provider, or by searching the id. A model that is off is left out of `/v1/models`, and requests for it get `404 model_not_found` naming the dashboard, including requests that reach it through an alias or effort routing. A shared model expands to one switch per provider.
- **New models**: **Turn on automatically** (the default) serves models as soon as a provider lists them. **Wait for review** keeps models found later off, under **Waiting for review**, until you turn them on.

Clicking a provider opens its drawer at `/dashboard/models/<provider>`: its status with **Sign in again** for a rejected credential, the routing switch, its accounts with a **Use for** switch that turns the provider off for that account only (the account's other providers keep serving), and its models.

Clicking an effort-routed ID opens its editor at `/dashboard/models/effort/<id>`; **New effort model** and **Set up** open it at `/dashboard/models/effort`. Pick a Google Antigravity model for each effort level clients may ask for (a suggested family fills its variants in) and choose the default for requests without a usable effort. **How requests resolve** shows where each level, and everything else, goes, how Claude-style `/v1/messages` requests pick a level, and an example request to copy. **What clients see** lists what changes in `/v1/models` and offers to turn on a variant that is off. Saving applies to new requests immediately. Closing the editor, Back, Forward or leaving the page with unsaved changes asks first.

## Playground

Open **Playground** to test enabled models using your dashboard session. Choose **Chat**, **Compare**, **Compliance**, or **Transcription**; links use `/dashboard/playground?tab=chat|compare|compliance|transcription`.

- **Chat** supports multi-turn text conversations, PNG/JPEG/WebP image attachments, a system prompt, streaming, temperature, maximum output tokens and reasoning effort. Leave optional parameters blank for provider defaults. **Stop all** interrupts active requests; **Retry last turn** (in the panel's **⋯** menu) sends that turn again. Changing the model starts its conversation over.
- **Compare** sends the same message and images to two or three models concurrently. Each panel keeps its own conversation and has its own **Stop** while it runs. Settings are synchronized by default; turn synchronization off to configure each panel separately. Errors in one panel do not stop the others.
- **Transcription** accepts an audio file or records from the current device's microphone. Choose an enabled Gemini model or the `whisper-1` compatibility alias, optionally set a language code (`es`, `en`, etc.) and vocabulary context, then press **Transcribe**. Preview supported audio in the player before sending. Stop recording keeps the clip; Cancel recording discards it. The browser releases the microphone on stop, cancellation, errors and navigation away, including permission prompts resolved after leaving the page.
- Recording requires HTTPS or `localhost`, microphone permission and a browser with MediaRecorder support. Other browsers can still upload files. Clips stop automatically after five minutes or fail if they exceed the upload limit. WAV, MP3, M4A/MP4, WebM, OGG/OGA, FLAC and PCM files are accepted; the browser reserves 64 KiB of the server body limit for multipart metadata. Raw PCM may not preview in the browser.
- Transcription sends audio only when **Transcribe** is pressed, using your dashboard session and existing audio routing, quota and timeout handling. Cancel transcription aborts the request. Text results can be copied, downloaded as `.txt`, deleted and included in JSON exports; audio files and recordings remain in the current tab and are never saved in playground history or JSON exports. Existing server-side logging remains independent.
- **Tools JSON** accepts an array of OpenAI function definitions. Calls and arguments are shown for inspection; tools are never executed. Tool-call turns and failed or interrupted turns are excluded from subsequent conversation context.
- Each result shows duration, time until the first content was received by the browser, token usage and available routing headers. First-content timing includes the adapter and transport; it is not a measurement of the provider's internal token generation. Missing metrics show as —. Prices, where available, are estimates at API list rates.
- **Compliance** runs five Chat Completions checks: basic response structure, SSE streaming and termination, a verifiable system instruction, JSON mode output, and a forced function call. Select up to three models and any cases. Cases run sequentially within each model, with at most three model workers and a 120-second timeout per request. Stop all cancels running and queued cases; **Retry failed** repeats selected Failed/Error cases. Audio-only models such as `whisper-1` are shown but can't be selected.

Compliance reports **Passed**, **Failed**, **Not supported**, **Error**, or **Cancelled** in a results table with a summary line; expand a row for the explanation, metrics and the request, response and routing details. Only an explicit unsupported-feature error receives **Not supported**. Passing means the observed output meets the case's checks through the rotator; it does not certify a provider or prove that a parameter was enforced internally. Adapter gaps can therefore appear as failed tests.

Tests use real routing, model/provider switches, quotas, compression and request logging. They are not deduplicated and consume real quota. Images require a model and adapter that support vision, and the total request must fit the server's configured body limit (25 MiB by default).

Conversations, drafts, images, transcripts and compliance results are automatically saved to **IndexedDB in this browser**, without requiring PostgreSQL. **New playground** creates a separate saved workspace; use the history selector in the page header to reopen one. The **⋯** menu next to it has **Delete this playground…**, which removes the current workspace, and **Delete all history…**, which removes every playground workspace. Local history is separate from the rotator's existing server-side request logs.

**Export** (in the same menu) downloads the current workspace as JSON in version 1 format, including attachments and results. **Import…** validates and restores an export as a new workspace without sending requests. Imports are limited to 100 MiB. Interrupted saved turns can be retried. If browser storage fails, work remains in memory and can still be exported. The privacy mask hides images and raw details and masks account information in displayed text.

## Requests

**Live** streams the last 200 requests held in memory, interleaved with rotator and proxy events (rotations, upstream errors). Filter by all, errors or successful, hide rotator events, search by model, account or status, or **Pause** the stream. It works without PostgreSQL.

**History** needs PostgreSQL and shows the stored request log:

![Request history](images/dashboard-requests-history.png)

- Filter by date range, outcome, virtual keys and models; filters are kept in the URL. Auto-refresh can be set to every 10 seconds, 30 seconds or minute.
- Totals for the filtered range: requests, prompt and completion tokens, list-price value and average duration.
- **Requests** lists each request (25 per page); click a row to see the request body, the response and the metadata, each with a copy button. **By key** totals the same filters per virtual key.

What is recorded, and the matching REST endpoints, are described in [Virtual Keys & Spend Logging](virtual-keys.md#spend-logging).

## Usage

![Usage](images/dashboard-usage.png)

- **Tokens**: token volume by model for the last hour (per minute), 6 hours (per 5 minutes), 24 hours (per hour), 7 days or 30 days (per day). The headline figures describe the selected range: tokens in and out, requests, the peak bar and the estimated savings at paid API list prices. Hover a bar for its per-model breakdown; click a legend entry to hide or highlight a model. All-time totals are shown below the chart.
- **CSV** and **JSON** download the full token usage history.
- **Latency**: time to first byte and total duration (p50 and p95) per model, over the last 200 requests of each model.
- **Savings by model**: the selected range priced at each model's list price.
- **Activity**: requests per hour over the last 60 days, in your local time.

## Virtual keys

![Virtual keys](images/dashboard-keys.png)

Virtual keys need PostgreSQL. The page lists every key with its owner, allowed models, status and last use, and can be filtered by status or searched by alias, key or user.

**New key** asks for an alias, an optional user and the allowed models (grouped by provider; none selected allows every model). The raw key is shown once, right after it is created. Each key's **⋯** menu has Edit models, Block or Unblock, and Delete key. See [Virtual Keys](virtual-keys.md) for scoping rules and the CLI.

## Settings

- **Routing**: the **Allow fresh windows** and **Auto-warmup** switches, and **Reset all breakers** while circuit breakers are open.
- **Policy**: the routing policy and its main limits (requests per rotation, rotate on quota drop, concurrent requests per account, quota poll interval). Everything else is edited in the configuration file. The policies are explained in [How It Works](how-it-works.md#routing-policies).
- **Accounts**: **Add account**.
- **Benchmark**: sends one small request through each active account and reports latency and failures. Results are not saved.
- **Configuration**: export, import or edit the raw configuration file (`accounts.json`). It contains account credentials, so keep exports private. Fields are described in [Configuration](configuration.md).
- **Appearance and privacy**: theme (follows the system unless you pick light or dark) and the privacy mask.
- **About**: version, uptime, listening address, whether an admin token is required, where request history is stored, project links and **Sign out**.

## Privacy mask

The privacy mask replaces account names, emails, keys and IP addresses with placeholders such as `Account 1`, for screenshots and screen sharing. Turn it on from the profile menu, Settings, or <kbd>⌘K</kbd>, or add `?mask=1` to any dashboard link. The setting is remembered in the browser.

## Working on the dashboard

The source is in `src/web` (Preact and TypeScript). `npm run dashboard:dev` runs the real dashboard routes against a simulated rotator with sample accounts and traffic; see [Contributing](../CONTRIBUTING.md#working-on-the-dashboard).
