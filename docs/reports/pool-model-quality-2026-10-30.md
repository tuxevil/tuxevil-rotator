# Explicit pool-model trial — 2026-10-30

Models: beam, nemotron-3-ultra, deepseek-v4.1-flash:1017, via unchanged active service at localhost:51200. No production routing settings were changed. This tests explicit-model delivery, not deployment of the branch or effort-pool decisions.

Six deterministic combinatorial tasks have integer answers computed through exhaustive reference enumeration by scripts/build-routing-reasoning-suite.py. Fixture: reasoning-oracles.json. Scores are exact trimmed integer match; no generated code was executed.

The initial unbounded attempt was stopped after repeated Nemotron transport failures and DeepSeek 402 attempts appeared in service logs. Logs are operational context, not a per-request result artifact; concurrent service traffic limits attribution. No ranking is based on that interrupted run.

A bounded retry used 2048 output tokens, a 20-second client deadline and one operational failure per model before skipping later cases. Sanitized results are in pool-model-quality-2026-10-30-results.json.

| Model | Exact matches | Operational observations |
| --- | ---: | --- |
| beam | 1/6 | Five responses reported exactly the 2048-token cap |
| nemotron-3-ultra | Not measurable | First completion failed; next five skipped |
| deepseek-v4.1-flash:1017 | Not measurable | Six responses reported zero tokens; independent probe returned empty content |

The DeepSeek diagnostic probe returned HTTP 200, finish_reason stop, zero input/output tokens and zero content characters. The trial artifact predates the empty-completion evaluator fix: its DeepSeek rows have passed=false without an error marker. They must not be interpreted as six reasoning mistakes. The new evaluator flags empty responses as operational failures and skips later cases under the configured budget.

Beam's one verified exact answer is weighted-interval scheduling (44). Five cap-sized outputs suggest budget exhaustion but do not prove truncation without finish reasons; the original trial did not capture finish reasons. The evaluator now records sanitized finish reason and answer length for future trials. No intrinsic-quality comparison is justified by this run, and reported token counts alone do not establish prices.

Conclusion: do not activate these provisional high/max pools. First diagnose Nemotron transport and empty DeepSeek responses, then repeat with explicit completion/truncation accounting and a justified output budget. Beam is a baseline with one verified task solved under this budget, not a demonstrated adequate model for all high/max requests.

Evaluator improvements reserve output before spending, persist partial results, keep HTTP status codes without provider error text, apply a per-model operational failure budget and distinguish empty completions. Deadline expiration does not guarantee upstream computation or billing stopped.
