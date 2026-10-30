# Evaluating auto routing against a baseline

The existing account benchmark checks connectivity/performance. This runner compares task outcomes for `auto` and a fixed model with identical prompts. It makes real completion requests and consumes quota when run against a live rotator.

```bash
ROTATOR_EVAL_BASE_URL=http://127.0.0.1:51200/v1/ \
  npx tsx scripts/evaluate-auto-routing.ts \
  test/fixtures/auto-routing/exact-match.json YOUR_BASELINE_MODEL /tmp/auto-evaluation.json
```

For authenticated deployments supply `ROTATOR_EVAL_API_KEY` through your environment. The suite must contain 1–100 objects with unique `id`, `prompt` and `expected` strings. Each case generates two sequential requests, in alternating model order, with a 256-token output cap and 120-second per-request deadline. Redirects are rejected. Output creation refuses to overwrite an existing file and uses owner-only permissions.

The JSON artifact contains per-case trimmed exact-match outcomes, requested/returned model, elapsed time, token usage when supplied and sanitized failure markers. It omits prompt and completion text. A returned `model` may still be the router alias; correlate server decision logs when the upstream model name is needed. Missing token usage is unknown, not zero. Failed requests count as failed cases.

The three supplied cases are smoke checks, not evidence of general model quality. Add representative deterministic tasks and repeat the suite before drawing conclusions. For open-ended coding, evaluate executable results and human-reviewed correctness separately. This runner does not execute generated code, invoke tools, estimate prices or judge answers with another model. It sends no session metadata, so it evaluates per-request selection rather than affinity/escalation.

Run against a controlled local server first. Compare success count before latency or quota, retain the baseline/model configuration used, and review failures. Do not interpret classifier confidence as independently measured correctness.
