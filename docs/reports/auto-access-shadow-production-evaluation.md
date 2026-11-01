# Production evaluation of auto access shadow

Checked at 2026-10-31T12:32:41.849Z. The observation window begins at deployment commit cdab9a3, dated 2026-10-31T06:59:41-05:00. The service is active and listening. Persisted configuration enables modelAccessShadow and semantic routing with model-choice selection.

The available journal contains530 lines after deployment, including35 completed-request log lines and35 account-level model-access-policy-shadow events. There are zero auto-routing-decision events and zero auto-routing-access-shadow events. The broader journal search from midnight also found neither auto event. This establishes an empty evaluable automatic-routing sample; ordinary proxy traffic does not substitute for model-auto decisions. The logs alone do not establish why clients did not traverse that selection path.

Avoided failures, proposed alternative changes and cases without an alternative are unmeasurable, not zero. Offline regression tests establish implementation behavior but are not production quality evidence. No synthetic completion was submitted, client routing changed, enforcement enabled or provider quota spent for this review.

Keep shadow enabled. Issue3cjt remains open for an actual model-auto sample. The next evaluation should collect timestamped auto shadow events, distinguish model-wide exclusions from partial account rejections, retain cases with no permitted alternative, and correlate hypothetical changes with actual request outcomes. Expiry and recovery require longitudinal observations, not extrapolation from one snapshot. An operational fallback ranking is not proof of alternative answer quality.

Public artifacts contain aggregate counts and configuration booleans only. Raw journal lines, account identities, provider errors and credentials are excluded. No application code changed; whitespace validation passed.
