import { it } from "node:test";
import assert from "node:assert/strict";
import { observeQuota, quotaFreshness } from "../src/quota-observation.js";
import type { ModelQuota } from "../src/types.js";

it("annotates all sources without changing router-facing fields", () => {
  const q: ModelQuota = { modelKey: "test", displayName: "Test", percentRemaining: 50, resetTime: null, timerType: "fresh" };
  const before = structuredClone(q);
  for (const source of ["reported", "derived", "estimated", "unknown"] as const) {
    const observation = observeQuota(q, 100, source, "unknown");
    assert.equal(observation.percentageSource, source);
    assert.equal(observation.remainingPercent, source === "unknown" ? null : 50);
    assert.deepEqual(q, before);
    const annotated = { ...q, observation };
    assert.equal(quotaFreshness(annotated, 200, 100), "fresh");
    assert.equal(quotaFreshness(annotated, 201, 100), "stale");
    assert.equal(quotaFreshness(annotated, 99, 100), "unknown");
  }
  assert.equal(quotaFreshness(before, 200, 100), "unknown");
  assert.equal(observeQuota({ ...q, percentRemaining: NaN }, 100, "reported", "reported").remainingPercent, null);
});
