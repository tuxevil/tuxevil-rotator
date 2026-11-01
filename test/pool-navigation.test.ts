import { it } from "node:test";
import assert from "node:assert/strict";
import { findPoolTarget } from "../src/web/lib/pool-navigation.js";

it("finds Inspect targets independently of encoded provider-qualified row IDs", () => {
  const rows = [
    { id: "pool-%5BproviderA%2Cclaude%5D", dataset: { poolModel: "claude" } },
    { id: "pool-%5BproviderB%2Cclaude%5D", dataset: { poolModel: "claude" } },
    { id: "pool-%5BproviderB%2Cgemini%5D", dataset: { poolModel: "gemini" } },
  ];
  assert.equal(findPoolTarget(rows, "claude"), rows[0]);
  assert.equal(findPoolTarget(rows, "gemini"), rows[2]);
  assert.equal(findPoolTarget(rows, "missing"), undefined);
});
