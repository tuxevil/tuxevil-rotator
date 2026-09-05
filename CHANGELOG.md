# Changelog

## [Unreleased]

## [3.6.1] - 2026-09-05

### Added

- **Effort-based model routing**: Optional aliases can dispatch requests to concrete model variants based on `reasoning_effort`, while preserving the alias in client-facing responses and tracking quotas against the concrete target ([#32](https://github.com/tuxevil/tuxevil-rotator/pull/32) by [@CyR1en](https://github.com/CyR1en)).

### Fixed

- **Partial Google quota snapshots**: Reset-only quota entries are now treated as exhausted instead of being discarded, while omitted pools remain available from the last known-good snapshot.
- **Model-scoped cooldown reconciliation**: Shared Claude and Gemini pools now reconcile cooldowns independently, preventing one exhausted pool from blocking its sibling and honoring fresh provider reset deadlines.

## [3.6.0] - 2026-09-04

### Added

- **Persistent dynamic model ownership**: Dynamic Antigravity model ownership is persisted by complete account identity and credential-generation fingerprint, so cold restarts cannot route a model through an account or project that never advertised it. ([#30](https://github.com/tuxevil/tuxevil-rotator/pull/30) by [@javargasm](https://github.com/javargasm))

### Fixed

- **Dynamic catalog and quota safety**: Malformed quota entries are ignored without replacing the last known-good snapshot; exhausted sibling pools, stale in-flight responses, retired/reserved model IDs, and account removal or credential changes are handled safely. Persisted cooldown, circuit-breaker, and 429 state is migrated without shortening valid deadlines or losing history. ([#30](https://github.com/tuxevil/tuxevil-rotator/pull/30) by [@javargasm](https://github.com/javargasm))
- **Dynamic model compatibility metadata**: Effective output-token and thinking metadata now honor runtime constraints and operator overrides across Chat, Responses, and Anthropic compatibility paths, with provider- and version-aware Gemini pricing fallbacks. ([#30](https://github.com/tuxevil/tuxevil-rotator/pull/30) by [@javargasm](https://github.com/javargasm))
- **Partial model specification overrides**: Operators can now override only selected `modelSpecs` fields while inheriting the effective runtime, static, or family defaults for omitted metadata. Overrides are retained through configuration normalization and persistence, including context-window lookups. ([#31](https://github.com/tuxevil/tuxevil-rotator/pull/31) by [@javargasm](https://github.com/javargasm))

## [3.5.0] - 2026-09-03

### Added
- **Live Antigravity model discovery**: Successful quota polls now reconcile model IDs, context windows, output limits, thinking metadata, and account availability into `/v1/models` without a second discovery request ([#29](https://github.com/tuxevil/tuxevil-rotator/pull/29) by [@javargasm](https://github.com/javargasm)).

### Fixed
- **Dynamic catalog safety**: Discovery now excludes retired `gemini-3.5-*` IDs, keys snapshots by full account identity, honors case-insensitive operator `modelSpecs` substring overrides, and keeps removed dynamic models from falling through to the generic Gemini pool ([#29](https://github.com/tuxevil/tuxevil-rotator/pull/29) by [@javargasm](https://github.com/javargasm)).

## [3.4.0] - 2026-09-03

### Added
- **Gemini 3.8 Flash support**: Added the native Antigravity IDs `gemini-3.8-flash-high`, `gemini-3.8-flash-medium`, and `gemini-3.8-flash-low` across model discovery, routing, context limits, pricing, dashboards, telemetry, and integration documentation. All three IDs were discovered across nine configured accounts and verified with live generation ([#28](https://github.com/tuxevil/tuxevil-rotator/pull/28) by [@CyR1en](https://github.com/CyR1en)).

### Changed
- **Antigravity client version**: Updated the default Antigravity user agent from `1.107.0` to `2.11.0`; the newer user agent is required for Gemini 3.8 Flash discovery and generation ([#28](https://github.com/tuxevil/tuxevil-rotator/pull/28) by [@CyR1en](https://github.com/CyR1en)).
- **Gemini 3.5 Flash catalog removal**: Removed Gemini 3.5 Flash from the user-facing supported-model catalog and defaults to match Antigravity 2.11. Backend discovery may still return legacy 3.5 quota entries ([#28](https://github.com/tuxevil/tuxevil-rotator/pull/28) by [@CyR1en](https://github.com/CyR1en)).

## [3.3.2] - 2026-08-28

### Fixed
- **Model-scoped Antigravity cooldowns**: `RESOURCE_EXHAUSTED` 429s now cool only the exhausted Claude or Gemini pool; sibling pools on the same account remain routable immediately ([#26](https://github.com/tuxevil/tuxevil-rotator/pull/26) by [@javargasm](https://github.com/javargasm)).
- **Explicit reset duration honored on `RESOURCE_EXHAUSTED`**: The rotator parses `Resets in Xh Ym Zs` from Antigravity error messages and applies that exact cooldown instead of the generic 30-minute cap. Falls back to 30 minutes when no duration is present ([#26](https://github.com/tuxevil/tuxevil-rotator/pull/26) by [@javargasm](https://github.com/javargasm)).
- **Persisted Antigravity pool deadlines survive restarts**: `claude` and `gemini` cooldown deadlines are no longer truncated to 30 minutes on startup; only generic model cooldowns are capped ([#26](https://github.com/tuxevil/tuxevil-rotator/pull/26) by [@javargasm](https://github.com/javargasm)).
- **Untouched 100% pools show idle instead of a fake countdown**: When Google reports `remainingFraction >= 1` the reset timestamp is discarded and the pool renders as `idle` with no timer ([#26](https://github.com/tuxevil/tuxevil-rotator/pull/26) by [@javargasm](https://github.com/javargasm)).
- **RAW POLL reconciliation of exhausted pool deadlines**: A successful quota poll reporting 0% with a valid future reset replaces the stale cooldown deadline for that pool; invalid, past, or unchanged resets are ignored ([#26](https://github.com/tuxevil/tuxevil-rotator/pull/26) by [@javargasm](https://github.com/javargasm)).
- **Serialized per-account quota polling with trailing repoll**: Overlapping `pollAccountQuota` calls for the same account queue a single trailing repoll instead of running concurrently; `pollAllQuotas` is now single-flighted ([#26](https://github.com/tuxevil/tuxevil-rotator/pull/26) by [@javargasm](https://github.com/javargasm)).
- **`gpt-oss:20b` kickstarts routed through Ollama**: On multi-provider accounts (Google + Ollama), the kickstart for the Ollama session pool is correctly sent to the Ollama endpoint with the Ollama API key ([#26](https://github.com/tuxevil/tuxevil-rotator/pull/26) by [@javargasm](https://github.com/javargasm)).
- **Kickstart actions hidden for disabled/flagged accounts**: The dashboard no longer renders `▶ Start` or `Start Idle Timers` buttons for accounts that are not eligible for kickstart ([#26](https://github.com/tuxevil/tuxevil-rotator/pull/26) by [@javargasm](https://github.com/javargasm)).
- **`gemini-3.7-flash-tiered` added to OpenCode integration docs**: Context window updated to 1,000,000 tokens; set as the recommended default model ([#26](https://github.com/tuxevil/tuxevil-rotator/pull/26) by [@javargasm](https://github.com/javargasm)).

## [3.3.1] - 2026-08-27

### Fixed
- **Admin token propagation on hosted login**: Propagate the configured admin token to the "Continue With Google" link on the `/login` landing page, preventing a 401 Unauthorized error when navigating to `/auth/antigravity/start` ([#25](https://github.com/tuxevil/tuxevil-rotator/pull/25) by [@CelestialCreator](https://github.com/CelestialCreator)).

## [3.3.0] - 2026-08-24

### Added
- **Queued multi-request Antigravity pooling (5×5 concurrent streams)**: Up to 5 concurrent Antigravity streams per account across model pools, with a 25-stream total across 5 accounts. Requests are distributed breadth-first by total account load across mixed Gemini and Claude traffic ([#24](https://github.com/tuxevil/tuxevil-rotator/pull/24) by [@javargasm](https://github.com/javargasm)).
- **Process-local strict FIFO request queue**: Requests exceeding total pool capacity wait in a strict FIFO queue with automatic 300-second expiration, early client disconnect cancellation (`AbortSignal`), and immediate wakeup on lease release, cooldown expiry, circuit-breaker reset, catalog discovery, or config reload ([#24](https://github.com/tuxevil/tuxevil-rotator/pull/24) by [@javargasm](https://github.com/javargasm)).
- **Dashboard concurrency metrics**: Account cards on the web dashboard display active vs. max concurrency (e.g. `Concurrency: 3/5`) for Google Antigravity accounts ([#24](https://github.com/tuxevil/tuxevil-rotator/pull/24) by [@javargasm](https://github.com/javargasm)).

### Changed
- **Config defaults**: `maxConcurrentRequestsPerAccount` and `maxConcurrentRequestsPerProjectModel` default values raised from `1` to `5` ([#24](https://github.com/tuxevil/tuxevil-rotator/pull/24) by [@javargasm](https://github.com/javargasm)).

### Fixed
- **Canonical project ID resolution**: Forwarding, quota polling, Code Assist passthrough, and admission gating consistently resolve trimmed nested `google-antigravity` credentials before legacy flat `projectId` fields, preventing unkeyed empty project ID collision across unrelated accounts ([#24](https://github.com/tuxevil/tuxevil-rotator/pull/24) by [@javargasm](https://github.com/javargasm)).

## [3.2.3] - 2026-08-21

### Fixed
- **Account-scoped 429 `RESOURCE_EXHAUSTED` resilience & account lifecycle**: When an individual account exhausts its quota (returning 429 `RESOURCE_EXHAUSTED` on Claude or Gemini), the proxy now safely releases the failed account before rotating, allowing immediate retry with the next eligible account in the pool instead of failing prematurely ([#23](https://github.com/tuxevil/tuxevil-rotator/pull/23) by [@javargasm](https://github.com/javargasm)).
- **Synchronous account leasing & atomic concurrency accounting**: `inFlightRequests` reservation and model assignment tracking now occur synchronously and indivisibly at lease time before asynchronous save or refresh operations. If activation fails, in-flight counters are rolled back and token buckets are refunded immediately ([#23](https://github.com/tuxevil/tuxevil-rotator/pull/23) by [@javargasm](https://github.com/javargasm)).
- **Snapshot-based token refresh & generation tracking**: Provider token refreshes execute against isolated account snapshot clones. Refreshed tokens are published only if the credential generation has not changed during flight, cleanly discarding stale tokens if credentials were reconfigured ([#23](https://github.com/tuxevil/tuxevil-rotator/pull/23) by [@javargasm](https://github.com/javargasm)).
- **Provider-scoped token publication**: Token refreshes for multi-provider accounts (e.g. Google Antigravity + OpenAI Codex) now update strictly provider-owned fields, preventing cross-provider token and credential overwrites ([#23](https://github.com/tuxevil/tuxevil-rotator/pull/23) by [@javargasm](https://github.com/javargasm)).
- **Identity resolution with non-secret credential fingerprinting**: Duplicate-email accounts without stable provider IDs are resolved using a 12-character SHA-256 non-secret credential fingerprint, isolating runtime state during `replaceConfig` ([#23](https://github.com/tuxevil/tuxevil-rotator/pull/23) by [@javargasm](https://github.com/javargasm)).
- **Exact incarnation exclusion on retry**: `rotateToNext(model, failedAccount)` binds exclusion strictly to the exact runtime object instance, preventing false 503 errors when an account is replaced by a healthy incarnation ([#23](https://github.com/tuxevil/tuxevil-rotator/pull/23) by [@javargasm](https://github.com/javargasm)).

## [3.2.2] - 2026-08-21

### Fixed
- **Spend-logger memory leak in file-based storage mode**: When running in default file-based storage mode (without PostgreSQL), `flushSpendLogs()` returned early without draining or clearing the log `queue`. Since requests with sanitized payloads (up to 512 KB each) were being enqueued, heap memory grew indefinitely. `logSpend()` now short-circuits and clears `queue` when PostgreSQL is not configured ([#22](https://github.com/tuxevil/tuxevil-rotator/pull/22) by [@javargasm](https://github.com/javargasm)).
- **Atomic PostgreSQL spend log insert & daily aggregation via CTE**: Combined `rotator_spend_logs` insert and `rotator_daily_spend` upsert into a single atomic Common Table Expression query. Re-attempted inserts with existing `request_id` values return 0 rows from `ins_log`, ensuring daily metrics are not double-counted on retries. On database errors, only uncommitted logs are re-enqueued and bounded by a strict FIFO cap (`MAX_QUEUE_CAP = 100`) ([#22](https://github.com/tuxevil/tuxevil-rotator/pull/22) by [@javargasm](https://github.com/javargasm)).
- **Unbounded Virtual Key cache bounded**: Added `KEY_CACHE_MAX = 500` with 1-minute TTL and FIFO eviction to `keyCache` in `src/virtual-keys.ts`, preventing memory exhaustion from negative lookup caching and key scanning ([#22](https://github.com/tuxevil/tuxevil-rotator/pull/22) by [@javargasm](https://github.com/javargasm)).
- `/v1/models` no longer reports the outdated 500K Claude context window.

### Added
- **Official per-model context windows surfaced across providers**: New `src/providers/google-antigravity/catalog.ts` publishes the upstream context windows for Claude (Opus 4.6 / Sonnet 4.6 → 1M, Opus 4.5 / Sonnet 4.5 → 200K), Google Gemini (3.1 Pro, 3 Pro, 3 Flash variants, 2.5 Pro/Flash → 1M each), and `gpt-oss-120b` (131,072). The new `getAntigravityContextWindow(model)` helper is the single source of truth.
- **`/api/show` lookup for Ollama model context windows**: `src/providers/ollama/context-window.ts` calls `POST https://ollama.com/api/show` to read `model_info.<arch>.context_length`, cached for `TAGS_CACHE_TTL_MS` and falling back to the operator-provided `OLLAMA_NUM_CTX` env (default 8192).
- **`ModelSpec.contextWindow`**: Optional `contextWindow` field in `src/compat/model-specs.ts` reflects upstream values; resolved automatically via `getModelSpec()` and propagated through `/v1/models`-adjacent surfaces.

### Changed
- **OpenAI Codex catalog updated to GPT-5.6 family official 1.05M window**: `CODEX_CONTEXT_WINDOW` raised from 272_000 to 1_050_000 per `https://platform.openai.com/docs/models`. The 2M safety cap on `/models`-discovered ids is preserved.
- **OpenCode Zen catalog now exposes a per-id helper** (`getOpenCodeZenContextWindow`) that documents the placeholder 128K window until OpenCode publishes per-model specs.
- **`MODEL_CATALOG` in `src/compat.ts`**: Claude Opus 4.6 / Sonnet 4.6 context window raised from 500_000 to 1_000_000 to match Anthropic's published spec.

## [3.2.1] - 2026-08-16

### Fixed

- **Credential persistence across restarts with PostgreSQL**: When PostgreSQL is configured as the account store, credentials added via the login panel (`ollama`, `opencode-zen`, `openai-codex`) were stored using the legacy flat `apiKey` field instead of the structured `credentials[{provider, apiKey}]` shape. On the next quota poll, the rotator read back the correct structured credential from the database but the Ollama provider adapter found nothing, flagging the account with 401. The `handleOllamaCliLogin` onboarding handler now always persists as `credentials: [{ provider: "ollama", apiKey }]`.

- **OpenCode Zen and sibling credentials lost on `replaceConfig`**: When the dashboard config editor saved a new config (e.g. after changing routing settings), `replaceConfig()` merged credentials correctly in memory but then persisted the original unmerged `config.accounts` payload to PostgreSQL. After the next restart the database-sourced config lacked the `opencode-zen` (or `ollama`) credential entirely. The fix builds the merged account list first and persists that merged list, so no credential is ever dropped by a config save.

- **Legacy Ollama JSON re-imported on every boot with PostgreSQL**: `importLegacyOllamaRotatorAccounts()` ran unconditionally at startup, allowing a stale `~/.ollama-rotator/accounts.json` to re-introduce revoked API keys each time the service restarted. The import is now skipped when `TUXEVIL_ROTATOR_DATABASE_URL` is configured, making PostgreSQL the sole authoritative source.

- **`accounts.json` disk file migrated into PostgreSQL on startup**: `PostgresSettingsRepository.init()` migrated any on-disk `accounts.json` into the database on first boot. If the file contained an outdated credential it would silently overwrite the database value. The `accounts_json` key is now excluded from the disk-to-database migration path; only non-credential settings (state, token usage, admin token) are migrated from disk.

- **PostgreSQL writes were fire-and-forget**: Account config writes to PostgreSQL were non-blocking background promises. A service restart occurring within the write window could lose the latest credential update. All settings writes are now awaited before returning a success response.

- **`mergeCredentials` called on pre-normalization data in `addAccountToConfig`**: The merge was applied against the raw (possibly legacy-shaped) existing account instead of its normalized form, causing duplicate or missing credentials in edge cases. The existing account is now normalized before merging.

### Changed

- **`replaceConfig` syncs in-memory and persisted accounts atomically**: The merged account list is computed once and used for both `this.accounts`/`this.config` and the PostgreSQL write, preventing divergence.

## [3.2.0] - 2026-08-14

### Added
- **Gemini 3.7 Flash Model Support**: Full support for Google's Gemini 3.7 Flash models (`gemini-3.7-flash`, `gemini-3.7-flash-tiered`, `gemini-3.7-flash-high`, `gemini-3.7-flash-medium`, `gemini-3.7-flash-low`). Includes thinking level and reasoning effort mapping, token cost tracking, dashboard visualization, and telemetry support ([#21](https://github.com/tuxevil/tuxevil-rotator/pull/21) by [@CyR1en](https://github.com/CyR1en)).
- **OpenCode Zen Provider Support**: Integrated `opencode-zen` as a supported free-tier provider for `deepseek-v4-flash-free`, `nemotron-3.5-lightning-free`, `nemotron-3-ultra-free`, `mimo-v2.5-free`, and `hy3-free`. Includes API key validation via `opencode.ai/zen/v1`, quota polling, streaming and non-streaming chat completions, market pricing to calculate USD savings, and an OpenCode Zen tab in `/login` and `/login-cli`.
- **429 Rate-Limit Retry Headers**: Convey `retryAfterMs` and `retry_after_seconds` in rate-limited error responses to allow clients to respect upstream cooldowns accurately.

### Fixed
- **Streaming Tool Call Assembly**: Statefully preserve tool call names and IDs across SSE deltas, preventing split chunks from dropping function metadata in multi-turn tool calling.
- **OpenCode Zen Account Rotation & Rate Limits**: Scope OpenCode Zen rate limits per-model to prevent single-model 429 errors from locking out the entire provider pool, and ensure proper account rotation on upstream 429s.
- **OpenCode Zen Content-Type & Streaming**: Strip duplicate content-type headers, fix Accept header negotiation, and fix token refresh and format handling for `deepseek-v4-flash-free`.
- **Dashboard Generate Key Modal**: Dynamically populate the Virtual Key generation model grid from `/api/models` to include only active providers and registered models.
- **Dashboard UI & Cache Control**: Restored missing card header closing `<div>` tag and added static asset cache control headers.
- **Test Isolation**: Isolated `TUXEVIL_ROTATOR_DIR` in `db-store` tests to prevent test suites from modifying local user configurations.

### Changed
- **Provider Ordering**: Standardized provider order precedence across quota pools, credentials, and UI displays (`google-antigravity` -> `ollama` -> `opencode-zen` -> `openai-codex`).
- **Catalog Cleanup**: Removed deprecated `ling-3.0-tiny-free` and `laguna-s-2.1-free` models from the OpenCode Zen catalog to avoid false-positive account flag warnings.
- **Provider Architecture**: Decoupled provider eligibility checks and routing logic from rotator core into modular provider adapters.

## [3.1.0] - 2026-08-12

### Added
- **OpenAI Codex OAuth provider**: Support for OpenAI Codex authentication and accounts (`gpt-5.6-codex`, `gpt-5.6-codex-mini`, `gpt-5.6-codex-max`, `codex-sol-4-6`).
- **Web & CLI OAuth login**: Integrated Codex provider tab in `/login` and `/login-cli` for PKCE OAuth authentication.
- **Codex pricing & dashboard visualizer**: Added cost tracking and yellow color spectrum mapping for Codex GPT-5.6 models in token usage charts.
- **Tool calling translation & compat**: Tool calls and chat completions automatically translate between OpenAI Codex and proxy formats.

### Fixed
- **Provider catalog isolation**: Prevented non-Codex and Google models from polluting Codex discovery routing.
- **Isolated provider kickstarts**: Provider kickstart pools operate independently without triggering unneeded OAuth refresh flows.
- **Codex usage & spend tracking**: Fixed recording of usage and spend for Codex compat requests.
- **Gemini turn bug fix**: Prevented model-ending compat requests for Gemini models.

### Changed
- **Dashboard account cards**: Removed the legacy `FLASH` / `PRO` / `CLAUDE` model badges that previously indicated which model each account was last active for. The tier selector (`UNKNOWN` / `FREE` / `PLUS` / `PRO` / `ULTRA`) is unchanged.

## [3.0.0] - 2026-08-11

### Changed
- **Project rebrand**: the project, CLI, repository, default config directory, environment-variable prefix, and GHCR image are now `tuxevil-rotator`.
- **New npm package**: install `tuxevil-rotator` for the v3 release. The former `pi-antigravity-rotator` package remains available as a deprecated migration path.
- **Guided migration**: `tuxevil-rotator migrate` safely copies legacy configuration files into `~/.tuxevil-rotator/` without deleting the original files.
- **Multi-provider surface**: Google Antigravity and Ollama Cloud are exposed through one provider-agnostic rotator and CLI.

### Compatibility
- The legacy `pi-antigravity-rotator` command, `PI_ROTATOR_*` variables, old config directory, systemd unit fallback, virtual-key salt, and encryption context remain supported for migration.

## [2.8.12] - 2026-08-11

### Added
- **`/login-cli` now supports adding Ollama Cloud accounts alongside Google (Antigravity)**. The page has provider tabs: the existing Google OAuth paste-the-redirect-URL flow stays, and a new Ollama panel (ported from ollama-rotator) validates the API key against ollama.com before saving. `handleCliLoginApi` dispatches on `provider` (`google-antigravity` default / `ollama`), reusing `validateApiKey` and `defaultAccountEmail` from the Ollama provider layer.

## [2.8.11] - 2026-08-11

### Fixed
- **"Free tier model access" attention item is now informational (green)**: `renderAttentionItem` had no `info` type, so the item fell through to the orange warning style even though it is purely informational. Ported the `info` branch (info icon + `operator-green` border/icon, `#22c55e`) from ollama-rotator, matching how the attention modal renders it there.

## [2.8.10] - 2026-08-11

### Fixed
- **Token Usage chart missed Ollama model savings**: the dashboard recomputes savings client-side from `MODEL_PRICING_CLIENT`, which only mirrored the Google-model prices. Ollama models (`gpt-oss:20b`, `gemma4:31b`, `deepseek-v4-flash:...`, `kimi-*`, etc.) had no pricing entry, so `calcSavingsFromBuckets` skipped them and the "Savings" total and per-model legend showed nothing for Ollama traffic even though the backend already priced it. The client table now mirrors `MODEL_PRICING` in `src/types.ts` for all Ollama Cloud models.

## [2.8.9] - 2026-08-11

### Fixed
- **Dual google+ollama accounts were excluded from the `claude`/`gemini` pools**: `isProviderEligibleForKey` required the account to NOT have an `ollama` credential for Google pool keys, so every dual account (27 of 46, including the accounts at 100% claude quota) could never serve `claude` even with a full weekly bucket. Only the google-only accounts stayed eligible; once those drained, three unique 429s armed the 6-hour model circuit breaker and blocked every account — including healthy ones. Eligibility now checks for the `google-antigravity` credential itself, so dual accounts serve both the Ollama `session` pool and the Google pools.
- **Routing diagnostics lied about the best route**: `buildRoutingDiagnostics` never applied provider eligibility, so it reported "Best route is dragontecuador@gmail.com" while `pickBestModelAccount` silently rejected that same account. `getRoutingRejectionForModel` now reports the new `provider-ineligible` reason, making the dashboard match the rotation decision.
- **Account-level quota exhaustion no longer arms the circuit breakers**: a 429 with RESOURCE_EXHAUSTED ("Individual quota reached…") is per-account daily/weekly exhaustion, already handled by the account's own cooldown from `markExhausted`. `recordProvider429` ignored that distinction, so three drained accounts armed the pool-wide project/model breakers for hours and blocked accounts that still had quota. The proxy now passes `providerResourceExhausted` through and exhausted-account 429s skip breaker arming.

## [2.8.8] - 2026-08-10

### Changed
- **Default API key placeholder rebranded**: documentation now instructs agents to use API key `tuxevil` instead of `antigravity` (open mode when no Virtual Keys are configured). Updated in README and all integration guides (aider, claude-code, cline, codex, continue, cursor, hermes, open-webui, openclaw, roo-code). Provider IDs and `antigravity/gemini-...` model paths are untouched.

## [2.8.7] - 2026-08-10

### Added
- **"Free tier model access" attention notice for Ollama accounts**: ported `MODEL_TIER_ACCESS` from `~/ollama-rotator` (verified 2026-08-09 probes: `gpt-oss`, `gemma4:31b`, `minimax-m3`, `nemotron-3-*` are free-tier; the rest require a subscription). `getStatus()` now exposes `modelTierAccess` only when at least one account carries an `ollama` credential, and the dashboard attention panel shows the ✓/✗ model list with the HTTP 403 "requires a subscription" explainer for accounts on the free tier (or unset), exactly like ollama-rotator.

## [2.8.6] - 2026-08-10

### Changed
- **Ollama models no longer activate in-flight tracking**: `startRequest`/`finishRequest` are now no-ops for the Ollama pool (key `"session"` and any model in the Ollama catalog). Until now every Ollama request went through `getActiveAccount` → `startRequest(account, "session")`, which incremented `inFlightByModel["session"]` — but the proxy's `finishRequest` calls pass `resolveQuotaModelKey(model) ?? undefined`, which resolves to `undefined` for Ollama models, so the decrement landed on `"__default__"` and the counter never came back down. Accounts stayed in-flight forever and the dashboard bars stuck at their peak. Ollama Cloud has no per-account concurrency limit, so tracking it was both broken and pointless; Antigravity (`claude`, `gemini`) counters are unaffected.

## [2.8.5] - 2026-08-10

### Fixed
- **Quota bars duplicated across poll cycles**: `extractQuotas` and `extractUsagePools` already returned the canonical family pool entries (`claude`, `gemini` for Antigravity; `session`, `weekly` for Ollama), but the per-adapter merge into `account.quota` preserved every previous entry from the SAME provider alongside the new ones. Each quota poll therefore appended a fresh copy of each pool instead of replacing the previous one, so the dashboard's RAW POLL line kept growing the bars vertically across cycles (`[claude] [gemini] | ollama: [session] [weekly]` repeated 2×, 3×, …). The merge now keeps entries from the *other* provider and fully replaces this provider's entries every cycle, so each quota is reported exactly once.
- **Ollama pool wedged on per-account concurrency**: Ollama Cloud imposes no per-account concurrency limit, but `isAvailableForModel` and `getRoutingRejectionForModel` rejected accounts whose `inFlightByModel["session"]` already reached `maxConcurrentRequestsPerAccount` (default 1), so any second concurrent Ollama request was forced to wait for the first to finish or retry on another account. The predecessor project dropped this check for Ollama for the same reason. The pool key `session` now skips the concurrency check; Antigravity (`claude`, `gemini`) keeps it.

## [2.8.4] - 2026-08-10

### Fixed
- **Ollama tool-call `arguments` shape**: OpenAI-compat clients send `messages[].tool_calls[].function.arguments` as a JSON-encoded **string** (e.g. `"{\"q\":\"x\"}"`), while Ollama's native API expects a parsed **object**. The translator was passing the string through verbatim, so Ollama rejected every multi-turn request that included an `assistant` message with `tool_calls` (or a `tool` response) with `HTTP 400: Value looks like object, but can't find closing '}' symbol`. `openAIToOllamaBody` now parses `arguments` into an object via the new `toolArgumentsToObject` helper before forwarding, and the Responses-API output path serializes them back to a string via `toolArgumentsToString` so OpenAI-compat clients receive the canonical shape. `OpenAIToolCall.arguments` and `ResponseFunctionCallOutputItem.arguments` were widened from `string` to `unknown` to reflect both providers' shapes.

## [2.8.3] - 2026-08-10

### Fixed
- **Provider dispatch for Ollama models without a `:` tag**: the proxy's `providerAdapterForModel` helper relied on `body.model.includes(":")` to recognize Ollama models. This misrouted models like `minimax-m3`, `kimi-k3`, `glm-5.1`, `glm-5.2`, `nemotron-3-super`, `nemotron-3-ultra`, and `deepseek-v4-pro` to the Antigravity adapter (no `:` in the name), where the Antigravity API rejected the OpenAI-style payload with `HTTP 400: Unknown name "messages" at 'request'`. The helper now consults `rotator.getOllamaModels()` (the source of truth populated from `/api/tags`) and only falls back to the credentials-only dispatch when that method is absent (e.g. test stubs).

## [2.8.2] - 2026-08-10

### Added
- **Ollama Cloud model pricing in `MODEL_PRICING`**: `calculateCost()` previously returned `0` for every Ollama model because only the Antigravity models had price entries (claude + gemini variants). 18 entries were ported from `~/ollama-rotator/src/types.ts` (`gpt-oss:20b`, `gpt-oss:120b`, `deepseek-v4-flash:preview`, `deepseek-v4-flash:0731`, `deepseek-v4-pro`, `qwen3.5:397b`, `glm-5.1`, `glm-5.2`, `gemma4:31b`, `kimi-k2.6`, `kimi-k2.7-code`, `kimi-k3`, `minimax-m2.7`, `minimax-m3`, `mistral-large-3:675b`, `nemotron-3-nano:30b`, `nemotron-3-super`, `nemotron-3-ultra`). The dashboard spend summary now reports non-zero USD for Ollama traffic.

## [2.8.1] - 2026-08-10

### Changed
- **Antigravity quota pools consolidated by family**: `QUOTA_MODEL_KEYS` is now `claude` (every Claude variant + gpt-oss) and `gemini` (every Gemini variant). `account.quota` carries at most one Antigravity entry per family instead of one per model, matching how Antigravity itself reports the shared bucket. `resolveQuotaModelKey` returns `"claude"` or `"gemini"` for any member of those families; `MODEL_CATALOG` `quotaPool` values follow suit. `resolveDisplayModelKey` and `MODEL_PRICING` are unchanged, so telemetry and pricing still distinguish variants.
- **Consolidated RAW POLL log**: per quota cycle, each provider's adapter stashes its formatted pools into `account.lastPollByProvider` and the rotator emits a single `RAW POLL email -> google-antigravity: [...] | ollama: [...]` line, with Antigravity pools first and Ollama (session/weekly) last. Multi-provider accounts no longer log a separate line per provider.

## [2.8.0] - 2026-08-10

### Added
- **Parent-Account Credential Model (F4)**: Each account is now identified by its email and can hold per-provider credentials (`credentials: [{provider, apiKey/refreshToken, projectId}]`). A single human with both a Google Antigravity OAuth token and an Ollama Cloud API key is stored as one account row instead of two. The dashboard, login flow, quota poll, kickstart, and rotation all key on the email — per-provider credentials are dispatched at request time. Legacy flat-shape configs (`provider`/`apiKey`/`refreshToken` at the top level) are still accepted and normalized on load. Migrate `login --provider <id>` to add credentials to an existing account rather than creating a duplicate row.

### Changed
- **Ollama Cloud Account Import**: the legacy importer now merges the `ollama` credential into any existing account with the same email (instead of skipping the email), so multi-provider identities are unified on first import. The import log now reports `M merged into existing account(s), N new account(s)`.

### Fixed
- **Ollama singleton-pool rotation threshold** (closed by `pi-antigravity-rotator-tuv`): with only one Ollama account, the persisted request-count threshold (`requestsPerRotation`) excluded the lone account from the pool after one request, producing `All accounts disabled or unavailable`. Resolved by F4: the Ollama pool now holds 28 accounts (27 dual + 1 Ollama-only), so rotation always has an alternative.

## [Unreleased]

### Fixed
- **Ollama Content Array Normalization**: message `content` arrays (OpenAI-style blocks, e.g. from multimodal requests) are flattened to plain strings and `image_url` blocks are moved to the native `images` field before forwarding to Ollama Cloud, whose Go API rejects `messages[].content` arrays with `cannot unmarshal array` errors. Ported from ollama-rotator `ec5fa5a`; applies to the native `/api/chat` route and all v1 compat adapters.
- **Native `/api/chat` Payload Parsing**: the native route now parses the Ollama payload shape (`{model, messages, stream, options}`) before internal validation, which previously rejected every native request with `400 body.request is required`. Requires `model` and a non-empty `messages` array.
- **Ollama Catalog at Startup**: the Ollama Cloud model catalog is fetched once at boot (previously only inside quota poll cycles, every ~5 min), so provider-aware routing and `GET /v1/models` see Ollama models immediately.

## [2.7.0] - 2026-08-10

### Added
- **Multi-Provider Support**: The rotator now routes through two provider families. Google Antigravity accounts (OAuth, default) and Ollama Cloud accounts (static API keys, `login --provider ollama`) coexist in one account store, with per-provider model catalog resolution.
- **Ollama Cloud Compatibility (B2)**: `POST /v1/chat/completions`, `/v1/responses`, and `/v1/messages` translate requests to Ollama's native `api/chat` NDJSON protocol for Ollama models; streaming deltas (including `tool_calls` and usage) are converted to SSE in both OpenAI and Anthropic formats. `GET /v1/models` lists the Ollama catalog (`owned_by: "ollama"`), and the native `/api/chat` endpoint routes Ollama models to Ollama accounts.
- **Legacy Account Migration**: On startup, Ollama Cloud accounts from `~/.ollama-rotator/accounts.json` (the predecessor product, overridable via `OLLAMA_ROTATOR_DIR`) are imported automatically — tagged `provider: "ollama"`, preserving `label`/`tier`/`type`. Duplicate emails and entries without an API key are skipped.

### Changed
- `GET /v1/models` and the v1 translation layer are now provider-aware: Ollama models are no longer rejected with a `400` error; they are handled by the Ollama adapter.

### Documentation
- `docs/configuration.md`: new Providers section, provider-aware account fields table, and legacy migration notes.
- `docs/adding-accounts.md`: Ollama Cloud login section and manual migration steps.

## [2.6.3] - 2026-08-05

### Fixed
- **Login for New Accounts**: Project discovery now tries the production `daily-cloudcode-pa` / `cloudcode-pa` endpoints before the sandbox one and, when `loadCodeAssist` returns no project yet, provisions one through the `onboardUser` flow the Antigravity IDE uses. Previously brand-new accounts failed at login with "Could not discover Cloud Code companion project ID from Google" unless they were first activated manually in the IDE.
- **CLI Login Backend Mismatch**: `pi-antigravity-rotator login` now mirrors the environment of the installed systemd service unit (`PI_ROTATOR_DATABASE_URL` and any `Environment=`/`EnvironmentFile=` drop-ins, plus `ANTIGRAVITY_*`) so the CLI writes to the same account store the running service reads from. Previously, on PostgreSQL-backed installs, login wrote to the on-disk `accounts.json` while the service read from the database, so newly added accounts never appeared on the dashboard.

## [2.6.2] - 2026-08-04

### Fixed
- **Tool Function Names in OpenAI Compat**: When the thought-signature cache re-enables the upstream `functionCall` path, tool responses whose `name` field is missing are now resolved from the preceding assistant `tool_calls` history (matched by `tool_call_id`). Previously they fell back to `"unknown"`, which Google rejects with `400 INVALID_ARGUMENT` on `gemini-3.6-flash-high` and other cached routes.

### Verified
- **Compat Regression Coverage**: Added a translator test proving the tool-role branch emits the historical function name (`edit`) instead of `"unknown"` when the cached signature re-enables the `functionCall` path.

## [2.6.1] - 2026-08-01

### Added
- **Routing Inspector Health Breakdown**: Show quota, error, cooldown, availability, and final-score components for each routing candidate.

### Fixed
- **Claude Code Tool Schemas**: Strip the unsupported JSON Schema `propertyNames` keyword from Gemini and Claude-via-Gemini tool declarations, preventing `400 INVALID_ARGUMENT` responses while preserving neighboring schema fields. ([PR #19](https://github.com/tuxevil/pi-antigravity-rotator/pull/19) by [@Codder-hermes](https://github.com/Codder-hermes))

### Verified
- **Incremental Streaming**: Added integration coverage proving OpenAI Chat, Responses, Anthropic, and native adapters deliver upstream chunks before completion.

### Documentation
- **Roadmap Status**: Reconciled the roadmap with the completed routing diagnostics, incremental streaming, and async persistence work, including the decision to descope the account-card health badge.

## [2.6.0] - 2026-07-30

### Added
- **Prompt Compression**: Added opt-in lossless Lite compression and RTK compression with 55 command-specific filter packs. Configure `compressionMode` as `lite`, `rtk`, or `rtk+lite`, or override it per request with `X-Rotator-Compression`.
- **Account Benchmarking**: Added a dashboard benchmark for measuring active account performance without persisting benchmark results.
- **Request Observability**: Added `X-Rotator-*` response headers for account, model, token, cost, latency, health, routing, idempotency, and compression metrics.

### Changed
- **Dashboard Workspaces**: Redesigned the Accounts, Virtual Keys, Spend Logs, and telemetry/notification views with improved navigation, masking, filtering, and responsive layouts.
- **Request Reliability**: Added idempotency protection for duplicate in-flight requests and pre-flush stream recovery with configurable retries.
- **Persistence Performance**: Migrated hot-path state persistence to asynchronous I/O and improved telemetry accounting for input/output tokens and savings.

### Security
- **Refresh Token Encryption**: Added AES-256-GCM encryption at rest with salted `scrypt` key derivation for new `enc:v2` tokens while preserving decryption of existing `enc:v1` tokens.
- **Code Scanning Hardening**: Removed the catastrophic-backtracking path regex, stopped exposing upstream/config error details to clients, and retained diagnostics in server logs.
- **Benchmark Privacy**: Applied the dashboard's existing PII masking to benchmark account labels.

## [2.5.0] - 2026-07-28

### Added
- **Automated GHCR Docker Build**: Added GitHub Actions workflow (`.github/workflows/docker-publish.yml`) for building multi-architecture (`linux/amd64`, `linux/arm64`) Docker images and publishing to GitHub Container Registry (`ghcr.io/tuxevil/pi-antigravity-rotator`).
- **Pre-built Docker Image Support**: Updated `docker-compose.yml` to pull pre-built images from GHCR by default and updated `README.md` with `docker pull` instructions.

## [2.4.0] - 2026-07-23

### Added
- **Virtual Keys**: Issued scoped `rk-...` API keys with per-key model authorization rules and user tracking. Supports CLI management (`pi-antigravity-rotator keys list/generate/delete`) and Web UI (`/dashboard/keys`).
- **Spend Logs & LiteLLM-grade Inspector**: Persistent audit trail for requests, token metrics, latency (TTFB & total), USD cost estimation (6 decimals), Base64 media sanitization (1 MB cap), and multi-tab Request/Response/Metadata inspector.
- **Multi-page Dashboard UI**: Redesigned header with integrated navigation tabs connecting Accounts (`/dashboard`), Virtual Keys (`/dashboard/keys`), and Spend Logs (`/dashboard/logs`). Includes customizable column visibility, full search/filtering, global DB-aggregated summary metrics, and robust PII masking (`?mask=1`).
- **PostgreSQL Persistence & Retention**: Added PostgreSQL storage backend for high-concurrency key validation and spend audit logging, with automatic background retention policies (`PI_ROTATOR_LOG_RETENTION_DAYS`, default 30 days).

### Security
- **PBKDF2 Key Derivation**: Hardened virtual key storage to use PBKDF2 (10,000 iterations) for one-way key hashing, eliminating weak SHA-256 derivation (resolves CodeQL alert #19 and #20).
- **Stack Trace Hardening**: Redacted internal error stack traces from dashboard HTTP responses and logged them via logger (resolves CodeQL alerts #11-#18).

## [2.3.6] - 2026-07-21

### Fixed
- **Telemetry**: Fixed telemetry and notification polling endpoint URL by removing port `:3800` from `https://telemetry.tuxevil.com`.

## [2.3.5] - 2026-07-21

### Added
- **Gemini 3.6 Flash**: Added model discovery, routing, pricing, dashboard, and quota support while keeping the shared Gemini Flash pool behavior. ([PR #18](https://github.com/tuxevil/pi-antigravity-rotator/pull/18) by [@CyR1en](https://github.com/CyR1en))
- **Security policy**: Added repository security guidance and hardened dashboard, onboarding, telemetry, and notification handling.

### Changed
- **OAuth compatibility**: Operator-provided OAuth credentials take precedence, while the legacy fallback remains available with a deprecation warning so existing installations are not interrupted.

### Fixed
- **Test isolation**: Routing fixtures no longer write to the operator's real account configuration directory.
- **Security hardening**: Removed OAuth credentials from utility scripts, eliminated clear-text OAuth logging, and addressed remaining CodeQL/security findings.
- **Dependency security**: Updated `brace-expansion` to `5.0.7`; `npm audit` is clean.

## [2.3.4] - 2026-07-21

### Fixed
- **Telemetry**: Restored port `3800` to the telemetry and notification endpoint URL (`https://telemetry.tuxevil.com:3800`).

## [2.3.3] - 2026-07-21

### Changed
- **Telemetry**: Updated telemetry and notification polling endpoint URL to `https://telemetry.tuxevil.com`.

## [2.3.2] - 2026-07-05

### Fixed
- **Assistant History**: Preserve final Responses assistant history.
- **Claude Formatting**: Prevent Claude assistant prefill payloads and fix orphan Claude tool results to comply with API formatting constraints.
- **Resource Leaks**: Release compat streams on client disconnect to prevent memory leaks.
- **Security Audit**: Addressed audit hardening findings and fixed audit issues around OAuth and admin routes.


## [2.3.1] - 2026-06-30


### Added
- **Manual & Auto-Warmup (Kickstart) Timers**: Added ability to kickstart idle/fresh timers. A minimal request (`maxOutputTokens=1`) is sent to the cheapest model in the pool to start the 5h/7d reset window.
- **Auto-Warmup Toggle**: Global operator toggle to automatically warm up idle pools during the quota polling cycle.
- **Admin Endpoints**: Added `POST /api/kickstart/:email`, `POST /api/kickstart/:email/:modelKey`, and `POST /api/settings/auto-warmup/on|off`.
- **Dashboard UI**: Added "Start Idle Timers" button on account cards when idle pools are detected, and a global "Enable/Disable Auto-Warmup" button in operator controls. Added telemetry cost estimates for `gemini-3.5-flash`.

### Fixed
- Included rolling idle pools (100% quota with a fresh resetTime) as valid kickstart targets.
- Isolated tests from the production config directory (`PI_ROTATOR_DIR=/tmp/pi-rotator-test`) to prevent config corruption during `npm test`.

### Improved
- **Accurate Quota Forecast**: Replaced the simple arithmetic average of pool quota with a weighted calculation based on each account's Tier capacity (Ultra/Pro/Plus/Free). The Dashboard's time remaining and percentage estimates are now mathematically accurate for mixed-tier deployments. (PR [#14](https://github.com/tuxevil/pi-antigravity-rotator/pull/14) by [@josenicomaia](https://github.com/josenicomaia))

## [2.3.0] - 2026-06-22

### Added
- **PostgreSQL Storage Layer**: Optional PostgreSQL persistence support via a clean Repository Pattern (`ISettingsRepository`), enabling deployments without local disk writes. (PR [#13](https://github.com/tuxevil/pi-antigravity-rotator/pull/13) by [@josenicomaia](https://github.com/josenicomaia))
- **Web-based Account Management**: Add, remove, and update accounts and their tier directly from the dashboard UI without manually editing JSON files.
- **Improved Auth Flow**: Added `/login-cli` endpoint to dramatically simplify the OAuth login callback process.

### Changed
- **Token Regeneration**: As part of the refactor to the new storage abstraction, upgrading to this version will automatically regenerate the `PI_ROTATOR_ADMIN_TOKEN` on first boot. The new token will be printed to the console output.


## [2.2.2] - 2026-06-21

### Fixed
- **Telemetry HTTPS Error**: Reverted the default telemetry endpoint from `https://` back to `http://` because the backend server does not support SSL, which was causing silent "packet length too long" errors and preventing telemetry and broadcast notifications from working.

### Refactored
- **Compatibility Layer**: Massively refactored the 2,400-line `src/compat.ts` into smaller, single-responsibility modules under `src/compat/` for easier maintenance. (PR [#11](https://github.com/tuxevil/pi-antigravity-rotator/pull/11) by [@josenicomaia](https://github.com/josenicomaia))

## [2.2.1] - 2026-06-20

### Fixed
- **Support tool response images**: Extracted any image content (`image_url` or `image` formats) from OpenAI tool response content and mapped them to Antigravity `inlineData` parts. (PR [#9](https://github.com/tuxevil/pi-antigravity-rotator/pull/9) by [@josenicomaia](https://github.com/josenicomaia))
- **Ordered tool results**: Guaranteed all tool results remain clustered at the top of the parts array, complying with Claude's strict layout requirements. (PR [#9](https://github.com/tuxevil/pi-antigravity-rotator/pull/9) by [@josenicomaia](https://github.com/josenicomaia))
- **Dangling tool call filtering**: Filtered out any `tool_calls` that do not have a matching `tool_result` in the subsequent message to prevent `400 Bad Request`. (PR [#9](https://github.com/tuxevil/pi-antigravity-rotator/pull/9) by [@josenicomaia](https://github.com/josenicomaia))
- **Inline JSON-Schema union types**: Collapsed Draft-2020-12 inline union type arrays (e.g. `type: ["number", "null"]`) to the first non-null type and lifted nullability into the proto-supported `nullable` flag to fix 400 errors. (PR [#10](https://github.com/tuxevil/pi-antigravity-rotator/pull/10) by [@yashyadav711](https://github.com/yashyadav711))

## [2.2.0] - 2026-06-16

### Security

### Security
- **Admin token autogeneration**: On first run with no `PI_ROTATOR_ADMIN_TOKEN` env var, a cryptographically secure token is generated, persisted to `.admin-token` (mode 0600), and printed once to the operator. Dashboard and `/api/*` routes are now protected by default on fresh installs. Override the generated token by setting `PI_ROTATOR_ADMIN_TOKEN` in the env. `.admin-token` added to `.gitignore`.
- **Querystring secret redaction**: `redactSensitive()` now also redacts `access_token`, `token`, `api_key`, `apikey`, `key`, `refresh_token` when they appear in querystring (`?key=val&...`) or URL fragment.
- **OAuth fallback warning**: New `warnIfUsingFallbackOAuthCreds()` detects when `ANTIGRAVITY_CLIENT_ID` and/or `ANTIGRAVITY_CLIENT_SECRET` are missing and emits a one-time warning that the rotator is using the public Antigravity IDE client.
- **Removed open CORS**: `Access-Control-Allow-Origin: *` removed from `/api/status` and `/api/config`. Replaced with `Cache-Control: no-store`. Dashboard still works same-origin.
- **Truncated/redacted validation logs**: New `logValidationFailure()` truncates payloads to 200 chars and runs them through `redactSensitive` before logging. Applied to OpenAI messages validation and stream error logs in `compat.ts`.

### Added
- **`Config.modelSpecs`**: Operators can now override the per-model thinking/output spec table used by the compat layer without recompiling. Add a `modelSpecs` field to `accounts.json` and call `setModelSpecsOverride()` at boot (done automatically by `index.ts`).
- **`warnIfInsecureTelemetryEndpoint()`**: Detects plain `http://` telemetry endpoints and emits a one-time warning. Default endpoint switched to `https://`. Override via `PI_ROTATOR_TELEMETRY_URL`. Silence via `PI_ROTATOR_TELEMETRY_INSECURE_OK=1`.
- **Persistent `responsesStore`**: The OpenAI Responses API store (used by Codex via `previous_response_id`) is now persisted to `<configDir>/responses.json` with atomic writes and a 1.5s debounce. Restart-safe: in-flight Codex conversations continue across rotator restarts. New `src/responses-store.ts` with `load()`, `flush()`, `flushSync()`. Corrupt files are moved aside to `.corrupt-<ts>.bak` on startup.
- **Debounced state writes**: Hot paths (`recordRequest`, `markExhausted`, `markError`, `markFlagged`) now call `scheduleStateSave()` instead of `saveState()`, coalescing multiple writes within a 1s window into a single disk write. New `flushPendingStateSaveSync()` in the SIGTERM/SIGINT shutdown handler drains the queue synchronously to minimise data loss.
- **GitHub Actions CI**: New `.github/workflows/ci.yml` runs `npm ci` + `npm run check` (typecheck + 191 tests) on push and PR to `main`. Node 22 with npm cache. PRs without green checks cannot be merged.
- **8 e2e proxy tests** (`test/proxy-e2e.test.ts`): Cover the full proxy flow with a local HTTP server as mock Antigravity — 200 happy path, 429 rate-limited (Retry-After and RESOURCE_EXHAUSTED), 401 unauthorized, 403 flagged and non-flagged, 500 server error, endpoint cascade (daily→prod).
- **7 dashboard tests** (`test/dashboard.test.ts`): Verify utf-8/viewport meta tags, all 12 admin API endpoints are referenced, the `escapeHtml`/`jsString`/`maskText`/`maskEmail` helpers are present and `escapeHtml` correctly escapes the 5 HTML-sensitive characters, no hardcoded OAuth secrets or refresh tokens leak into the HTML.

### Changed
- **Refactored `proxy.ts`**: Extracted `classifyUpstreamResponse()` that returns a discriminated `UpstreamAction`. Both `withRotation()` and `handleProxyRequest()` dispatch against the helper instead of duplicating the 401/403/404/400/429/5xx branches. ~150 lines of parallel code removed. New `UpstreamAction` type with 9 action kinds.

### Cleanup
- **Removed `src/antigravity-prompt.ts`**: 80-line `ANTIGRAVITY_IDENTITY_PROMPT` export with 0 references in the repo.
- **Consolidated agent docs**: `CLAUDE.md` now points to `AGENTS.md` as the single source of truth. The duplicated BEADS INTEGRATION block is gone.
- **Moved scripts to `scripts/`**: 10 one-off utility scripts (`mitm.js`, `mock_google.js`, `query_models.{js,ts}`, `test-compat.ts`, `test-direct.js`, `test_generate.js`, `test_loop.js`, `test-http.cjs`, `test-openai.cjs`) moved from the repo root. `query_models.ts` and `test-compat.ts` updated to use `../src/...` relative imports after the move.

## [2.2.1] - 2026-06-16

### Fixed
- **SSE usage extraction cross-event matching**: The old `extractTokenUsage()` ran a regex on the last 32KB of the upstream body, which could match across SSE event boundaries and return incorrect `(input, output)` pairs. Replaced with `SseEventAccumulator` + `extractUsageFromSseEvent()` that buffer complete SSE events (split on `\n\n`), parse each `data:` payload as JSON, and recursively search for `usageMetadata` (Gemini) or `usage` (OpenAI/Anthropic). Regex remains as a last-resort fallback for malformed JSON. Real-time streaming is preserved — the `res.write(chunk)` in `onData` is unchanged. Resolves ROADMAP §2.

## [2.1.6] - 2026-06-12

### Fixed
- **Streaming tool calls finish reason**: Fixed an issue where `streamCompatSse` emitted `finish_reason: "stop"` instead of `"tool_calls"` when function calls were streamed to the client via OpenAI compatibility layer. This resolves compatibility issues with clients like ZED editor that discard pending tool executions as canceled when receiving "stop".

## [2.1.5] - 2026-05-27

### Fixed
- **Claude tool_use/tool_result ordering via Responses API**: Resolved a persistent `400 INVALID_ARGUMENT` (`messages.1: tool_use ids were found without tool_result blocks immediately after`) error when using Claude models (e.g. `claude-sonnet-4-6`) through the OpenAI Responses API (used by Codex and similar agents). Three structural issues were corrected in the Gemini content turn builder:
  - **Parallel function_call merging**: Codex sends parallel tool calls as separate `function_call` input items. Each was creating its own assistant turn, but Claude requires all `tool_use` blocks in a single assistant message. Consecutive `function_call` items are now merged into one assistant message with multiple `tool_calls`.
  - **Text/tool_call separation**: Codex sends the assistant's narration text (`"Let me explore..."`) and its `function_call` items as separate input items. The narration was creating a `model` Gemini turn between the `functionCall` turn and the `functionResponse` turn, breaking Claude's strict ordering. Text-only model turns that follow a `functionCall` model turn are now suppressed.
  - **Consecutive tool result merging**: Multiple `functionResponse` parts are now merged into a single `user` Gemini turn, ensuring all `tool_result` blocks appear in one message directly after the `tool_use` assistant message.


## [2.1.4] - 2026-05-27

### Improved
- **Less Lossy Schema Collapsing for Claude**: The `sanitizeClaudeViaGeminiSchema` function now handles complex `anyOf`/`oneOf`/`allOf` schemas with significantly less information loss:
  - **Nullable detection (lossless)**: `anyOf: [{type: X}, {type: "null"}]` patterns are now converted to `{type: X, nullable: true}` instead of losing the null variant.
  - **`allOf` deep merge (lossless)**: `allOf` variants are now deep-merged (properties union + required union) instead of picking only the first variant.
  - **`anyOf`/`oneOf` object merge**: When all variants are objects, properties are merged into a union and only fields required in ALL variants remain required, preserving wider input acceptance.
  - The first-variant fallback is still used for truly incompatible mixed-type unions.

### Fixed
- **README: Incorrect model names in Codex section**: Removed references to nonexistent `claude-3-5-sonnet` and `gemini-3-pro` models, replaced with actual supported models (`claude-opus-4-6-thinking`, `gemini-3.1-pro`, `gpt-oss-120b`, etc.).

### Added
- **Schema sanitizer tests**: Added test cases for nullable detection, `allOf` deep merge, and `anyOf` object variant merging.

## [2.1.3] - 2026-05-27

### Fixed
- **Anthropic Tool Use Content Blocks**: Anthropic `tool_use` and `tool_result` content blocks in message history are now correctly converted to Gemini `functionCall` / `functionResponse` parts when proxying through the Anthropic-compatible `/v1/messages` adapter, preventing `400 INVALID_ARGUMENT` errors on multi-turn tool conversations. (PR [#7](https://github.com/tuxevil/pi-antigravity-rotator/pull/7) by [@javargasm](https://github.com/javargasm))
- **Anthropic Tool Forwarding**: `tools` and `tool_choice` from Anthropic `/v1/messages` requests are now properly forwarded to the Gemini upstream, enabling full Anthropic-native tool calling through the rotator.
- **Anthropic Tool Response Streaming**: Streaming and non-streaming Anthropic responses now correctly emit `tool_use` content blocks and set `stop_reason: "tool_use"` when function calls are present.
- **JSON Schema `anyOf`/`oneOf`/`allOf` Collapse**: The Claude schema sanitizer now collapses composite schema keywords (`anyOf`, `oneOf`, `allOf`) to their first variant before forwarding to Gemini, preventing schema corruption during the Gemini proto round-trip.

### Added
- **Anthropic Tool Conversion Tests**: Added dedicated test cases for Anthropic tool conversions and JSON schema type collapsing in the compat test suite. ([@javargasm](https://github.com/javargasm))

## [2.1.2] - 2026-05-25

### Added
- **Developer Role Support**: Added comprehensive compatibility and validation support for the newer `"developer"` role (introduced by OpenAI to replace the system prompt on models like o1/gpt-4o).
- **Developer Message Routing**: Automatically routes messages with the `"developer"` role as system instructions upstream in the Antigravity request mapping.
- **Improved Adapter Coverage**: Extended type validation and integration testing in the compat adapters to fully cover the new schema additions.

## [2.1.1] - 2026-05-21

### Added
- **Discord Server Integration**: Added direct links and a styled interactive badge to the official project Discord server for community coordination.
- **Account Quota Donations UI**: Integrated a detailed step-by-step guide directly inside the dashboard's "Support the Creator" modal on how to safely donate a secondary Google account quota, along with a one-click guide link to the README.
- **README Guide on Quota Donations**: Added comprehensive instructions in the README on how to extract and securely share secondary/throwaway account credentials, including clear steps on how to revoke access at any time from Google settings.

## [2.1.0] - 2026-05-21

### Added
- **Codex Agent Integration Support**: Out-of-the-box support for connecting agentic frameworks like Codex (executing in VS Code or CLI) by routing OpenAI Responses API payloads and enabling native reasoning streaming, function-calling translation, and strict contract validation.
- **OpenAI Responses API Compatibility**: Full compatibility with the OpenAI Responses endpoint family (`POST /v1/responses`, `GET /v1/responses/<id>`, `DELETE /v1/responses/<id>`, `POST /v1/responses/<id>/cancel`, and `GET /v1/responses/<id>/input_items`). Includes full support for structured inputs, in-memory conversation/responses storage, and native tool-calling/reasoning visibility, tailored for advanced agentic frameworks.
- **Hybrid Routing Policy**: Added optional `routingPolicy: "hybrid"` with weighted selection across timer priority, quota, tier, health, local token bucket state, and distance.
- **Routing Inspector**: Added a dashboard modal that explains the currently selected route, candidate scores, and why each account was excluded for a model.
- **Rate Limit Parser Module**: Extracted robust retry parsing into `src/rate-limit-parser.ts` with support for `Retry-After`, `x-ratelimit-reset`, `quotaResetDelay`, `quotaResetTimeStamp`, `retryDelay`, and duration strings.

### Changed
- **Token Bucket Guardrail**: Added optional per-account token buckets to slow repeated reuse of the same account without changing the default v2.0 routing behavior.
- **Attention Needed Coverage**: The dashboard now surfaces unroutable models and token-bucket exhaustion alongside existing security, cooldown, disabled, flagged, and error alerts.
- **Compat Hardening**: Added coverage for `cache_control` stripping, schema forwarding, missing-signature tool history, and empty SSE parsing.

## [2.0.0] - 2026-05-20

### Added
- **Admin Config APIs**: Added `GET /api/config`, `PUT /api/config`, `GET /api/config/export`, and `POST /api/config/import` for validated runtime config management.
- **Dashboard Config Editor**: Added an embedded JSON editor with load/save/import/export controls and hosted login access.
- **Docker Deployment**: Added `Dockerfile`, `docker-compose.yml`, and `.dockerignore` for headless deployments with persistent `/data`.
- **Doctor Command**: Added `pi-antigravity-rotator doctor` to validate config, inspect backups, and report missing admin auth.
- **Gemini-Compatible Discovery**: Added `/v1beta/models` and a minimal Gemini-style `generateContent` route family.

### Changed
- **Version 2.0**: Bumped package version to `2.0.0` on branch `v2.0`.
- **Persistence Hardening**: Config, state, and token usage now write atomically with timestamped backups.
- **Routing Metadata**: Added optional account `tier` plus runtime `healthScore` as timer-first tie-breakers.
- **Security Visibility**: Startup logs, `/api/status`, and the dashboard now warn when `PI_ROTATOR_ADMIN_TOKEN` is missing.

### Migration
- Existing `accounts.json` stays compatible. New defaults are `bindHost: "0.0.0.0"`, `routingPolicy: "timer-first"`, and `accounts[].tier: "unknown"`.

## [1.14.0] - 2026-05-19

### Added
- **Gemini 3.5 Flash Support**: Added routing and dashboard support for the new `gemini-3.5-flash` model family (including `gemini-3.5-flash-low` / `gemini-3.5-flash-medium` and `gemini-3-flash-agent` / `gemini-3.5-flash-high`).
- **GPT-OSS 120B Support**: Added complete support (pricing, styling, and dashboard visualization) for the `gpt-oss-120b-medium` model, mapping its quota tracking to the shared Claude pool (`claude-opus-4-6-thinking`).
- **Model Role Support**: Added support for the `"model"` role in compatibility layer chat completions, validating and mapping it to native Gemini model turns.
- **Request Normalization**: Added normalization helpers (`normalizeOpenAIChatCompletionRequest` / `normalizeAnthropicMessagesRequest`) to automatically format loose inputs, Responses-style inputs (e.g., `input`, `prompt`), and raw native Antigravity request payloads into standard OpenAI/Anthropic messages format.

## [1.13.0] - 2026-05-19

### Removed
- **Pro Family Features**: Completely removed legacy Pro Family sharing infrastructure (Advisor recommendations, dual-window tracking, and associated UI elements) to simplify architecture for unified quota pools.

### Added
- **Quota Reset Countdown**: Added a new column to the Quota Forecast dashboard component that displays the exact time remaining until the next quota reset.
- **Token Usage Metrics Output**: The proxy now correctly captures and forwards precise input/output token counts from the upstream API back to the client, fully enabling usage statistics reporting in compatible adapters.

## [1.12.4] - 2026-05-18

### Added
- **Claude `cache_control` stripping**: Anthropic requests often include `cache_control` objects which Google Cloud Code Assist API rejects with "Extra inputs are not permitted". The proxy now safely strips `cache_control` from all system and message content blocks before forwarding them to Gemini.
- **Claude `VALIDATED` Function Calling**: Automatically enforces `toolConfig: { functionCallingConfig: { mode: "VALIDATED" } }` for Claude models when tools are present, ensuring stricter schema adherence.
- **Adaptive Thinking Budgets**: Replaced static thinking budget values with a dynamic `MODEL_SPECS` mapping. `gemini-3-flash` now correctly uses adaptive thinking budgets (`-1`) which allows the model to decide its own optimal reasoning length, while Pro models use strict budgets (e.g. `10001` for high).
- **Max Output Tokens Enforcement**: The proxy now enforces hard `maxOutputTokens` caps based on the specific model's upper limits (e.g. `65535` vs `64000`), dynamically adjusting them to ensure there is enough room for both the thinking budget and the final output response without triggering upstream validation errors.

## [1.12.3] - 2026-05-18

### Fixed
- **Gemini 3.1 Pro High Deprecation (`400 Invalid Argument`)**: Google Cloud Code Assist deprecated the internal string `"gemini-3.1-pro-high"` and replaced it with `"gemini-pro-agent"`. The proxy now automatically maps `"gemini-3.1-pro-high"` to `"gemini-pro-agent"` under the hood when constructing the upstream payload, preventing `400` validation errors while allowing clients to continue using the `-high` alias.
- **Missing `thought_signature` on Tool Calls (`400 Invalid Argument`)**: Gemini thinking models strictly require a cryptographic Base64 `thought_signature` for all `functionCall` history parts, which the proxy normally caches in RAM. To prevent API rejection on cache misses (e.g. after a proxy restart or when using synthetic tool IDs), the proxy now gracefully collapses the orphaned tool exchange into a neutral user summary (`[Context: The assistant used tools...]`). This preserves the conversation context without triggering the `400` error or teaching the model bad tool-calling formats.

## [1.12.2] - 2026-05-18

### Fixed
- **Gemini Flash/Pro regression (`INVALID_ARGUMENT`)**: The `id` field added to `functionCall` and `functionResponse` history parts for Claude multi-turn support was also being sent to Gemini native models, which reject it. The field is now only included when the model is Claude (`/^claude-/i`).

## [1.12.1] - 2026-05-18

### Fixed
- **Claude tool schema compatibility (JSON Schema Draft 2020-12)**: When routing requests to Claude models (`claude-sonnet-4-6`, `claude-opus-4-6-thinking`) through Gemini's API, a new `sanitizeClaudeViaGeminiSchema` function is used instead of the Gemini-native sanitizer. It only removes fields that Gemini's outer API layer rejects (e.g. `$ref`, `$defs`, `if/then/else`) and converts `const` → `enum`, while preserving valid Draft 2020-12 keywords (`minimum`, `maximum`, `pattern`, `minLength`, `title`, `default`, etc.) that Claude requires.
- **Claude `anyOf [{type,const}]` → flat `enum` collapse**: Schemas with `anyOf` items of the form `[{"type":"string","const":"fact"},{"type":"string","const":"lesson"}]` are now correctly collapsed into `{"type":"string","enum":["fact","lesson"]}`. Previously this produced a redundant `anyOf` with single-element enums that Claude rejected as invalid.
- **Claude multi-turn tool call IDs (`tool_use.id: Field required`)**: When replaying tool-call history for Claude models, the OpenAI tool call `id` (e.g. `call_xxx`) is now included in the Gemini `functionCall.id` field, and the `tool_call_id` from tool response messages is included in the Gemini `functionResponse.id` field. Gemini passes these through to Claude as `tool_use.id` / `tool_use_id`, fixing the "Field required" error on multi-turn agentic conversations.

## [1.12.0] - 2026-05-17


### Added
- **Native Reasoning/Thinking Support**: Interleaved thinking blocks from Gemini 3.1 Pro, Gemini 3 Flash, and Claude models are now properly exposed to OpenAI and Anthropic compatible clients as `reasoning_content` and `thinking_delta` chunks.
- **Model & Project Circuit Breaker Reset**: Added manual reset buttons on the dashboard for all circuit breakers, allowing operators to bypass the cooldown period when desired.
- **Circuit Breaker Visibility**: Added model-level and project-level circuit breaker state (active flags and remaining cooldowns) to the `/api/status` endpoint and the dashboard.

### Fixed
- **Gemini 3 Thinking Levels**: Fixed an issue where Gemini 3 models failed to return reasoning blocks without a defined `reasoning_effort` flag by automatically inferring the necessary `thinkingLevel` from the model alias (`-high` or `-low`).

## [1.11.0] - 2026-05-17

### Added
- **Universal Agent Support (Pi, Hermes, OpenWebUI, etc.) via OpenAI-compatible provider**: This package is no longer exclusive to the Pi agent. With full tool calling support now implemented, the rotator can be seamlessly consumed by *any* agent using an OpenAI-compatible provider profile. Point the provider base URL to `http://localhost:51200/v1/` and set any non-empty string as the API key. All Antigravity models (`gemini-3-flash`, `gemini-3.1-pro-low`, `gemini-3.1-pro-high`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`) are available through `GET /v1/models`.
- **Full tool/function calling support for compatibility adapters**: Safely maps standard OpenAI function definitions into Gemini's format, allowing agents to fully utilize tools.
- **XML-based tool call parsing**: Processes XML `<model_context>` artifacts from Gemini responses and formats them as standard OpenAI tool calls.
- **`userAgent: "antigravity"` in request body**: Added the required `userAgent` field to all forwarded payloads so the Antigravity endpoint treats them as first-party agent traffic.

### Fixed
- **Gemini schema sanitization**: Converts `anyOf` with `const` patterns in JSON schemas into Gemini-compatible `enum` arrays. Excludes `exclusiveMinimum` and `exclusiveMaximum` keywords to prevent Gemini 400 Bad Request errors.
- **Multi-turn tool call artifacts**: In multi-turn chat history, previous tool calls and results are now flattened to text to prevent 400 Bad Request rejection from Gemini.
- **Daily endpoint prioritization**: Added `daily-cloudcode-pa.googleapis.com` as the primary endpoint with `cloudcode-pa.googleapis.com` as fallback. The daily endpoint accepts Antigravity payloads without rate-limiting them as RESOURCE_EXHAUSTED — matching CLIProxyAPI's approach from the same fix.
- **`modelBreakers` not exposed in `/api/status`**: Model-level circuit breakers were persisted inside the `safety` sub-object of `state.json` but not surfaced in the API status response, making them invisible to operators when debugging "All accounts disabled" errors.

## [1.10.1] - 2026-04-30

### Fixed
- **Telemetry Flag Validation**: The telemetry receiver now validates `flag` payloads separately from heartbeat payloads, so `quota API 403` flags are written to `YYYY-MM-DD-flags.jsonl` and counted in the dashboard.
- **Flag Analysis Clarity**: Dashboard flag stats now show both raw `Flag Events` and deduped `Unique Flag Incidents`.

## [1.10.0] - 2026-04-30

### Added
- **OpenAI-compatible adapter**: Added `GET /v1/models` and non-streaming/compat-streaming `POST /v1/chat/completions` so OpenAI-style clients can use the rotator.
- **Anthropic-compatible adapter**: Added non-streaming/compat-streaming `POST /v1/messages` so Anthropic-style clients can use the rotator.
- **Image input for adapters**: Added base64 image support for OpenAI data URLs and Anthropic base64 image sources.
- **Model-wide 429 circuit breaker**: If multiple unique accounts hit provider `429` for the same quota model in a short window, routing for that model pauses globally to avoid burning the pool.
- **Local request-safety notes**: Added ignored local docs under `docs/request-safety/` for incident analysis and agent retry policy.

### Changed
- **Retry semantics for exhausted capacity**: Temporary no-capacity states now return `429` with `Retry-After`/`retryAfterMs`; terminal no-capacity states return `503` with `retryable:false`.
- **Quota polling policy**: Quota API `401/403` still flags the affected account, but no longer triggers global protective pause. Polling remains diagnostic so operators can see blast radius.
- **429 containment**: Provider `429` responses stop the current request and feed circuit breakers instead of exposing more accounts to retry storms.
- **Dashboard status header**: Dashboard now shows the running rotator version in the header.

### Fixed
- **Quota poll cascade visibility**: Quota polling can now continue discovering account state instead of being blocked by nuclear pause.
- **Client retry storm risk**: Rotator responses now provide explicit retry timing to downstream agents so they can back off instead of retrying rapidly.

### Limitations
- Compatibility adapter streaming currently buffers the upstream Antigravity stream and emits a final SSE delta; token-by-token passthrough is not implemented yet.
- Tool/function calling through compatibility adapters is explicitly rejected with `400` until a safe mapper is implemented.

## [1.9.3] - 2026-04-29

### Added
- **Admin Broadcast Notifications**: The dashboard now supports operator-controlled broadcast notifications. A new `notification-poller` checks the telemetry server every 30 minutes for active announcements, allowing operators to push critical alerts (like required re-enrollments or bug notices) to all connected clients.
- **Admin Notification UI**: The telemetry receiver now includes a full dashboard at `/notifications` to create, edit, delete, and preview broadcast messages with version-targeting capabilities.

### Changed
- **Telemetry Heartbeat**: Reduced the telemetry heartbeat interval from 6 hours to 1 hour for more timely metrics reporting.

## [1.9.2] - 2026-04-29

### Fixed
- **Project Discovery Without Shared Fallback**: Login now fails if Google does not return a companion project ID. No more shared `rising-fact-p41fc` fallback.
- **Activation Hint**: Login/discovery errors now tell you to open the account in Antigravity IDE and send one message first.
- **Activation Docs**: README now documents the first-use activation rule for new accounts.

## [1.9.1] - 2026-04-29

### Fixed
- **429 Account-Safety Backoff**: All provider-side `429` responses now stop the current request instead of immediately retrying another account. This prevents cascade-burning the full pool when Google rate-limits a shared project/request bucket. `RESOURCE_EXHAUSTED` gets a 30-minute cooldown; other 429s use parsed `Retry-After`/retry-delay.
- **Stream Idle Crash Safety**: Stream idle timeout now closes cleanly without emitting an unhandled stream error that could crash-loop systemd.

### Added
- **Project Circuit Breaker**: If multiple accounts sharing a `projectId` hit provider `429` for the same quota model inside a rolling window, routing pauses that `projectId`/model instead of burning sibling accounts.
- **Daily Safety Budgets**: Per-account and per-`projectId` daily upstream attempt counters now trigger slow-mode jitter and hard stops until the next UTC day.
- **Project Concurrency Guard**: Added `maxConcurrentRequestsPerProjectModel` to prevent simultaneous calls through multiple accounts backed by the same provider project bucket.
- **Large Context Warning**: Requests above 1 MiB now log a warning because huge contexts increase rate-limit and flag pressure.

## [1.9.0] - 2026-04-29

### Added
- **Version Check & Auto-Update**: The dashboard now checks the npm registry every 30 minutes for new releases. When a newer version is available, a gradient banner appears at the top with the current and latest version, a link to the GitHub changelog, and a one-click "Update Now" button. The update runs `npm install -g pi-antigravity-rotator@latest` (auto-detects global vs local installs). After updating, a green "Restart required" notice is shown. The banner can be dismissed per-version (stored in `localStorage`). Version checks fail silently when offline.
- **Self-Update API**: New `POST /api/self-update` endpoint (admin-only) that triggers the npm update from the dashboard.

## [1.8.6] - 2026-04-29

### Fixed
- **4h/8h/12h/1d charts empty for non-UTC timezones**: `mergeBucketsBy` normalized bucket periods to local time, then `padBuckets` re-applied `getLocalKey` treating those local-time strings as UTC — double-converting them and shifting all data outside the visible window. Fixed by passing the same `keyFn` to both `mergeBucketsBy` and `padBuckets`, so the fill loop uses the exact same key format as the data map.

## [1.8.5] - 2026-04-29

### Fixed
- **4h / 8h / 12h views empty**: These views only pulled from `minutes` buckets. Minutes older than ~2h are rolled into `hours` and removed, leaving those views blank. Fixed by including `hours` as a data source alongside `minutes` for all sub-day views.

## [1.8.4] - 2026-04-29

### Changed
- **Dashboard Savings by View**: The "Savings: $X" figure in the token usage chart now reflects only the visible time window (1h / 2h / 4h / 8h / 12h / 1d / 7d / 1m) instead of all-time totals. Per-model savings in the legend also update accordingly. Pricing table (`MODEL_PRICING_CLIENT`) is kept in sync with the server-side `MODEL_PRICING` in `types.ts`.

## [1.8.3] - 2026-04-29

### Fixed
- **Token Usage Deduplication (Critical)**: `getTokenUsage()` now correctly excludes minute buckets that have already been rolled up into hour buckets, and hour buckets rolled into day buckets, etc. Previously the hierarchical rollup structure caused all-time totals to be correct only in edge cases. Fixed by filtering each bucket level against the next level up before summing. Exposed `tokensByModel` directly on `TokenUsageData` for clean access in telemetry payload.

## [1.8.2] - 2026-04-29

### Fixed
- **Token Usage Overcounting**: `getTokenUsage()` was summing `minutes + hours + days + months` buckets, which are hierarchical rollups of the same data — causing every token to be counted ~4×. Now reads only the raw `minutes` buckets (source of truth). Telemetry payload corrected accordingly. Historical JSONL data on the receiver was inflated; divide by ~4 for real estimates.
- **Telemetry Dashboard Filters**: Added server-side filtering to `/v1/stats` by `installId`, `version`, `os`, `model`, `from`, `to` query params.
- **Telemetry Web Dashboard**: Added interactive filter bar with auto-populated dropdowns for all filter dimensions. Active filter indicator shows current scope. Auto-refresh respects active filters.
- **Telemetry Endpoint**: Updated to `http://telemetry.dragont.ec:3800/v1/events` (port explicit until reverse proxy is configured).

## [1.8.0] - 2026-04-29

### Added
- **Anonymous Telemetry**: Opt-out telemetry to help understand real-world usage and, crucially, to improve the anti-flag algorithm that protects your accounts. Collects pool metrics, error patterns, and flag triggers without capturing any PII or emails.
- **Telemetry Receiver**: Included a standalone Node.js server (`tools/telemetry-receiver/`) for deploying your own instance to collect telemetry securely via JSONL files.
- **Server-Side Savings Calculation**: The receiver now computes estimated USD savings directly from raw per-model token usage reports, ensuring pricing updates don't require client updates.
- **Star Reminder**: A one-time, non-intrusive terminal prompt shown after 24 hours of successful use, encouraging a GitHub star.

## [1.7.0] - 2026-04-29

### Security
- **API Protection**: Added `PI_ROTATOR_ADMIN_TOKEN` environment variable to optionally secure the web dashboard and `/api/*` endpoints. If not set, it retains local open access.
- **Payload Limits**: Added `PI_ROTATOR_MAX_BODY_BYTES` to protect the proxy from memory exhaustion via oversized payloads (defaults to 25 MiB).
- **Dashboard Hardening**: Implemented strict HTML escaping across all dynamic fields in the dashboard to prevent XSS.
- **Log Redaction**: Centralized logging now automatically redacts sensitive tokens (Bearer, OAuth, refresh/access tokens) before outputting to the console.

### Added
- **Automated Checks**: Integrated a test suite (`node:test`) and typechecking (`tsc --noEmit`) to prevent regressions. Added `npm run check`.
- **Config Validation**: Runtime validation for the initial config load and proxy request bodies.
- **Resilience**: Added automated retries with exponential backoff for non-streaming internal requests (Quota, OAuth, Token Refresh).

### Changed
- **Telemetry UI**: Refreshed the token usage chart colors to function as a visual "price heat map" (Opus in Red, Pro High in Blue, Pro Low in Light Blue, etc.).
- **Logging**: Added `PI_ROTATOR_LOG_LEVEL` (debug, info, warn, error, silent) for fine-grained logging control.

## [1.6.0] - 2026-04-29

### Added
- **Dual-Window Tracking**: Advanced tracking for both Free and Pro quota windows simultaneously.

## [1.5.0] - 2026-04-28

### Added
- **Pro Family Advisor**: A new smart assistant in the dashboard that scans your account pool and alerts you if there are routing imbalances or underutilized accounts, giving actionable steps to fix them.
- **Advanced Telemetry & Statistics**:
  - Estimated API Savings ($USD) to track how much money the tool saves you.
  - Latency tracking (p50/p95) per model to detect degraded accounts.
  - Quota Forecast grid predicting when each model will exhaust its quota based on current burn rate.
  - Searchable Request Log directly in the dashboard.
  - 60-day historical usage Heatmap.
  - Data export to CSV and JSON formats.
- **Creator Support**: Added a Ko-fi donation modal and header button to support the maintainer.

## [1.4.24] - 2026-04-28

## [1.4.21] - 2026-04-28

### Changed
- **Dual-Window Architecture**: Completely rewrote the dual-window tracker to use immutable, permanent anchors. Anchors are never deleted, only refreshed when their physical date expires.
- **Dual-Window Logic**: A timer is classified strictly by matching its reset date against the permanent Pro or Free anchors. New anchors are assigned to Pro ONLY if a genuine 5h timer is present, otherwise they default to Free.
- **Manual Anchor Override**: Added a UI button in the dashboard to manually swap Pro and Free anchors for a model, giving users absolute control to correct the state if Google's API behavior causes a misclassification.

## [1.4.11] - 2026-04-28

### Fixed
- **Dual-Window Recharging Logic**: The dashboard now correctly distinguishes between expired 5h timers (which grant +40% quota) and expired 7d timers (which grant 100% quota) when visually projecting available capacity.

## [1.4.10] - 2026-04-28

### Changed
- **Dual-Window Display**: The dashboard now automatically assumes 100% quota and displays "ready" in green for dual-window timers whose reset dates have already passed, eliminating the need to manually compute past reset timestamps.

## [1.4.8] - 2026-04-28

### Fixed
- **Dual-Window Cross Contamination**: Fixed an edge case where switching an account back to Free tier would mistakenly classify its new Free 7d timer as a Pro 7d cooldown due to a loose time tolerance and overly aggressive cross-model correlation.
- Reduced dual-window reset time matching tolerance from 1 hour to 5 minutes to prevent identical fallback timer assignments.

## [1.4.7] - 2026-04-28

### Added
- **Dual-Window Dashboard UI**: Added a dedicated visual section to each account card in the dashboard showing the exact Pro vs Free quota and reset timers side-by-side.

## [1.4.6] - 2026-04-28

### Added
- **Dual-Window Quota Tracking**: Pro Family Advisor now simultaneously tracks both Free and Pro quota windows for the same account. It correctly identifies whether a 7-day timer is a Free tier reset or a Pro tier cooldown by correlating reset times.
- **Cross-Model Pro Correlation**: If any model on an account shows a 5h (Pro) timer, the rotator now intelligently infers that all other models on that account are also currently Pro, even if they are in their 7d cooldown phase.

## [1.4.5] - 2026-04-28

### Added
- **Extended Token Views**: Added `2h`, `4h`, `8h`, and `12h` options to the Token Usage chart. The backend now retains up to 12 hours of minute-level resolution for accurate high-fidelity zooming.

### Changed
- **Activity Heatmap Scaling**: Expanded the heatmap to cover the last 60 days. The grid is now responsive, taking up the full width of the screen without distorting cell proportions, and the Y-axis now orders hours naturally from 00 to 23.
- **Timezone Alignment**: X-axis labels on the Token Usage chart and the Heatmap now correctly reflect the browser's local time instead of UTC.

## [1.4.1] - 2026-04-28

### Added
- **Export Data**: Added `CSV` and `JSON` export buttons to the Token Usage panel on the dashboard to easily download token metrics for external reporting.

## [1.4.0] - 2026-04-28

### Added
- **Savings Estimation**: Dashboard now calculates and displays estimated USD savings based on tracked token usage compared to paid API pricing.
- **Latency Tracking**: Proxy measures Time-to-First-Byte (TTFB) and Total duration per request. Dashboard displays p50/p95 latency stats by model.
- **Quota Forecast**: Dashboard predicts when each model's quota will run out based on real-time requests/hour burn rate.
- **Live Dashboard (SSE)**: Dashboard now updates in real-time via Server-Sent Events, removing the need for polling or manual refreshes.
- **Live Request Log**: Searchable, real-time mini-log in the dashboard showing the last 200 requests (Account, Model, Status, TTFB, Total duration, Tokens).
- **Activity Heatmap**: GitHub-style contribution grid displaying request intensity per hour across the last 7 days.
- **Enhanced Logging**: Added explicit `START` and `END` proxy logs with unique request IDs for unambiguous tracing of 503s and 429s.

### Changed
- Configurable **Antigravity Version**: Extracted hardcoded `QUOTA_USER_AGENT` into an environment variable to prevent "This version of Antigravity is no longer supported" API errors. Now uses `1.107.0` by default.
- Per-model cooldown granularity: Accounts can now serve fallback models (e.g. Gemini) even if their primary model (e.g. Claude) is exhausted.
- **Token Tracking Architecture**: Refactored token usage into a tiered time-series (minutes/hours/days/months) with rolling sliding windows to avoid data drops at calendar boundaries.

### Fixed
- Fixed in-flight request leak where accounts could get stuck in a "busy" state indefinitely due to deprecated `req.aborted` handlers in Node 24.
- Fixed rate-limit logic bypassing model-specific cooldown checks after a 429 was hit.


## [1.3.9] - 2026-04-27

### Fixed
- Fixed `ERR_MODULE_NOT_FOUND` crash on `pi-antigravity-rotator login` (and all other CLI commands) when installed globally via npm or Volta. The binary entry point was resolving `src/cli.ts` relative to `bin/` instead of the package root, causing Node to look for `bin/src/cli.ts` which does not exist in any install layout. Changed import path from `./src/cli.ts` to `../src/cli.ts`.

## [1.3.8] - 2026-04-26

### Fixed
- Persist per-model request-count rotation counters across restarts so configured request thresholds continue to work after service reloads.
- Keep serving from the current healthy account when request-count rotation reaches its threshold but no replacement account is available, avoiding unnecessary `503` responses while usable quota remains.

## [1.3.7] - 2026-04-25

### Fixed
- Release in-flight account reservations when a streaming response closes early, the client disconnects, or the upstream stream goes idle, preventing accounts from getting stuck as busy indefinitely.

## [1.3.6] - 2026-04-24

### Fixed
- Treat Node `fetch failed` transport errors as transient upstream/network failures instead of account health errors, avoiding false account disables during stalled requests.

## [1.3.5] - 2026-04-24

### Fixed
- Make request-count rotation deterministic by counting per-model account assignments before the next request is forwarded, instead of rotating only after a successful response completes.

## [1.3.4] - 2026-04-24

### Fixed
- Rotate fairly among accounts that tie on model timer priority and remaining quota instead of repeatedly selecting the first matching candidate.

## [1.3.3] - 2026-04-23

### Added
- Hosted Antigravity login flow so operators can complete Google account linking from a browser and feed the callback URL back into the rotator workflow.
- Global fresh-window operator control plus per-account override so dormant quota windows can be blocked pool-wide and selectively re-enabled account by account.
- Header modal launchers for Attention Needed and Pro Family Advisor to keep operator actions available without taking permanent dashboard space.

### Changed
- Reworked the dashboard layout to prioritize the account grid above the fold: request totals moved into the header, bulky summary widgets were removed, and Recent Events now sits at the bottom.
- Simplified the header by moving the PII visibility toggle next to the title and removing the inline model-routing pills.
- Tightened the routing health strip with denser pills, single-line counters, and clearer spacing between major dashboard sections.

## [1.3.2] - 2026-04-23

### Added
- Routing health panel in the dashboard with current state, stop reason, retry window, and pool blocker counts.
- Attention Needed summary panel for flagged, cooling, disabled, and error accounts.
- Recent Events feed showing the latest rotator and proxy incidents that led to the current state.
- In-memory event buffer exposed through the status API for dashboard diagnostics.
- Conservative concurrency guardrail to cap each account to one in-flight request by default.
- Protective pause after serious provider ToS/abuse-style flags to stop the rest of the pool from being burned.

### Changed
- Dashboard now focuses on operator visibility so the service can be monitored without relying on `journalctl`.
- Request-count rotation is now only used when quota data is still unknown, reducing unnecessary account churn.
- Flagged accounts remain quarantined until the provider explicitly restores access.

### Fixed
- Fixed the exhausted fallback path so cooled-down accounts are no longer selected again when all accounts are exhausted.
- Fixed proxy retry behavior so it returns `503` immediately when no healthy replacement account exists instead of continuing to hammer the pool.
- Fixed quota polling so flagged accounts are no longer re-polled every cycle after a provider `403`.
- Fixed bursty same-account pressure by reserving accounts during selection and request handling.

## [1.3.1] - 2026-04-22

### Changed
- Prioritize Pro 5h accounts in rotation. Accounts with active 5h timers are now drained first to maximize the +40% recharge benefit when the timer expires. Previously they were saved for last, wasting quota.

## [1.3.0] - 2026-04-22

### Added
- Pro Family Sharing Advisor: dashboard panel suggests when to add/remove accounts from Pro family sharing.
- Pro/Free/Family Manager badges on account cards (auto-detected from 5h/7d timer type).
- `familyManager` config flag for the account that owns the family plan.
- `proSlots` config option for max simultaneous Pro accounts (default 6).
- Advisor prioritizes accounts by longest reset time when suggesting Pro upgrades.
- Only G3Pro and Claude quotas considered for remove-pro decisions (Flash ignored).


## [1.2.0] - 2026-04-22

### Added
- PII masking mode for dashboard (`?mask` URL param or toggle button). Masks emails and labels for screen recordings.
- Contextual help hints for flagged accounts (verification instructions, Google Account Recovery link).
- Model-aware quota rotation: accounts with 0% quota for the requested model are skipped instead of wasting requests.

### Fixed
- Fixed `ReadableStream is locked` crash by using `Response.text()` and `Readable.fromWeb()` instead of raw ReadableStream API.
- Fixed `ERR_HTTP_HEADERS_SENT` crash when retrying after response headers were already sent.
- Fixed 403 fallthrough bug: non-flagging 403 responses consumed the body then fell through to streaming, causing locked stream errors.
- Accounts needing verification (`Verify your account`) are now flagged immediately instead of retried.
- Dashboard URL routing now handles query parameters correctly.

## [1.1.0] - 2026-04-22

### Changed
- Use prod endpoint only (`cloudcode-pa.googleapis.com`). Removed daily/autopush endpoints that caused multi-minute hangs.
- 503 errors (no capacity) are now returned directly to the agent for its own retry/backoff instead of burning through all accounts.
- Quota-based rotation only triggers if a healthy account is available. The proxy won't rotate away from a working account if there's no better alternative.
- Dashboard accounts are sorted by total quota (highest first), flagged/disabled last.
- Config files now default to `~/.pi-antigravity-rotator/` (overridable via `PI_ROTATOR_DIR` env or `--config-dir` flag).

### Added
- `POST /api/reset-cooldowns` endpoint to clear all cooldowns at once.
- CLI entry point with `start`, `login`, and `status` commands.
- 30-minute max cooldown cap on all exhaustions (prevents multi-day cooldowns).
- Stale cooldowns from `state.json` are capped to 30 minutes on startup.
- Case-insensitive authorization header handling (fixes duplicate header bug with pi agent).
- MIT License.

### Fixed
- Fixed duplicate `Authorization` header causing 401 on all accounts. Pi sends lowercase `authorization`; the proxy was keeping both the original and the new one.
- Fixed infinite retry loop when all accounts are exhausted or 503 (no capacity).
- Fixed quota rotation moving away from the only working account when no alternatives are available.

## [1.0.0] - 2026-04-22

### Added
- Initial release.
- Per-model routing (Gemini Pro, Flash, Claude).
- Quota-based rotation with configurable drop threshold.
- Request-count-based rotation (fallback).
- 429 failover with automatic cooldown.
- Account protection: quota API 403, API 401, API 403 keyword detection.
- Real-time dashboard with account cards, quota bars, and model routing table.
- OAuth login helper with automatic pi agent configuration.
- State persistence across restarts.
