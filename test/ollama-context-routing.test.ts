import { it } from "node:test";
import assert from "node:assert/strict";
import { clearOllamaContextCache, getCachedOllamaContextWindow, getOllamaContextWindow } from "../src/providers/ollama/context-window.js";
import type { AccountRuntime } from "../src/types.js";

it("uses discovered windows until expiry and returns a conservative fallback without network calls", async (t) => {
  clearOllamaContextCache();
  const fallback = getCachedOllamaContextWindow("unknown");
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return new Response(JSON.stringify({ model_info: { "llama.context_length": 32768 } }), { status: 200 });
  });
  const account = { config: { provider: "ollama", apiKey: "test-key" } } as AccountRuntime;
  assert.equal(await getOllamaContextWindow("test-model", account), 32768);
  assert.equal(getCachedOllamaContextWindow("test-model"), 32768);
  assert.equal(calls, 1);
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 24 * 60 * 60 * 1000);
  assert.equal(getCachedOllamaContextWindow("test-model"), fallback);
  assert.equal(calls, 1);
  clearOllamaContextCache();
});
