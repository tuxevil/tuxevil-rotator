// Pure view-model logic behind the dashboard app (src/web/lib).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DashboardAccount, DashboardOverview, UsageBucket } from "../src/dashboard-types.js";
import type { ModelQuota } from "../src/types.js";
import { actionableCount, buildAttention } from "../src/web/lib/attention.js";
import { ACCOUNT_FILTERS, matchesQuery, sortAccounts } from "../src/web/lib/accounts.js";
import { modelColor } from "../src/web/lib/colors.js";
import { formatCompact, formatDuration, formatMs, formatUsd } from "../src/web/lib/format.js";
import { createMasker } from "../src/web/lib/mask.js";
import { buildPools, poolKeyForModel } from "../src/web/lib/pools.js";
import { errorHint, isKickstartable, quotaProvider } from "../src/web/lib/status.js";
import {
  aggregateBars,
  buildHeatmap,
  computeSavings,
  formatAxisTokens,
  LEGACY_RANGES,
  localDayKey,
  niceAxis,
  RANGE_SPECS,
  tickIndices,
} from "../src/web/lib/usage.js";

const NOW = Date.UTC(2026, 9, 3, 12, 2, 30);
const H = 3_600_000;

function quota(modelKey: string, percentRemaining: number, extra: Partial<ModelQuota> = {}): ModelQuota {
  return {
    modelKey,
    displayName: modelKey.charAt(0).toUpperCase() + modelKey.slice(1),
    percentRemaining,
    resetTime: new Date(NOW + 2 * H).toISOString(),
    timerType: "5h",
    ...extra,
  };
}

function account(email: string, extra: Partial<DashboardAccount> = {}): DashboardAccount {
  return {
    email,
    label: email.split("@")[0],
    provider: "google-antigravity",
    status: "ready",
    activeForModels: [],
    requestsSinceRotation: 0,
    totalRequests: 0,
    dailyRequestCount: 0,
    dailyAccountStopRequests: 350,
    dailyProjectRequestCount: 0,
    dailyProjectStopRequests: 1200,
    cooldownsByModel: {},
    lastUsed: 0,
    lastError: null,
    consecutiveErrors: 0,
    hasValidToken: true,
    quota: [],
    inFlightRequests: 0,
    inFlightByModel: {},
    proDetected: false,
    tier: "pro",
    healthScore: 1,
    tokenBucket: { enabled: false, tokens: 0, capacity: 0, nextRefillAt: null },
    allowFreshWindowStartsOverride: false,
    effectiveFreshWindowStartsAllowed: true,
    ...extra,
  };
}

function diagEntry(email: string, score: number | null, rejectedReason: string | null = null) {
  return {
    email,
    label: email,
    status: "ready" as const,
    score,
    timerPriority: null,
    quota: null,
    tier: "pro" as const,
    healthScore: 1,
    healthBreakdown: { quotaComponent: 1, errorPenalty: 0, cooldownPenalty: 0, availabilityPenalty: 0, score: 1 },
    distance: null,
    tokenBucket: { enabled: false, tokens: 0, capacity: 0, nextRefillAt: null },
    rejectedReason: rejectedReason as never,
    rejectedDetail: null,
  };
}

function overview(extra: Partial<DashboardOverview> = {}): DashboardOverview {
  return {
    generatedAt: NOW,
    version: "3.10.0",
    proxyPort: 51200,
    startedAt: NOW - H,
    requestsPerRotation: 5,
    maxConcurrentRequestsPerAccount: 5,
    totalRequestsAllAccounts: 0,
    activeAccounts: {},
    accounts: [],
    protectivePause: { until: 0, reason: null },
    operatorControls: { allowFreshWindowStarts: true, autoWarmupEnabled: false },
    security: { adminTokenConfigured: true, warning: null, bindHost: "127.0.0.1" },
    routingHealth: {
      state: "healthy",
      reason: "",
      nextRetryAt: null,
      availableCount: 0,
      readyCount: 0,
      activeCount: 0,
      cooldownCount: 0,
      busyCount: 0,
      flaggedCount: 0,
      disabledCount: 0,
      errorCount: 0,
    },
    routingDiagnostics: {},
    circuitBreakers: { model: {}, project: {} },
    predictions: {},
    modelTierAccess: null,
    updateInfo: null,
    notifications: [],
    hostedOAuthConfigured: false,
    capabilities: { database: false },
    usage: { totalRequests: 0, totalInputTokens: 0, totalOutputTokens: 0, savingsUsd: 0 },
    traffic: [],
    recentRequestsByModel: {},
    ...extra,
  };
}

