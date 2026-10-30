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

This release does not change routing or enforce this registry. It does not yet collect per-account request observations or log per-request policy comparisons in shadow. Those should be added with scoped evidence and expiry before enabling any enforcement. This initial UI/API is read-only; rule editing is through reviewed source changes.
