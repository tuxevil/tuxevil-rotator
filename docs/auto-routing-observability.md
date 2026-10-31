# Auto routing decision logs

Every completed `model: auto` selection emits an `auto-routing-decision` JSON event through the server logger. It describes routing, not completion quality or completion success.

Fields include route, selected model/provider, mode, reason, confidence, total routing latency in milliseconds, catalog count, eligible count, shortlist count and aggregate exclusion counts. `classifier_latency_ms` appears only when a classifier call was attempted. A null model with `no-eligible-candidates` means selection found no usable candidate.

Exclusions report the first failed check per candidate: context, wire format, vision, tools, reasoning, inactive provider, unavailable account pool or `access-policy`. Access-policy exclusions apply provider-specific plan declarations, the confirmed Ollama/Codex Free lists, the confirmed Antigravity Free/Plus model list, and recent model/account entitlement or payment evidence. Virtual-key permission exclusions are counted as `permission`. The catalog has already been filtered by served-model policy; those earlier exclusions are not counted. Shortlist trimming is visible as the difference between eligible and shortlist counts.

`getAutoRoutingCandidateStatus` and dashboard provider-health summaries describe operational availability only. `auto` separately checks whether at least one operational account is eligible for that exact provider/model pair. A plan restriction therefore excludes an `auto` candidate without making an otherwise healthy provider appear down. At account admission, `auto` rechecks the same provider/model eligibility before reserving an account.

For OpenAI Chat Completions only, an auto request may try up to two other provider/model pairs before output reaches the client. Empty Ollama output and explicitly recoverable upstream availability/payment failures trigger this recovery. The failed pair is excluded for the rest of that request. Explicit model requests never use this recovery, and a stream is never replayed after response headers or content have been sent.

If recovery has no remaining eligible candidate, the response preserves the last recoverable failure status with a sanitized summary instead of replacing it with a generic 503. A request that has no eligible candidate before any upstream attempt still returns 503.

Events contain no request text, tool output, keys or classifier endpoint URLs. Shadow mode additionally emits its existing comparison event. Confidence is classifier confidence, not measured answer accuracy. Latency includes candidate preparation; classifier latency includes SDK/network work.

The classifier circuit is local to a rotator instance. A transport/SDK failure opens it for 30 seconds; requests during that interval use deterministic selection. Afterward one recovery probe runs while concurrent requests continue using fallback. Successful transport closes the circuit; invalid decisions still use their own deterministic fallback. Changing classifier endpoint, model or key resets the circuit identity.

Before introducing affinity or escalation, evaluate representative tasks with explicit success criteria: answer correctness, tool execution, retries, end-to-end latency and quota consumption. Log frequency alone cannot demonstrate improved model quality.

## Context estimate

The estimate counts serialized text at roughly three UTF-8 bytes per token, adds 4,096 tokens per recognized image and reserves requested output (4,096 by default). It recognizes OpenAI/Anthropic image blocks and Gemini inline image parts; base64 image bytes are omitted from the text estimate. Gemini `generationConfig.maxOutputTokens` also sets the output reserve. Models must fit the estimate within 95% of their advertised window.

This is an eligibility approximation, not a tokenizer or image-resolution calculation. High-resolution images, URL contents and provider-specific processing may require more tokens. Provider limits remain authoritative.

## Optional continuation affinity

Set `typesafeRouting.sessionAffinity: true` to reuse the chosen model when a request carries the same `metadata.session_id` and latest human ask. Default is false. `sessionAffinityTtlSeconds` defaults to 1800 (1–86400), measured from selection, not extended on each hit. IDs must be nonblank strings up to 256 characters.

Compatibility routes scope the ID by virtual-key token hash and wire route. Requests without a virtual key share the anonymous scope: clients must use distinct, unpredictable session IDs. Session IDs and human asks are hashed in the in-memory cache and omitted from logs. Pins are local to each rotator process, bounded to 2048 entries and lost on restart.

Every reuse rechecks permission, context, capabilities and operational availability. An ineligible pin or changed human ask triggers normal selection. A pin can survive shortlist changes because its eligibility is checked independently of shortlist trimming. `reason: session-continuation` identifies reuse; shadow mode bypasses affinity. Identical repeated human asks are indistinguishable from continuations; clients should start a new session ID for a new task with identical text.

This preserves model continuity, not provider-side conversation state or guaranteed prompt-cache hits. It does not escalate stalled tasks yet.

## Optional stall escalation

With both `sessionAffinity: true` and `stallEscalation: true`, a pinned task gets at most one escalation attempt after three consecutive structured tool failures. Anthropic `tool_result.is_error: true` and tool/function-output messages with `is_error: true` or `status: failed` qualify. A successful tool result or new human ask resets the consecutive-error count. Plain text mentioning an error never qualifies.

The attempt selects among other reasoning-capable models using normal eligibility, permission and classifier rules. With no eligible alternative, the valid pin continues serving. An attempt is reserved before classification so concurrent requests cannot launch duplicate escalation attempts; they may continue using the existing pin while selection runs. The pin retains its original expiration. Logs identify successful selection as `session-stall-escalation`.

This is a capability-based recovery attempt, not a measured quality tier upgrade. It does not detect repeated successful calls, parse unstructured error text or guarantee that the alternative solves the task. It is disabled by default and bypassed in shadow mode.

