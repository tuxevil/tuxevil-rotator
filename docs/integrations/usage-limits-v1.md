# Read-only aggregated usage limits v1

`GET /api/usage-limits/v1` is a server-to-server interface. It exposes only global
provider/pool observations. It never refreshes OAuth, polls a provider, reserves
capacity, rotates an account or modifies routing. T3 Code is not a dependency.

## Configuration

Set `TUXEVIL_ROTATOR_USAGE_READ_TOKEN` to a separately generated secret (for
example, generate 32 random bytes with `openssl rand -hex 32`). Store it in the
service environment using the normal operator-managed configuration. Do not
reuse the administrative token or an inference API key. This change does not
configure, restart or deploy any running instance.

No token means the endpoint rejects all requests. Authentication is mandatory
regardless of whether administrative authentication is enabled. The read token
is reserved across HTTP headers and query credential carriers: presenting it
elsewhere returns 403 before route dispatch, including inference and WebSocket
upgrades. It cannot be exchanged for a dashboard session. If the read token and
admin token coincide, the summary rejects authentication and administrative
session authorization fails closed; fix configuration rather than sharing keys.

Use HTTPS for remote access. The only supported summary credential is:

    Authorization: Bearer <independent-read-token>

Query strings, cookies and administrative tokens do not authenticate this API.
No CORS access is enabled for this endpoint. Desktop and Android clients should
receive the result through their authenticated T3 server; keep the read token on
that server. All consumers can share a token initially; rotating it revokes all
of them. Individually revocable per-consumer tokens are outside v1.

Example (the shell variable contains the configured secret):

    curl --fail --silent --show-error \
      -H "Authorization: Bearer ${ROTATOR_USAGE_READ_TOKEN}" \
      https://rotator.example/api/usage-limits/v1

Never put this token in a dashboard URL. An optional dashboard link belongs to
consumer configuration and must be HTTP(S), without embedded credentials.

## Identity and caching

An installation UUID is atomically published in `usage-limits-instance-id` in
the existing config directory. No identity is derived from credentials, account
emails or instance addresses. Concurrent initializers converge on the same file.
The file must survive restarts. A missing file is created only on an authorized
summary read; an invalid/unreadable file returns 503, never a new transient ID.
Cloned installations must receive separate config directories/identity files;
servers intentionally sharing one installation should share its identity.

A per-server cache lasts at most one second and coalesces simultaneous readers.
It uses the existing dashboard overview and shared `src/quota-pools.ts`
aggregation. Cache expiration reads current local state, never external quota
APIs. Identity loading has a five-second response timeout. Responses are bounded
to 1 MiB. Every response is `Cache-Control: no-store`; no shared HTTP cache is
permitted. Authentication is checked for every request, including cache hits.

## JSON contract

The authoritative TypeScript types are `UsageLimitsSnapshotV1` and
`UsageLimitsPoolV1` in `src/usage-limits.ts`. The top-level keys are:

| Field | Meaning |
| --- | --- |
| schemaVersion | Integer 1 |
| instanceId | Stable installation UUID |
| generatedAt | Response snapshot generation, epoch milliseconds |
| pools | Aggregate records only |

Each record has these fixed v1 fields:

| Field | Meaning |
| --- | --- |
| id | Opaque stable identity; currently JSON tuple of provider and model pool |
| scope | `pool`, or `provider` when no quota pool has been observed |
| name / providerId | Pool display name and origin provider ID |
| knowledge | `known`, `unknown`, or reserved `not-applicable` |
| remainingPercent | Observed aggregate percentage, or null |
| percentageBasis | `tier-estimate`, `included-credits`, or `unknown` |
| accountsWithQuota | Accounts with observed positive quota/prepaid credit, or null |
| accountsEligible | Non-rejected members from existing routing diagnostics, or null |
| accountsConsidered | In-service pool members; for provider-only rows, connected accounts shown by the dashboard |
| availability | `available`, `unavailable`, or `unknown`, based solely on determinable eligibility |
| nextResetAt / resetBasis | Earliest future observation reset and `reported`, `estimated`, or `unknown` |
| observedAt | Oldest contributing measurement, epoch milliseconds, or null |
| freshness | `fresh`, `stale`, or `unknown` |
| quotaUnit | `percent`, `usd`, or `unknown` |
| credits | Aggregate USD fields, or null |
| catalogAccessible | Known successful catalog access, or null; does not establish quota |

All timestamps are epoch milliseconds in UTC. `generatedAt` never establishes
measurement freshness. The shared dashboard threshold is 15 minutes. A stale
known percentage remains known and stale; unknown percentages remain null.
Missing timestamps give unknown freshness. `not-applicable` is reserved for a
future explicit source observation; v1 producers do not infer unlimited service.

USD credits contain exactly `balanceUsd`, `allowanceUsd` and `purchasedUsd`.
The percentage is the existing included-balance/allowance ratio, not a conversion
of money into tokens. Purchased credits stay separate. Credits without verified
observed capacity are withheld rather than exporting legacy values as measured.
Tier-weighted percentages are relative-capacity estimates, not interchangeable
provider allowances. Counts of accounts with quota are not eligibility promises.
Unknown eligibility includes absent/ambiguous provider diagnostics. `availability`
is a snapshot, never a reservation or a guarantee of a successful next request.

