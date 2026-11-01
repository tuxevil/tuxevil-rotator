# Executable coding comparison — 2026-10-30

The unchanged active service was called with Gemini 3.8 Flash medium, Gemini 4 Argon medium, Sonnet 5.5 medium and Codex gpt-6.1-terra. Each task used the same prompt and 2048 output-token cap, with a 45-second client timeout. Production routing settings were not changed. Native reasoning behavior was not normalized across providers.

Tasks: immutable interval merging; JSON Merge Patch with prototype safety; CSV parsing with quoted delimiters, escaped quotes and multiline fields. Fixture prompts and executable assertions are in test/fixtures/auto-routing/coding/tasks.json. Known-good references pass and deliberately broken solutions fail through the same sandbox via scripts/evaluate-coding-pools.py --self-test.

Generated JavaScript ran inside bubblewrap with a new network/PID/user namespace, cleared environment, no repository or credential mounts, read-only code/tests, a 128MB V8 old-space setting and a five-second wall deadline. System libraries are mounted read-only. This is a local bounded evaluation, not certification against deliberately adversarial sandbox exploits. A random completion marker prevents a simple process.exit(0) from passing without running the assertions. Generated source and stdout/stderr are not saved in the report.

| Model | Code tasks passed | Operational exclusions |
| --- | ---: | --- |
| Gemini 3.8 Flash medium | 3/3 | None |
| Gemini 4 Argon medium | 3/3 | None |
| Sonnet 5.5 medium | 3/3 | None |
| gpt-6.1-terra | 1 completed task passed | Merge-patch HTTP400; CSV skipped |

No completed code submission failed its assertions. Terra's HTTP400 was reproduced by one diagnostic retry, returning upstream_error; no raw provider text is stored. This is not evidence of inferior coding quality. Follow-up issue: pi-antigravity-rotator-bdi7.

End-to-end median recorded latency was 30261ms for Gemini 3.8, 7158ms for Gemini 4 and 8707ms for Sonnet. These include proxy queue/jitter/retries and local grading; with one sample per task they do not isolate model inference speed. Terra's timings mix an operational rejection and one completion and are not comparable. Reported completion token totals were 1061, 1135 and 3254 for the three fully completing models; accounting and thinking differ between providers, so no price ranking follows.

Model order rotated per task; three tasks do not fully balance four model positions. Tests were known only to the grader but are now public fixtures; future repetitions can be contaminated. This is a small functional smoke test, not repository-level coding, autonomous debugging or actual tool use. All three completing models tied, so there is no demonstrated quality basis to replace Gemini 3.8 with Gemini 4 or Sonnet globally.

Next: diagnose Terra's request rejection, then expand edge cases and multi-file tasks with independently reviewed checks. Keep effort-pool activation, affinity and escalation unchanged. Results: coding-pools-2026-10-30-results.json; diagnostic: coding-terra-2026-10-30-diagnostic.json.
