import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, TokenBucket } from "../src/types.js";

const savedEnv = {
  TUXEVIL_ROTATOR_DIR: process.env.TUXEVIL_ROTATOR_DIR,
  PI_ROTATOR_DIR: process.env.PI_ROTATOR_DIR,
  DATABASE_URL: process.env.DATABASE_URL,
  TUXEVIL_ROTATOR_DATABASE_URL: process.env.TUXEVIL_ROTATOR_DATABASE_URL,
  PI_ROTATOR_DATABASE_URL: process.env.PI_ROTATOR_DATABASE_URL,
  TZ: process.env.TZ,
};
const testDir = mkdtempSync(join(tmpdir(), "tuxevil-token-rollup-"));
process.env.TUXEVIL_ROTATOR_DIR = testDir;
process.env.PI_ROTATOR_DIR = testDir;
delete process.env.DATABASE_URL;
delete process.env.TUXEVIL_ROTATOR_DATABASE_URL;
delete process.env.PI_ROTATOR_DATABASE_URL;

// These modules resolve their config paths during import, so load them only
// after the isolated test directory has been selected above.
const { AccountRotator } = await import("../src/rotator.js");
const { initDb, closeDb } = await import("../src/db-store.js");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MODEL = "claude-sonnet-4-6";

function makeConfig(): Config {
  return {
    proxyPort: 51200,
    bindHost: "0.0.0.0",
    routingPolicy: "timer-first",
    requestsPerRotation: 5,
    rotateOnQuotaDrop: 20,
    quotaPollIntervalMs: 300000,
    accounts: [{ email: "a@example.com", refreshToken: "a", projectId: "pa", tier: "free" }],
  };
}

// Period keys are UTC, whatever the host timezone.
const minuteKey = (ms: number) => new Date(ms).toISOString().slice(0, 16);
const hourKey = (ms: number) => new Date(ms).toISOString().slice(0, 13);
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const monthKey = (ms: number) => new Date(ms).toISOString().slice(0, 7);

function bucket(period: string): TokenBucket {
  return {
    period,
    inputTokens: 100,
    outputTokens: 10,
    requests: 1,
    byModel: { [MODEL]: { inputTokens: 100, outputTokens: 10, requests: 1 } },
  };
}

describe("token usage rollup", () => {
  before(async () => {
    await initDb();
  });

  after(async () => {
    await closeDb();
    rmSync(testDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // Ahead of UTC, behind it, and UTC itself: the cutoffs must not move.
  for (const tz of ["UTC", "Pacific/Auckland", "America/Los_Angeles"]) {
    it(`moves stale buckets up one tier and keeps the rest (TZ=${tz})`, async () => {
      process.env.TZ = tz;
      const rotator = new AccountRotator(makeConfig()) as any;
      rotator.stopQuotaPolling();

      const now = Date.now();
      const staleMinute = now - 13 * HOUR;
      const freshMinute = now - 1 * HOUR;
      const staleHour = now - 63 * DAY;
      const freshHour = now - 30 * DAY;
      const staleDay = now - 90 * DAY;
      rotator.tokenBuckets = {
        minutes: [bucket(minuteKey(staleMinute)), bucket(minuteKey(freshMinute))],
        hours: [bucket(hourKey(staleHour)), bucket(hourKey(freshHour))],
        days: [bucket(dayKey(staleDay))],
        months: [],
      };

      rotator.recordTokenUsage(MODEL, 100, 10);
      const usage = rotator.getTokenUsage();
      const periods = (tier: TokenBucket[]) => tier.map((b) => b.period);

      // Minutes: 12 hours are kept; the 13-hour-old one is now an hour bucket.
      assert.equal(usage.minutes.length, 2, "the fresh minute and the one just recorded");
      assert.ok(periods(usage.minutes).includes(minuteKey(freshMinute)));
      assert.ok(!periods(usage.minutes).includes(minuteKey(staleMinute)));

      // Hours: the 30-day-old bucket stays, the 63-day-old one is rolled up.
      assert.deepEqual(
        periods(usage.hours).sort(),
        [hourKey(freshHour), hourKey(staleMinute)].sort(),
      );

      // Days are kept no longer than hours, so stale ones land in their month.
      assert.deepEqual(usage.days, []);
      assert.deepEqual(
        periods(usage.months).sort(),
        [...new Set([monthKey(staleHour), monthKey(staleDay)])].sort(),
      );

      // Nothing is lost or counted twice on the way up.
      assert.equal(usage.totalRequests, 6);
      assert.equal(usage.totalInputTokens, 600);
      assert.equal(usage.totalOutputTokens, 60);

      await rotator.flushPendingTokenUsageSave();
    });
  }

  it("counts a partly rolled-up period in full", () => {
    process.env.TZ = "UTC";
    const rotator = new AccountRotator(makeConfig()) as any;
    rotator.stopQuotaPolling();

    // The cutoff usually falls inside a period: its older part has moved up
    // a tier while the rest is still waiting below. Both halves are real,
    // distinct traffic.
    const now = Date.now();
    const hour = Math.floor((now - 6 * HOUR) / HOUR) * HOUR;
    const day = Math.floor((now - 20 * DAY) / DAY) * DAY;
    const oldDay = now - 70 * DAY;
    rotator.tokenBuckets = {
      minutes: [bucket(minuteKey(hour + 45 * 60_000))],
      hours: [bucket(hourKey(hour)), bucket(hourKey(day + 5 * HOUR))],
      days: [bucket(dayKey(day)), bucket(dayKey(oldDay))],
      months: [bucket(monthKey(oldDay))],
    };

    const usage = rotator.getTokenUsage();
    assert.equal(usage.totalRequests, 6);
    assert.equal(usage.totalInputTokens, 600);
    assert.equal(usage.totalOutputTokens, 60);
    assert.deepEqual(usage.tokensByModel[MODEL], { input: 600, output: 60, requests: 6 });
  });

  it("keeps every hour the 61-day activity window reads", async () => {
    process.env.TZ = "UTC";
    const rotator = new AccountRotator(makeConfig()) as any;
    rotator.stopQuotaPolling();

    const now = Date.now();
    const insideWindow = now - 61 * DAY + HOUR;
    rotator.tokenBuckets = {
      minutes: [],
      hours: [bucket(hourKey(insideWindow))],
      days: [],
      months: [],
    };

    rotator.recordTokenUsage(MODEL, 100, 10);
    assert.deepEqual(
      rotator.getTokenUsage().hours.map((b: TokenBucket) => b.period),
      [hourKey(insideWindow)],
    );

    await rotator.flushPendingTokenUsageSave();
  });
});
