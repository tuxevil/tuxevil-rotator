# Codex OAuth evidence continuity

A deterministic regression reproduced the bug through the real provider refresh path with a mocked OAuth response: saving the rotated refresh token made the existing plan and observation disappear. The cause was the credential-generation fingerprint changing without an explicit evidence transition. The original regression passes with the fix.

The OAuth response must attest the configured Codex account ID. Returned email claims must match when present, and conflicting access-token/ID-token identities are rejected. After saving the replacement credential, only unexpired evidence for the exact initiating generation is transferred. Original observation and expiry dates are preserved. Newer destination records win. Manual replacements, renamed accounts, different principals and opaque identity responses cannot recover old evidence. A stale in-flight refresh cannot overwrite a newer persisted credential. The production refresh queue reloads settings when the queued operation executes, so a manual replacement made after enqueueing is also respected.

Operational repair used the operator-confirmed 24 Free and one Plus declarations. Each declaration was matched to its stable account identity and expected plan, then scoped to the current credential while the service was stopped. Original observation/expiry timestamps were retained, other provider plans were preserved, and private pre-change receipts were saved. Historical access observations were not rebound; new Codex probes supplied fresh evidence.

The Codex-only matrix processed 100 combinations: 48 observations and 52 explicit skips. Locally disabled models stayed disabled.

| Model | Plan | Success | Unknown | Quota | Skipped |
| --- | --- | ---: | ---: | ---: | ---: |
| gpt-5.6-luna | free | 0 | 0 | 0 | 24 |
| gpt-5.6-luna | plus | 0 | 0 | 0 | 1 |
| gpt-5.6-terra | free | 0 | 0 | 0 | 24 |
| gpt-5.6-terra | plus | 0 | 0 | 0 | 1 |
| gpt-6-luna | free | 22 | 0 | 2 | 0 |
| gpt-6-luna | plus | 1 | 0 | 0 | 0 |
| gpt-6.1-terra | free | 0 | 22 | 0 | 2 |
| gpt-6.1-terra | plus | 1 | 0 | 0 | 0 |

All 48 fresh batch observations were checked through the API and PostgreSQL before a further systemd restart. That restart produced 25 actual credential rotations. All 25 plans (24 Free, one Plus) and 53 current observations, including normal traffic beyond the batch, remained visible and persisted with unchanged timestamps. Other provider plans were unchanged. Shadow stayed enabled and automatic enforcement stayed disabled.

The Plus account completed a Terra 6.1 request. Twenty-two Free-account Terra 6.1 requests returned generic HTTP 400 and remain unknown; two were skipped after quota errors. These account-specific results do not establish universal plan entitlements. The two GPT 5.6 models were locally disabled and were not probed.

Validation: full checks passed with 1,366 passing tests, two skipped tests, zero failures, zero lint errors and 17 existing lint warnings. Focused regressions also cover repository reload, TTL preservation, expired evidence, newer destination evidence, linked-provider preservation, principal changes, conflicting token identities, manual replacement followed by refresh, stale in-flight refresh rejection and provider-filtered probe execution.

Credential and evidence writes remain separate. A crash or evidence-write failure after saving the valid credential fails closed; the warning and later evidence writes provide best-effort recovery. Transactional/durable recovery is tracked separately as `pi-antigravity-rotator-6egv`. No historical evidence is automatically revived to hide such a gap.

Public artifacts contain aggregate metadata only. Private receipts remain in the operator state directory. Temporary administrative authorization is removed after verification.

After the queued-settings reload safeguard, another restart verified all 25 plans again. Of the initial observation snapshot, 47 still-current records retained their timestamps, 4 had been replaced by genuinely newer requests, and two short-lived quota records had expired normally. API and PostgreSQL matched the current credential scopes.
