# Production rollout: informational model access and shadow

Source: 876b6e9. Service: pi-antigravity-rotator.service, managed exclusively through systemd with its existing environment/drop-ins. Port: 51200. Operator authorization was to deploy informational capture and policy shadow with automatic restrictions disabled.

The preflight quality suite passed, including both type checks, tests and lint (zero errors, 17 existing warnings). The first stop check found an active request, so the service was left running. A later check found zero in-flight requests; the service was then stopped through systemd, not by killing its worker.

While stopped, the stored configuration was locked in a database transaction and only modelAccessShadow was set to true. An owner-only backup and previous-flag metadata were retained under /root/.local/state/tuxevil-rotator-rollbacks/access-shadow-*. Canonical comparison verified that no other configuration value changed. The service was started through systemd with its normal environment. The first readiness probe preceded port binding and was retried after startup; the following authenticated probes succeeded.

Post-start checks confirmed all 48 accounts in status and access diagnostics. Runtime retained tier-first routing, model-choice semantic selection, semantic shadow false, affinity false and stall escalation false. Those policies were not activated or modified by this rollout. Informational policy shadow is enabled; automatic access-rule enforcement remains absent.

A single real beam request returned HTTP200 and the expected integer. Its model-access-policy-shadow event recorded enforced=false and policyState=unknown. The success observation appeared through the administrator API and in the PostgreSQL model_access_evidence setting. Unknown is appropriate because the Ollama seed list is pending independent verification; observed request success does not promote a global rule.

Old worker PID: 3124564. New worker PID after the managed stop/start: 3136646. Private preparation files holding environment/admin credentials were removed after validation. The live service remains running with shadow enabled. The sanitized result artifact is model-access-shadow-production-rollout-results.json.

Rollback: use systemd for a controlled stop/start after checking in-flight work. Restore only the previous modelAccessShadow flag (false, present before rollout) in the latest stored configuration. Do not replace all account configuration from a stale backup, since credentials may have refreshed. Private backup metadata is available for recovery. An ordinary rollback of the flag disables comparisons but leaves informational capture intact.

Limits: this was a smoke check, not a long-duration traffic soak or validation of every account/model/plan. No live plan declarations were fabricated or changed. No paid-model eligibility was inferred from the successful beam request. Next step is to review accumulated observed access and unknown/conditional/would-block comparisons before proposing enforcement.
