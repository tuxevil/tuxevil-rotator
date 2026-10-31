# Evidence-aware auto-routing shadow

Added an opt-in comparison under the existing modelAccessShadow flag. Operationally eligible account/model combinations are checked against current credential-scoped observations. A model is projected out only when every eligible account has an explicit model-unavailable or entitlement rejection in unknown client context. Other error classes and absent evidence are not negative access evidence.

The projection preserves authorization, capabilities, context limits and route compatibility. It retains an eligible actual choice, otherwise reports the deterministic operational alternative or no alternative. It does not rerun Jev, change session affinity, issue upstream requests or alter the returned selection. Logs contain model/provider metadata and aggregate counts only, with enforced=false. A surviving Plus account can therefore retain Terra despite Free-account rejections.

Expiry, credential changes and subsequent successes allow reconsideration. No active retry scheduler is introduced in this shadow phase. Administrative probes remain the controlled verification mechanism.

Regression tests cover all-account rejection, sibling-account availability, empty populations, expiry, manual credential replacement, quota/authentication/generic errors, recovery after success, permission-safe alternatives, unchanged actual selection and absence of prompt text in logs. Full checks passed with 1373 passing tests and two skips, zero failures, zero lint errors and 17 existing lint warnings. Source was loaded through systemd; no production completion was forced solely to generate shadow logs.
