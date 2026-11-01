# Ollama provider diagnosis — 2026-10-30

Symptoms: empty DeepSeek HTTP-success completions and Nemotron fetch failures during the previous explicit-model trial. Production configuration was not changed or restarted.

Three bounded direct provider requests used one existing Ollama API-key account, the normal branch forwarder/proxy dispatcher, a synthetic short prompt, 32 output tokens and a 15-second deadline. Configuration was read with SELECT and credentials decrypted only in memory. Sanitized body-shape evidence is in ollama-provider-diagnosis-2026-10-30-results.json; no raw response text or credentials are stored.

Beam and Nemotron both returned valid native JSON with answer text and thinking. DeepSeek returned native HTTP 402 with a quota/payment-related error. Therefore Nemotron is not universally unreachable, and a DeepSeek quality ranking is invalid on this account. Prior service logs contained timeout errors; workload-dependent latency or the request deadline remains a plausible explanation of Nemotron failures. This short probe does not prove the reason for every earlier timeout, nor justify increasing global timeouts.

A deterministic local reproduction found a separate compatibility defect: parseOllamaNdjson ignored error objects and malformed lines and could return empty text with no failure signal. It also discarded thinking and done_reason, so a budget-exhausted reasoning-only response could look like an empty normal stop. Nonstreaming pretty-printed JSON could fail line-by-line parsing.

Fix: parse complete JSON objects as well as NDJSON; flag upstream error records, malformed/incomplete responses and no-content responses; preserve thinking and map length to MAX_TOKENS. The nonstreaming compat path converts Ollama parsing errors into its existing generic 502 failure response, without copying raw provider messages. Tool-only results remain valid. Thinking-only completions remain valid with reasoning_content and output-limit metadata when supplied.

Regression tests failed before the fix and pass after it. HTTP coverage injects an error object behind upstream HTTP 200 and verifies downstream 502 without provider-error disclosure. This is branch validation, not proof that production's historical DeepSeek HTTP-200 responses had exactly this body: those raw bodies were not captured.

Next: deploy only after review; diagnose provider quota/access for DeepSeek, then repeat bounded trials. For Nemotron, compare harder tasks with explicit deadline accounting before changing production timeouts. Streaming and native passthrough behavior were outside this nonstreaming fix.

Primary API references: [chat response fields](https://docs.ollama.com/api/chat) and [error records, including errors after a stream starts](https://docs.ollama.com/api/errors). These support handling explicit errors even when an HTTP response has already begun successfully.