describe("model pools", () => {
  const fleet = overview({
    accounts: [
      account("a@x.dev", {
        tier: "ultra",
        quota: [quota("claude", 80, { resetTime: new Date(NOW + 3 * H).toISOString() }), quota("gemini", 10)],
      }),
      account("b@x.dev", {
        tier: "free",
        quota: [
          quota("claude", 0, { resetTime: new Date(NOW + 1 * H).toISOString() }),
          quota("gemini", 100, { resetTime: new Date(NOW + 5 * H).toISOString() }),
        ],
      }),
      account("c@x.dev", { status: "flagged", quota: [quota("claude", 100)] }),
    ],
    routingDiagnostics: {
      claude: {
        modelKey: "claude",
        policy: "timer-first",
        selectedEmail: "a@x.dev",
        reason: "",
        availableCandidates: 1,
        rejectedCandidates: 2,
        accounts: [diagEntry("a@x.dev", 9), diagEntry("b@x.dev", null, "quota-zero"), diagEntry("c@x.dev", null, "flagged")],
      },
      gemini: {
        modelKey: "gemini",
        policy: "timer-first",
        selectedEmail: "b@x.dev",
        reason: "",
        availableCandidates: 2,
        rejectedCandidates: 0,
        accounts: [diagEntry("a@x.dev", 3), diagEntry("b@x.dev", 8)],
      },
    },
    recentRequestsByModel: { "claude-sonnet-4-6": 30, "gpt-oss-120b-medium": 20 },
    activeAccounts: { claude: "a@x.dev", gemini: "a@x.dev" },
  });

  it("pools quota per model, weighted by tier, without out-of-service accounts", () => {
    const [claude, gemini] = buildPools(fleet, NOW);
    assert.equal(claude.key, "claude");
    assert.equal(claude.members.length, 2, "the quarantined account is not counted");
    assert.equal(claude.capacity, Math.round((80 * 2000) / 2250));
    assert.equal(claude.withQuota, 1);
    assert.equal(claude.serving?.email, "a@x.dev");
    assert.deepEqual(claude.nextUp, [], "rejected candidates are never next up");
    assert.equal(claude.nextResetAt, NOW + 1 * H, "the soonest real reset wins");
    assert.equal(claude.burnPerHour, 50, "gpt-oss draws from the Claude pool");
    assert.equal(claude.hoursLeft, (0.8 * 2000) / 50);
    assert.equal(claude.state, "ok");

    assert.equal(gemini.serving?.email, "a@x.dev", "serving is the active account, not the policy's next pick");
    assert.deepEqual(gemini.nextUp.map((a) => a.email), ["b@x.dev"]);
    assert.equal(gemini.hoursLeft, null, "no traffic means no estimate");
  });

  it("leaves serving empty until a pool has an active account, with the policy's pick next up", () => {
    const idle = overview({
      accounts: [account("a@x.dev", { quota: [quota("gemini", 100)] }), account("b@x.dev", { quota: [quota("gemini", 100)] })],
      routingDiagnostics: {
        gemini: {
          modelKey: "gemini",
          policy: "timer-first",
          selectedEmail: "a@x.dev",
          reason: "",
          availableCandidates: 2,
          rejectedCandidates: 0,
          accounts: [diagEntry("a@x.dev", 3), diagEntry("b@x.dev", 8)],
        },
      },
    });
    const [gemini] = buildPools(idle, NOW);
    assert.equal(gemini.serving, null);
    assert.deepEqual(gemini.nextUp.map((a) => a.email), ["a@x.dev", "b@x.dev"], "the policy's pick leads even with a lower score");
    assert.equal(gemini.state, "ok", "an unused pool is not blocked");
  });

  it("ignores rolling windows that have not started when looking for the next reset", () => {
    const pools = buildPools(
      overview({
        accounts: [account("a@x.dev", { quota: [quota("claude", 100, { resetTime: new Date(NOW + 5 * H).toISOString() })] })],
      }),
      NOW,
    );
    assert.equal(pools[0].nextResetAt, null);
  });

  it("marks pools blocked by a breaker, low, or empty", () => {
    const blocked = buildPools({ ...fleet, circuitBreakers: { model: { claude: NOW + 60_000 }, project: {} } }, NOW);
    assert.equal(blocked[0].state, "blocked");
    assert.equal(blocked[0].breakerUntil, NOW + 60_000);

    const low = buildPools(overview({ accounts: [account("a@x.dev", { quota: [quota("claude", 12)] })] }), NOW);
    assert.equal(low[0].state, "low");
    const empty = buildPools(overview({ accounts: [account("a@x.dev", { quota: [quota("claude", 0)] })] }), NOW);
    assert.equal(empty[0].state, "blocked", "no account with quota means nothing can serve");
  });

  it("maps request models to quota pools", () => {
    assert.equal(poolKeyForModel("claude-opus-4-6-thinking"), "claude");
    assert.equal(poolKeyForModel("gpt-oss-120b-medium"), "claude");
    assert.equal(poolKeyForModel("gemini-3.8-flash-low"), "gemini");
    assert.equal(poolKeyForModel("gpt-5.6-terra"), "openai-codex");
    assert.equal(poolKeyForModel("big-pickle"), "opencode-zen");
    assert.equal(poolKeyForModel("glm-5.1"), "session");
  });
});

