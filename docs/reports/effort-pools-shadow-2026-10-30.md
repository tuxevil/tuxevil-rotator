# Effort-pool shadow validation — 2026-10-30

Source: c82846f, isolated file-backed instance on 127.0.0.1:51371. Only Ollama API-key accounts were copied; OAuth and production PostgreSQL writes were excluded. Production service was not restarted or reconfigured. Classifier used the configured Jev alias, so this is not pinned-model reproducibility.

Provisional groups: low beam; medium beam/minimax-m3.1-flash; high nemotron-3-ultra; max deepseek-v4.1-flash:1017. All IDs use provider prefix ollama/. This grouping tests routing mechanics; relative quality of these models has not been established. The secret-free fragment is docs/examples/effort-pools-shadow.json; credentials and enabled flag must be configured separately.

Fixture: test/fixtures/auto-routing/effort-shadow.json. Four authored prompts represent routine arithmetic, bounded implementation, distributed debugging and broad architecture. Expected effort labels are authored judgments, not externally graded ground truth.

The initial pass matched all four authored labels. Three subsequent repetitions per prompt matched all twelve. Every request returned HTTP 200, and every decision used typesafe-effort-pool-shadow. Confidence ranges on the repeated run:

| Authored level | Classified level | Confidence range | Recommended model | Served model |
| --- | --- | --- | --- | --- |
| low | low | 1.00 | beam | beam |
| medium | medium | 0.93–0.95 | beam | beam |
| high | high | 0.87–0.88 | nemotron-3-ultra | beam |
| max | max | 0.99 | deepseek-v4.1-flash:1017 | beam |

This demonstrates distinct, stable difficulty classification on this small fixture and valid mapping into eligible pools. It does not show that recommended models solve hard tasks better. Shadow mode generated no completions from high/max recommended models. Output cap was 32 tokens to bound the mechanics test, so completion quality was not evaluated. Repeated latency measurements may include caching and are not a performance benchmark.

Affinity and escalation remained disabled. Temporary process and credential directory were removed after the trial. Next step: evaluate actual high/max recommendations against beam using executable or independently reviewed task outcomes before any production activation. Retain shadow by default.
