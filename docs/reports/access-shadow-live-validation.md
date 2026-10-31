# Controlled live access-shadow validation

Validated source: 771f00e. An isolated instance bound only to 127.0.0.1:51371 with file-backed settings, modelAccessShadow enabled and semantic routing disabled. Production port 51200 remained on the same PID throughout and was not restarted or reconfigured.

Configuration was read through SELECT from the existing database. One Ollama API credential was copied into a private temporary directory using a synthetic local account label. No OAuth credentials were copied, refreshed or used by the temporary process. Automatic quota polling was stopped before its initial run; the test catalog contained only beam. This trial consumed two real provider completions on that credential.

Checks performed:

- Unauthenticated access diagnostics returned HTTP401.
- An operator-assumed free plan was saved through the authenticated provider-plan API. This declaration is test setup, not verified subscription evidence.
- Two distinct short prompts to beam returned HTTP200 and the expected integer answers.
- Two model-access-policy-shadow events identified the selected provider/model, stored provider declaration, policyState=unknown and enforced=false. The actual policyState was unknown because the Ollama seed rule is still operator-pending; neither event blocked or rerouted the request.
- The evidence API showed one success observation because the latest result replaces earlier results for the same account/provider/model/client scope.
- After graceful shutdown and process restart, the stored plan and success observation were restored through the API.
- The restarted process was stopped and its private credential/configuration directory removed.

The sanitized artifact is access-shadow-live-validation-results.json. It contains no credentials, raw account identity, prompts or provider response text. Shadow's account identifier is hashed. The source is the local branch, not a production deployment.

Limits: only beam/Ollama success was exercised with a real provider. This did not verify a plan-restricted provider rejection, all model families, real OpenCode client origin, or production database persistence. File reload and the actual branch pipeline were exercised; PostgreSQL uses the same settings interface but was only read for preparation. Existing isolated tests cover typed error categories, expiry, credential invalidation, authentication and non-enforcing would-block comparisons.

Seventeen focused tests passed after the live trial. No application code changed in this validation. The experiment supports a later controlled rollout of informational capture/shadow, not entitlement enforcement or a model-quality claim.

## Later auto-routing change

This report records the pre-enforcement state. On 2026-10-31, the router began enforcing confirmed provider-plan eligibility for `auto`, including the seven Ollama Free-credit models and the operator-confirmed Codex Free list. The informational access API remains non-authorizing; this report's shadow events are historical evidence only.