describe("attention items", () => {
  const data = overview({
    accounts: [
      account("flag@x.dev", { status: "flagged", lastError: "Account requires verification" }),
      account("err@x.dev", { status: "error", lastError: "HTTP 429" }),
      account("off@x.dev", { status: "disabled" }),
      account("ok@x.dev", { tier: "free" }),
    ],
    circuitBreakers: { model: { gemini: NOW + 600_000 }, project: {} },
    routingDiagnostics: {
      gemini: { modelKey: "gemini", policy: "timer-first", selectedEmail: null, reason: "breaker", availableCandidates: 0, rejectedCandidates: 1, accounts: [] },
      claude: { modelKey: "claude", policy: "timer-first", selectedEmail: null, reason: "all accounts out of quota", availableCandidates: 0, rejectedCandidates: 1, accounts: [] },
      __default__: { modelKey: "__default__", policy: "timer-first", selectedEmail: null, reason: "", availableCandidates: 0, rejectedCandidates: 0, accounts: [] },
    },
    protectivePause: { until: NOW + H, reason: "Provider flag" },
    modelTierAccess: { "gpt-oss:120b": "free", "glm-5.1": "subscription" },
  });

  it("lists every problem with the action that fixes it, most severe first", () => {
    const items = buildAttention(data, NOW, (email) => `name(${email})`);
    const ids = items.map((i) => i.id);
    assert.deepEqual(items.slice(0, 2).map((i) => i.id), ["protective-pause", "flagged:flag@x.dev"]);
    assert.ok(ids.includes("protective-pause"));
    assert.ok(!ids.includes("unroutable:claude"), "the pause explains why nothing routes");

    const flagged = items.find((i) => i.id === "flagged:flag@x.dev")!;
    assert.equal(flagged.title, "name(flag@x.dev) is quarantined");
    assert.deepEqual(flagged.actions.map((a) => a.kind), ["open-account", "restore"]);
    assert.match(flagged.hint ?? "", /Antigravity IDE/);

    assert.deepEqual(items.find((i) => i.id === "error:err@x.dev")!.actions.map((a) => a.kind), ["open-account", "disable"]);
    assert.deepEqual(items.find((i) => i.id === "disabled:off@x.dev")!.actions.map((a) => a.kind), ["open-account", "enable"]);
    assert.deepEqual(items.find((i) => i.id === "breaker:gemini")!.actions[0], { kind: "reset-breaker", model: "gemini" });

    const tier = items.find((i) => i.id === "free-tier-models")!;
    assert.equal(tier.severity, "info");
    assert.deepEqual(tier.chips, [
      { label: "gpt-oss:120b", tone: "ok" },
      { label: "glm-5.1", tone: "bad" },
    ]);

    assert.equal(actionableCount(items), items.filter((i) => i.severity !== "info").length);
  });

  it("names unroutable models when routing is not paused", () => {
    const items = buildAttention({ ...data, protectivePause: { until: 0, reason: null } }, NOW);
    const ids = items.map((i) => i.id);
    assert.ok(ids.includes("unroutable:claude"));
    assert.ok(!ids.includes("unroutable:gemini"), "the breaker item already explains gemini");
    assert.ok(!ids.includes("unroutable:__default__"));
    assert.equal(items[0].severity, "critical");
  });

  it("is empty for a healthy fleet", () => {
    assert.deepEqual(buildAttention(overview({ accounts: [account("a@x.dev")] }), NOW), []);
  });

  it("names the exposure warning after what is exposed, and makes it a note inside a container", () => {
    const exposed = (security: Partial<DashboardOverview["security"]>) =>
      buildAttention(
        overview({
          accounts: [account("a@x.dev")],
          security: { adminTokenConfigured: true, warning: "Proxy routes are unauthenticated.", bindHost: "0.0.0.0", ...security },
        }),
        NOW,
      ).find((i) => i.id === "security")!;

    const host = exposed({});
    assert.equal(host.title, "Proxy listens on all interfaces");
    assert.equal(host.severity, "warning");
    assert.match(host.hint ?? "", /bindHost to 127\.0\.0\.1/);

    const container = exposed({ inContainer: true });
    assert.equal(container.severity, "info", "the container cannot see where its port is published");
    assert.equal(container.hint, null, "bindHost advice does not apply in a container");

    const noToken = exposed({ inContainer: true, adminTokenConfigured: false });
    assert.equal(noToken.title, "Admin routes are exposed");
    assert.equal(noToken.severity, "warning");
  });
});

