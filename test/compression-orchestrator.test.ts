import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import {
  applyPromptCompression,
  parseCompressionMode,
} from "../src/compression/index.js";
import type { ChatMessage } from "../src/providers/google-antigravity/translators.js";

describe("Compression Orchestrator", () => {
  it("keeps the OpenCode compression header in Advanced settings only", () => {
    const guide = readFileSync(
      new URL("../docs/integrations/opencode.md", import.meta.url),
      "utf8",
    );
    const advanced = guide.indexOf("## Advanced Settings & Prompt Compression");
    assert.ok(advanced > 0);
    assert.doesNotMatch(guide.slice(0, advanced), /X-Rotator-Compression/);
    assert.match(guide.slice(advanced), /X-Rotator-Compression/);
  });

  it("parses compression modes from headers and config", () => {
    assert.equal(parseCompressionMode("lite"), "lite");
    assert.equal(parseCompressionMode("rtk"), "rtk");
    assert.equal(parseCompressionMode("rtk+lite"), "rtk+lite");
    assert.equal(parseCompressionMode("lite+rtk"), "rtk+lite");
    assert.equal(parseCompressionMode("off"), "off");
    assert.equal(parseCompressionMode(null, "rtk"), "rtk");
    assert.equal(parseCompressionMode(undefined, "off"), "off");
    assert.equal(parseCompressionMode(["lite"]), "lite");
  });

  it("passes through when mode is off", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "Hello world" },
    ];
    const res = applyPromptCompression(msgs, "off");
    assert.equal(res.stats, null);
    assert.equal(res.messages, msgs);
  });

  it("applies lite compression", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "You are a helpful assistant.\n\n\nBe concise." },
      { role: "user", content: "Hello" },
    ];
    const res = applyPromptCompression(msgs, "lite");
    assert.notEqual(res.stats, null);
    assert.equal(res.stats?.mode, "lite");
    assert.ok(res.stats!.savedChars >= 0);
    assert.equal(
      (res.messages[0].content as string).includes("\n\n\n"),
      false,
    );
  });

  it("applies rtk compression on tool outputs", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "Run git diff" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "bash", arguments: '{"command":"git diff"}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: `diff --git a/file.txt b/file.txt
index 1234567..89abcdef 100644
--- a/file.txt
+++ b/file.txt
@@ -1,5 +1,5 @@
-old line 1
+new line 1`,
      },
    ];

    const res = applyPromptCompression(msgs, "rtk");
    assert.notEqual(res.stats, null);
    assert.equal(res.stats?.mode, "rtk");
    assert.ok(res.stats!.savedChars > 0);
    assert.ok(res.stats!.techniques.includes("rtk"));
  });

  it("applies combined rtk+lite compression", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "System prompt\n\n\n\nNext line" },
      { role: "user", content: "Run npm test" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "bash", arguments: '{"command":"npm test"}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: `> test
PASS test/foo.test.ts (1.2s)
PASS test/bar.test.ts (2.1s)
Test Suites: 2 passed, 2 total
Tests: 15 passed, 15 total
Snapshots: 0 total
Time: 3.5s`,
      },
    ];

    const res = applyPromptCompression(msgs, "rtk+lite");
    assert.notEqual(res.stats, null);
    assert.equal(res.stats?.mode, "rtk+lite");
    assert.ok(res.stats!.savedChars > 0);
  });
});

 it("preserves distinct instructions sharing a long prefix", () => {
   const prefix = "instruction ".repeat(30);
   const messages: ChatMessage[] = [
     { role: "system", content: prefix + "Keep A" },
     { role: "system", content: prefix + "Keep B" },
     { role: "developer", content: prefix + "Keep A" },
   ];
   assert.equal(applyPromptCompression(messages, "lite").messages.length, 3);
 });

 it("filters noisy output before truncation so trailing errors survive", () => {
   const messages: ChatMessage[] = [{ role: "tool", content:
     "Error: start\n" + "ordinary log entry\n".repeat(200) + "Error: critical trailing failure" }];
   const result = applyPromptCompression(messages, "rtk+lite");
   assert.match(result.messages[0].content as string, /critical trailing failure/);
 });
