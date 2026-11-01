# Empty Ollama completion handling

The historical Pi reply was HTTP200 with a compatible stop response, null content and no tool calls. The original upstream stream was unavailable, so its provider-versus-converter cause remains unproven. Structural replay reproduces the silent-stop behavior with empty or thinking-only Ollama output.

The chat compatibility stream now emits an explicit error instead of a successful stop when Ollama ends without useful text or a tool call. Compatibility/spend outcome recording uses502 for this error. Already-committed HTTP headers may remain200; consumers must inspect SSE errors. Nonstreaming parsing also rejects thinking-only output while retaining reasoning/usage/limit metadata for diagnosis. Existing bounded nonstream rotation error handling remains in place.

A safe empty-ollama-completion event records chunk count, terminal presence, upstream content/thinking character counts, raw tool-call count and converted text count. It retains no text or tool arguments. These diagnostics can distinguish a future missing final response from certain conversion mismatches. They cannot retrospectively identify the historical provider stream.

Regression tests cover empty and thinking-only streams, explicit errors without a successful terminal stop, and preservation of output-limit metadata. The full suite passed1376 tests with2 skips, zero failures, zero lint errors and17 existing warnings. After structural diagnostics were added, focused replay, source/test type checks and targeted lint passed again.

Deployment uses systemd after an idle-request check and verifies auto discovery afterward. The remote Pi worktree and session are untouched. No benchmark implementation or synthetic paid completion was executed.

Transparent alternate-model recovery is not performed after streaming headers/output are committed. Follow-up e47t tracks bounded pre-output buffering and recovery without duplicate text/tools. The historical-cause investigation remains7lvm pending new structural evidence. This change fixes silent successful termination and outcome reporting; it does not claim to make the upstream model produce a useful answer in every case.