describe("token chart math", () => {
  const bucket = (start: number, span: number, inputTokens: number): UsageBucket => ({
    start,
    span,
    inputTokens,
    outputTokens: 0,
    requests: 1,
    byModel: { "claude-sonnet-4-6": { inputTokens, outputTokens: 0, requests: 1 } },
  });
  const minute = (iso: string) => Date.parse(`${iso}:00Z`);

  it("places buckets in clock-aligned bars and never smears coarse buckets", () => {
    const buckets = [
      bucket(minute("2026-10-03T12:01"), 60_000, 100),
      bucket(minute("2026-10-03T11:58"), 60_000, 40),
      bucket(Date.parse("2026-10-03T08:00:00Z"), H, 5000),
    ];
    const sixHours = aggregateBars(buckets, RANGE_SPECS["6h"], NOW);
    assert.equal(sixHours.length, 72);
    assert.equal(sixHours.reduce((s, b) => s + b.inputTokens, 0), 140, "the hourly bucket cannot fit a 5-minute bar");
    assert.equal(sixHours.at(-1)!.inputTokens, 100);

    const day = aggregateBars(buckets, RANGE_SPECS["24h"], NOW);
    assert.equal(day.length, 24);
    assert.equal(day.reduce((s, b) => s + b.inputTokens, 0), 5140);
    assert.ok(day.every((b, i) => i === 0 || b.start === day[i - 1].end), "bars are contiguous");
  });

  it("picks round axis steps and thins tick labels", () => {
    assert.deepEqual(niceAxis(1_870_000, 5), { max: 2_000_000, step: 500_000 });
    assert.deepEqual(niceAxis(206_200, 5), { max: 250_000, step: 50_000 });
    assert.deepEqual(niceAxis(0, 5), { max: 1, step: 1 });
    assert.equal(formatAxisTokens(1_500_000), "1.5M");
    assert.equal(formatAxisTokens(9_990_000_000), "10B");
    const bars = aggregateBars([], RANGE_SPECS["1h"], NOW);
    const ticks = tickIndices(bars, RANGE_SPECS["1h"], 6);
    assert.ok(ticks.every((t, i) => i === 0 || (t - ticks[i - 1]) * 6 >= 72), "labels keep a minimum gap");
  });

  it("computes savings from server prices, optionally for visible models only", () => {
    const pricing = { "gpt-5.6-sol": { inputPer1M: 5, outputPer1M: 30 }, "gpt-5.6-luna": { inputPer1M: 0.2, outputPer1M: 1.2 } };
    const bars = [
      {
        byModel: {
          "gpt-5.6-sol": { inputTokens: 1_000_000, outputTokens: 1_000_000, requests: 1 },
          "gpt-5.6-luna": { inputTokens: 1_000_000, outputTokens: 1_000_000, requests: 1 },
          "unpriced-model": { inputTokens: 9_000_000, outputTokens: 0, requests: 1 },
        },
      },
    ];
    const all = computeSavings(bars, pricing);
    assert.equal(all.byModel["gpt-5.6-sol"], 35);
    assert.equal(Math.round(all.byModel["gpt-5.6-luna"] * 100) / 100, 1.4);
    assert.equal(all.byModel["unpriced-model"], undefined);
    assert.equal(computeSavings(bars, pricing, new Set(["gpt-5.6-luna"])).byModel["gpt-5.6-sol"], undefined);
  });

  it("maps legacy saved ranges", () => {
    assert.equal(LEGACY_RANGES["1m"], "30d");
    assert.equal(LEGACY_RANGES["1d"], "24h");
  });

  it("places hourly activity on the viewer's local day and hour", () => {
    const start = Date.parse("2026-10-02T15:00:00Z");
    const map = buildHeatmap([[start, 7]], NOW, 60);
    assert.equal(map.days.length, 60);
    assert.equal(map.days.at(-1)!.key, localDayKey(NOW));
    assert.equal(map.cells.get(`${localDayKey(start)}|${new Date(start).getHours()}`), 7);
    assert.equal(map.max, 7);
  });
});

