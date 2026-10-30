# Aggregated usage limits: Phase 1 audit (blocked)

Baseline: rotator a9051c58cc029c43ece38ed084d448e26be04cfb.
No production changes or T3 implementation. No endpoint is exposed by this change.

## Existing dashboard contract

ProvidersPanel in src/web/pages/Overview.tsx consumes buildProviderGroups and
buildPools from src/web/lib/pools.ts. Those pure functions are the required
single source of aggregation; a future server projection must reuse them,
preferably after moving them and their pure dependencies to a shared module.

buildPools groups by modelKey, not (providerId, modelKey). It creates a pool
before filtering members. Disabled, flagged and off accounts and disabled
providers are excluded. Error and cooldown accounts remain members. Therefore
withQuota is NOT a count of routable accounts. It counts positive percentages
or purchased credits, independently of cooldowns and authentication failures.

Weights are allowanceUsd where present, otherwise tier estimates: ultra/max
2000, team/pro 1500, plus 1000, free/unknown 250. Non-credit capacity is the
rounded weighted mean of clamped remaining percentages. These tier weights
are approximate request capacities, not measured interchangeable allowances.

For credit pools capacity is rounded balanceUsd / allowanceUsd, clamped to
0..100; purchasedUsd is separate and can keep an account counted as withQuota.
The availability state uses balance plus purchased credits relative to allowance.
These two indicators intentionally can disagree. The percentage describes
included credits, not all purchasing power. Missing/zero allowance must not be
silently described as a measured included-credit percentage.

Next reset is the earliest future resetTime among members, excluding fresh
windows and full windows within ten minutes of five hours or seven days.
That final exclusion is a heuristic. Next up comes from routing diagnostics
and is completely separate. Burn and hours-left are estimates, excluded from
this API. Circuit breakers and no selected routing candidates can block a pool
with positive remaining quota.

## Blocking provenance gaps

1. src/providers/opencode-zen/quota.ts synthesizes 100% after a successful
   models-catalog request. This verifies access, not remaining quota. Exporting
   it as known quota violates the integration requirements. Correcting only
   the API would disagree with the dashboard.
2. src/providers/ollama/quota.ts computes the legacy weekly reset locally and
   anchors legacy session windows at first observed usage. These are estimates,
   not provider-reported reset timestamps. The credit API path has a separately
   reported period.until. ModelQuota cannot distinguish these origins.
3. AccountRuntime.lastQuotaPoll is account-wide. DashboardAccount omits it;
   no per-pool observation timestamp survives in ModelQuota. Successful polling
   of a sibling provider cannot establish freshness of another provider's data.
   Snapshot generatedAt is not quota observedAt.
4. Pool grouping does not include provider identity. Reusing the current key
   unchanged is unsafe for future providers with colliding modelKey values.
5. Missing numeric percentages are coerced to zero in buildPools. There is no
   explicit unknown/not-applicable representation in ModelQuota. The Codex
   parser also supplies a full placeholder for a missing window, although its
   dominant-window selection generally chooses the consumed observed window.

These require coordinated provider parsing, runtime/persistence, dashboard
aggregation and rendering changes. They are not safe endpoint-only fixes:
quota rows are also used by routing. Do not alter their semantics casually.
Do not expose a misleading endpoint while this prerequisite remains unresolved.

## Proposed v1 contract (not finalized until provenance is fixed)

GET /api/usage-limits/v1, required dedicated Bearer credential.

    {
      "schemaVersion": 1,
      "instanceId": "persisted-random-installation-id",
      "generatedAt": "ISO-8601",
      "pools": [{
        "id": "provider:pool",
        "name": "Claude",
        "providerId": "google-antigravity",
        "knowledge": "known|unknown|not-applicable",
        "freshness": "fresh|stale|unknown",
        "observedAt": null,
        "availability": "ok|low|empty|blocked|unknown",
        "remainingPercent": null,
        "percentageBasis": "tier-weighted|included-credit-ratio|unknown",
        "accountsWithQuota": null,
        "accountsConsidered": 0,
        "nextResetAt": null,
        "resetBasis": "reported|estimated|unknown",
        "quotaUnit": "percent|usd|unknown",
        "credits": null
      }]
    }

Credits, when present, contain only aggregate balanceUsd, allowanceUsd and
purchasedUsd. JSON null means unavailable, never zero or unlimited. Freshness
must be based on the oldest contributing measurement and explicit per-provider
policy, not response generation. Preserve a known stale value with stale state;
never make a new measurement timestamp when only serving cached state.

Use stable installation identity independent of secrets. Consumers deduplicate
by (instanceId, pool.id); direct-provider quotas remain separate and must not be
summed with external summaries. No account identity, label, email, error detail,
request history, OAuth fields or routing diagnostics leave the projection.

## Security implementation requirements

Dedicated environment-configured read token, mandatory even when admin auth is
disabled. Reject token equality with administrative/inference credentials.
Guard against the read token being accepted by existing permissive admin or
inference paths; endpoint authentication alone does not establish isolation.
Use timing-safe comparison and explicit output fields. No query credentials,
no browser CORS access, no shared-cache storage. Invalid auth returns a generic
401. Unsupported methods cannot mutate state. Bound work and response size.

Read existing runtime state only. Never invoke quota polling, token refresh or
provider HTTP from the endpoint. A short bounded shared cache may reuse the
projection across readers. No SSE. The dashboard URL is optional consumer-side
configuration, validated as HTTP(S) without embedded credentials.

## T3 follow-up, no code changes in this phase

Extend packages/contracts/src/providerUsageLimits.ts and the source config
schema with a discriminated external-snapshot variant containing pools, not
UsageLimitSourceAccount records. Dispatch in
apps/server/src/usage/UsageLimitSources.ts to a new externalSnapshotApi.ts.
Preserve CLIProxy behavior and reject reset-credit commands for read sources.
Keep the last successful snapshot on transient failure and expose source errors.

Update web settings AddUsageLimitSourceDialog, web UsageLimits/UsagePage and
mobile UsageLimitsSection/UsageLimitsPooled. Use a compact pool row, generic
provider fallback and explicit freshness/unknown text. Do not instantiate a
Codex or Claude account/driver for a pool. Deduplicate across environment feeds
by stable instance/pool identity; never add percentages. Fetch exclusively from
T3 servers with timeout, bounded response decoding, sanitized errors and no
cross-origin credential forwarding on redirects.

## Required acceptance fixtures and tests

After prerequisite fixes: same-snapshot dashboard/API equality, unequal tiers,
unequal allowances, prepaid-only availability, zero allowance, partial unknown
measurements, inactive and disabled accounts, cooldown/error distinction,
provider key collisions, shared model pools, real vs estimated reset, fresh
windows, stale sibling-provider data and provider disappearance.

HTTP integration tests must cover absent/wrong/admin/read credentials, every
administrative and inference route using read credentials, secret canaries in
all runtime fields, unsupported methods, parallel readers with zero upstream
calls, stable instance identity across restart and unchanged proxy tests.
Fixtures must be generated from these verified cases. Invented example responses
must not be labelled real. No live administrative endpoint was queried here.

## Delivery decision

Phase 1 endpoint, final contract, real response examples and consumer fixtures
are intentionally deferred. Resolve provenance in a prerequisite change before
implementing the two integration PRs. This audit is not a completed integration.
