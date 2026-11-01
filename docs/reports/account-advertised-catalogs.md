# Account-advertised catalogs and scoped probes

Antigravity account diagnostics now expose exact provider-advertised model IDs, source, capture time, expiry and freshness. The Model Access panel shows the selected account’s catalog and current account/model advertisement state separately from subscription-rule decisions and access observations. Expired snapshots become stale while the panel remains open.

The global model catalog remains a union across accounts. Routine admin probes consult the selected account’s active-generation catalog before authentication refresh or model forwarding. A fresh catalog without the resolved upstream model returns `model-not-advertised`; absent and expired catalogs return `catalog-unknown` and `catalog-stale`. These local skips create no provider-failure observation. Fresh empty catalogs remain distinct from unknown data. Alias resolution uses the same upstream alias mapping as forwarding.

Freshness lasts two configured quota polling intervals, bounded to one through 30 minutes. The API returns a copy of the registry snapshot and exposes no raw credential or generation secret. Account-level catalogs currently come from Antigravity only; other providers retain unknown catalog availability and their existing probe behavior.

An authenticated admin may explicitly request `allowUnadvertised: true`, or use the runner’s `--allow-unadvertised` flag, for controlled cross-availability diagnostics. The response and runner artifact identify the override. Global catalog membership, active accounts, provider/model switches, concurrency and bounded responses remain required. Catalog skips apply per model and do not stop other eligible models in the batch.

Production validation after systemd deployment confirmed 48 fresh account catalogs. A Free-account Gemini 4 probe was locally skipped without changing its observations; an advertised Gemini 3.8 control completed; an explicit Gemini 4 override reached the provider and returned HTTP 404. Both upstream observations were checked in PostgreSQL. All operator plan metadata was preserved, shadow remained enabled and automatic subscription-policy enforcement remained disabled. Provider-advertised membership is informational for access explanations and does not establish universal plan entitlement.

Validation passed: 1,369 tests, two skipped tests, zero failures, zero lint errors and 17 existing lint warnings. Types, frontend compilation, credential-generation isolation, snapshot-copy safety, alias membership, empty/missing/stale catalogs, per-model runner continuation and explicit override handling were covered. No browser preview was used to validate the interface.

Private pre/post access receipts remain in the operator state directory. Public artifacts contain only aggregate verification metadata. The Antigravity 404 catalog review remains the historical evidence behind this change.