Shared model quota is exported once per provider/pool. Provider-only rows use
an opaque provider identity with a null pool component, and have unknown quota.
Never combine or average different pools, windows, currencies or origins.

Clients must treat IDs as opaque, tolerate added fields in v1, and reject an
unsupported schemaVersion. Null means unknown, not zero, 100%, or unlimited.
Deduplicate by `(instanceId, id)` across T3 servers; never sum their snapshots.
Keep direct-provider quotas and external summaries labelled separately, without
adding them or attempting account matches.

## Errors

Errors contain only `{ "error": "code" }`, with no account/provider error text.
401 `unauthorized`: missing/wrong credential, disabled endpoint, invalid auth
configuration or query-string request. 405 `method_not_allowed`: authenticated
unsupported method (`Allow: GET`). 503 `snapshot_unavailable`: local identity or
snapshot failure, size bound or identity timeout. Outside this endpoint, a
presented read credential returns 403 `read_credential_scope`.

Consumers should use bounded timeouts/backoff and retain their last successful
snapshot with an explicit disconnected/stale-source indicator. Never replace a
failed read with an empty fleet or fresh timestamps. The rotator does not keep a
previous response across a failed cache refresh. Detailed errors remain private.

## Examples and fixtures

`test/fixtures/usage-limits/v1/summary.json` is a complete response generated from
`input.ts`. It is deliberately synthetic and anonymized; it is not production
telemetry. It covers weighted Antigravity capacity, monetary Ollama quota with
an estimated reset, and accessible OpenCode catalog with unknown quota. Tests
compare the generated response with this versioned fixture and shared dashboard
values. No production endpoint was queried or configured for these examples.

## Future T3 integration (not implemented here)

Add a discriminated read-only aggregate source rather than fake accounts to
`packages/contracts/src/providerUsageLimits.ts` and its source configuration.
Dispatch it from `apps/server/src/usage/UsageLimitSources.ts` to a bounded HTTP
snapshot reader. Disable reset-credit actions server-side for this source;
validate version, finite numeric fields, nullable states and response size.
Do not forward bearer credentials on redirects, log them or expose them to UI.

Render compact aggregate rows in web `UsageLimits`/`UsagePage` and mobile
`UsageLimitsSection`/`UsageLimitsPooled`, preserving units, basis, freshness and
source errors. Use the same fixtures in consumer contract tests. Source settings
belong alongside `AddUsageLimitSourceDialog`; optional dashboard URLs are consumer
configuration. T3 must not recompute quota, infer individual accounts or register
these pools as executable Codex/Claude provider drivers.

This PR is stacked on the validated PR #44 branch while that PR remains unmerged.
No merge, deployment, routing-policy change or T3 source change is included.

## Verification and limits

Full `npm run check`: 1,319 passing tests, two skipped, server/web/test types
passing, ESLint zero errors (17 existing warnings). Production dependency audit:
zero vulnerabilities. Packaging dry run includes both new API modules.

Regressions exercise exact shared-dashboard projection, monetary units, stale
and unknown observations, missing/ambiguous diagnostics, provider-key collisions,
versioned fixture stability, identity initialization races/corruption, cache
expiration, concurrent HTTP readers, generic failures, no leaked account canaries,
admin/read key collisions, dashboard sessions, inference and WebSocket denial.
The actual proxy test verifies ten simultaneous summary reads make no upstream
calls. Existing routing/proxy tests remain green; no router implementation was
modified. Browser/T3 rendering is outside this server-only change.

The `observedAt`/freshness of an accessible catalog with unknown quota describes
the catalog-access observation, not a measured remaining allowance. Source
measurement failures remain reflected through aging observations; the snapshot
cannot manufacture a last successful quota time for legacy rows. The endpoint
has no per-provider last-error text or independent polling status.

Local `npm run coverage` also passes its configured thresholds. The repository
CI workflows filter pull requests to `main`; this stacked PR does not trigger
those workflows until it is retargeted after authorized integration of #44.
The successful CI/CodeQL results on #44 validate the preparatory base, not the
new endpoint code. Do not treat local type/lint/test/coverage checks or the
production dependency audit as a completed CodeQL run for this new PR.

## Additive partial-coverage fields

`quotaCoverage: { knownAccounts, totalAccounts }` is included for each record.
`partialObservation` is null for complete or wholly unknown quota coverage.
For partial coverage it contains `remainingPercent`, `accountsWithQuota`,
`percentageBasis`, `observedAt` and `freshness`, all scoped only to accounts with
valid, explicitly sourced percentage observations. Its percentage uses the same
shared tier/allowance weighting as the dashboard. Never promote it to a fleet
percentage or silently include unknown accounts in its denominator.

The original top-level record fields keep their semantics: unknown fleet
`remainingPercent` and `accountsWithQuota` stay null and knowledge stays unknown.
Eligibility is independent. Subset freshness does not establish freshness of the
unknown portion. The additional fixture `v1/partial.json` demonstrates one known
Claude observation and one unknown account, with 80% for the measured subset
and no fleet percentage. Clients unaware of these added fields can safely
continue displaying unknown fleet quota.
