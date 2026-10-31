# Model access rules (informational)

The Models dashboard has a Model access panel. Account details link to it with the account preselected. Filter rules by provider, plan and model; inspect a concrete model with an optional policy date and client declaration. Sources, verification/review dates and removal dates remain visible.

`GET /api/model-access` returns the rules and sanitized account summaries. It requires the existing administrator authentication and uses `Cache-Control: no-store`. It never returns credentials. Add query parameters to explain a combination:

```text
/api/model-access?provider=google-antigravity&model=claude-opus-5-5-high&plan=free
/api/model-access?provider=google-antigravity&model=claude-sonnet-4-6&plan=free&at=2026-11-02
/api/model-access?accountId=ACCOUNT_ID&provider=openai-codex&model=gpt-6-luna
/api/model-access?provider=opencode-zen&model=mimo-v2.5-free&client=opencode
```

States: allowed means documented plan access, blocked means a documented restriction, conditional means additional evidence/conditions are required, and unknown means evidence is missing, pending or stale. These are policy explanations, not effective request authorization or live availability. Quota, credential validity, cooldowns, capability requirements and virtual-key scopes remain separate.

Rules live in `src/model-access.ts`. Entries identify provider, model family/pattern, plan IDs, declared state, source, evidence status, verification date, valid-from date, review date and optional end-of-availability/client condition. Family matching requires an exact ID or a hyphen suffix; the OpenCode free-model pattern matches the `-free` suffix. This does not enumerate every possible model.

Antigravity Free/Plus restrictions and paid/trial distinctions are documented from the official model matrix. The Claude 4.6 removal uses a November 2 UTC diagnostic cutoff; upstream's exact rollout time is not asserted. Rules have no historical evidence before October 30, and need review after November 29. These dates are diagnostic defaults, not scheduled production changes.

Codex and Ollama seed lists are operator-reported and deliberately pending independent verification. Their declared states are shown but decisions remain unknown. Codex Luna 5.6 membership is specifically unresolved because the supplied lists differed. A generic 400 is not recorded as a plan restriction. No automatic learning or account/model block is created from this endpoint.

Account plans are inferred only for single-provider accounts with an unambiguous stored free/plus/ultra tier. Generic Pro is unknown because paid versus trial is unresolved. Linked-provider accounts have no inferred provider plan. A plan query parameter is an explicit simulation assumption; it does not persist or change an account. An OpenCode client declaration always remains conditional, never proof of genuine origin or guaranteed provider acceptance.

This release does not change routing or enforce this registry. It collects scoped observations as described below, but logs policy comparisons only with the opt-in setting below. Rule editing remains through reviewed source changes; provider plan declarations use the authenticated API below.

## Provider plans and observed access

`PUT /api/model-access/plan` accepts `{ "accountId": "…", "provider": "openai-codex", "plan": "free" }` using administrator authentication. The provider must be connected to that account. Plans are operator declarations, not independently verified subscriptions; they expire after 30 days. The dashboard's save button makes this distinction explicit. A stored provider declaration takes precedence over a generic single-provider tier, while an explicit query plan remains a simulation override.

Private evidence uses the existing settings repository (`model_access_evidence` in PostgreSQL or owner-only `model-access-evidence.json` in file mode). Raw credentials are not stored; evidence carries a credential fingerprint. Account identity or credential changes invalidate earlier evidence. For accounts whose identity includes a key fingerprint, changing one provider credential may invalidate all linked evidence conservatively.

The actual rotation paths capture successful completions and HTTP/transport outcomes. Records are scoped to account, provider, selected model, credential and declared client class. Only the latest record for that scope is retained, capped at 2000 observations and 2000 plan declarations. Success expires after one day; authentication/quota/transport after five minutes; unknown, payment-or-plan, explicit entitlement and client restrictions after one hour. No raw prompt, response, user-agent, provider error text or secret is retained.

Generic 400/403 stays unknown. HTTP401 means authentication, 429 quota, and 402 payment-or-plan. Only allowlisted structured error codes produce an entitlement/client restriction classification. OpenCode user-agent detection is a declaration, not verified origin. A successful completion demonstrates that one request worked, not unrestricted plan access or every capability. HTTP success with a subsequent parsing failure is not recorded as successful model access.

Observation persistence is best effort, debounced by 250ms and flushed during graceful shutdown; a crash can lose recent observations. Plan API success awaits persistence. Evidence is informational and does not override the documented policy state or alter selection, retries, cooldowns or authorization. Capture is skipped when the settings repository is not initialized. Comparison-only routing shadow is available through the opt-in setting below.

The `at` query controls policy-date simulation; stored plan and observation summaries represent the current unexpired evidence, not a historical account ledger. API responses omit credential fingerprints. Evidence cannot establish that a user-agent declaration is genuine, and observed successes do not broaden virtual-key access or documented plan rules.

