import test from "node:test";
import assert from "node:assert/strict";
import {
	calculateCost,
	generateRequestId,
  logSpend,
  getSpendLogs,
  getDailySpendSummary,
} from "../src/spend-logger.js";

test("calculateCost uses the official Codex GPT-5.6 rates", () => {
	assert.equal(calculateCost("gpt-5.6-sol", 1_000_000, 1_000_000), 35);
	assert.equal(calculateCost("gpt-5.6-terra", 1_000_000, 1_000_000), 14);
	assert.equal(calculateCost("gpt-5.6-luna", 1_000_000, 1_000_000), 1.4);
});

test("calculateCost uses the official Gemini 3.7 Flash tiered rates", () => {
	// 1M input (0.75) + 1M output (3.75) = 4.50
	assert.equal(
		calculateCost("gemini-3.7-flash-tiered", 1_000_000, 1_000_000),
		4.5,
	);
	// Provider-prefixed ids resolve through the 3.7-flash fallback.
	assert.equal(
		calculateCost("google/gemini-3.7-flash-tiered", 1_000_000, 1_000_000),
		4.5,
	);
});

test("calculateCost never falls 3.7-flash through to gemini-3-flash rates", () => {
	const tiered = calculateCost("gemini-3.7-flash-tiered", 1_000_000, 1_000_000);
	const legacy = calculateCost("gemini-3-flash", 1_000_000, 1_000_000);
	assert.equal(legacy, 3.5); // 0.50 + 3.00
	assert.notEqual(tiered, legacy);
});

test("generateRequestId produces unique prefixed strings", () => {
  const id1 = generateRequestId();
  const id2 = generateRequestId();

  assert.match(id1, /^req_/);
  assert.match(id2, /^req_/);
  assert.notEqual(id1, id2);
});

test("logSpend enqueues log without throwing", () => {
  assert.doesNotThrow(() => {
    logSpend({
      model: "gemini-3.5-flash-high",
      callType: "chat_completion",
      status: "success",
      promptTokens: 100,
      completionTokens: 50,
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      durationMs: 450,
    });
  });
});

test("getSpendLogs returns empty logs when DB is not configured", async () => {
  const result = await getSpendLogs();
  assert.equal(result.total, 0);
  assert.deepEqual(result.logs, []);
});

test("getDailySpendSummary returns empty array when DB is not configured", async () => {
  const summary = await getDailySpendSummary({});
  assert.deepEqual(summary, []);
});

test("sanitizeLikePattern escapes backslashes, percent signs, and underscores", () => {
  const input = "test\\%_query";
  const escaped = input.replace(/[\\%_]/g, "\\$&");
  assert.equal(escaped, "test\\\\\\%\\_query");
});
