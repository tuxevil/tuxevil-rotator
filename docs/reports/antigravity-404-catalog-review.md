# Antigravity 404 catalog review

The reviewed Gemini 4 and Claude 5.5 identifiers are valid: all three completed requests on both paid Pro control accounts. Their HTTP 404 responses on Free controls correlate with those models being absent from those accounts’ provider-advertised catalogs. The evidence supports account-specific availability, not deleting or renaming these IDs globally. A generic 404 alone remains unknown for subscription entitlement.

All 48 persisted provider snapshots matched the current Antigravity credential fingerprint. At inspection, the oldest was about 79 seconds old. The model names below were passed without an alias rewrite. Plans are the operator-confirmed provider declarations; snapshot membership comes from the provider’s `fetchAvailableModels` response.

| Exact model ID | Free accounts advertising it | Paid Pro accounts advertising it |
| --- | ---: | ---: |
| gemini-3.8-flash-medium | 46/46 | 2/2 |
| gemini-4-argon-medium | 0/46 | 2/2 |
| claude-sonnet-4-6 | 46/46 | 0/2 |
| claude-opus-4-6-thinking | 46/46 | 0/2 |
| claude-sonnet-5-5-medium | 0/46 | 2/2 |
| claude-opus-5-5-medium | 0/46 | 2/2 |

Claude 4.6 remains advertised to the Free accounts in this snapshot and is absent from the paid Pro snapshots, which advertise Claude 5.5 instead. This review does not establish a global retirement date. The prior batch also completed Claude 4.6 requests on two Free accounts; the new controls could not repeat those completions because the Claude pool returned quota errors.

The global catalog is intentionally a union of active account catalogs. Normal model routing preserves exact observed model IDs and rejects accounts that do not advertise a scoped model (`getProviderEligibilityRejection` in `src/rotator.ts`). The administrative exact-account probe currently checks global catalog membership only, which allowed the earlier cross-availability tests. These results are not evidence that normal routing selected Free accounts for Pro-only advertised models.

Controlled recheck used both Pro accounts and two Free accounts, selected using the available Claude quota metadata. Each probe retained exact account targeting, short provider benchmark payloads, response limits and no account fallback. Quota/transport/auth failures stopped further tests for the affected Gemini or Claude pool.

| Control group | Model | Result |
| --- | --- | --- |
| Paid Pro (2) | Gemini 3.8, Gemini 4, Sonnet 5.5, Opus 5.5 | Two completed HTTP 200 responses per model |
| Free (2) | Gemini 3.8 | Two completed HTTP 200 responses |
| Free (2) | Gemini 4, Sonnet 5.5, Opus 5.5 | Two HTTP 404 responses per model; absent from account catalogs |
| Paid Pro (2) | Sonnet 4.6, Opus 4.6 | Four responses without completion evidence; remain unknown and are absent from account catalogs |
| Free (2) | Sonnet 4.6 | Two HTTP 429 quota responses |
| Free (2) | Opus 4.6 | Two skipped after Claude quota errors |

The recheck recorded 22 observations: 10 success, 10 unknown and two quota results, plus two explicit skips. All 22 fresh observations were verified through the API and PostgreSQL. Membership for all 48 accounts remained consistent during verification. Operator plan metadata and reviewed aliases were preserved. Shadow remained enabled and automatic entitlement enforcement remained disabled.

No application code or model switches changed. Forty-five existing dynamic-catalog and model-routing/snapshot tests passed; whitespace validation passed. Valid IDs and aliases are retained. Follow-up `pi-antigravity-rotator-np6t` will expose account-level advertised availability and freshness in access diagnostics, and use it to scope routine probes while preserving a deliberate diagnostic override.

Public results contain aggregate metadata only. Private catalog receipts and pre/post access metadata are kept in the operator state directory. Temporary administrative authorization is removed after verification.
