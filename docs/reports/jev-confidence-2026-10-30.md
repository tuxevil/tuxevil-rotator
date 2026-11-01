# Jev confidence diagnosis — 2026-10-30

Symptom: all twelve auto requests in isolated branch validation used low-confidence fallback. Hypotheses: response scale mismatch; ambiguous candidate choices; insufficient model-quality metadata.

The installed SDK declares confidence on [0,1]. Official documentation describes Choice confidence as normalized distance of the maximum probability above a uniform distribution, not correctness probability: https://docs.typesafe.ai/confidence . The current threshold comparison uses the documented field and scale. No threshold was changed.

A diagnostic harness read classifier configuration through a SELECT from the settings database, decrypted it in memory, and called the branch selector with equal-health Ollama candidates from the existing catalog. No completion provider was called. Synthetic tasks are preserved in test/fixtures/auto-routing/code-and-instructions.json. Candidate metadata used the prior catalog's 128K context and generic capability values; this is a classifier experiment, not a live context eligibility test.

An initial attempt failed with typesafe-error then used the circuit fallback. Its transport cause was not captured, so no specific timeout claim is made. A subsequent direct control using two distinct difficulty categories succeeded with confidence 1. Repeating the six model-selection calls then produced valid answers with confidence 0.09–0.24, maximum probabilities 0.24–0.37 and small margins. All remained below 0.45. Task effort was low in all six cases, consistent with these bounded questions.

This rules out a universal inability to return high confidence and supports ambiguity of model selection under generic metadata. It does not establish which candidate performs best. The control changes both question and options, so it is not a controlled attribution to any individual metadata field.

Change: permanent decision metadata now retains classifier confidence, configured threshold, top probability, top-two margin, task effort/confidence and selected model even when fallback serves another model. No prompts, keys or full distributions are logged. Existing completion confidence remains separate from classifier diagnostics.

Next experiment: evaluate distinct task-fit pools using measured model results, or classify task difficulty separately and choose operationally inside a configured pool. Do not lower the threshold merely to increase classifier acceptance. The six new exact-match cases test code reading and instruction handling; the tool-plan case is a text choice, not executed tool use.

A separate completion run exercised these six cases against the unchanged active service on port 51200, auto versus beam. Its sanitized artifact is auto-code-active-service-2026-10-30-results.json. This is a broader workload smoke test of the active service, not validation of the new branch diagnostics or executable coding/tool ability.
