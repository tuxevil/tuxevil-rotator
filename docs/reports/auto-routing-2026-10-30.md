# Branch validation — 2026-10-30

Source: 3ae33808e619e53c1d8ad1f32b5092434874f862. Production was not restarted.

Port 51200 runs src/index.ts from this repository, started October 29 at 17:30:20 local. Nearest prior commit: 62d0948 at 17:30:03. This provenance is inferred; no runtime SHA is exposed.

Temporary instance: 127.0.0.1:51371, separate file-backed settings, no production database connection. Configuration was read via SELECT; only Ollama API credentials were copied, excluding OAuth. Jev retained; affinity and escalation disabled. Process stopped after testing and credential snapshot removed.

Three simple tasks (arithmetic, JSON extraction, logic), repeated three times per arm, alternating order. Baseline: beam. This differs from the earlier Gemini comparison and is not a before/after benchmark.

| Metric | auto | beam fixed |
| --- | ---: | ---: |
| Exact matches | 9/9 | 9/9 |
| Mean latency | 1267 ms | 1197 ms |
| Median latency | 1324 ms | 1085 ms |
| Input tokens | 657 | 657 |
| Output tokens | 712 | 730 |

All 12 auto calls across the initial and repeated runs used typesafe-low-confidence fallback and selected beam. This validates live fallback behavior, not better semantic selection. Classifier usage is excluded from completion token totals; no savings claim is justified. An initial 8.9-second request was not representative of the repeated run.

Ollama output tokens come from terminal eval_count, not visible text length. The data does not establish internal reasoning token counts.

Sanitized results are in auto-routing-2026-10-30-results.json. No prompts, responses or credentials. Remaining: coding/tool task evaluation, confidence calibration, capability discovery and separate affinity/escalation trials. Keep optional policies disabled pending evidence.