describe("accounts list", () => {
  const list = [
    account("zed@x.dev", { label: "Zed", status: "error", quota: [quota("claude", 90)] }),
    account("amy@x.dev", { label: "Amy", status: "ready", quota: [quota("claude", 20)] }),
    account("bo@x.dev", { label: "Bo", status: "cooldown", provider: "ollama" }),
  ];

  it("filters by status group", () => {
    const count = (id: string) => list.filter(ACCOUNT_FILTERS.find((f) => f.id === id)!.match).length;
    assert.equal(count("all"), 3);
    assert.equal(count("serving"), 1);
    assert.equal(count("cooling"), 1);
    assert.equal(count("attention"), 1);
  });

  it("searches names, providers and pools, but not hidden emails", () => {
    assert.ok(matchesQuery(list[2], "ollama", "Bo", false));
    assert.ok(matchesQuery(list[0], "claude", "Zed", false));
    assert.ok(matchesQuery(list[1], "amy@x", "Amy", false));
    assert.ok(!matchesQuery(list[1], "amy@x", "Account 1", true), "masked emails are not searchable");
  });

  it("sorts by quota and by name", () => {
    const name = (email: string) => list.find((a) => a.email === email)!.label;
    assert.deepEqual(sortAccounts(list, "quota", -1, name).map((a) => a.label), ["Zed", "Amy", "Bo"]);
    assert.deepEqual(sortAccounts(list, "name", 1, name).map((a) => a.label), ["Amy", "Bo", "Zed"]);
  });
});

