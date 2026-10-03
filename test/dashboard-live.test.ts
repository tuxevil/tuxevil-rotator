import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildActivity,
  buildOverview,
  buildUsage,
  DashboardLiveHub,
  periodStart,
  tokenUsageCsv,
} from "../src/dashboard-live.js";
import { getModelPricing, type StatusResponse, type TokenBucket, type TokenUsageData } from "../src/types.js";

const NOW = Date.UTC(2026, 9, 3, 12, 30, 15);
const M = 60_000;
const H = 60 * M;

function bucket(period: string, model: string, input: number, requests = 1): TokenBucket {
  return {
    period,
    inputTokens: input,
    outputTokens: input / 10,
    requests,
    byModel: { [model]: { inputTokens: input, outputTokens: input / 10, requests } },
  };
}

function minuteKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16);
}

function account(email: string, extra: Record<string, unknown> = {}) {
  return {
    email,
    label: email.split("@")[0],
    provider: "google-antigravity",
    status: "ready",
    activeForModels: [],
    requestsSinceRotation: 0,
    totalRequests: 10,
    dailyRequestCount: 0,
    dailyAccountStopRequests: 350,
    dailyProjectRequestCount: 0,
    dailyProjectStopRequests: 1200,
    cooldownsByModel: {},
    lastUsed: NOW - H,
    lastError: null,
    consecutiveErrors: 0,
    hasValidToken: true,
    quota: [{ modelKey: "claude", displayName: "Claude", percentRemaining: 50, resetTime: null, timerType: "5h" }],
    inFlightRequests: 0,
    inFlightByModel: {},
    proDetected: false,
    tier: "pro",
    healthScore: 0.9,
    tokenBucket: { enabled: true, tokens: 2.04, capacity: 5, nextRefillInMs: 12_400 },
    allowFreshWindowStartsOverride: false,
    effectiveFreshWindowStartsAllowed: true,
    ...extra,
  };
}

/** The same rotator state observed `ms` later: every countdown has ticked down. */
function elapsed(status: StatusResponse, ms: number): StatusResponse {
  return {
    ...status,
    uptime: status.uptime + ms,
    protectivePauseRemaining: Math.max(0, status.protectivePauseRemaining - ms),
    routingHealth: { ...status.routingHealth, nextRetryIn: status.routingHealth.nextRetryIn - ms },
    accounts: status.accounts.map((a) => ({
      ...a,
      tokenBucket: { ...a.tokenBucket, nextRefillInMs: a.tokenBucket.nextRefillInMs - ms },
    })),
  };
}

function makeStatus(overrides: Partial<StatusResponse> = {}): StatusResponse {
  return {
    version: "3.10.0",
    proxyPort: 51200,
    requestsPerRotation: 5,
    maxConcurrentRequestsPerAccount: 5,
    totalRequestsAllAccounts: 20,
    uptime: 3 * H,
    activeAccounts: { claude: "a@x.dev" },
    accounts: [account("a@x.dev"), account("b@x.dev")] as never,
    protectivePauseUntil: NOW + 2 * H,
    protectivePauseRemaining: 2 * H,
    protectivePauseReason: "flagged",
    operatorControls: { allowFreshWindowStarts: true, autoWarmupEnabled: false },
    security: { adminTokenConfigured: true, warning: null, bindHost: "127.0.0.1" },
    routingDiagnostics: {},
    ollamaModels: [],
    predictions: {},
    circuitBreakers: {
      model: { gemini: { until: NOW + 10 * M, remainingMs: 10 * M } },
      project: { "p::claude": { until: NOW - M, remainingMs: 0 } },
    },
    routingHealth: {
      state: "healthy",
      reason: "ok",
      nextRetryIn: 90_400,
      availableCount: 2,
      readyCount: 2,
      activeCount: 0,
      cooldownCount: 0,
      busyCount: 0,
      flaggedCount: 0,
      disabledCount: 0,
      errorCount: 0,
    },
    recentEvents: [],
    requestLog: [],
    tokenUsage: {
      minutes: [bucket(minuteKey(NOW - 2 * M), "claude-sonnet-4-6", 1000, 3), bucket(minuteKey(NOW - 90 * M), "claude-sonnet-4-6", 50)],
      hours: [],
      days: [],
      months: [],
      totalInputTokens: 1050,
      totalOutputTokens: 105,
      totalRequests: 4,
      tokensByModel: {},
      savings: { totalUsd: 0.5, byModel: {} },
    },
    latencyStats: {},
    ...overrides,
  };
}

