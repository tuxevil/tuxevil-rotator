import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { DynamicModelRegistry } from "../src/providers/google-antigravity/dynamic-catalog.js";

describe("DynamicModelRegistry.restorePersistedSnapshots null/primitive entries (1509f8e2)", () => {
  const reg = DynamicModelRegistry.getInstance();

  afterEach(() => {
    reg.reset();
  });

  it("ignores null and primitive model entries without throwing TypeError", () => {
    reg.reset();
    const snap = {
      version: 1,
      accounts: {
        "acc@example.com": {
          credentialGenerationFingerprint: "fp1",
          capturedAt: 1000,
          models: [null, "bad", 42],
        },
      },
    };
    assert.doesNotThrow(() => {
      reg.restorePersistedSnapshots(snap, [
        { id: "acc@example.com", credentialGenerationFingerprint: "fp1" },
      ]);
    });
    assert.equal(reg.wasDiscovered("gemini-3-flash"), false);
  });
});
