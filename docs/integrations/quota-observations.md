# Preparatory quota observations

This change prepares the aggregated integration; it exposes no new endpoint,
adds no provider requests, and does not change routing policy or its inputs.
The earlier usage-limits-audit.md remains the historical baseline.

## Additive administrative contract

ModelQuota optionally carries observation:

- observedAt: epoch milliseconds of the successful measurement; cached reads
  retain their original timestamp.
- percentageSource: reported, derived, estimated, or unknown.
- remainingPercent: normalized observed percentage, or null if unknown.
- resetSource: reported, estimated, or unknown.
- resetAt: observed/estimated reset, or null.
- catalogAccessible: optional catalog-access observation for OpenCode Zen.

Router-facing percentRemaining, resetTime and timerType remain unchanged.
The separate observation retains provider data even when local cooldown logic
later overrides those fields. A positive observation does not promise that
routing can use the account now.

Google percentages are derived from reported fractions, with the existing
conservative shared-pool choice. Missing fractions retain their legacy routing
zero but have unknown observed percentage. Google timer classification remains
a routing heuristic; it is not exported as a measured window duration.
Codex percentages are derived from reported usage; the existing dominant-window
selection is preserved. Cache hits retain fetchedAt.
Ollama balance-window percentages are reported; included-credit ratios and
legacy usage complements are derived. Legacy session/weekly resets are estimated;
balance API resets are reported. USD balance, allowance and purchased credits
remain separate. OpenCode Zen catalog success records access and unknown quota;
the synthetic routing 100 remains untouched.

## Pure aggregation

src/quota-pools.ts is shared by the dashboard and future server consumers.
The old web import re-exports it for compatibility. Aggregation identity is a
JSON tuple of provider and modelKey; the router modelKey is retained separately.
The one pooledCapacity function implements the existing allowance/tier formula.
Tier weighting is an estimate of relative capacity, never a directly measured
fleet allowance. No second API-specific formula exists.

observedCapacity and observedWithQuota are null if any contributing percentage
is unknown. No partial fleet percentage is presented as complete. Legacy
capacity/withQuota fields remain available for compatibility but must not be
used by the future external endpoint. eligibleNow counts non-rejected existing
routing diagnostics for pool members. It is null when diagnostics are absent
or a provider/model collision makes their attribution ambiguous. It is a
snapshot, not a reservation or a second selection policy.

The oldest contributing timestamp determines observedAt. Freshness is unknown
if any timestamp is missing, invalid or in the future, stale after 15 minutes,
and fresh otherwise. This is an observability threshold, not a provider SLA or
a change to polling. OpenCode can have recent catalog access and unknown quota.
Known stale values remain visible with a stale label. Unknown values have no
percentage bar. Observed resets use the earliest future observation reset;
estimated resets are labelled. No Next up or cooldown is called a quota reset.

## Persistence compatibility

No storage schema or migration changes. Existing runtime state persistence
stores counters and cooldowns, not quota rows. No global lastQuotaPoll is copied
into observations. Legacy/restored quota objects lacking observation load as
before and have unknown provenance/freshness. Existing consumers can ignore
the additive field. Updating one provider never stamps retained sibling rows.

## Dashboard changes and limits

Overview Providers shows observed capacity, positive-quota and eligible counts,
freshness, the tier estimate label and estimated reset label. OpenCode quota is
unknown despite accessible catalog. No global quota is labelled unlimited or
not-applicable without evidence. Account-level and Models legacy presentations
are outside this focused change; they still consume compatibility values and
must not be reused as an external contract.

Eligibility attribution for new providers with colliding router pool keys remains
unknown until existing diagnostics can identify provider scope. This does not
change the routing key or its behavior. Aggregate state still comes from existing
routing diagnostics; it is not interchangeable with measured remaining quota.

## Next integration change

Finalize the v1 allowlisted aggregate DTO, dedicated read credential, stable
installation ID, cache/error behavior and HTTP permission tests. Map unknown
and freshness explicitly. Exclude all individual identities and detailed errors.
Add versioned consumer fixtures and T3 web/mobile design. No T3 code is changed
here. The integration tracking issue remains open.

## Validation and security review

The full project check covers server/web TypeScript, test TypeScript, all tests
and ESLint. Added regression coverage includes observational source classes,
legacy JSON rows, future/old timestamps, provider collisions, USD/prepaid credits,
unknown catalog quota, cooldown-vs-observation separation, unchanged routing
diagnostics/candidate results and Codex cache timestamps. Provider HTTP mocks
verify the existing Ollama request count and untouched sibling observations.

Security review: no auth, proxy routes, inference handlers, storage schema or
router implementation changes. Observations are assembled from explicit fields;
no credential, email, error text or response body is copied into metadata. No new
logging and no dependency changes. Production dependency audit found zero
vulnerabilities. Packaging dry run includes the new shared modules.

No browser visual session or production verification was performed. Dashboard
changes are covered by view-model tests and web typechecking. Existing account
identities remain confined to the already administrative dashboard contracts;
this preparation is not itself a safe public response DTO.

## PR review corrections

Codex reset-only windows may supply a compatibility zero usage without a usage
measurement. The parser now tracks valid supplied usage separately, and only
those windows produce a derived observed percentage. Missing, invalid and
out-of-range usage retain their previous router-facing values but have unknown
observed percentage, including Spark. Snapshot/cache reuse preserves this flag.

Overview Inspect alerts still address router model keys. Their target lookup now
uses a dedicated data attribute instead of constructing an obsolete row ID.
When several providers share the same router key, Inspect selects the first
matching row; it does not invent provider identity for an unscoped alert.
