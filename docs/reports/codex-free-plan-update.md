# Operator-confirmed Codex Free plans

The operator confirmed that all Codex accounts other than the previously identified Plus account are Free. Twenty-four provider-specific Free declarations were saved through the authenticated live API. The existing Plus declaration was preserved. All25 were checked through both the API and PostgreSQL; none remain unknown.

Declarations retain30-day expiry and credential scoping. Private before/after receipts are retained under /root/.local/state/tuxevil-rotator-rollbacks/codex-free-*. No account identifiers or credentials appear in this report. At the time of this report, routing and automatic enforcement were unchanged; confirmed plans did not independently verify model entitlements.

## Subsequent auto-routing enforcement (2026-10-31)

Auto now applies provider-specific plan evidence and the confirmed Codex Free list when ranking candidates and selecting an account. An unknown Codex plan is not assumed to be Free or Plus; that account is excluded from auto until its provider plan is declared. Live quota and account-level rejections remain separate checks. Explicit model requests keep their existing routing behavior.
