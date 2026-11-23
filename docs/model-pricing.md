# Model pricing audit — 2026-11-23

Prices are USD per million tokens. This audit covers every entry in `src/types.ts` and the standalone telemetry receiver. Only confirmed rates were changed; model availability and routing were not changed.

## Official sources

| Provider / models | Source | Result |
| --- | --- | --- |
| Google Gemini 4 Carbon & Argon, all effort aliases | https://ai.google.dev/gemini-api/docs/pricing | Standard input 2, output 10, cached input 0.10 through November 30, 2026; then 4 / 20 / 0.20. Implicit caching only. Added `gemini-4-carbon` and `gemini-4-argon-disabled` plus family fallbacks. |
| Google Gemini 4 Neon, all effort aliases | Same Google source | Added Standard Paid Tier rates: input 3, output 15, cached input 0.15 (implicit caching only) plus family fallback. |
| Google Gemini 4 Hydrogen, all effort aliases (`-tiered`, `-sonar`, etc.) | Same Google source | Added Standard Paid Tier rates: input 1.50, output 7.50, cached input 0.075 (implicit caching only) plus family fallback. |
| Google Gemini 3.6 Flash & 3.8 Flash, all effort aliases | Same Google source | Introductory rates confirmed: 0.75 / 3.75 / 0.075, storage 0.50 per million tokens/hour through December 31, 2026. All four rates double January 1, 2027. Added explicit `gemini-3.8-flash` and `gemini-3.8-flash-tiered` entries. |
| Google Gemini 3.1 Pro and Gemini 3 Flash | Same Google source, preview sections | Existing base text input/output rates retained: 2 / 12 and 0.50 / 3. Long-context and modality tiers are not represented. |
| Claude Opus 5.5 and Sonnet 5.5 | https://platform.claude.com/docs/en/about-claude/pricing | Added official rates: Opus 5.5 at 4 / 20 / 0.20 (0.05x cache hit), Sonnet 5.5 at 2 / 10 / 0.10 (0.05x cache hit), plus `5-5`/`5.5` family fallbacks. |
| Claude Opus 4.6 and Sonnet 4.6 | Same Anthropic source | Existing base input/output rates confirmed: 5 / 25 and 3 / 15. |
| OpenAI GPT-6.2 Astra/Sol, GPT-6.1 Sol/Terra | https://developers.openai.com/api/docs/pricing | Added Standard short-context rates: GPT-6.2 Astra 8 / 40 / 0.40, GPT-6.2 Sol 2 / 10 / 0.10, GPT-6.1 Sol 2 / 10 / 0.10, GPT-6.1 Terra 1 / 5 / 0.05. |
| OpenAI GPT-5.6 Sol/Terra/Luna, GPT-6 Astra/Sol/Luna | Same OpenAI source | Existing Standard short-context rates confirmed. GPT-5.6 Sol promotion extended through November 30, 2026; no automatic expiry or assumed replacement price. |
| Ollama Cloud models (`beam`, `deepseek-v4.1-flash`/`:1017`, `deepseek-v4-pro`, `gemma4`, `glm-5.2`/`5.3`/`5.3-flash`, `gpt-oss`, `hy4`, `inkling-2-small`, `kimi-k2.6`/`k2.7-code`/`k3`/`k3.1-pro`, `mimo-v2.6-flash`/`pro`, `minimax-m2.7`/`m3`/`m3.1-flash`, `mistral-large-3`/`4`, `muse-spark-open`, `nemotron-3-nano`/`super`/`ultra`) | https://ollama.com/pricing | Added new published models (`beam`, `deepseek-v4.1-flash:1017`, `hy4`, `inkling-2-small`, `kimi-k3.1-pro`, `mimo-v2.6-flash`, `mimo-v2.6-pro`, `minimax-m3.1-flash`, `muse-spark-open`) and updated `mistral-large-4` from 0.68 / 2.09 to 0.70 / 2.10 (cache 0.07). Size aliases retain the corresponding model price. |
| OpenCode Big Pickle, Nemotron 3 Ultra Free / 3.5 Lightning Free | https://opencode.ai/docs/zen/ | Zero prices confirmed. Free-tier access restrictions are separate from prices. |

## Unconfirmed and historical entries

The current Google page does not list Gemini 3.7 Flash. Its existing introductory estimate and original verification date are preserved, not newly certified. Antigravity GPT-OSS 120b-medium has no confirmed matching paid API price; its historical 2 / 10 estimate is unchanged and is not the Ollama GPT-OSS price.

Ollama's current table omits DeepSeek v4 Flash :0731, v4 Pro :0813, Qwen3.5 :397b and GLM 5.1. Their historical application estimates remain unchanged. Receiver-only DeepSeek v4 Flash :preview is likewise retained without confirmation.

OpenCode's current page omits MiMo v2.5 Free, Ling 3.0 Flash Fin Free and Muse Spark 1.3 Contributor Free. Their previous zero estimates are preserved, not verified as currently available. Receiver-only Ling 3.0 Tiny Free and Laguna S 2.1 Free retain historical estimates; their names alone do not establish zero cost.

## Estimation limits and maintenance

These are static snapshots, not live billing schedules. Recheck Carbon/Argon and GPT-5.6 Sol before December 1, and Flash before January 1. No date-sensitive repricing was introduced.

Application spend logs and receiver savings use aggregate input/output counts. Cached-input/storage metadata does not add cache-aware billing. Estimates omit cache writes, long-context surcharges, audio/image rates, batch/flex/priority discounts, regional premiums, tools, off-peak pricing, subscription credits and taxes. API-equivalent value is not actual subscription savings. Historical aggregate telemetry may be recalculated at today's table; existing persisted spend records are not migrated.

Provider prices differ (for example MiniMax M3 on Ollama versus OpenCode); no other provider's rate was substituted for missing evidence. Dynamic family fallbacks remain estimates for unseen models. The receiver mirror includes all application entries, with a regression test to detect drift, while retaining receiver-only historical entries.
