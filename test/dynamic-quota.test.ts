import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DashboardOverview } from "../src/dashboard-types.js";
import type { AccountRuntime, Config, GoogleQuotaResponse, GoogleQuotaSummaryResponse } from "../src/types.js";

const savedEnv = {
  TUXEVIL_ROTATOR_DIR: process.env.TUXEVIL_ROTATOR_DIR,
  PI_ROTATOR_DIR: process.env.PI_ROTATOR_DIR,
  DATABASE_URL: process.env.DATABASE_URL,
  TUXEVIL_ROTATOR_DATABASE_URL: process.env.TUXEVIL_ROTATOR_DATABASE_URL,
  PI_ROTATOR_DATABASE_URL: process.env.PI_ROTATOR_DATABASE_URL,
};
const testDir = mkdtempSync(join(tmpdir(), "tuxevil-dynamic-quota-"));
process.env.TUXEVIL_ROTATOR_DIR = testDir;
process.env.PI_ROTATOR_DIR = testDir;
delete process.env.DATABASE_URL;
delete process.env.TUXEVIL_ROTATOR_DATABASE_URL;
delete process.env.PI_ROTATOR_DATABASE_URL;

const { getAccountIdentity, getCredentialGeneration } = await import("../src/account-identity.js");
const { initDb, closeDb, setCachedState } = await import("../src/db-store.js");
const { dynamicCatalog } = await import("../src/providers/google-antigravity/dynamic-catalog.js");
const {
  buildSummaryModelPoolMap,
  extractQuotas,
  fetchProviderQuota,
  parseGoogleQuotaSummaryResponse,
} = await import("../src/providers/google-antigravity/quota.js");
const { buildPools } = await import("../src/quota-pools.js");
const { AccountRotator } = await import("../src/rotator.js");
const { quotaPoolLabel } = await import("../src/web/lib/models.js");
const { timerLabel, windowShortLabel } = await import("../src/web/lib/status.js");

const H = 3_600_000;
const D = 24 * H;

function makeAccount(email: string, projectId = `proj-${email}`, tier: Config["accounts"][0]["tier"] = "pro"): AccountRuntime {
  return {
    config: {
      email,
      tier,
      credentials: [{ provider: "google-antigravity", refreshToken: `refresh-${email}`, projectId }],
    },
    accessToken: `access-${email}`,
    tokenExpires: Date.now() + 3600_000,
    requestsSinceRotation: 0,
    totalRequests: 0,
    cooldownsByModel: {},
    quotaExhaustedAt: 0,
    quota: [],
    lastQuotaPoll: 0,
    lastUsed: 0,
    lastError: null,
    consecutiveErrors: 0,
    disabled: false,
    flagged: false,
    inFlightRequests: 0,
    inFlightByModel: {},
    allowFreshWindowStartsOverride: false,
    dailyRequestCount: 0,
    dailyRequestDay: "2026-11-20",
    healthScore: 1,
    tokenBucket: { tokens: 50, lastRefillAt: Date.now() },
  };
}

