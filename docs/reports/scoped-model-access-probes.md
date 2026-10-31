# Scoped live model access probes

Completed matrix: 620 account/provider/model combinations. 309 have classified observations; 311 were skipped. This covers selected model IDs from the live catalog, not every effort variant. No subscription declarations, model switches or enforcement settings were changed.

| Provider | Observed | Success | Unknown | Quota | Transport | Skipped |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| google-antigravity | 150 | 54 | 52 | 44 | 0 | 138 |
| ollama | 108 | 105 | 0 | 0 | 3 | 88 |
| openai-codex | 46 | 22 | 22 | 2 | 0 | 54 |
| opencode-zen | 5 | 0 | 0 | 5 | 0 | 31 |

The authenticated probe targets one account and provider without account rotation. It uses short benchmark payloads, a 30-second request deadline, a 256 KiB response limit and complete-response checks. Codex does not accept an output-token cap on its internal endpoint; the prompt asks for a one-word answer and the deadline bounds wall time. Only classified metadata is retained. OpenCode origin is not simulated; Zen uses unknown client context.

Authentication, quota and transport results stop further models for that account/provider. Disabled models remain disabled and do not prevent testing other enabled models. Busy or unavailable accounts are not forced into service. Skips are coverage gaps, not access denials. The resumable runner reuses unexpired observations and can revisit untested scopes.

Observed generic Codex HTTP 400 and Antigravity HTTP 404 results remain unknown. These do not establish plan-specific entitlement restrictions. HTTP 200 without a completed provider response also remains unknown. Model identifiers returning 404 require separate catalog validation. No seed plan rule was promoted to verified universal entitlement.

After loading the final source through systemd, 224 unexpired observations were checked through both the live API and PostgreSQL. Expired short-lived quota/transport observations remain represented in this batch report, while the live store retains only current evidence. All subscription declarations visible in the pre-run API matched the private receipt and remained present in PostgreSQL. Shadow remains enabled; automatic enforcement remains disabled.

Validation: full check passed with 1,364 passing tests, two skipped tests, zero failures, zero lint errors and 17 existing lint warnings. Focused probe, runner and admin-auth regression tests plus final type checks passed after persistence-readiness and concurrency safeguards. Tests cover incomplete HTTP 200 responses, provider targeting, quota classification, file persistence, busy-account handling, concurrent-probe rejection, read-only dry runs, disabled-model continuation and resume without duplicate completions.

Known blocker: 44 additional unexpired observations were verified in PostgreSQL but excluded from the live API because their credential fingerprints differ from current persisted credentials. All 25 Codex subscription declarations were already absent from the pre-run API, although their historical evidence remains stored. Codex matrix plan values are therefore unknown and cannot substantiate Free/Plus entitlement claims. Routine verified OAuth refresh needs an explicit evidence transition; manual credential replacement must continue invalidating evidence. This follow-up is tracked as `pi-antigravity-rotator-0hf9` (P1). Skipped coverage is tracked as `pi-antigravity-rotator-dqfn`; catalog 404 validation as `pi-antigravity-rotator-3tdh`.

Public results are aggregated by provider, model and declared plan. No account identities, credentials, prompts or provider response bodies appear in these artifacts. Private pre/post metadata receipts remain in the operator state directory; temporary probe authorization is removed after verification.

The Codex OAuth continuity blocker was subsequently fixed and validated across 25 real rotations. See [Codex OAuth evidence continuity](codex-oauth-evidence-continuity.md) for current results; the measurements above remain the historical pre-fix batch.
