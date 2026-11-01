# Codex Terra 6.1 account rejection

Matched live controls used the same provider benchmark template on two operator-confirmed Free accounts and the Plus account. All three completed Luna 6. Plus also completed Terra 6.1. Both Free accounts returned HTTP400 with the exact provider response stating that the requested model is not supported when using Codex with a ChatGPT account. The narrow recognizer matched the actual provider response; no raw response text was retained.

The observation category is now `model-unavailable`, scoped to account, credential and model with one-hour expiry. It records an explicit account rejection rather than inferring universal plan entitlement. Generic400, mismatched model names, other providers and unrelated parameter errors remain unknown. The dashboard shows the account-specific reason; probe artifacts retain a safe reason constant.

Separately, [official OpenAI pricing](https://learn.chatgpt.com/docs/pricing) lists Terra6.1 for paid Work/Codex plans including Plus, and the [October26 changelog](https://learn.chatgpt.com/docs/changelog) documents that rollout. Exact Free/Plus informational rules now cite that primary source. They do not extend to future suffixes or API-key tiers. Availability remains subject to account, rollout and surface restrictions.

Full checks passed:1371 tests passed,2 skipped,0 failed; lint had0 errors and17 existing warnings. Regression coverage includes exact error recognition, negative cases, persistence reload, source dates and exact model matching. Production was restarted through systemd and all six control requests completed with the expected outcomes. All responses reported enforced=false. Normal routing remains unchanged and shadow stays active.

Remaining Ollama and disabled GPT5.6 seed verification is tracked separately in1sts. Public artifacts contain only plan/model/result metadata, without account identities, credentials, prompts or raw provider text.