describe("dynamic Google quota groups and windows", () => {
  before(async () => {
    await initDb();
  });

  beforeEach(async () => {
    dynamicCatalog.reset();
    await setCachedState({ modelAccounts: {}, accounts: {} });
  });

  after(async () => {
    await closeDb();
    rmSync(testDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("separates Argon, Gemini Models, and Claude/GPT groups with multi-window tracking and reconciles summary lag", () => {
    const now = Date.parse("2026-11-20T20:00:00Z");
    const reset5h = "2026-11-21T00:15:00Z";
    const resetWeekly = "2026-11-25T12:00:00Z";
    const resetArgon = "2026-11-26T01:11:45Z";
    const resetClaude = "2026-11-26T01:11:54Z";

    const availableModels: GoogleQuotaResponse = {
      models: {
        "gemini-4-neon-high": {
          displayName: "Gemini 4 Neon (High)",
          quotaInfo: { remainingFraction: 0.85, resetTime: reset5h },
        },
        "gemini-4-hydrogen-high": {
          displayName: "Gemini 4 Hydrogen (High)",
          quotaInfo: { remainingFraction: 0.85, resetTime: reset5h },
        },
        "gemini-3.8-flash-high": {
          displayName: "Gemini 3.8 Flash (High)",
          quotaInfo: { remainingFraction: 0.85, resetTime: reset5h },
        },
        "gemini-4-argon-high": {
          displayName: "Gemini 4 Argon (High)",
          quotaInfo: { remainingFraction: 0.00026666667, resetTime: resetArgon },
        },
        "claude-opus-5-5-high": {
          displayName: "Claude Opus 5.5 (High)",
          quotaInfo: { remainingFraction: 0.4977208, resetTime: resetClaude },
        },
        "gpt-oss-120b-medium": {
          displayName: "GPT-OSS 120B (Medium)",
          quotaInfo: { remainingFraction: 0.4977208, resetTime: resetClaude },
        },
      },
    };

    const summary: GoogleQuotaSummaryResponse = {
      groups: [
        {
          displayName: "Gemini Models",
          description: "Models within this group: Gemini 4 Neon, Gemini 4 Hydrogen, Gemini 3.8 Flash",
          buckets: [
            { bucketId: "gemini-weekly", displayName: "Weekly Limit Remaining", window: "weekly", resetTime: resetWeekly, remainingFraction: 0.39 },
            { bucketId: "gemini-5h", displayName: "Five Hour Limit Remaining", window: "5h", resetTime: reset5h, remainingFraction: 0.85 },
          ],
        },
        {
          displayName: "Claude and GPT models",
          description: "Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B",
          buckets: [
            // Simulate summary backend reporting 1.0 while fetchAvailableModels already reports 0.4977
            { bucketId: "3p-weekly", displayName: "Weekly Limit Remaining", window: "weekly", remainingFraction: 1 },
            { bucketId: "3p-5h", displayName: "Five Hour Limit Remaining", window: "5h", remainingFraction: 1 },
          ],
        },
        {
          displayName: "Gemini 4 Argon",
          description: "For paid Pro plans, Argon quota is separate.",
          buckets: [
            { bucketId: "gemini-argon-wtu-weekly", displayName: "Gemini 4 Argon Weekly Limit", window: "weekly", resetTime: resetArgon, remainingFraction: 0.00026666667 },
          ],
        },
      ],
    };

    const map = buildSummaryModelPoolMap(availableModels, summary);
    assert.equal(map.get("gemini-4-argon-high"), "gemini-4-argon");
    assert.equal(map.get("gemini-4-neon-high"), "gemini");
    assert.equal(map.get("gemini-3.8-flash-high"), "gemini");
    assert.equal(map.get("claude-opus-5-5-high"), "claude");
    assert.equal(map.get("gpt-oss-120b-medium"), "claude");

    const quotas = extractQuotas(availableModels, [], summary, now);
    assert.deepEqual(quotas.map((q) => q.modelKey), ["gemini", "claude", "gemini-4-argon"]);

    const gemini = quotas.find((q) => q.modelKey === "gemini")!;
    assert.equal(gemini.displayName, "Gemini Models");
    assert.equal(gemini.percentRemaining, 39);
    assert.equal(gemini.timerType, "5h");
    assert.equal(gemini.resetTime, reset5h);
    assert.deepEqual(gemini.windows?.map((w) => [w.window, w.percentRemaining, w.active]), [
      ["5h", 85, true],
      ["weekly", 39, true],
    ]);

    const claude = quotas.find((q) => q.modelKey === "claude")!;
    assert.equal(claude.percentRemaining, 50);
    assert.equal(claude.timerType, "7d");
    assert.equal(claude.resetTime, resetClaude);
    assert.deepEqual(claude.windows?.map((w) => [w.window, w.percentRemaining, w.active]), [
      ["5h", 100, false],
      ["weekly", 50, true],
    ]);

    const argon = quotas.find((q) => q.modelKey === "gemini-4-argon")!;
    assert.equal(argon.displayName, "Gemini 4 Argon");
    assert.equal(argon.percentRemaining, 0);
    assert.equal(argon.timerType, "7d");
    assert.equal(argon.resetTime, resetArgon);
    assert.deepEqual(argon.windows?.map((w) => [w.window, w.percentRemaining, w.active]), [
      ["weekly", 0, true],
    ]);
  });

  it("dynamically adds and removes quota groups and windows (such as dropping 5h or adding daily/2h)", async () => {
    const now = Date.now();
    const account = makeAccount("dynamic@example.com");
    const accountId = getAccountIdentity(account);
    const generation = getCredentialGeneration(account, "google-antigravity");
    dynamicCatalog.retainAccounts([{ id: accountId, generation }]);

    let currentSummary: GoogleQuotaSummaryResponse = {
      groups: [
        {
          displayName: "Gemini Models",
          description: "Models within this group: Gemini 3.8 Flash",
          buckets: [
            { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.9, resetTime: new Date(now + 4 * H).toISOString() },
            { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.7, resetTime: new Date(now + 6 * D).toISOString() },
          ],
        },
        {
          displayName: "Experimental Vision",
          description: "Models within this group: Vision Pro X",
          buckets: [
            { bucketId: "vision-2h", window: "2h", remainingFraction: 0.8, resetTime: new Date(now + 90 * 60_000).toISOString() },
            { bucketId: "vision-daily", window: "daily", remainingFraction: 0.6, resetTime: new Date(now + 18 * H).toISOString() },
          ],
        },
      ],
    };

    const currentModels: GoogleQuotaResponse = {
      models: {
        "gemini-3.8-flash-high": { displayName: "Gemini 3.8 Flash (High)", quotaInfo: { remainingFraction: 0.9 } },
        "vision-pro-x": { displayName: "Vision Pro X", quotaInfo: { remainingFraction: 0.8 } },
      },
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      const body = url.includes("retrieveUserQuotaSummary") ? currentSummary : currentModels;
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const ctx = { log: () => {}, markFlagged: () => {}, reportQuotaPollFlag: () => {} };
    try {
      // Poll 1: 5h + weekly on Gemini, 2h + daily on brand-new group "Experimental Vision"
      await fetchProviderQuota(account, ctx);
      assert.deepEqual(account.quota.map((q) => q.modelKey), ["gemini", "experimental-vision"]);
      assert.equal(dynamicCatalog.resolveQuotaPoolForAccount(accountId, "vision-pro-x"), "experimental-vision");
      const vision = account.quota.find((q) => q.modelKey === "experimental-vision")!;
      assert.equal(vision.percentRemaining, 60);
      assert.equal(vision.timerType, "2h");
      assert.deepEqual(vision.windows?.map((w) => [w.window, w.label]), [
        ["2h", "2h limit"],
        ["daily", "Daily limit"],
      ]);

      // Poll 2: Google removes 5h window (Ultra-style) AND removes "Experimental Vision" group
      delete currentModels.models["vision-pro-x"];
      currentSummary = {
        groups: [
          {
            displayName: "Gemini Models",
            description: "Models within this group: Gemini 3.8 Flash",
            buckets: [
              { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.65, resetTime: new Date(now + 5 * D).toISOString() },
            ],
          },
        ],
      };

      await fetchProviderQuota(account, ctx);
      assert.deepEqual(account.quota.map((q) => q.modelKey), ["gemini"]);
      assert.equal(account.quota.find((q) => q.modelKey === "experimental-vision"), undefined);
      assert.deepEqual(account.quota[0].windows?.map((w) => w.window), ["weekly"]);
      assert.equal(account.quota[0].timerType, "7d");
      assert.equal(account.quota[0].percentRemaining, 65);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("isolates Argon exhaustion on Pro while routing unified Argon via Gemini on Ultra and kickstarting custom pools", async () => {
    const now = Date.now();
    const proWithExhaustedArgon = makeAccount("pro-argon@example.com", "proj-a", "pro");
    const ultraWithUnifiedArgon = makeAccount("ultra-unified@example.com", "proj-b", "ultra");
    const rotator = new AccountRotator({
      proxyPort: 0,
      requestsPerRotation: 5,
      rotateOnQuotaDrop: 20,
      quotaPollIntervalMs: 300_000,
      accounts: [proWithExhaustedArgon.config, ultraWithUnifiedArgon.config],
    });
    rotator.stopQuotaPolling();
    const internal = rotator as unknown as {
      accounts: AccountRuntime[];
      getModelQuota: (acc: AccountRuntime, model: string) => number;
    };

    const aId = getAccountIdentity(internal.accounts[0]);
    const bId = getAccountIdentity(internal.accounts[1]);
    const aGen = getCredentialGeneration(internal.accounts[0], "google-antigravity");
    const bGen = getCredentialGeneration(internal.accounts[1], "google-antigravity");
    dynamicCatalog.retainAccounts([
      { id: aId, generation: aGen },
      { id: bId, generation: bGen },
    ]);

    dynamicCatalog.updateFromEndpointResponse(
      { models: { "gemini-3.8-flash-high": {}, "gemini-4-argon-high": {}, "gemini-4-argon-low": {} } },
      aId,
      aGen,
      undefined,
      new Map([
        ["gemini-3.8-flash-high", "gemini"],
        ["gemini-4-argon-high", "gemini-4-argon"],
        ["gemini-4-argon-low", "gemini-4-argon"],
      ]),
    );
    dynamicCatalog.updateFromEndpointResponse(
      { models: { "gemini-3.8-flash-high": {}, "gemini-4-argon-high": {} } },
      bId,
      bGen,
      undefined,
      new Map([
        ["gemini-3.8-flash-high", "gemini"],
        ["gemini-4-argon-high", "gemini"],
      ]),
    );

    internal.accounts[0].accessToken = "test-access-a";
    internal.accounts[0].tokenExpires = now + H;
    internal.accounts[1].accessToken = "test-access-b";
    internal.accounts[1].tokenExpires = now + H;
    internal.accounts[0].quota = [
      { modelKey: "gemini", displayName: "Gemini Models", providerId: "google-antigravity", percentRemaining: 90, resetTime: new Date(now + 4 * H).toISOString(), timerType: "5h" },
      { modelKey: "gemini-4-argon", displayName: "Gemini 4 Argon", providerId: "google-antigravity", percentRemaining: 0, resetTime: new Date(now + 4 * D).toISOString(), timerType: "7d" },
    ];
    internal.accounts[1].quota = [
      { modelKey: "gemini", displayName: "Gemini Models", providerId: "google-antigravity", percentRemaining: 80, resetTime: new Date(now + 4 * D).toISOString(), timerType: "7d" },
    ];

    const pickedGemini = await rotator.rotateModel("gemini-3.8-flash-high", now, -1, false);
    assert.equal(pickedGemini?.config.email, "pro-argon@example.com");

    const pickedArgon = await rotator.rotateModel("gemini-4-argon-high", now, -1, false);
    assert.equal(pickedArgon?.config.email, "ultra-unified@example.com");

    // Exhausting unified gemini-4-argon-high on Ultra only marks Ultra's Gemini pool
    rotator.markExhausted(internal.accounts[1], "gemini-4-argon-high", 2 * D, "QUOTA_EXHAUSTED");
    assert.ok((internal.accounts[1].cooldownsByModel.gemini ?? 0) > now);
    assert.equal(internal.accounts[0].cooldownsByModel.gemini, undefined);
    assert.equal(internal.getModelQuota(internal.accounts[0], "gemini-3.8-flash-high"), 90);

    // Custom pool kickstart selects a preferred non-disabled model belonging to that dynamic pool
    internal.accounts[0].accessToken = "test-access";
    internal.accounts[0].tokenExpires = now + H;
    internal.accounts[0].quota[1] = {
      modelKey: "gemini-4-argon",
      displayName: "Gemini 4 Argon",
      providerId: "google-antigravity",
      percentRemaining: 100,
      resetTime: null,
      timerType: "fresh",
    };
    const requestedUrls: string[] = [];
    let kickModel = "";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("streamGenerateContent")) {
        kickModel = (JSON.parse(String(init?.body)) as { model: string }).model;
        return new Response("", { status: 200 });
      }
      if (url.includes("retrieveUserQuotaSummary")) {
        return new Response(JSON.stringify({ groups: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ models: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    try {
      const kick = await rotator.kickstartTimerForAccount("pro-argon@example.com", "gemini-4-argon");
      assert.equal(kick.ok, true);
      assert.equal(kickModel, "gemini-4-argon-low");
      assert.ok(requestedUrls.some((u) => u.includes("streamGenerateContent")));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("round-trips custom dynamic pools through persistence and aggregates fleet windows + labels cleanly", () => {
    const accounts = [{ id: "acc-1", credentialGenerationFingerprint: "fp-1" }];
    const poolOverrides = new Map([["gemini-4-argon-high", "gemini-4-argon"]]);
    dynamicCatalog.updateFromEndpointResponse(
      { models: { "gemini-4-argon-high": { maxTokens: 1_000_000 } } },
      "acc-1",
      undefined,
      undefined,
      poolOverrides,
    );
    const saved = dynamicCatalog.getPersistedSnapshots(accounts);
    dynamicCatalog.reset();
    dynamicCatalog.restorePersistedSnapshots(saved, accounts);
    dynamicCatalog.restoreDiscoveredQuotaPools({ "experimental-vision-x": "experimental-vision" });

    assert.equal(dynamicCatalog.resolveQuotaPoolForAccount("acc-1", "gemini-4-argon-high"), "gemini-4-argon");
    assert.equal(dynamicCatalog.resolveQuotaPool("experimental-vision-x"), "experimental-vision");

    const now = Date.now();
    const fleet = {
      generatedAt: now,
      version: "test",
      proxyPort: 0,
      startedAt: now - H,
      requestsPerRotation: 5,
      maxConcurrentRequestsPerAccount: 5,
      totalRequestsAllAccounts: 0,
      activeAccounts: {},
      protectivePause: { until: 0, reason: null },
      operatorControls: { allowFreshWindowStarts: true, autoWarmupEnabled: false },
      security: { adminTokenConfigured: true, warning: null, bindHost: "127.0.0.1" },
      routingHealth: { state: "healthy", reason: "", nextRetryAt: null, availableCount: 2, readyCount: 2, activeCount: 0, cooldownCount: 0, busyCount: 0, flaggedCount: 0, disabledCount: 0, errorCount: 0 },
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
      recentRequestsByModel: { "gemini-4-argon-high": 12, "gemini-3.8-flash-high": 30 },
      accounts: [
        {
          email: "pro@x.dev",
          label: "pro",
          provider: "google-antigravity",
          status: "ready",
          tier: "pro",
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
          inFlightRequests: 0,
          inFlightByModel: {},
          proDetected: true,
          healthScore: 1,
          tokenBucket: { enabled: false, tokens: 0, capacity: 0, nextRefillAt: null },
          allowFreshWindowStartsOverride: false,
          effectiveFreshWindowStartsAllowed: true,
          quota: [
            {
              modelKey: "gemini",
              displayName: "Gemini Models",
              providerId: "google-antigravity",
              percentRemaining: 40,
              resetTime: new Date(now + 2 * H).toISOString(),
              timerType: "5h",
              windows: [
                { id: "gemini-5h", window: "5h", label: "5h limit", percentRemaining: 80, resetTime: new Date(now + 2 * H).toISOString(), durationMs: 5 * H, active: true },
                { id: "gemini-weekly", window: "weekly", label: "Weekly limit", percentRemaining: 40, resetTime: new Date(now + 4 * D).toISOString(), durationMs: 7 * D, active: true },
              ],
            },
            {
              modelKey: "gemini-4-argon",
              displayName: "Gemini 4 Argon",
              providerId: "google-antigravity",
              percentRemaining: 10,
              resetTime: new Date(now + 5 * D).toISOString(),
              timerType: "7d",
              windows: [
                { id: "gemini-argon-wtu-weekly", window: "weekly", label: "Weekly limit", percentRemaining: 10, resetTime: new Date(now + 5 * D).toISOString(), durationMs: 7 * D, active: true },
              ],
            },
          ],
        },
        {
          email: "ultra@x.dev",
          label: "ultra",
          provider: "google-antigravity",
          status: "ready",
          tier: "ultra",
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
          inFlightRequests: 0,
          inFlightByModel: {},
          proDetected: false,
          healthScore: 1,
          tokenBucket: { enabled: false, tokens: 0, capacity: 0, nextRefillAt: null },
          allowFreshWindowStartsOverride: false,
          effectiveFreshWindowStartsAllowed: true,
          quota: [
            {
              modelKey: "gemini",
              displayName: "Gemini Models",
              providerId: "google-antigravity",
              percentRemaining: 100,
              resetTime: null,
              timerType: "fresh",
              windows: [
                { id: "gemini-weekly", window: "weekly", label: "Weekly limit", percentRemaining: 100, resetTime: null, durationMs: 7 * D, active: false },
              ],
            },
          ],
        },
      ],
    } as unknown as DashboardOverview;

    const pools = buildPools(fleet, now);
    const argonPool = pools.find((p) => p.key === "gemini-4-argon")!;
    const geminiPool = pools.find((p) => p.key === "gemini")!;
    assert.ok(argonPool);
    assert.equal(argonPool.burnPerHour, 12);
    assert.equal(geminiPool.burnPerHour, 30);
    assert.deepEqual(geminiPool.windows?.map((w) => [w.window, w.accountsReporting]), [
      ["5h", 1],
      ["weekly", 2],
    ]);

    assert.equal(quotaPoolLabel("gemini-4-argon"), "Gemini 4 Argon");
    assert.equal(timerLabel("daily"), "Daily window");
    assert.equal(timerLabel("2h"), "2h window");
    assert.equal(windowShortLabel({ window: "weekly", label: "Weekly limit" }), "Weekly");
    assert.equal(windowShortLabel({ window: "5h", label: "5h limit" }), "5h");
  });

  it("ignores malformed quota summary responses cleanly", () => {
    assert.equal(parseGoogleQuotaSummaryResponse(null), null);
    assert.equal(parseGoogleQuotaSummaryResponse({ groups: [] }), null);
    assert.equal(parseGoogleQuotaSummaryResponse({ groups: [{ displayName: "Bad", buckets: [{ remainingFraction: 2 }] }] }), null);
  });
});
