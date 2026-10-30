# Provider plan population from existing metadata

The live inventory contains 48 parent accounts with linked provider credentials: 48 Antigravity, 28 Ollama, 25 Codex and 6 OpenCode Zen memberships. These counts overlap; they are not separate totals of parent accounts.

Initially no provider-specific plan declarations existed. Fifteen accounts had a single provider (Antigravity) and an existing unambiguous stored free tier. Those values were migrated through the authenticated plan API as operator-authorized declarations, with the existing 30-day expiration. This is attribution of existing metadata to its sole provider, not fresh provider attestation. No requests to model providers were needed.

All fifteen writes succeeded. Current coverage:

| Provider | Declared | Still unknown |
| --- | ---: | ---: |
| Antigravity | 15 | 33 |
| Ollama | 0 | 28 |
| Codex | 0 | 25 |
| OpenCode Zen | 0 | 6 |

The parent-account tier inventory contained 45 free, 2 pro and 1 unknown. A free parent linked to several providers does not prove every linked subscription is free. Pro does not establish paid versus trial. No such assumptions were persisted. Existing declarations were skipped rather than overwritten.

A live diagnostic on a migrated account used provider-declaration as its plan source: Gemini 3.8 Flash medium allowed; Gemini 4 Argon high and Sonnet 5.5 high blocked by documented policy. These are informational states. Runtime routing, retries and policy enforcement were unchanged; shadow remains enabled.

Operator clarification was requested for whether Ollama/Codex accounts are all free or include paid/trial accounts. Until that evidence is supplied or fetched from provider-specific metadata, unknown remains appropriate. OpenCode client-origin restrictions are independent of a subscription tier.

Private before/after declaration receipts are retained under /root/.local/state/tuxevil-rotator-rollbacks/provider-plans-*; the public artifact omits account IDs, labels and credentials. A rollback should remove only declarations created by this batch if their recorded timestamps still match, preserving subsequent operator edits and access observations. Never replace the entire evidence store with an old snapshot.