describe("buildOverview", () => {
  it("turns countdowns into absolute timestamps", () => {
    const overview = buildOverview(makeStatus(), NOW, { database: false });
    assert.equal(overview.startedAt, Math.round((NOW - 3 * H) / 1000) * 1000);
    assert.equal(overview.routingHealth.nextRetryAt, Math.round((NOW + 90_400) / 1000) * 1000);
    assert.equal(overview.accounts[0].tokenBucket.nextRefillAt, Math.round((NOW + 12_400) / 1000) * 1000);
    assert.equal(overview.accounts[0].tokenBucket.tokens, 2);
    assert.equal(overview.protectivePause.until, NOW + 2 * H);
    assert.deepEqual(overview.circuitBreakers.model, { gemini: NOW + 10 * M });
    assert.deepEqual(overview.circuitBreakers.project, {}, "expired breakers are dropped");
    assert.equal("uptime" in overview, false);
    assert.equal("requestLog" in overview, false, "history stays out of the overview");
    assert.equal("tokenUsage" in overview, false);
  });

  it("is identical a second later when nothing changed", () => {
    const status = makeStatus();
    const a = buildOverview(status, NOW, { database: true });
    const b = buildOverview(elapsed(status, 1000), NOW + 1000, { database: true });
    const { generatedAt: _a, ...restA } = a;
    const { generatedAt: _b, ...restB } = b;
    assert.equal(JSON.stringify(restA), JSON.stringify(restB));
  });

  it("summarizes the last hour of traffic per minute and per model", () => {
    const overview = buildOverview(makeStatus(), NOW, { database: false });
    assert.equal(overview.traffic.length, 60);
    assert.equal(overview.traffic.reduce((s, m) => s + m.requests, 0), 3, "the 90-minute-old bucket is outside the hour");
    assert.equal(overview.traffic[57].requests, 3);
    assert.deepEqual(overview.recentRequestsByModel, { "claude-sonnet-4-6": 3 });
    assert.equal(overview.usage.totalRequests, 4);
  });
});

describe("DashboardLiveHub", () => {
  function hubFor(state: { status: StatusResponse }) {
    let now = NOW;
    const hub = new DashboardLiveHub({
      getStatus: () => state.status,
      capabilities: () => ({ database: false }),
      now: () => now,
    });
    return { hub, tick: (ms = 1000) => (now += ms) };
  }

  it("sends nothing on the first collect or when nothing changed", () => {
    const state = { status: makeStatus() };
    const { hub, tick } = hubFor(state);
    assert.deepEqual(hub.collect(), []);
    tick(1000);
    state.status = elapsed(state.status, 1000);
    assert.deepEqual(hub.collect(), []);
  });

  it("sends only the accounts that changed", () => {
    const state = { status: makeStatus() };
    const { hub } = hubFor(state);
    hub.collect();
    state.status = makeStatus({
      accounts: [account("a@x.dev"), account("b@x.dev", { status: "error", lastError: "429" })] as never,
    });
    const messages = hub.collect();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, "accounts");
    const patch = messages[0].data as { upsert: Array<{ email: string }>; remove: string[]; order?: string[] };
    assert.deepEqual(patch.upsert.map((a) => a.email), ["b@x.dev"]);
    assert.deepEqual(patch.remove, []);
    assert.equal(patch.order, undefined);
  });

  it("reports removed accounts and order changes", () => {
    const state = { status: makeStatus() };
    const { hub } = hubFor(state);
    hub.collect();
    state.status = makeStatus({ accounts: [account("b@x.dev")] as never });
    const [message] = hub.collect();
    assert.equal(message.type, "accounts");
    assert.deepEqual((message.data as { remove: string[] }).remove, ["a@x.dev"]);
    assert.deepEqual((message.data as { order: string[] }).order, ["b@x.dev"]);
  });

  it("sends changed overview sections without the accounts", () => {
    const state = { status: makeStatus() };
    const { hub } = hubFor(state);
    hub.collect();
    state.status = makeStatus({ operatorControls: { allowFreshWindowStarts: false, autoWarmupEnabled: false } });
    const [message] = hub.collect();
    assert.equal(message.type, "overview");
    const data = message.data as Record<string, unknown>;
    assert.deepEqual(data.operatorControls, { allowFreshWindowStarts: false, autoWarmupEnabled: false });
    assert.equal("accounts" in data, false);
    assert.equal("routingHealth" in data, false);
  });

  it("streams new requests and events once, with increasing ids", () => {
    const first = { timestamp: NOW - 5000, model: "m", account: "a@x.dev", statusCode: 200, ttfbMs: 1, totalMs: 2, inputTokens: 3, outputTokens: 4 };
    const state = { status: makeStatus({ requestLog: [first] }) };
    const { hub } = hubFor(state);
    hub.collect();
    const snapshot = hub.snapshot();
    assert.equal(snapshot.requests.length, 1);

    const second = { ...first, timestamp: NOW, statusCode: 429 };
    const event = { timestamp: NOW, source: "rotator" as const, level: "warn" as const, message: "rotated" };
    state.status = makeStatus({ requestLog: [second, first], recentEvents: [event] });
    const messages = hub.collect();
    const requests = messages.find((m) => m.type === "requests")!.data as Array<{ id: number; statusCode: number }>;
    assert.deepEqual(requests.map((r) => r.statusCode), [429]);
    assert.ok(requests[0].id > snapshot.requests[0].id);
    const events = messages.find((m) => m.type === "events")!.data as Array<{ message: string }>;
    assert.deepEqual(events.map((e) => e.message), ["rotated"]);
    assert.deepEqual(hub.collect().filter((m) => m.type === "requests" || m.type === "events"), [], "nothing is resent");
  });

  it("writes a snapshot, then patches, to connected clients", () => {
    const state = { status: makeStatus() };
    const { hub } = hubFor(state);
    const writes: string[] = [];
    let onClose: () => void = () => {};
    const res = {
      writeHead() {},
      write(chunk: string) {
        writes.push(chunk);
        return true;
      },
      on(event: string, listener: () => void) {
        if (event === "close") onClose = listener;
      },
      end() {},
    };
    hub.addClient(res as never);
    assert.equal(hub.clientCount, 1);
    assert.match(writes.join(""), /event: snapshot\ndata: \{"overview"/);
    state.status = makeStatus({ accounts: [account("a@x.dev", { status: "disabled" }), account("b@x.dev")] as never });
    hub.tick();
    assert.match(writes.at(-1)!, /^event: accounts\ndata: /);
    onClose();
    assert.equal(hub.clientCount, 0);
    hub.close();
  });
});