describe("privacy mask", () => {
  const accounts = [
    { email: "zoe@corp.com", label: "Zoe Work" },
    { email: "al@corp.com", label: "Al" },
  ];

  it("passes values through when off", () => {
    const m = createMasker(accounts, false);
    assert.equal(m.name("zoe@corp.com"), "Zoe Work");
    assert.equal(m.email("zoe@corp.com"), "zoe@corp.com");
    assert.equal(m.text("rotated to zoe@corp.com"), "rotated to zoe@corp.com");
  });

  it("replaces names, emails, keys and IPs with stable aliases", () => {
    const m = createMasker(accounts, true);
    assert.equal(m.name("al@corp.com"), "Account 1", "aliases follow email order");
    assert.equal(m.name("zoe@corp.com"), "Account 2");
    assert.equal(m.name("Zoe Work"), "Account 2", "request logs name accounts by label");
    assert.equal(m.name(""), "");
    assert.equal(m.email("zoe@corp.com"), "account-2@•••");
    assert.equal(m.text("Zoe Work hit 429; rotated to al@corp.com, cc bob@else.org"), "Account 2 hit 429; rotated to Account 1, cc •••@•••");
    assert.equal(m.text("Alert: Al is cooling down"), "Alert: Account 1 is cooling down", "labels are replaced as whole words");
    assert.equal(m.key("rk-abc123"), "rk-•••");
    assert.equal(m.key("cursor-laptop"), "Key 1");
    assert.equal(m.key("unauthenticated"), "unauthenticated");
    assert.equal(m.ip("192.168.4.20"), "192.168.x.x");
  });
});

describe("status and formatting helpers", () => {
  it("only offers kickstart for idle pools that support it", () => {
    assert.equal(isKickstartable(quota("claude", 100, { timerType: "fresh" })), true);
    assert.equal(isKickstartable(quota("claude", 100, { timerType: "5h" })), false);
    assert.equal(isKickstartable(quota("openai-codex", 100, { timerType: "fresh", providerId: "openai-codex" })), true);
    assert.equal(isKickstartable(quota("session", 100, { timerType: "fresh", providerId: "ollama" })), true);
    assert.equal(isKickstartable(quota("weekly", 100, { timerType: "fresh", providerId: "ollama" })), false);
    assert.equal(isKickstartable(quota("opencode-zen", 100, { timerType: "fresh", providerId: "opencode-zen" })), false);
  });

  it("infers the provider of a quota pool", () => {
    assert.equal(quotaProvider({ modelKey: "gemini" }), "google-antigravity");
    assert.equal(quotaProvider({ modelKey: "monthly" }), "ollama");
    assert.equal(quotaProvider({ modelKey: "openai-codex-spark" }), "openai-codex");
    assert.equal(quotaProvider({ modelKey: "x", providerId: "opencode-zen" }), "opencode-zen");
  });

  it("explains errors that need action outside the rotator", () => {
    assert.match(errorHint("HTTP 403: account requires verification") ?? "", /Antigravity IDE/);
    assert.match(errorHint("violates the Terms of Service") ?? "", /Account Recovery/);
    assert.equal(errorHint("HTTP 500"), null);
  });

  it("formats durations, counts, money and latency compactly", () => {
    assert.equal(formatDuration(3 * 86_400_000 + 23 * H + 59 * 60_000), "3d 23h");
    assert.equal(formatDuration(4 * H + 47 * 60_000 + 30_000), "4h 47m");
    assert.equal(formatDuration(0), "—");
    assert.equal(formatCompact(1_234_567), "1.2M");
    assert.equal(formatCompact(999), "999");
    assert.equal(formatUsd(0.000042), "$0.000042");
    assert.equal(formatUsd(0.0042), "$0.0042");
    assert.equal(formatUsd(12_345.6), "$12,345.60");
    assert.equal(formatMs(450), "450ms");
    assert.equal(formatMs(12_340), "12.3s");
  });

  it("keeps model families in distinct chart colors", () => {
    assert.equal(modelColor("claude-opus-4-6-thinking"), "#b91c1c");
    assert.equal(modelColor("claude-sonnet-4-6"), "#ef4444");
    assert.equal(modelColor("gpt-oss-120b-medium"), "#fca5a5");
    assert.equal(modelColor("gemini-3.1-pro-high"), modelColor("gemini-3.1-pro-low"));
    assert.notEqual(modelColor("gemini-3.1-pro-high"), modelColor("gemini-3.8-flash-high"));
    assert.notEqual(modelColor("gemini-3.8-flash-high"), modelColor("gemini-3.6-flash-high"));
    assert.equal(modelColor("kimi-k3"), "#047857");
    assert.equal(modelColor("gpt-5.6-terra"), "#eab308");
    assert.notEqual(modelColor("gpt-5.6-sol"), modelColor("claude-opus-4-6-thinking"));
  });
});
