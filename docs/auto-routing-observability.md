# Auto routing decision logs

Every completed `model: auto` selection emits an `auto-routing-decision` JSON event through the server logger. It describes routing, not completion quality or completion success.

Fields include route, selected model/provider, mode, reason, confidence, total routing latency in milliseconds, catalog count, eligible count, shortlist count and aggregate exclusion counts. `classifier_latency_ms` appears only when a classifier call was attempted. A null model with `no-eligible-candidates` means selection found no usable candidate.

Exclusions report the first failed check per candidate: context, wire format, vision, tools, reasoning, inactive provider or unavailable account pool. The catalog has already been filtered by served-model policy and virtual-key permissions; these earlier exclusions are not counted. Shortlist trimming is visible as the difference between eligible and shortlist counts.

Events contain no request text, tool output, keys or classifier endpoint URLs. Shadow mode additionally emits its existing comparison event. Confidence is classifier confidence, not measured answer accuracy. Latency includes candidate preparation; classifier latency includes SDK/network work.

The classifier circuit is local to a rotator instance. A transport/SDK failure opens it for 30 seconds; requests during that interval use deterministic selection. Afterward one recovery probe runs while concurrent requests continue using fallback. Successful transport closes the circuit; invalid decisions still use their own deterministic fallback. Changing classifier endpoint, model or key resets the circuit identity.

Before introducing affinity or escalation, evaluate representative tasks with explicit success criteria: answer correctness, tool execution, retries, end-to-end latency and quota consumption. Log frequency alone cannot demonstrate improved model quality.