describe("usage history", () => {
  const usage: TokenUsageData = {
    minutes: [
      bucket(minuteKey(NOW - 30 * M), "claude-sonnet-4-6", 100),
      bucket(minuteKey(NOW - 5 * H), "gemini-3.7-flash-tiered", 200),
      bucket(minuteKey(NOW - 5 * H + M), "gemini-3.7-flash-tiered", 300),
    ],
    hours: [bucket("2026-10-01T08", "gpt-5.6-terra", 5000)],
    days: [bucket("2026-09-10", "claude-sonnet-4-6", 9000)],
    months: [bucket("2026-01", "claude-sonnet-4-6", 1)],
    totalInputTokens: 14_601,
    totalOutputTokens: 1460,
    totalRequests: 6,
    tokensByModel: {},
    savings: { totalUsd: 1.5, byModel: {} },
  };

  it("returns only buckets that fit the range window and granularity", () => {
    const hour = buildUsage(usage, {}, "1h", NOW);
    assert.deepEqual(hour.buckets.map((b) => b.start), [NOW - 30 * M - ((NOW - 30 * M) % M)]);
    assert.ok(hour.buckets.every((b) => b.span === M));

    const day = buildUsage(usage, {}, "24h", NOW);
    assert.equal(day.buckets.length, 3, "minutes only; the hourly bucket is two days old");

    const week = buildUsage(usage, {}, "7d", NOW);
    assert.ok(week.buckets.every((b) => b.span === H), "minutes are rolled into hours for long ranges");
    const fiveHoursAgo = week.buckets.find((b) => b.byModel["gemini-3.7-flash-tiered"]);
    assert.equal(fiveHoursAgo?.inputTokens, 500, "both minutes land in one hour bucket");
    assert.ok(week.buckets.some((b) => b.byModel["gpt-5.6-terra"]));

    const month = buildUsage(usage, {}, "30d", NOW);
    assert.ok(month.buckets.some((b) => b.span === 24 * H), "daily buckets are included for 30d");
    assert.ok(!month.buckets.some((b) => b.start === periodStart("2026-01")), "monthly rollups never appear");
  });

  it("prices models with the server price list", () => {
    const week = buildUsage(usage, {}, "7d", NOW);
    for (const model of ["claude-sonnet-4-6", "gemini-3.7-flash-tiered", "gpt-5.6-terra"]) {
      const price = getModelPricing(model)!;
      assert.deepEqual(week.pricing[model], { inputPer1M: price.inputPer1M, outputPer1M: price.outputPer1M });
    }
    assert.equal(week.pricing["gemini-3.7-flash-tiered"].inputPer1M, 0.75);
    assert.equal(week.allTime.requests, 6);
  });

  it("builds hourly activity for the last 60 days", () => {
    const activity = buildActivity(usage, NOW);
    const total = activity.hours.reduce((sum, [, requests]) => sum + requests, 0);
    assert.equal(total, 4, "minutes and hours count; days and months are outside the hourly view");
    assert.ok(activity.hours.every(([start], i) => i === 0 || start > activity.hours[i - 1][0]));
  });

  it("exports usage as CSV with escaped model names", () => {
    const csv = tokenUsageCsv({ ...usage, minutes: [bucket(minuteKey(NOW), 'odd,"model"', 1)] });
    assert.match(csv, /^Tier,Period,Model,InputTokens,OutputTokens,Requests\n/);
    assert.match(csv, /minutes,[^,]+,"odd,""model""",1,0\.1,1/);
    const formula = tokenUsageCsv({ ...usage, minutes: [bucket(minuteKey(NOW), "=1+1", 1)] });
    assert.match(formula, /minutes,[^,]+,'=1\+1,1,0\.1,1/, "formula-leading names are neutralized");
  });
});
