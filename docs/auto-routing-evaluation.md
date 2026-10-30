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

## Comparing explicit pool candidates

Set `ROTATOR_EVAL_MODELS` to a comma-separated list of 1–8 distinct IDs to override the default auto/baseline pair. The baseline positional argument is still required for CLI compatibility. `ROTATOR_EVAL_MAX_TOKENS` sets a shared integer output budget from 1 to 8192 (default 256). Artifacts record the model list and budget. These are explicit-model trials; they do not test auto selection.

```bash
ROTATOR_EVAL_MODELS=beam,nemotron-3-ultra,deepseek-v4.1-flash:1017 \
ROTATOR_EVAL_MAX_TOKENS=2048 \
  npx tsx scripts/evaluate-auto-routing.ts \
  test/fixtures/auto-routing/reasoning-oracles.json beam /tmp/pool-quality.json
```

Regenerate this six-case suite with `python3 scripts/build-routing-reasoning-suite.py`. Reference results use exhaustive enumeration for knapsack, weighted intervals, assignment, grid paths, topological order counts and subset counting. They require exact integer output, not generated code execution. An incorrect format, exhausted output budget or provider failure counts as a failed case; this does not isolate the underlying cause. Use repeated trials and examine failure modes before ranking models. With three models, reversing order leaves the middle model in the middle; it is not a fully balanced experimental design.

## Bounded failures and partial artifacts

The CLI now reserves the output file before any completion request, preventing accidental repeated spend when a path already exists. It updates the artifact after each result; `status: running` means the trial did not finish, while `complete` means all planned rows were recorded. Abrupt interruption can still occur during a write; use completed artifacts for final analysis.

`ROTATOR_EVAL_MAX_FAILURES` limits operational failures per model (default 1, range 1–100). Later rows are marked `model-skipped-after-failure` and make no request. Incorrect exact-match answers do not consume this failure budget. HTTP failures preserve only the numeric status, such as `http-402`; other errors use `completion-failed`. No provider error text is copied. Report skipped, operationally failed and answered-but-wrong rows separately rather than treating all as evidence of reasoning quality.

`ROTATOR_EVAL_TIMEOUT_MS` sets the per-request client deadline (default 120000, range 1000–120000). A client timeout does not prove the provider stopped computing or avoided charging. The proxy may retry upstream accounts within that deadline.

Empty text responses are marked `empty-completion` and consume the operational failure budget even with HTTP 200. New rows record `answerChars` and a sanitized `finishReason` when available, allowing empty and potentially truncated output to be distinguished without storing completion text. Historical artifacts may predate these fields.
