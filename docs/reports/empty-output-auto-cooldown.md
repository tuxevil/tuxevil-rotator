# Temporary auto cooldown after empty output

Production structural diagnostics confirmed Beam ended with no content or tools: one response contained122 thinking characters, another contained neither content nor thinking. These were upstream message fields, not a final answer hidden by Pi. Recent failed auto requests specified8192 maximum completion tokens and consumed few tokens, so the inspected failures do not appear to exhaust that budget. The broader reason for the model ending early remains unproven.

Auto repeatedly selected Beam again. A separate process-local output-health circuit now excludes a provider/model pair from automatic candidate construction for five minutes after an empty Ollama compatibility stream. Other candidates retain all existing permission, capability, route and operational checks. The exclusion reason is empty-output-cooldown. Expiry permits another attempt. Explicit model requests remain available. This is a temporary quality-health signal, not a plan restriction or permanent model ban.

The cache is capped at256 pairs and expires entries; restarting resets it. A new empty response can still surface to the caller before subsequent auto requests avoid the model. This phase does not replay already-started streams or guarantee another eligible model exists. Follow-up e47t covers bounded pre-output alternate-model recovery.

Regression verifies exclusion, provider isolation, preserved alternatives and expiry. Full checks passed1377 tests with2 skips, zero failures, zero lint errors and17 existing warnings. Deployment waits for idle requests, restarts with systemd and verifies auto discovery. The remote Pi task was not modified or replayed.
