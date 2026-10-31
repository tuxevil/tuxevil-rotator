# Intermittent Pi auto failures

The reviewed production journal contains14 auto decisions. Six corresponding auto upstream failures came from OpenCode Zen: big-pickle returned a FreeUsageLimitError directing free-model use to OpenCode, and ling-3.0-flash-fin-free repeatedly returned model-unavailable errors. Beam and an Antigravity Opus selection completed in the same window. These logs explain the observed HTTP failures, not every possible Pi-side error.

Auto routing did not filter the documented client-origin condition before invoking the classifier. It could repeatedly recommend these catalog entries despite Pi having no verified OpenCode origin. The existing informational shadow intentionally did not enforce that condition.

Candidate construction now excludes big-pickle and -free OpenCode Zen models when auto routing has no verified OpenCode context. This compatibility check is applied before classification and shared by deterministic fallback, affinity revalidation and shadow projections. A claimed user-agent does not bypass it. Explicit model requests retain their previous behavior; no global model switches or plan declarations were changed. Generic400 errors are not automatically treated as entitlement denials.

A regression verifies that the actual candidate builder excludes the two observed Zen entries while preserving an eligible Ollama model. Full checks passed with1375 tests passing, two skipped, zero failures, zero lint errors and17 existing warnings. Production deployment waits for an idle request snapshot before restarting through systemd and checks auto discovery afterward. Remote Pi client UI and future traffic still require observation; no synthetic paid completion was generated for this fix.
