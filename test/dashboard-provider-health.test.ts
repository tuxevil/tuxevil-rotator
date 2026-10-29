import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { AccountConfig, AccountRuntime, Config, ModelQuota } from "../src/types.js";

const testDir = mkdtempSync(join(tmpdir(), "tuxevil-provider-health-"));
const testEnv = {
  TUXEVIL_ROTATOR_DIR: testDir,
  PI_ROTATOR_DIR: testDir,
  TUXEVIL_ROTATOR_TELEMETRY: "off",
  ANTIGRAVITY_CLIENT_ID: "test-client-id",
  ANTIGRAVITY_CLIENT_SECRET: "test-client-secret",
  DATABASE_URL: undefined,
  TUXEVIL_ROTATOR_DATABASE_URL: undefined,
  PI_ROTATOR_DATABASE_URL: undefined,
};
const savedEnv = Object.fromEntries(Object.keys(testEnv).map((key) => [key, process.env[key]]));
for (const [key, value] of Object.entries(testEnv)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

const { AccountRotator } = await import("../src/rotator.js");
const { initDb, closeDb, setCachedState } = await import("../src/db-store.js");
const { buildModelCatalogResponse } = await import("../src/dashboard.js");
const { buildOverview } = await import("../src/dashboard-live.js");
const { dynamicCatalog } = await import("../src/providers/google-antigravity/dynamic-catalog.js");
const { buildModelRows, canServeProvider, filterModelRows, summarizeProviders } = await import("../src/web/lib/models.js");
const { buildPools } = await import("../src/web/lib/pools.js");
const { getAccountIdentity } = await import("../src/account-identity.js");

function makeRotator(accounts: AccountConfig[], extra: Partial<Config> = {}) {
  const rotator = new AccountRotator({
    proxyPort: 51200,
    bindHost: "127.0.0.1",
    requestsPerRotation: 5,
    rotateOnQuotaDrop: 20,
    quotaPollIntervalMs: 300000,
    routingPolicy: "timer-first",
    accounts,
    ...extra,
  });
  rotator.stopQuotaPolling();
  return rotator;
}

function runtimeAccounts(rotator: InstanceType<typeof AccountRotator>): AccountRuntime[] {
  return (rotator as unknown as { accounts: AccountRuntime[] }).accounts;
}

function quota(modelKey: string, providerId: string, percentRemaining: number): ModelQuota {
  return { modelKey, providerId, percentRemaining, displayName: modelKey, resetTime: null, timerType: "monthly" };
}

const mixedAccount: AccountConfig = {
  email: "mixed@example.com",
  projectId: "test-project",
  refreshToken: "test-google-refresh",
  credentials: [
    { provider: "google-antigravity", projectId: "test-project", refreshToken: "test-google-refresh" },
    { provider: "ollama", apiKey: "test-ollama-key" },
  ],
  tier: "pro",
};

const allProvidersAccount: AccountConfig = {
  ...mixedAccount,
  credentials: [
    ...mixedAccount.credentials!,
    { provider: "openai-codex", refreshToken: "test-codex-refresh" },
    { provider: "opencode-zen", apiKey: "test-zen-key" },
  ],
};

const providerCases = [
  { id: "google-antigravity", model: "gemini-3.8-flash-high", pools: ["claude", "gemini"] },
  { id: "ollama", model: "new-ollama-model", pools: ["monthly"] },
  { id: "openai-codex", model: "gpt-5.6-luna", pools: ["openai-codex"] },
  { id: "opencode-zen", model: "big-pickle", pools: ["opencode-zen"] },
];

describe("provider health from the real catalog and routing snapshot", () => {
  const originalFetch = globalThis.fetch;

  before(async () => {
    globalThis.fetch = async () => { throw new Error("Provider-health tests must not access the network"); };
    await initDb();
  });

  beforeEach(() => setCachedState({ modelAccounts: {}, accounts: {} }));
  afterEach(() => dynamicCatalog.reset());

  after(async () => {
    await closeDb();
    globalThis.fetch = originalFetch;
    rmSync(testDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("keeps an unreviewed model in the review count and filter while its provider is off", () => {
    const rotator = makeRotator([], {
      disabledProviders: ["ollama"],
      autoEnableNewModels: false,
      reviewedModels: [],
    });
    rotator.setOllamaModels(["new-ollama-model"]);
    const catalog = buildModelCatalogResponse(rotator);
    const entry = catalog.models.find((model) => model.id === "new-ollama-model")!;
    assert.deepEqual([entry.modelSwitch, entry.offReason], ["review", "provider"]);

    const rows = buildModelRows(catalog, {});
    const row = rows.find((model) => model.id === entry.id)!;
    assert.equal(row.on, false);
    assert.equal(row.waiting, true);
    assert.equal(rows.filter((model) => model.waiting && model.offerings.some((offering) => offering.providerId === "ollama")).length, 1);
    assert.deepEqual(filterModelRows(rows, { filter: "waiting", provider: "ollama", query: "" }).map((model) => model.id), [entry.id]);
  });

  it("does not report an exhausted provider as healthy when its sibling remains ready", () => {
    const rotator = makeRotator([mixedAccount]);
    const [account] = runtimeAccounts(rotator);
    account.quota = [quota("monthly", "ollama", 0), quota("gemini", "google-antigravity", 80)];
    rotator.setOllamaModels(["new-ollama-model"]);
    const now = Date.now();
    const overview = buildOverview(rotator.getStatus(), now, { database: false });
    assert.equal(overview.accounts[0].status, "ready");
    assert.equal(overview.routingDiagnostics.monthly.availableCandidates, 0);
    assert.equal(overview.routingDiagnostics.monthly.accounts[0].rejectedReason, "quota-zero");
    assert.equal(overview.routingDiagnostics.gemini.availableCandidates, 1);

    const summaries = summarizeProviders(buildModelCatalogResponse(rotator), overview, now);
    const ollama = summaries.find((summary) => summary.provider.id === "ollama")!;
    assert.equal(ollama.canServe, 0);
    assert.equal(ollama.state, "unavailable");
    assert.equal(canServeProvider(overview.accounts[0], "ollama", now), false);
    assert.equal(summaries.find((summary) => summary.provider.id === "google-antigravity")!.canServe, 1);
  });

  it("keeps purchased Ollama credits usable and respects the Models account provider switch", async () => {
    const rotator = makeRotator([mixedAccount]);
    rotator.setOllamaModels(["new-ollama-model"]);
    const [account] = runtimeAccounts(rotator);
    const credits = { balanceUsd: 0, allowanceUsd: 2.5, purchasedUsd: 5 };
    account.quota = [
      { ...quota("monthly", "ollama", 0), credits },
      quota("gemini", "google-antigravity", 80),
    ];

    for (const enabled of [true, false, true]) {
      assert.equal(await rotator.setAccountProviderEnabled(getAccountIdentity(account), "ollama", enabled), true);
      const now = Date.now();
      const overview = buildOverview(rotator.getStatus(), now, { database: false });
      const summaries = summarizeProviders(buildModelCatalogResponse(rotator), overview, now);
      const ollama = summaries.find((summary) => summary.provider.id === "ollama")!;
      assert.equal(rotator.getAutoRoutingCandidateStatus("new-ollama-model", "ollama").available, enabled);
      assert.equal(overview.routingDiagnostics.monthly.availableCandidates, Number(enabled));
      assert.equal(ollama.canServe, Number(enabled));
      assert.equal(ollama.state, enabled ? "healthy" : "unavailable");

      const pools = buildPools(overview, now);
      const monthly = pools.find((pool) => pool.key === "monthly")!;
      assert.deepEqual(monthly.credits, enabled ? credits : null);
      assert.equal(monthly.members.length, Number(enabled));
      assert.equal(monthly.withQuota, Number(enabled));
      assert.equal(monthly.capacity, 0, "purchased credits do not inflate the included balance");
      assert.equal(monthly.state, enabled ? "ok" : "blocked");
      assert.equal(summaries.find((summary) => summary.provider.id === "google-antigravity")!.canServe, 1);
      assert.equal(pools.find((pool) => pool.key === "gemini")!.capacity, 80);
    }
  });

  it("reports zero quota per provider while allowing unpolled and explicitly unknown quota", () => {
    for (const provider of providerCases) {
      const rotator = makeRotator([allProvidersAccount]);
      rotator.setOllamaModels(["new-ollama-model"]);
      const [account] = runtimeAccounts(rotator);
      account.quota = providerCases.flatMap((owner) => owner.pools.map((key) => quota(key, owner.id, 0)));
      const now = Date.now();
      const catalog = buildModelCatalogResponse(rotator);
      let overview = buildOverview(rotator.getStatus(), now, { database: false });
      assert.equal(rotator.getAutoRoutingCandidateStatus(provider.model, provider.id).available, false);
      let summary = summarizeProviders(catalog, overview, now).find((entry) => entry.provider.id === provider.id)!;
      assert.equal(summary.canServe, 0, `${provider.id} with zero quota`);
      assert.equal(summary.state, "unavailable");

      account.quota = account.quota.filter((entry) => entry.providerId !== provider.id);
      overview = buildOverview(rotator.getStatus(), now, { database: false });
      assert.equal(rotator.getAutoRoutingCandidateStatus(provider.model, provider.id).available, true);
      summary = summarizeProviders(catalog, overview, now).find((entry) => entry.provider.id === provider.id)!;
      assert.equal(summary.canServe, 1, `${provider.id} before its quota poll`);
      assert.equal(summary.state, "healthy");

      account.quota.push(...provider.pools.map((key) => quota(key, provider.id, -1)));
      overview = buildOverview(rotator.getStatus(), now, { database: false });
      assert.equal(rotator.getAutoRoutingCandidateStatus(provider.model, provider.id).available, true);
      assert.equal(summarizeProviders(catalog, overview, now).find((entry) => entry.provider.id === provider.id)!.canServe, 1);
    }
  });

  it("keeps a provider healthy when at least one of its pools can serve", () => {
    const rotator = makeRotator([mixedAccount]);
    runtimeAccounts(rotator)[0].quota = [quota("claude", "google-antigravity", 0), quota("gemini", "google-antigravity", 80)];
    const now = Date.now();
    const overview = buildOverview(rotator.getStatus(), now, { database: false });
    assert.equal(overview.routingDiagnostics.claude.availableCandidates, 0);
    assert.equal(overview.routingDiagnostics.gemini.availableCandidates, 1);
    const google = summarizeProviders(buildModelCatalogResponse(rotator), overview, now).find((entry) => entry.provider.id === "google-antigravity")!;
    assert.equal(google.canServe, 1);
    assert.equal(google.state, "healthy");
  });

  it("uses pool diagnostics for cooldowns while the account remains ready", () => {
    const rotator = makeRotator([mixedAccount]);
    rotator.setOllamaModels(["new-ollama-model"]);
    const [account] = runtimeAccounts(rotator);
    account.quota = [quota("monthly", "ollama", 80), quota("gemini", "google-antigravity", 80)];
    account.cooldownsByModel.monthly = Date.now() + 60_000;
    const now = Date.now();
    const overview = buildOverview(rotator.getStatus(), now, { database: false });
    assert.equal(overview.accounts[0].status, "ready");
    assert.equal(overview.routingDiagnostics.monthly.accounts[0].rejectedReason, "cooldown");
    const ollama = summarizeProviders(buildModelCatalogResponse(rotator), overview, now).find((entry) => entry.provider.id === "ollama")!;
    assert.equal(ollama.canServe, 0);
    assert.equal(ollama.state, "unavailable");
  });

  it("uses each provider's pool for a discovered Google model also listed by Ollama", () => {
    const rotator = makeRotator([mixedAccount]);
    const [account] = runtimeAccounts(rotator);
    dynamicCatalog.updateFromEndpointResponse({ models: { "gemini-discovered-shared": { quotaInfo: { remainingFraction: 0 } } } }, getAccountIdentity(account));
    rotator.setOllamaModels(["gemini-discovered-shared"]);
    account.quota = [quota("claude", "google-antigravity", 0), quota("gemini", "google-antigravity", 0), quota("monthly", "ollama", 80)];
    const now = Date.now();
    const catalog = buildModelCatalogResponse(rotator);
    assert.deepEqual(catalog.models.filter((entry) => entry.id === "gemini-discovered-shared").map((entry) => [entry.providerId, entry.quotaPool]), [["ollama", "monthly"], ["google-antigravity", "gemini"]]);
    assert.equal(rotator.getAutoRoutingCandidateStatus("gemini-discovered-shared", "google-antigravity").available, false);
    assert.equal(rotator.getAutoRoutingCandidateStatus("gemini-discovered-shared", "ollama").available, true);
    const overview = buildOverview(rotator.getStatus(), now, { database: false });
    const summaries = summarizeProviders(catalog, overview, now);
    assert.equal(summaries.find((entry) => entry.provider.id === "google-antigravity")!.canServe, 0);
    assert.equal(summaries.find((entry) => entry.provider.id === "ollama")!.canServe, 1);
  });

  it("does not apply one same-email account's diagnostic to its sibling", () => {
    const rotator = makeRotator([mixedAccount, { ...mixedAccount, projectId: "second-project", credentials: [{ provider: "google-antigravity", projectId: "second-project", refreshToken: "second-refresh" }] }]);
    const [empty, available] = runtimeAccounts(rotator);
    empty.quota = [quota("claude", "google-antigravity", 0), quota("gemini", "google-antigravity", 0)];
    available.quota = [quota("claude", "google-antigravity", 80), quota("gemini", "google-antigravity", 80)];
    const now = Date.now();
    const overview = buildOverview(rotator.getStatus(), now, { database: false });
    assert.deepEqual(overview.routingDiagnostics.gemini.accounts.map((entry) => entry.rejectedReason), ["quota-zero", null]);
    const google = summarizeProviders(buildModelCatalogResponse(rotator), overview, now).find((entry) => entry.provider.id === "google-antigravity")!;
    assert.equal(google.canServe, 1);
    assert.equal(google.state, "healthy");
  });

  for (const duplicateEmail of [true, false]) {
    it(`honors fresh-window diagnostics for ${duplicateEmail ? "same-email" : "distinct-email"} accounts and keeps their Ollama sibling usable`, async () => {
      const rotator = makeRotator(["first", "second"].map((project) => ({
        email: duplicateEmail ? "same@example.com" : `${project}@example.com`,
        credentials: [
          { provider: "google-antigravity", projectId: project, refreshToken: `test-google-${project}` },
          { provider: "ollama", apiKey: `test-ollama-${project}` },
        ],
      })));
      rotator.setOllamaModels(["new-ollama-model"]);
      const accounts = runtimeAccounts(rotator);
      for (const account of accounts) {
        account.quota = [
          { ...quota("claude", "google-antigravity", 100), timerType: "fresh" },
          { ...quota("gemini", "google-antigravity", 100), timerType: "fresh" },
          quota("monthly", "ollama", 80),
        ];
      }
      await rotator.setAllowFreshWindowStarts(false);
      const now = Date.now();
      let overview = buildOverview(rotator.getStatus(), now, { database: false });
      assert.deepEqual(overview.accounts.map((account) => account.status), ["ready", "ready"]);
      for (const key of ["claude", "gemini"]) {
        assert.equal(overview.routingDiagnostics[key].availableCandidates, 0);
        assert.deepEqual(overview.routingDiagnostics[key].accounts.map((entry) => entry.rejectedReason), ["fresh-window-blocked", "fresh-window-blocked"]);
      }
      assert.equal(rotator.getAutoRoutingCandidateStatus("gemini-3.8-flash-high", "google-antigravity").available, false);
      const catalog = buildModelCatalogResponse(rotator);
      let summaries = summarizeProviders(catalog, overview, now);
      let google = summaries.find((entry) => entry.provider.id === "google-antigravity")!;
      assert.equal(google.canServe, 0);
      assert.equal(google.state, "unavailable");
      assert.equal(summaries.find((entry) => entry.provider.id === "ollama")!.canServe, 2);
      assert.notEqual(overview.accounts[0].id, overview.accounts[1].id);
      assert.deepEqual(overview.routingDiagnostics.gemini.accounts.map((entry) => entry.id), overview.accounts.map((account) => account.id));

      // The second project may override the policy without making the first
      // project's fresh window eligible, even when their emails are equal.
      accounts[1].allowFreshWindowStartsOverride = true;
      overview = buildOverview(rotator.getStatus(), now, { database: false });
      assert.deepEqual(overview.routingDiagnostics.gemini.accounts.map((entry) => entry.rejectedReason), ["fresh-window-blocked", null]);
      summaries = summarizeProviders(catalog, overview, now);
      google = summaries.find((entry) => entry.provider.id === "google-antigravity")!;
      assert.equal(google.canServe, 1);
      assert.equal(google.state, "healthy");
    });
  }

  it("retains unambiguous email matching for legacy diagnostics without account IDs", async () => {
    const rotator = makeRotator([mixedAccount]);
    runtimeAccounts(rotator)[0].quota = [
      { ...quota("claude", "google-antigravity", 100), timerType: "fresh" },
      { ...quota("gemini", "google-antigravity", 100), timerType: "fresh" },
      quota("monthly", "ollama", 80),
    ];
    await rotator.setAllowFreshWindowStarts(false);
    const now = Date.now();
    const overview = buildOverview(rotator.getStatus(), now, { database: false });
    // Omit IDs as older dashboard snapshots did. Keep the account ID first
    // to also cover a modern account paired with a legacy diagnostic.
    for (const diagnostic of Object.values(overview.routingDiagnostics)) {
      for (const entry of diagnostic.accounts) delete entry.id;
    }
    const catalog = buildModelCatalogResponse(rotator);
    for (const keepAccountId of [true, false]) {
      if (!keepAccountId) delete overview.accounts[0].id;
      const summaries = summarizeProviders(catalog, overview, now);
      assert.equal(summaries.find((entry) => entry.provider.id === "google-antigravity")!.canServe, 0);
      assert.equal(summaries.find((entry) => entry.provider.id === "ollama")!.canServe, 1);
    }
  });

  it("excludes switched-off provider quota from pooled capacity and keeps the enabled sibling", () => {
    const rotator = makeRotator([mixedAccount]);
    const [account] = runtimeAccounts(rotator);
    account.disabledProviders = ["ollama"];
    account.quota = [
      quota("monthly", "ollama", 100),
      { modelKey: "session", displayName: "Legacy session", percentRemaining: 100, resetTime: null, timerType: "5h" },
      quota("gemini", "google-antigravity", 80),
    ];
    const now = Date.now();
    const overview = buildOverview(rotator.getStatus(), now, { database: false });
    overview.recentRequestsByModel = { "some-ollama-model": 20, "gemini-3.8-flash-high": 10 };
    assert.equal(overview.accounts[0].status, "ready");
    assert.equal(overview.routingDiagnostics.monthly.availableCandidates, 0);
    assert.equal(overview.routingDiagnostics.gemini.availableCandidates, 1);

    const pools = buildPools(overview, now);
    const monthly = pools.find((pool) => pool.key === "monthly")!;
    assert.equal(monthly.members.length, 0);
    assert.equal(monthly.capacity, 0);
    assert.equal(monthly.withQuota, 0);
    const session = pools.find((pool) => pool.key === "session")!;
    assert.equal(session.members.length, 0);
    assert.equal(session.capacity, 0);
    assert.equal(session.hoursLeft, 0);
    const gemini = pools.find((pool) => pool.key === "gemini")!;
    assert.equal(gemini.members.length, 1);
    assert.equal(gemini.capacity, 80);
    assert.equal(gemini.withQuota, 1);
    assert.equal(gemini.hoursLeft, 120);
  });

  it("keeps available provider capacity when another account turns that provider off", () => {
    const rotator = makeRotator([mixedAccount, {
      email: "ollama-only@example.com",
      credentials: [{ provider: "ollama", apiKey: "second-ollama-key" }],
      tier: "pro",
    }]);
    const [off, available] = runtimeAccounts(rotator);
    off.disabledProviders = ["ollama"];
    off.quota = [quota("monthly", "ollama", 100), quota("gemini", "google-antigravity", 80)];
    available.quota = [quota("monthly", "ollama", 20)];
    const now = Date.now();
    const overview = buildOverview(rotator.getStatus(), now, { database: false });
    const pools = buildPools(overview, now);
    const monthly = pools.find((pool) => pool.key === "monthly")!;
    assert.deepEqual(monthly.members.map((member) => member.account.email), [available.config.email]);
    assert.equal(monthly.capacity, 20);
    assert.equal(monthly.withQuota, 1);
    assert.equal(pools.find((pool) => pool.key === "gemini")!.capacity, 80);
  });
  it("keeps routing diagnostics and candidate decisions identical with observation metadata", () => {
    const rotator = makeRotator([mixedAccount]);
    const [runtime] = runtimeAccounts(rotator);
    runtime.quota = [quota("gemini", "google-antigravity", 80), quota("monthly", "ollama", 50)];
    const before = rotator.getStatus().routingDiagnostics;
    const candidate = rotator.getAutoRoutingCandidateStatus("new-ollama-model", "ollama");
    for (const percentageSource of ["reported", "derived", "estimated", "unknown"] as const) {
      for (const q of runtime.quota) q.observation = {
        observedAt: 1, percentageSource, remainingPercent: percentageSource === "unknown" ? null : 13,
        resetSource: "estimated", resetAt: null,
      };
      assert.deepEqual(rotator.getStatus().routingDiagnostics, before);
      assert.deepEqual(rotator.getAutoRoutingCandidateStatus("new-ollama-model", "ollama"), candidate);
      assert.deepEqual(runtime.quota.map(q => q.percentRemaining), [80, 50]);
    }
  });

});
