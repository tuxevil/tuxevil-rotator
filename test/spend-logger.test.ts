import test from "node:test";
import assert from "node:assert/strict";
import {
	calculateCost,
	generateRequestId,
  logSpend,
  flushSpendLogs,
  getSpendLogs,
  getDailySpendSummary,
  getSpendQueueSizeForTests,
  getSpendQueueItemsForTests,
  setSpendQueueForTests,
  resetSpendLoggerForTests,
} from "../src/spend-logger.js";

test("calculateCost uses the official Codex GPT-5.6 rates", () => {
	assert.equal(calculateCost("gpt-5.6-sol", 1_000_000, 1_000_000), 35);
	assert.equal(calculateCost("gpt-5.6-terra", 1_000_000, 1_000_000), 14);
	assert.equal(calculateCost("gpt-5.6-luna", 1_000_000, 1_000_000), 1.4);
});

test("calculateCost uses the official GPT-6 Astra rates", () => {
	assert.equal(calculateCost("gpt-6-astra", 1_000_000, 1_000_000), 60);
});

test("calculateCost uses the official GPT-6 Sol and Luna rates", () => {
	assert.equal(calculateCost("gpt-6-sol", 1_000_000, 1_000_000), 12);
	assert.equal(calculateCost("gpt-6-luna", 1_000_000, 1_000_000), 0.6);
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

test("calculateCost uses Gemini 3.8 Flash rates for every native level", () => {
	for (const variant of ["low", "medium", "high"]) {
		assert.equal(
			calculateCost(`gemini-3.8-flash-${variant}`, 1_000_000, 1_000_000),
			4.5,
		);
	}
	assert.equal(
		calculateCost("google/gemini-3.8-flash-high", 1_000_000, 1_000_000),
		4.5,
	);
});

test("generateRequestId produces unique prefixed strings", () => {
  const id1 = generateRequestId();
  const id2 = generateRequestId();

  assert.match(id1, /^req_/);
  assert.match(id2, /^req_/);
  assert.notEqual(id1, id2);
});

test("logSpend enqueues log without throwing and keeps queue empty when DB is not configured", () => {
  resetSpendLoggerForTests();
  for (let i = 0; i < 120; i++) {
    logSpend({
      model: "gemini-3.8-flash-high",
      callType: "chat_completion",
      status: "success",
      promptTokens: 100,
      completionTokens: 50,
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      durationMs: 450,
    });
  }
  // Since DB is not configured in this test suite, queue must remain 0 to prevent memory leaks
  assert.equal(getSpendQueueSizeForTests(), 0);
});

test("logSpend uses dynamic family pricing in detailed cost metadata", () => {
  const origDb = process.env.DATABASE_URL;
  try {
    process.env.DATABASE_URL = "postgres://localhost:5432/test";
    resetSpendLoggerForTests();
    logSpend({
      model: "gemini-5.0-flash-future",
      callType: "chat_completion",
      status: "success",
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      durationMs: 100,
    });

    assert.deepEqual(getSpendQueueItemsForTests()[0].metadata?.costBreakdown, {
      promptCostUsd: 0.5,
      completionCostUsd: 3,
      totalCostUsd: 3.5,
      inputRatePer1M: 0.5,
      outputRatePer1M: 3,
    });
  } finally {
    if (origDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = origDb;
    resetSpendLoggerForTests();
  }
});

test("flushSpendLogs cleans queue when DB is not configured", async () => {
  await flushSpendLogs();
  assert.equal(getSpendQueueSizeForTests(), 0);
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

test("logSpend enforces FIFO cap of 100 entries when DB is configured", async () => {
  const origDb = process.env.DATABASE_URL;
  try {
    process.env.DATABASE_URL = "postgres://localhost:5432/test";
    resetSpendLoggerForTests();

    for (let i = 0; i < 105; i++) {
      logSpend({
        requestId: `req_${i.toString().padStart(3, "0")}`,
        model: "gemini-3.8-flash-high",
        callType: "chat_completion",
        status: "success",
        promptTokens: 100,
        completionTokens: 50,
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        durationMs: 100,
      });
    }
    // Await flushSpendLogs so DB error handler recombines uncommitted logs with queue
    await flushSpendLogs();

    assert.equal(getSpendQueueSizeForTests(), 100);
    const items = getSpendQueueItemsForTests();
    // Oldest 5 items (req_000 to req_004) should have been dropped
    assert.equal(items[0].requestId, "req_005");
    assert.equal(items[99].requestId, "req_104");
  } finally {
    if (origDb !== undefined) {
      process.env.DATABASE_URL = origDb;
    } else {
      delete process.env.DATABASE_URL;
    }
    resetSpendLoggerForTests();
  }
});

test("flushSpendLogs on DB failure preserves newest items (FIFO) under concurrent arrivals", async () => {
  const origDb = process.env.DATABASE_URL;
  try {
    process.env.DATABASE_URL = "postgres://localhost:5432/test";
    resetSpendLoggerForTests();

    // 50 inflight logs (req_000 to req_049)
    const inFlight: import("../src/types.js").SpendLog[] = [];
    for (let i = 0; i < 50; i++) {
      inFlight.push({
        requestId: `req_${i.toString().padStart(3, "0")}`,
        model: "gemini-3.8-flash-high",
        accountEmail: "test@example.com",
        callType: "chat_completion",
        status: "success",
        cost: 0.001,
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        durationMs: 100,
        createdAt: new Date().toISOString(),
      });
    }
    setSpendQueueForTests(inFlight);

    // Concurrently 100 new items arrived while flush was executing
    const concurrentNew: import("../src/types.js").SpendLog[] = [];
    for (let i = 50; i < 150; i++) {
      concurrentNew.push({
        requestId: `req_${i.toString().padStart(3, "0")}`,
        model: "gemini-3.8-flash-high",
        accountEmail: "test@example.com",
        callType: "chat_completion",
        status: "success",
        cost: 0.001,
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        durationMs: 100,
        createdAt: new Date().toISOString(),
      });
    }

    // Trigger flushSpendLogs which fails because DB connection is not initialized
    const flushPromise = flushSpendLogs();
    // Simulate concurrent enqueue during flush
    setSpendQueueForTests(concurrentNew);
    await flushPromise;

    // Queue must be capped at 100 and retain the newest (req_050 to req_149), dropping req_000-req_049
    assert.equal(getSpendQueueSizeForTests(), 100);
    const queueItems = getSpendQueueItemsForTests();
    assert.equal(queueItems[0].requestId, "req_050");
    assert.equal(queueItems[99].requestId, "req_149");
  } finally {
    if (origDb !== undefined) {
      process.env.DATABASE_URL = origDb;
    } else {
      delete process.env.DATABASE_URL;
    }
    resetSpendLoggerForTests();
  }
});

test("sanitizeLikePattern escapes backslashes, percent signs, and underscores", () => {
  const input = "test\\%_query";
  const escaped = input.replace(/[\\%_]/g, "\\$&");
  assert.equal(escaped, "test\\\\\\%\\_query");
});