## Ollama context metadata

Auto routing reads Ollama context windows from the existing `/api/show` cache rather than assuming 128,000 tokens. Catalog refresh starts background discovery in batches of four; selection performs no network I/O. Missing or expired entries use `OLLAMA_NUM_CTX` / `OLLAMA_CONTEXT_LENGTH`, with the existing 8,192 default. A model may therefore be excluded from a large request until discovery completes.

A discovered context length is the model's published upper bound, not a guarantee of provider runtime allocation. This change does not alter `/v1/models` advertising or infer vision/tool/reasoning capabilities from model names. Those metadata improvements remain separate.

## Regression coverage

`test/auto-routing-http-auth.test.ts` exercises a real local HTTP server with mocked PostgreSQL queries and an isolated settings directory. It covers missing/blocked keys, permission filtering before operational checks, no permitted candidate, and successful completion through a local Ollama-compatible upstream that verifies the forwarded model. It does not certify real PostgreSQL or provider behavior. Selector tests separately cover authorized alternatives, pin revalidation and late escalation completion after a newer task has replaced the pin.

## Classifier uncertainty diagnostics

Valid model-choice responses also log `classifier_selected_model`, `classifier_confidence`, `classifier_min_confidence`, `classifier_top_probability`, `classifier_probability_margin`, `classifier_effort` and `classifier_effort_confidence`, including when low confidence triggers fallback. Missing probability data is null. These describe the classifier answer, not independently measured quality, and are distinct from the served model/confidence. Full distributions and request text are omitted.

In `model-choice` mode, a `high` or `max` effort classification constrains selection to reasoning-capable candidates when one is present in the eligible shortlist. This guard stays active even when effort confidence is below `minConfidence`; that threshold still governs confidence in the selected model and its fallback behavior.

## Optional effort-first pools

`typesafeRouting.selectionPolicy` defaults to `model-choice`. Set it to `effort-pools` to ask Jev only for `task_effort` (low, medium, high or max), then select the best operational candidate inside an explicit pool. Model names/operational scores are excluded from classifier state in this mode. Example configuration fragment:

```json
{
  "typesafeRouting": {
    "enabled": true,
    "selectionPolicy": "effort-pools",
    "effortPools": {
      "low": ["ollama/beam"],
      "medium": ["ollama/beam"]
    },
    "shadowMode": true
  }
}
```

API credentials are configured separately. Pools contain exact `providerId/modelId` identifiers, not aliases or patterns. Model IDs can contain additional slashes. Configure high/max from measured task performance; there is no built-in claim that a model is a quality tier. Partial maps are supported: a missing tier falls back explicitly.

The selected pool is filtered for authorization, route, context, capabilities and availability before selection, independently of the original shortlist. Existing operational ordering chooses within it. Reasons distinguish selected, missing, unavailable, low-confidence and shadow outcomes. Missing/unavailable pools and uncertain effort fall back to normal operational selection; pools are preferences, not access-control allowlists. Jev disabled/error/circuit-open behavior is unchanged.

Shadow mode serves the normal deterministic model and logs `effort_pool_model`, `effort_pool_provider`, eligible count and effort confidence. It does not generate the recommended completion. In live effort-pool mode the returned confidence describes task-effort classification, not certainty that the chosen model is optimal. Affinity can retain a pool-selected model on continuations; stall escalation still limits alternatives to reasoning-capable candidates.

## Multi-provider experimental groups (2026-10-30)

The current secret-free fragment in `docs/examples/effort-pools-shadow.json` includes only these operator-specified Ollama free-credit models: beam, gemma4:31b, gpt-oss:120b, gpt-oss:20b, nemotron-3-nano:30b, nemotron-3-super and nemotron-3-ultra. DeepSeek and MiniMax are excluded from those experimental pools.

Antigravity candidates cover Gemini 3.8 Flash, Gemini 4 Argon, Sonnet 5.5 and Opus 5.5. Exact low/medium/high target IDs were verified against the active effort-route configuration rather than using client aliases as pool members. Codex includes only gpt-6-luna and gpt-6.1-terra. No OpenCode Zen models are included.

Assignment is provisional: low favors routine candidates, medium adds broader models, high adds Terra and higher-effort Gemini/Sonnet variants, max uses Opus high and Terra. This is operator configuration, not a measured quality ranking. Array order does not define priority: operational health/quota/load ordering still chooses within each pool. Pools do not force providers on, discover missing models or grant access. Candidates absent from a live catalog or ineligible for the request are skipped. Some operator-approved Ollama models are not currently advertised by the live service; listing them in a pool does not enable them.

The fragment remains in shadow, with affinity and escalation disabled. This update changes the example and tier-access metadata, not live production settings. The prior isolated shadow report tested the earlier Ollama-only configuration; it does not validate this expanded set.

The expanded example sets `restrictToEffortPools: true`. In effort-pools mode this limits all candidates to the union of configured pools before classification, deterministic fallback, pin reuse and escalation. Thus fallback can use another configured tier, but cannot select an omitted Ollama subscription model. Empty eligible union returns no target. Default is false for backward compatibility; virtual-key permissions and operational checks still apply. `pool_policy_excluded_count` reports exclusions from this configured union. This is an explicit model selection policy, not automatic account entitlement discovery.
