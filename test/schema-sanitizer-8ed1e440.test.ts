import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeClaudeViaGeminiSchema } from "../src/compat/schema-sanitizer.js";

describe("sanitizeClaudeViaGeminiSchema root & prototype-key preservation (8ed1e440)", () => {
  it("preserves root properties and required fields when merging allOf and prototype-named keys in anyOf", () => {
    const r1 = sanitizeClaudeViaGeminiSchema({
      type: "object",
      properties: { id: { type: "string" }, toString: { type: "boolean" } },
      required: ["id"],
      allOf: [{ properties: { extra: { type: "number" } }, required: ["extra"] }],
    }) as { properties: Record<string, unknown>; required: string[] };

    assert.ok(Object.hasOwn(r1.properties, "id"));
    assert.ok(Object.hasOwn(r1.properties, "toString"));
    assert.ok(Object.hasOwn(r1.properties, "extra"));
    assert.ok(r1.required.includes("id"));
    assert.ok(r1.required.includes("extra"));

    const r2 = sanitizeClaudeViaGeminiSchema({
      anyOf: [
        { type: "object", properties: { toString: { type: "string" }, a: { type: "string" } } },
        { type: "object", properties: { b: { type: "number" } } },
      ],
    }) as { properties: Record<string, unknown> };

    assert.ok(Object.hasOwn(r2.properties, "toString"));
    assert.ok(Object.hasOwn(r2.properties, "a"));
    assert.ok(Object.hasOwn(r2.properties, "b"));
  });
});
