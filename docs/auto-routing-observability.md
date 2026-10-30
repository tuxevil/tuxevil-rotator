# Auto routing decision logs

Every completed `model: auto` selection emits an `auto-routing-decision` JSON event through the server logger. It describes routing, not completion quality or completion success.

Fields include route, selected model/provider, mode, reason, confidence, total routing latency in milliseconds, catalog count, eligible count, shortlist count and aggregate exclusion counts. `classifier_latency_ms` appears only when a classifier call was attempted. A null model with `no-eligible-candidates` means selection found no usable candidate.

Exclusions report the first failed check per candidate: context, wire format, vision, tools, reasoning, inactive provider or unavailable account pool. Virtual-key permission exclusions are counted as `permission`. The catalog has already been filtered by served-model policy; those earlier exclusions are not counted. Shortlist trimming is visible as the difference between eligible and shortlist counts.

Events contain no request text, tool output, keys or classifier endpoint URLs. Shadow mode additionally emits its existing comparison event. Confidence is classifier confidence, not measured answer accuracy. Latency includes candidate preparation; classifier latency includes SDK/network work.

The classifier circuit is local to a rotator instance. A transport/SDK failure opens it for 30 seconds; requests during that interval use deterministic selection. Afterward one recovery probe runs while concurrent requests continue using fallback. Successful transport closes the circuit; invalid decisions still use their own deterministic fallback. Changing classifier endpoint, model or key resets the circuit identity.

Before introducing affinity or escalation, evaluate representative tasks with explicit success criteria: answer correctness, tool execution, retries, end-to-end latency and quota consumption. Log frequency alone cannot demonstrate improved model quality.

## Context estimate

The estimate counts serialized text at roughly three UTF-8 bytes per token, adds 4,096 tokens per recognized image and reserves requested output (4,096 by default). It recognizes OpenAI/Anthropic image blocks and Gemini inline image parts; base64 image bytes are omitted from the text estimate. Gemini `generationConfig.maxOutputTokens` also sets the output reserve. Models must fit the estimate within 95% of their advertised window.

This is an eligibility approximation, not a tokenizer or image-resolution calculation. High-resolution images, URL contents and provider-specific processing may require more tokens. Provider limits remain authoritative.
