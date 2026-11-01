# Auto eligibility and recovery rollout (2026-10-31)

Source: `da92286` on `feat/auto-routing-hardening`. Service: `pi-antigravity-rotator.service` on `pi.tuxevil.com`, port 51200.

The rollout enforces provider-specific plan eligibility for `auto` during candidate ranking and account reservation. Antigravity Free/Plus use the confirmed Gemini 3.8 Flash and Claude 4.6 list through the November 2 UTC cutoff. Ollama Free and Codex Free use their operator-confirmed model lists. A request can try at most two other distinct candidates after recoverable pre-output failures, including when an account becomes unavailable between ranking and admission. Operational provider health remains separate from plan eligibility.

Preflight `npm run check` passed: 1,393 tests passed, 2 skipped, 0 failed; lint reported 0 errors and 17 existing warnings. Before restart, authenticated `/api/status` returned HTTP 200 with 48 accounts, 0 in-flight requests and healthy routing. The service was restarted through systemd. After startup, `/api/status` again returned HTTP 200 with 48 accounts, 0 in-flight requests and healthy routing.

No account plan or routing configuration was changed during deployment. Live validation covered service readiness and aggregate account state; no provider completion was generated, so this report does not claim a live model-generation test.