## Opt-in policy shadow

Set top-level `modelAccessShadow: true` to emit `model-access-policy-shadow` events before each upstream rotation attempt. Default is false. Events contain a hashed account identifier, provider/model, plan and plan source, client declaration, policy state, rule IDs and `wouldBlock`. `enforced` is always false. No prompt, raw user-agent, credentials or provider error text is logged. Unknown/provisional access is not reported as would-block.

The comparison uses the actual selected account and its current credential-scoped plan declaration (or a conservative single-provider tier inference). It does not alter requests, authorization, selection, retries or cooldowns. A would-block finding depends on the recorded plan, which may still be an operator declaration rather than a provider-verified subscription. Observe these findings before considering any enforcement.

### Scoped live probes

`POST /api/model-access/probe` requires admin authentication and accepts
`{accountId, provider, model}`. It targets exactly one active account/provider
and a model in that provider's live catalog; it never rotates to another account.
Probes require an initialized evidence repository before spending provider quota.
Disabled providers/models and busy accounts are skipped. Only one probe runs at
a time. The provider benchmark payload requests a short reply, with a 30-second
request deadline and a 256 KiB response limit. An HTTP 200 without a completed
provider response is not access success. Results use the existing expiring,
credential-scoped observation store and appear in account access diagnostics.
No prompts, provider bodies, credentials or raw account identities are returned.
OpenCode identity is not fabricated: Zen probes use unknown client context.

`scripts/probe-model-access.mjs` builds a dry-run matrix from declared accounts
and live catalog models. Supply `ROTATOR_ADMIN_TOKEN` or a private
`ROTATOR_ADMIN_TOKEN_FILE`; optionally set `ROTATOR_URL` and
`ROTATOR_PROBE_OUTPUT`. Add `--execute` to spend provider quota. The runner
supports `--resume` to retain unexpired completed results and retry untested scopes. It
stops remaining models for an account/provider after authentication, quota or
transport failures, or unavailable/disabled accounts. It records missing catalog
models separately, writes sanitized results after each attempt and never changes
subscription declarations or enables automatic enforcement. Results demonstrate
account-specific access at the observation time, not universal plan entitlements.

### Verified Codex OAuth continuity

A successful refresh exchange may move current Codex evidence to the replacement
credential only when the provider-returned account ID matches the configured
Codex account ID. Returned email claims must also match when present; conflicting
access-token and ID-token identities are rejected before publishing credentials.
Opaque or missing identity claims do not attest continuity.

The persisted credential must still match the exact generation that initiated
the exchange. After saving the replacement credential, the refresh path transfers
only that generation's unexpired provider plan and observations. Original
observation and expiry timestamps remain unchanged, and newer destination
records take precedence. Manual credential replacement, account/principal
changes and unverified refreshes continue to invalidate earlier evidence.
Historical records are not automatically rebound. If evidence persistence fails
after the credential was saved, the valid credential remains usable and a warning
is logged; a later evidence write can retry persistence. A crash in that interval
fails closed rather than authorizing stale evidence.

The batch runner accepts `ROTATOR_PROBE_PROVIDERS=openai-codex` to restrict a
validation run to Codex without changing model switches or other providers.

### Account-advertised catalogs

Admin access reports include `accounts[].providerCatalogs` for Antigravity, with
`source: "fetchAvailableModels"`, `observedAt`, `expiresAt`, `freshness` and exact
`models`. The registry returns a copy scoped to the active credential generation.
An empty fresh list means no models were advertised; an absent, future-dated or
expired snapshot means unknown availability. Freshness lasts two configured quota
poll intervals, with a one-minute minimum and a 30-minute maximum. Other providers
currently return no account-level catalogs; their availability remains unknown.

Account/model queries include `catalogAvailability`, separately from the existing
subscription-rule decision. The Model Access panel lists the selected account's
last advertised IDs, source and dates; it marks expired snapshots stale even while
the page remains open. This information does not grant access or create universal
plan entitlement rules.

Routine Antigravity probes require a fresh account catalog advertising the resolved
upstream model (including configured aliases). Otherwise the admin API returns
HTTP 409 with `model-not-advertised`, `catalog-stale` or `catalog-unknown` before
refreshing authentication or contacting the model endpoint. These skips do not
create provider-failure observations. Other providers retain their existing probe
behavior until account-specific catalog sources are available.

An explicit admin request with `allowUnadvertised: true`, or the runner flag
`--allow-unadvertised`, bypasses only this account-catalog check. The existing
active-account, global-catalog, provider/model switches, concurrency and response
limits still apply. The response exposes `diagnosticOverride` and the runner saves
it in results. Routine matrix execution records catalog skips per model and keeps
testing other eligible models rather than stopping the entire provider.
