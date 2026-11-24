import { describe, it, before, after, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/types.js";
import { setAntigravityModelsForTest } from "./fixtures/antigravity-catalog.js";

const savedEnv = {
  TUXEVIL_ROTATOR_DIR: process.env.TUXEVIL_ROTATOR_DIR,
  PI_ROTATOR_DIR: process.env.PI_ROTATOR_DIR,
  DATABASE_URL: process.env.DATABASE_URL,
  TUXEVIL_ROTATOR_DATABASE_URL: process.env.TUXEVIL_ROTATOR_DATABASE_URL,
  PI_ROTATOR_DATABASE_URL: process.env.PI_ROTATOR_DATABASE_URL,
};
const testDir = mkdtempSync(join(tmpdir(), "tuxevil-v2-routing-"));
process.env.TUXEVIL_ROTATOR_DIR = testDir;
process.env.PI_ROTATOR_DIR = testDir;
delete process.env.DATABASE_URL;
delete process.env.TUXEVIL_ROTATOR_DATABASE_URL;
delete process.env.PI_ROTATOR_DATABASE_URL;

// These modules resolve their config paths during import, so load them only
// after the isolated test directory has been selected above.
const { AccountRotator } = await import("../src/rotator.js");
const { dynamicCatalog } = await import("../src/providers/google-antigravity/dynamic-catalog.js");
const { getAccountIdentity } = await import("../src/account-identity.js");
const { initDb, closeDb } = await import("../src/db-store.js");
const { setPersistedAdminToken } = await import("../src/admin-auth.js");
const { getProviderAdapter } = await import("../src/providers/registry.js");
const { clearCodexQuotaCache, CODEX_UNSTARTED_TIMER_THRESHOLD_SECONDS } = await import("../src/providers/openai-codex/quota.js");
const { providerAdapterForModel } = await import("../src/proxy.js");

function makeConfig(): Config {
  return {
    proxyPort: 51200,
    bindHost: "0.0.0.0",
    routingPolicy: "timer-first",
    requestsPerRotation: 5,
    rotateOnQuotaDrop: 20,
    quotaPollIntervalMs: 300000,
    accounts: [
      {
        email: "a@example.com",
        refreshToken: "a",
        projectId: "pa",
        tier: "free",
      },
      {
        email: "b@example.com",
        refreshToken: "b",
        projectId: "pb",
        tier: "ultra",
      },
    ],
    tokenBucketEnabled: false,
    tokenBucketMaxTokens: 5,
    tokenBucketRefillPerMinute: 1,
    tokenBucketInitialTokens: 5,
  };
}

function advertiseGoogleModelForRotator(rotator: any, model = "gemini-3.1-pro"): void {
  const accountIds = rotator.accounts
    .filter((account: any) => account.config.credentials?.some(
      (credential: any) => credential.provider === "google-antigravity",
    ))
    .map((account: any) => getAccountIdentity(account));
  setAntigravityModelsForTest([model], accountIds);
}

describe("v2 routing and status", () => {
  beforeEach(() => {
    dynamicCatalog.reset();
    const snapshot = {
      models: Object.fromEntries([
        "gemini-3.1-pro",
        "gemini-3-flash",
        "gemini-3.8-flash-high",
        "claude-opus-4-6-thinking",
      ].map((id) => [id, { quotaInfo: { remainingFraction: 1 } }])),
    };
    const accountIds = makeConfig().accounts!.map((account) => getAccountIdentity(account));
    for (const accountId of accountIds) {
      dynamicCatalog.updateFromEndpointResponse(snapshot, accountId);
    }
  });

  it("enforces Antigravity paid model access for direct admission and rotation", async () => {
    const config = makeConfig();
    config.accounts![1].tier = "pro";
    const ids = config.accounts!.map(getAccountIdentity);
    const models = ["claude-sonnet-5-5-medium", "claude-opus-5-5-high", "gemini-4-argon-high"];
    setAntigravityModelsForTest(models, ids);
    const rotator = new AccountRotator(config) as any;
    rotator.stopQuotaPolling();
    rotator.ensureValidTokenForProvider = async () => {};
    for (const model of models) {
      const account = await rotator.getActiveAccount(model, undefined, "google-antigravity");
      assert.equal(account?.config.email, "b@example.com", model);
      rotator.finishRequest(account, model, "google-antigravity");
      assert.equal(await rotator.rotateToNext(model, account, "google-antigravity"), null, model);
    }
  });

  it("calculates retry time using only accounts eligible for the selected model", () => {
    const config = makeConfig();
    config.accounts![1].tier = "pro";
    const rotator = new AccountRotator(config) as any;
    rotator.stopQuotaPolling();
    const model = "claude-sonnet-5-5-medium";
    setAntigravityModelsForTest([model], rotator.accounts.map((a: any) => getAccountIdentity(a.config)));
    const poolKey = rotator.resolveRequestPoolKey(model, "google-antigravity");
    const key = rotator.resolveQuotaStateKey(poolKey);
    const now = Date.now();
    rotator.accounts[0].cooldownsByModel[key] = now + 60_000;
    rotator.accounts[1].cooldownsByModel[key] = now + 600_000;
    const delay = rotator.getRetryAfterMs(model, "google-antigravity");
    assert.ok(delay > 590_000 && delay <= 600_000, `expected Pro cooldown, got ${delay}`);
  });

  it("enforces Codex plan eligibility for direct admission and retry rotation", async () => {
    const { accessEvidenceStore } = await import("../src/access-evidence.js");
    const config = makeConfig();
    config.accounts = ["free", "paid"].map((name) => ({
      email: `${name}-codex@example.com`,
      credentials: [{ provider: "openai-codex", refreshToken: name, providerAccountId: name }],
    }));
    const rotator = new AccountRotator(config) as any;
    rotator.stopQuotaPolling();
    rotator.setCodexModels(["gpt-6.1-terra", "gpt-6-luna"]);
    rotator.ensureValidTokenForProvider = async () => {};
    accessEvidenceStore().declarePlan(rotator.accounts[0].config, "openai-codex", "free");
    accessEvidenceStore().declarePlan(rotator.accounts[1].config, "openai-codex", "plus");
    const paid = await rotator.getActiveAccount("gpt-6.1-terra", undefined, "openai-codex");
    assert.equal(paid?.config.email, "paid-codex@example.com");
    rotator.finishRequest(paid, "gpt-6.1-terra", "openai-codex");
    assert.equal(await rotator.rotateToNext("gpt-6.1-terra", paid, "openai-codex"), null);
    const free = await rotator.rotateToNext("gpt-6-luna", paid, "openai-codex");
    assert.equal(free?.config.email, "free-codex@example.com");
  });

  it("merges different account catalogs without losing models or discovered metadata", async () => {
    const { getCodexModel, setDiscoveredCodexModels } = await import("../src/providers/openai-codex/catalog.js");
    const config = makeConfig();
    config.accounts = ["free", "paid", "broken", "other"].map((id) => ({
      email: `${id}@example.com`,
      credentials: [{ provider: "openai-codex", refreshToken: id }],
    }));
    const rotator = new AccountRotator(config) as any;
    rotator.stopQuotaPolling();
    for (const account of rotator.accounts) {
      account.providerTokens = { "openai-codex": { accessToken: account.config.email.split("@")[0], tokenExpires: Date.now() + 60_000 } };
    }
    rotator.ensureValidTokenForProvider = async (account: { config: { email: string } }) => {
      if (account.config.email.startsWith("broken")) throw new Error("invalid credential");
    };
    const originalFetch = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      const token = new Headers(init?.headers).get("authorization")!;
      requested.push(token);
      return Response.json({ models: token === "Bearer paid"
        ? [{ slug: "gpt-6.1-sol", context_window: 500_000 }, { slug: "gpt-6-sol", context_window: 800_000 }]
        : token === "Bearer other"
          ? [{ slug: "gpt-7-codex", context_window: 700_000 }]
          : [{ slug: "gpt-6-luna", context_window: 272_000 }],
      });
    }) as typeof fetch;
    try {
      await rotator.primeCodexCatalog();
      assert.equal(requested.length, 3, "failed token refresh does not prevent other discoveries");
      for (const model of ["gpt-6.1-sol", "gpt-7-codex", "gpt-6-luna"]) {
        assert.ok(rotator.getCodexModels().includes(model));
        assert.equal(getCodexModel(model)?.source, "discovered");
        assert.equal(providerAdapterForModel(rotator.accounts[0], model, rotator).id, "openai-codex");
      }
      assert.equal(getCodexModel("gpt-6-sol")?.contextWindow, 800_000);
    } finally {
      globalThis.fetch = originalFetch;
      setDiscoveredCodexModels([]);
    }
  });

  it("refreshes the Codex catalog during quota polling and coalesces concurrent discovery", async () => {
    const { setDiscoveredCodexModels } = await import("../src/providers/openai-codex/catalog.js");
    const config = makeConfig();
    config.accounts = [{ email: "catalog@example.com", credentials: [{ provider: "openai-codex", refreshToken: "refresh" }] }];
    const rotator = new AccountRotator(config) as any;
    rotator.stopQuotaPolling();
    rotator.accounts[0].providerTokens = { "openai-codex": { accessToken: "catalog-token", tokenExpires: Date.now() + 60_000 } };
    rotator.ensureValidTokenForProvider = async () => {};
    rotator.pollAccountQuota = async () => false;
    const originalFetch = globalThis.fetch;
    let calls = 0;
    let model = "gpt-6.1-sol";
    globalThis.fetch = (async () => {
      calls++;
      return Response.json({ models: [{ slug: model, context_window: 500_000 }] });
    }) as typeof fetch;
    try {
      await Promise.all([rotator.primeCodexCatalog(), rotator.primeCodexCatalog()]);
      assert.equal(calls, 1);
      assert.ok(rotator.getCodexModels().includes(model));
      assert.equal(providerAdapterForModel(rotator.accounts[0], model, rotator).id, "openai-codex");
      await rotator.pollAllQuotas();
      assert.equal(calls, 1, "fresh catalogs are cached across quota polls");
      model = "gpt-7.1-sol";
      rotator.lastCodexCatalogFetch = 0;
      await rotator.pollAllQuotas();
      await rotator.codexCatalogFetch;
      assert.equal(calls, 2);
      assert.ok(rotator.getCodexModels().includes(model));
      assert.equal(providerAdapterForModel(rotator.accounts[0], model, rotator).id, "openai-codex");
      rotator.accounts[0].disabledProviders = ["openai-codex"];
      await rotator.primeCodexCatalog();
      assert.equal(calls, 2, "disabled providers are not queried");
    } finally {
      globalThis.fetch = originalFetch;
      setDiscoveredCodexModels([]);
    }
  });

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

  afterEach(() => {
    setPersistedAdminToken(null);
  });

  it("keeps timer-first routing and uses tier as a tie-breaker", () => {
    const rotator = new AccountRotator(makeConfig()) as any;
    rotator.stopQuotaPolling();
    advertiseGoogleModelForRotator(rotator);
    rotator.accounts[0].quota = [
      {
        modelKey: "gemini",
        displayName: "G3.1Pro",
        percentRemaining: 50,
        resetTime: null,
        timerType: "7d",
      },
    ];
    rotator.accounts[1].quota = [
      {
        modelKey: "gemini",
        displayName: "G3.1Pro",
        percentRemaining: 50,
        resetTime: null,
        timerType: "7d",
      },
    ];
    rotator.accounts[0].healthScore = 0.9;
    rotator.accounts[1].healthScore = 0.9;

    const best = rotator.pickBestModelAccount("gemini-3.1-pro", Date.now(), -1);
    assert.equal(best?.config.email, "b@example.com");
  });

  it("skips empty Codex credentials and reports the actual rejection", () => {
    const rotator = new AccountRotator({
      ...makeConfig(),
      accounts: [
        {
          email: "empty-codex@example.com",
          credentials: [{ provider: "openai-codex", refreshToken: "" }],
          tier: "free",
        },
        {
          email: "valid-codex@example.com",
          credentials: [{ provider: "openai-codex", refreshToken: "codex-refresh" }],
          tier: "free",
        },
      ],
    }) as any;
    rotator.stopQuotaPolling();
    for (const account of rotator.accounts) {
      account.quota = [{
        modelKey: "openai-codex",
        displayName: "Codex",
        providerId: "openai-codex",
        percentRemaining: 100,
        resetTime: null,
        timerType: "fresh",
      }];
    }

    const modelKey = "openai-codex:gpt-5.6-luna";
    const best = rotator.pickBestModelAccount(modelKey, Date.now(), -1);
    assert.equal(best?.config.email, "valid-codex@example.com");

    const diagnostics = rotator.buildRoutingDiagnostics(modelKey, Date.now());
    const empty = diagnostics.accounts.find(
      (account: any) => account.email === "empty-codex@example.com",
    );
    assert.equal(empty?.rejectedReason, "provider-ineligible");
    assert.equal(empty?.rejectedDetail, "Codex credential is missing or empty");
  });

  it("deduplicates repeated no-route warnings for the same model", async () => {
    const rotator = new AccountRotator(makeConfig()) as any;
    rotator.stopQuotaPolling();
    for (const account of rotator.accounts) {
      account.quota = [{
        modelKey: "gemini",
        displayName: "Gemini",
        percentRemaining: 0,
        resetTime: null,
        timerType: "5h",
      }];
    }
    const logs: Array<{ message: string; level?: string }> = [];
    rotator.log = (message: string, level?: string) => logs.push({ message, level });
    rotator.activateModelAccount = async () => rotator.accounts[0];

    await rotator.rotateModel("gemini", Date.now(), -1);
    rotator.accounts[0].quota[0].percentRemaining = 100;
    await rotator.rotateModel("gemini", Date.now(), -1);
    rotator.accounts[0].quota[0].percentRemaining = 0;
    await rotator.rotateModel("gemini", Date.now(), -1);

    assert.equal(
      logs.filter((entry) => entry.message.includes("All accounts disabled or unavailable")).length,
      1,
    );
  });

  it("does not spam provider-mismatch warnings while a provider is cooling down", async () => {
    const rotator = new AccountRotator({
      ...makeConfig(),
      accounts: [{
        email: "codex-cooling@example.com",
        credentials: [{ provider: "openai-codex", refreshToken: "codex-refresh" }],
      }],
    }) as any;
    rotator.stopQuotaPolling();
    const account = rotator.accounts[0];
    account.providerCooldowns = { "openai-codex": Date.now() + 60_000 };
    account.quota = [{
      modelKey: "openai-codex",
      displayName: "Codex",
      providerId: "openai-codex",
      percentRemaining: 0,
      resetTime: new Date(Date.now() + 60_000).toISOString(),
      timerType: "5h",
    }];
    rotator.modelState.set("openai-codex:gpt-5.6-luna", {
      activeAccountIndex: 0,
      quotaAtRotationStart: 0,
      requestsOnActiveAccount: 0,
    });
    const logs: string[] = [];
    rotator.log = (message: string) => logs.push(message);

    await rotator.getActiveAccount("gpt-5.6-luna");
    await rotator.getActiveAccount("gpt-5.6-luna");

    assert.equal(logs.filter((message) => message.includes("provider mismatch")).length, 0);
  });

  it("kickstarts the Gemini pool through the shared Gemini 3 upstream model", async () => {
    const originalFetch = globalThis.fetch;
    let requestBody: { model?: string } | undefined;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("streamGenerateContent")) {
        requestBody = JSON.parse(String(init?.body)) as { model?: string };
        return new Response("", { status: 200 });
      }
      if (url.includes("fetchAvailableModels")) {
        return new Response(JSON.stringify({ models: {} }), { status: 200 });
      }
      throw new Error(`Unexpected fetch in direct kickstart test: ${url}`);
    }) as typeof fetch;

    try {
      const rotator = new AccountRotator(makeConfig()) as any;
      rotator.stopQuotaPolling();
      rotator.accounts[0].accessToken = "test-access-token";
      rotator.accounts[0].tokenExpires = Date.now() + 60_000;

      // The canonical quota pool key for Gemini is "gemini" (from QUOTA_MODEL_KEYS)
      const result = await rotator.kickstartTimerForAccount(
        "a@example.com",
        "gemini",
      );
      assert.equal(result.ok, true);
      assert.equal(result.upstreamModel, "gemini-3-flash");
      assert.equal(requestBody?.model, "gemini-3-flash");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("kickstarts family pool keys (gemini, claude) and kickstartAllFreshTimers", async () => {
    const originalFetch = globalThis.fetch;
    const requestedModels: string[] = [];
    let quotaPolls = 0;
    const mockQuotaResponse = {
      models: {
        "gemini-3.8-flash-high": { quotaInfo: { remainingFraction: 1.0, resetTime: null } },
        "claude-opus-4-6-thinking": { quotaInfo: { remainingFraction: 1.0, resetTime: null } },
      },
    };
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("streamGenerateContent")) {
        const body = JSON.parse(String(init?.body)) as { model?: string };
        if (body.model) requestedModels.push(body.model);
        return new Response("", { status: 200 });
      }
      if (url.includes("fetchAvailableModels")) {
        quotaPolls++;
        return new Response(JSON.stringify(mockQuotaResponse), { status: 200 });
      }
      throw new Error(`Unexpected fetch in kickstart test: ${url}`);
    }) as typeof fetch;

    try {
      const rotator = new AccountRotator(makeConfig()) as any;
      rotator.stopQuotaPolling();
      rotator.accounts[0].accessToken = "test-access-token";
      rotator.accounts[0].tokenExpires = Date.now() + 60_000;
      rotator.accounts[0].quota = [
        {
          modelKey: "gemini",
          displayName: "Gemini",
          providerId: "google-antigravity",
          percentRemaining: 100,
          resetTime: null,
          timerType: "fresh",
        },
        {
          modelKey: "claude",
          displayName: "Claude",
          providerId: "google-antigravity",
          percentRemaining: 100,
          resetTime: null,
          timerType: "fresh",
        },
      ];

      const resGemini = await rotator.kickstartTimerForAccount("a@example.com", "gemini");
      assert.equal(resGemini.ok, true);
      assert.equal(resGemini.upstreamModel, "gemini-3-flash");
      assert.equal(quotaPolls, 1, "a direct kickstart must refresh quota immediately");

      quotaPolls = 0;
      const resClaude = await rotator.kickstartTimerForAccount("a@example.com", "claude");
      assert.equal(resClaude.ok, true);
      assert.equal(resClaude.upstreamModel, "gpt-oss-120b-medium");
      assert.equal(quotaPolls, 1, "a direct kickstart must refresh quota immediately");

      requestedModels.length = 0;
      quotaPolls = 0;
      const allRes = await rotator.kickstartAllFreshTimers("a@example.com");
      assert.equal(allRes.ok, true);
      assert.equal(allRes.results.length, 2);
      assert.deepEqual(
        allRes.results.map((r: any) => r.upstreamModel).sort(),
        ["gemini-3-flash", "gpt-oss-120b-medium"].sort(),
      );
      assert.deepEqual(requestedModels.sort(), ["gemini-3-flash", "gpt-oss-120b-medium"].sort());
      assert.equal(quotaPolls, 1, "bulk kickstart must perform one account repoll");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("serializes quota polls per account and publishes the trailing snapshot", async () => {
    const rotator = new AccountRotator(makeConfig()) as any;
    rotator.stopQuotaPolling();
    const account = rotator.accounts[0];
    account.accessToken = "test-access-token";
    account.tokenExpires = Date.now() + 60_000;

    const adapter = getProviderAdapter("google-antigravity") as any;
    const originalFetchQuota = adapter.fetchQuota;
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let announceFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      announceFirst = resolve;
    });

    adapter.fetchQuota = async (target: any) => {
      calls++;
      const call = calls;
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        if (call === 1) {
          announceFirst();
          await firstGate;
        }
        target.quota = [
          {
            modelKey: "claude",
            displayName: "Claude",
            providerId: "google-antigravity",
            percentRemaining: call === 1 ? 10 : 90,
            resetTime: null,
            timerType: "fresh",
          },
        ];
      } finally {
        active--;
      }
    };

    try {
      const first = rotator.pollAccountQuota(account);
      await firstStarted;
      const second = rotator.pollAccountQuota(account);
      await new Promise<void>((resolve) => setImmediate(resolve));
      releaseFirst();
      await Promise.all([first, second]);

      assert.equal(calls, 2, "one overlapping request must schedule one trailing repoll");
      assert.equal(maxActive, 1, "quota fetches for one account must never overlap");
      assert.equal(account.quota[0]?.percentRemaining, 90, "the trailing snapshot must win");
    } finally {
      adapter.fetchQuota = originalFetchQuota;
      releaseFirst();
    }
  });

  it("reconciles an exhausted Google pool cooldown with its latest RAW POLL reset", async () => {
    const now = Date.now();
    const claudeResetTime = new Date(now + 51 * 60_000).toISOString();
    const geminiResetTime = new Date(now + 4 * 60 * 60_000).toISOString();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      assert.match(String(input), /fetchAvailableModels/);
      return new Response(
        JSON.stringify({
          models: {
            "claude-opus-4-6-thinking": {
              quotaInfo: { remainingFraction: 0, resetTime: claudeResetTime },
            },
            "gemini-3.1-pro": {
              quotaInfo: { remainingFraction: 0.93, resetTime: geminiResetTime },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const rotator = new AccountRotator({
      ...makeConfig(),
      accounts: [makeConfig().accounts[0]],
    }) as any;
    rotator.stopQuotaPolling();
    const account = rotator.accounts[0];
    account.accessToken = "test-access-token";
    account.tokenExpires = now + 60_000;
    account.cooldownsByModel = { claude: now + 80 * 60_000 };

    let saves = 0;
    let drains = 0;
    rotator.scheduleStateSave = () => saves++;
    rotator.requestWaiterDrain = () => drains++;

    try {
      await rotator.pollAccountQuota(account);

      assert.equal(
        account.cooldownsByModel.claude,
        new Date(claudeResetTime).getTime(),
      );
      assert.equal(account.cooldownsByModel.gemini, undefined);
      assert.equal(account.cooldownsByModel.__default__, undefined);
      assert.equal(rotator.isRoutableForModel(account, "gemini", Date.now()), true);
      assert.equal(saves, 1);
      assert.equal(drains, 1);

      await rotator.pollAccountQuota(account);
      assert.equal(saves, 2, "a successful snapshot persists its refreshed capture time");
      assert.equal(drains, 1, "an unchanged reset must not drain waiters again");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("shares one auto-warmup cycle across overlapping quota polls", async () => {
    const originalFetch = globalThis.fetch;
    const requestedModels: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (!url.includes("streamGenerateContent")) {
        throw new Error(`Unexpected fetch in overlapping warmup test: ${url}`);
      }
      const body = JSON.parse(String(init?.body)) as { model?: string };
      if (body.model) requestedModels.push(body.model);
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const rotator = new AccountRotator({
      ...makeConfig(),
      accounts: [makeConfig().accounts[0]],
    }) as any;
    rotator.stopQuotaPolling();
    const account = rotator.accounts[0];
    account.accessToken = "test-access-token";
    account.tokenExpires = Date.now() + 60_000;
    account.allowFreshWindowStartsOverride = true;
    account.quota = [
      {
        modelKey: "gemini",
        displayName: "Gemini",
        providerId: "google-antigravity",
        percentRemaining: 100,
        resetTime: null,
        timerType: "fresh",
      },
      {
        modelKey: "claude",
        displayName: "Claude",
        providerId: "google-antigravity",
        percentRemaining: 100,
        resetTime: null,
        timerType: "fresh",
      },
    ];
    rotator.autoWarmupEnabled = true;

    let pollCalls = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let announceFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      announceFirst = resolve;
    });
    rotator.pollAccountQuota = async () => {
      pollCalls++;
      if (pollCalls === 1) {
        announceFirst();
        await firstGate;
      }
      return true;
    };

    try {
      const first = rotator.pollAllQuotas();
      await firstStarted;
      const second = rotator.pollAllQuotas();
      await new Promise<void>((resolve) => setImmediate(resolve));
      releaseFirst();
      await Promise.all([first, second]);

      assert.deepEqual(
        requestedModels.sort(),
        ["gemini-3-flash", "gpt-oss-120b-medium"].sort(),
        "each upstream should be warmed exactly once",
      );
      assert.equal(pollCalls, 2, "one initial poll plus one post-warmup repoll");
    } finally {
      globalThis.fetch = originalFetch;
      releaseFirst();
    }
  });

  it("kickstarts gpt-oss:20b through Ollama on a Google plus Ollama account", async () => {
    const config = makeConfig();
    config.accounts = [
      {
        email: "dual-gpt-oss@example.com",
        credentials: [
          { provider: "google-antigravity", refreshToken: "g", projectId: "pg" },
          { provider: "ollama", apiKey: "o" },
        ],
      },
    ];
    const rotator = new AccountRotator(config) as any;
    rotator.stopQuotaPolling();
    const account = rotator.accounts[0];
    account.accessToken = "google-access-token";
    account.tokenExpires = Date.now() + 60_000;
    account.quota = [
      {
        modelKey: "session",
        displayName: "Ollama Session",
        providerId: "ollama",
        percentRemaining: 100,
        resetTime: null,
        timerType: "fresh",
      },
    ];

    const originalFetch = globalThis.fetch;
    const calls: Array<{
      url: string;
      authorization: string | null;
      body: { model?: string };
    }> = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)) as { model?: string },
      });
      return new Response("", { status: 200 });
    }) as typeof fetch;
    const recordedPools: string[] = [];
    rotator.recordRequest = (_target: unknown, model: string) => {
      recordedPools.push(model);
      return false;
    };
    let quotaPolls = 0;
    rotator.pollAccountQuota = async () => {
      quotaPolls++;
      return true;
    };

    try {
      const result = await rotator.kickstartTimerForAccount(
        "dual-gpt-oss@example.com",
        "gpt-oss:20b",
      );

      assert.equal(result.ok, true);
      assert.equal(result.upstreamModel, "gpt-oss:20b");
      assert.equal(calls.length, 1, "the kickstart must make no Google request");
      assert.match(calls[0].url, /\/api\/chat$/);
      assert.equal(calls[0].authorization, "Bearer o");
      assert.equal(calls[0].body.model, "gpt-oss:20b");
      assert.deepEqual(recordedPools, ["session"]);
      assert.equal(quotaPolls, 1, "a direct kickstart must refresh quota immediately");
      assert.equal(providerAdapterForModel(account, "gpt-oss:20b", rotator).id, "ollama");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps the provider verification reason when a kickstart invalidates the provider credential", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      error: {
        status: "PERMISSION_DENIED",
        message: "Verify your account to continue.",
        details: [{ reason: "VALIDATION_REQUIRED" }],
      },
    }), { status: 403 })) as typeof fetch;

    try {
      const rotator = new AccountRotator(makeConfig()) as any;
      rotator.stopQuotaPolling();
      const account = rotator.accounts[0];
      account.accessToken = "test-access-token";
      account.tokenExpires = Date.now() + 60_000;

      const result = await rotator.kickstartTimerForAccount("a@example.com", "claude", false);
      assert.equal(result.status, 403);
      // Provider-scoped: invalidProviders should be set, not account.flagged
      assert.ok(account.invalidProviders?.["google-antigravity"], "provider should be marked invalid");
      assert.match(account.lastError, /Verify your account to continue/);
      assert.match(account.lastError, /VALIDATION_REQUIRED/);
      account.invalidProviders = undefined;
      account.lastError = null;
      await rotator.saveState();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not flag an account for a model-specific kickstart 403", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      error: { status: "PERMISSION_DENIED", message: "Model is not available for this account." },
    }), { status: 403 })) as typeof fetch;

    try {
      const rotator = new AccountRotator(makeConfig()) as any;
      rotator.stopQuotaPolling();
      const account = rotator.accounts[1];
      account.accessToken = "test-access-token";
      account.tokenExpires = Date.now() + 60_000;

      const result = await rotator.kickstartTimerForAccount("b@example.com", "claude", false);
      assert.equal(result.status, 403);
      assert.equal(account.flagged, false);
      assert.equal(account.disabled, false);
      assert.match(account.lastError, /Model is not available/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses the Antigravity reset duration for a kickstart 429 on one pool", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: {
            status: "RESOURCE_EXHAUSTED",
            message: "quota exceeded. Resets in 1h20m14s",
          },
        }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    try {
      const rotator = new AccountRotator({
        ...makeConfig(),
        accounts: [makeConfig().accounts[0]],
      }) as any;
      rotator.stopQuotaPolling();
      const account = rotator.accounts[0];
      account.accessToken = "test-access-token";
      account.tokenExpires = Date.now() + 60_000;
      account.quota = [
        {
          modelKey: "claude",
          displayName: "Claude",
          providerId: "google-antigravity",
          percentRemaining: 100,
          resetTime: null,
          timerType: "fresh",
        },
        {
          modelKey: "gemini",
          displayName: "Gemini",
          providerId: "google-antigravity",
          percentRemaining: 100,
          resetTime: null,
          timerType: "fresh",
        },
      ];

      const before = Date.now();
      const result = await rotator.kickstartTimerForAccount(
        "a@example.com",
        "claude",
        false,
      );
      const after = Date.now();

      assert.equal(result.status, 429);
      assert.ok(account.cooldownsByModel.claude >= before + 4_815_000);
      assert.ok(account.cooldownsByModel.claude <= after + 4_815_000);
      assert.equal(account.cooldownsByModel.gemini, undefined);
      assert.equal(account.cooldownsByModel.__default__, undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to 30 minutes for a kickstart RESOURCE_EXHAUSTED without a duration", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: { status: "RESOURCE_EXHAUSTED", message: "quota exceeded" },
        }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    try {
      const rotator = new AccountRotator({
        ...makeConfig(),
        accounts: [makeConfig().accounts[0]],
      }) as any;
      rotator.stopQuotaPolling();
      const account = rotator.accounts[0];
      account.accessToken = "test-access-token";
      account.tokenExpires = Date.now() + 60_000;
      account.quota = [
        {
          modelKey: "gemini",
          displayName: "Gemini",
          providerId: "google-antigravity",
          percentRemaining: 100,
          resetTime: null,
          timerType: "fresh",
        },
      ];

      const before = Date.now();
      const result = await rotator.kickstartTimerForAccount(
        "a@example.com",
        "gemini",
        false,
      );
      const after = Date.now();

      assert.equal(result.status, 429);
      assert.ok(account.cooldownsByModel.gemini >= before + 1_800_000);
      assert.ok(account.cooldownsByModel.gemini <= after + 1_800_000);
      assert.equal(account.cooldownsByModel.__default__, undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("caps a generic kickstart 429 retry-after at 30 minutes", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: { status: "RATE_LIMITED", message: "rate limit exceeded" },
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "7200",
          },
        },
      )) as typeof fetch;

    try {
      const rotator = new AccountRotator({
        ...makeConfig(),
        accounts: [makeConfig().accounts[0]],
      }) as any;
      rotator.stopQuotaPolling();
      const account = rotator.accounts[0];
      account.accessToken = "test-access-token";
      account.tokenExpires = Date.now() + 60_000;
      account.quota = [
        {
          modelKey: "gemini",
          displayName: "Gemini",
          providerId: "google-antigravity",
          percentRemaining: 100,
          resetTime: null,
          timerType: "fresh",
        },
      ];

      let recordedCooldownMs: number | undefined;
      rotator.recordProvider429 = (
        _target: unknown,
        model: string,
        cooldownMs: number,
      ) => {
        assert.equal(model, "gemini");
        recordedCooldownMs = cooldownMs;
      };

      const result = await rotator.kickstartTimerForAccount(
        "a@example.com",
        "gemini",
        false,
      );

      assert.equal(result.status, 429);
      assert.equal(recordedCooldownMs, 1_800_000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps an Ollama kickstart 429 on the session pool", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: { message: "too many requests" } }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    try {
      const config = makeConfig();
      config.accounts = [
        {
          email: "ollama-429@example.com",
          credentials: [{ provider: "ollama", apiKey: "ollama-secret" }],
        },
      ];
      const rotator = new AccountRotator(config) as any;
      rotator.stopQuotaPolling();
      const account = rotator.accounts[0];
      account.quota = [
        {
          modelKey: "session",
          displayName: "Ollama Session",
          providerId: "ollama",
          percentRemaining: 100,
          resetTime: null,
          timerType: "fresh",
        },
      ];

      const result = await rotator.kickstartTimerForAccount(
        "ollama-429@example.com",
        "gpt-oss:20b",
        false,
      );

      assert.equal(result.status, 429);
      assert.deepEqual(Object.keys(account.cooldownsByModel), ["session"]);
      assert.equal(account.cooldownsByModel.__default__, undefined);
      assert.deepEqual(rotator.provider429Events, []);
      assert.deepEqual(rotator.modelBreakers, {});
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not kickstart a non-fresh pool whose reset time is unknown", async () => {
    const rotator = new AccountRotator({
      ...makeConfig(),
      accounts: [makeConfig().accounts[0]],
    }) as any;
    rotator.stopQuotaPolling();
    rotator.accounts[0].quota = [
      {
        modelKey: "gemini",
        displayName: "Gemini",
        providerId: "google-antigravity",
        percentRemaining: 100,
        resetTime: null,
        timerType: "5h",
      },
    ];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      throw new Error(`Unexpected fetch for non-fresh timer: ${String(input)}`);
    }) as typeof fetch;
    try {
      const result = await rotator.kickstartAllFreshTimers("a@example.com");
      assert.deepEqual(result.results, []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not send an Ollama kickstart from a Codex-only account", async () => {
    const rotator = new AccountRotator({
      ...makeConfig(),
      accounts: [
        {
          email: "codex-kickstart@example.com",
          credentials: [
            {
              provider: "openai-codex",
              refreshToken: "refresh",
              providerAccountId: "acct-codex",
            },
          ],
        },
      ],
    }) as any;
    rotator.stopQuotaPolling();
    const account = rotator.accounts[0];
    account.providerTokens = {
      "openai-codex": {
        accessToken: "codex-access-token",
        tokenExpires: Date.now() + 120_000,
      },
    };
    account.quota = [
      {
        modelKey: "session",
        displayName: "Ollama Cloud",
        providerId: "ollama",
        percentRemaining: 100,
        resetTime: null,
        timerType: "fresh",
      },
    ];

    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("unauthorized", { status: 401 });
    }) as typeof fetch;
    try {
      const result = await rotator.kickstartAllFreshTimers(
        "codex-kickstart@example.com",
      );
      assert.deepEqual(result.results, []);
      assert.equal(account.flagged, false);
      assert.equal(fetchCalled, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("kickstarts idle Codex timers with gpt-5.6-luna and refreshes past the quota cache", async () => {
    const rotator = new AccountRotator({
      ...makeConfig(),
      accounts: [
        {
          email: "codex-real-kickstart@example.com",
          credentials: [
            {
              provider: "openai-codex",
              refreshToken: "refresh",
              providerAccountId: "acct-codex",
            },
          ],
        },
      ],
    }) as any;
    rotator.stopQuotaPolling();
    const account = rotator.accounts[0];
    account.providerTokens = {
      "openai-codex": {
        accessToken: "codex-access-token",
        tokenExpires: Date.now() + 120_000,
      },
    };

    let quotaPolls = 0;
    let request: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
    const originalFetch = globalThis.fetch;
    clearCodexQuotaCache();
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/responses")) {
        request = {
          url,
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        };
        return new Response([
          "event: response.completed\n",
          'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
        ].join(""), { status: 200 });
      }
      if (url.includes("/wham/usage")) {
        quotaPolls++;
        const seconds = quotaPolls === 1
          ? CODEX_UNSTARTED_TIMER_THRESHOLD_SECONDS + 1
          : 60;
        return new Response(JSON.stringify({
          rate_limit: {
            primary_window: { used_percent: 0, reset_after_seconds: seconds },
            secondary_window: { used_percent: 0, reset_after_seconds: seconds },
          },
        }), { status: 200 });
      }
      throw new Error(`Unexpected fetch in Codex kickstart test: ${url}`);
    }) as typeof fetch;

    try {
      await rotator.pollAccountQuota(account);
      assert.equal(account.quota[0]?.timerType, "fresh");

      const result = await rotator.kickstartAllFreshTimers(
        "codex-real-kickstart@example.com",
      );
      assert.equal(result.ok, true);
      assert.deepEqual(result.results.map((entry: any) => ({
        quotaPools: entry.quotaPools,
        upstreamModel: entry.upstreamModel,
        ok: entry.ok,
      })), [{
        quotaPools: ["openai-codex"],
        upstreamModel: "gpt-5.6-luna",
        ok: true,
      }]);
      assert.equal(request?.url.endsWith("/responses"), true);
      assert.equal(request?.headers.get("authorization"), "Bearer codex-access-token");
      assert.equal(request?.headers.get("chatgpt-account-id"), "acct-codex");
      assert.equal(request?.body.model, "gpt-5.6-luna");
      assert.equal(quotaPolls, 2, "kickstart must bypass the stale Codex quota cache");
      assert.equal(account.quota[0]?.timerType, "5h");
      assert.ok(account.quota[0]?.resetTime);
    } finally {
      globalThis.fetch = originalFetch;
      clearCodexQuotaCache();
    }
  });

  it("keeps a failed Codex kickstart provider-scoped", async () => {
    const rotator = new AccountRotator({
      ...makeConfig(),
      accounts: [{
        email: "codex-kickstart-auth@example.com",
        credentials: [{
          provider: "openai-codex",
          refreshToken: "refresh",
          providerAccountId: "acct-codex",
        }],
      }],
    }) as any;
    rotator.stopQuotaPolling();
    const account = rotator.accounts[0];
    account.providerTokens = {
      "openai-codex": {
        accessToken: "codex-access-token",
        tokenExpires: Date.now() + 120_000,
      },
    };
    account.quota = [{
      modelKey: "openai-codex",
      displayName: "Codex",
      providerId: "openai-codex",
      percentRemaining: 100,
      resetTime: null,
      timerType: "fresh",
    }];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith("/responses")) return new Response("unauthorized", { status: 401 });
      throw new Error(`Unexpected fetch in Codex auth kickstart test: ${url}`);
    }) as typeof fetch;
    try {
      const result = await rotator.kickstartTimerForAccount(
        "codex-kickstart-auth@example.com",
        "openai-codex",
        false,
      );
      assert.equal(result.status, 401);
      assert.equal(account.flagged, false);
      assert.ok(account.invalidProviders?.["openai-codex"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces admin exposure warnings in status when token is missing", () => {
    const rotator = new AccountRotator(makeConfig());
    rotator.stopQuotaPolling();
    const status = rotator.getStatus();
    assert.equal(status.security.adminTokenConfigured, false);
    assert.match(status.security.warning || "", /TUXEVIL_ROTATOR_ADMIN_TOKEN/);
  });

  it("surfaces proxy exposure warnings even when admin auth is configured", () => {
    setPersistedAdminToken("secret");
    const rotator = new AccountRotator(makeConfig());
    rotator.stopQuotaPolling();
    const status = rotator.getStatus();
    assert.equal(status.security.adminTokenConfigured, true);
    assert.match(status.security.warning || "", /proxy routes are unauthenticated/);
    assert.doesNotMatch(
      status.security.warning || "",
      /TUXEVIL_ROTATOR_ADMIN_TOKEN is not configured/,
    );
  });

  it("does not warn for loopback binds when admin auth is configured", () => {
    setPersistedAdminToken("secret");
    const config = makeConfig();
    config.bindHost = "127.0.0.1";
    const rotator = new AccountRotator(config);
    rotator.stopQuotaPolling();
    const status = rotator.getStatus();
    assert.equal(status.security.adminTokenConfigured, true);
    assert.equal(status.security.warning, null);
  });

  it("supports quota-first policy when configured", () => {
    const config = makeConfig();
    config.routingPolicy = "quota-first";
    const rotator = new AccountRotator(config) as any;
    rotator.stopQuotaPolling();
    advertiseGoogleModelForRotator(rotator);
    rotator.accounts[0].quota = [
      {
        modelKey: "gemini",
        displayName: "G3.1Pro",
        percentRemaining: 90,
        resetTime: null,
        timerType: "fresh",
      },
    ];
    rotator.accounts[1].quota = [
      {
        modelKey: "gemini",
        displayName: "G3.1Pro",
        percentRemaining: 50,
        resetTime: null,
        timerType: "7d",
      },
    ];
    rotator.accounts[0].healthScore = 0.9;
    rotator.accounts[1].healthScore = 0.9;

    const best = rotator.pickBestModelAccount("gemini-3.1-pro", Date.now(), -1);
    assert.equal(best?.config.email, "a@example.com");
  });

  it("supports hybrid policy and excludes empty token buckets", () => {
    const config = makeConfig();
    config.routingPolicy = "hybrid";
    config.tokenBucketEnabled = true;
    const rotator = new AccountRotator(config) as any;
    rotator.stopQuotaPolling();
    advertiseGoogleModelForRotator(rotator);
    rotator.accounts[0].quota = [
      {
        modelKey: "gemini",
        displayName: "G3.1Pro",
        percentRemaining: 95,
        resetTime: null,
        timerType: "5h",
      },
    ];
    rotator.accounts[1].quota = [
      {
        modelKey: "gemini",
        displayName: "G3.1Pro",
        percentRemaining: 85,
        resetTime: null,
        timerType: "7d",
      },
    ];
    rotator.accounts[0].healthScore = 0.8;
    rotator.accounts[1].healthScore = 1;
    rotator.accounts[0].tokenBucket.tokens = 0;
    rotator.accounts[1].tokenBucket.tokens = 4;

    const best = rotator.pickBestModelAccount("gemini-3.1-pro", Date.now(), -1);
    assert.equal(best?.config.email, "b@example.com");

    const status = rotator.getStatus();
    assert.equal(
      status.routingDiagnostics.gemini.accounts[0].rejectedReason,
      "token-bucket-empty",
    );
  });

  it("keeps sticky-quota on the active account beyond the request threshold", async () => {
    const config = makeConfig();
    config.routingPolicy = "sticky-quota";
    config.requestsPerRotation = 1;
    const rotator = new AccountRotator(config) as any;
    rotator.stopQuotaPolling();
    rotator.ensureValidToken = async () => {};
    const model = "gemini";
    for (const account of rotator.accounts) {
      account.quota = [
        {
          modelKey: model,
          displayName: "G3.1Pro",
          percentRemaining: 80,
          resetTime: null,
          timerType: "7d",
        },
      ];
    }
    rotator.modelState.set(model, {
      activeAccountIndex: 0,
      stickyAccountIndex: 0,
      quotaAtRotationStart: 80,
      requestsOnActiveAccount: 0,
    });

    const account = await rotator.getActiveAccount(model);
    assert.equal(account?.config.email, "a@example.com");
    rotator.finishRequest(account, model);
    assert.equal(rotator.recordRequest(account, model), false);
    assert.equal(rotator.modelState.get(model).activeAccountIndex, 0);
  });

  it("temporarily falls back from sticky-quota and restores the preferred account", async () => {
    const config = makeConfig();
    config.routingPolicy = "sticky-quota";
    const rotator = new AccountRotator(config) as any;
    rotator.stopQuotaPolling();
    rotator.ensureValidToken = async () => {};
    const model = "gemini";
    for (const account of rotator.accounts) {
      account.quota = [
        {
          modelKey: model,
          displayName: "G3.1Pro",
          percentRemaining: 80,
          resetTime: null,
          timerType: "7d",
        },
      ];
    }
    rotator.modelState.delete(model);
    const initial = await rotator.getActiveAccount(model);
    assert.equal(initial?.config.email, "a@example.com");
    rotator.finishRequest(initial, model);
    assert.equal(rotator.modelState.get(model).stickyAccountIndex, 0);
    rotator.accounts[0].cooldownsByModel[model] = Date.now() + 60_000;

    const fallback = await rotator.getActiveAccount(model);
    assert.equal(fallback?.config.email, "b@example.com");
    rotator.finishRequest(fallback, model);
    assert.equal(rotator.modelState.get(model).stickyAccountIndex, 0);

    rotator.accounts[0].cooldownsByModel[model] = Date.now() - 1;
    const restored = await rotator.getActiveAccount(model);
    assert.equal(restored?.config.email, "a@example.com");
    rotator.finishRequest(restored, model);
    assert.equal(rotator.modelState.get(model).activeAccountIndex, 0);
  });

  it("permanently leaves a sticky account after its quota reaches zero", async () => {
    const config = makeConfig();
    config.routingPolicy = "sticky-quota";
    const rotator = new AccountRotator(config) as any;
    rotator.stopQuotaPolling();
    rotator.ensureValidToken = async () => {};
    const model = "gemini";
    rotator.accounts[0].quota = [
      {
        modelKey: model,
        displayName: "G3.1Pro",
        percentRemaining: 0,
        resetTime: null,
        timerType: "7d",
      },
    ];
    rotator.accounts[1].quota = [
      {
        modelKey: model,
        displayName: "G3.1Pro",
        percentRemaining: 80,
        resetTime: null,
        timerType: "7d",
      },
    ];
    rotator.modelState.set(model, {
      activeAccountIndex: 0,
      stickyAccountIndex: 0,
      quotaAtRotationStart: 80,
      requestsOnActiveAccount: 3,
    });

    const replacement = await rotator.getActiveAccount(model);
    assert.equal(replacement?.config.email, "b@example.com");
    rotator.finishRequest(replacement, model);
    assert.equal(rotator.modelState.get(model).stickyAccountIndex, 1);
  });

  it("uses circular account order for sequential-quota", () => {
    const config = makeConfig();
    config.routingPolicy = "sequential-quota";
    const rotator = new AccountRotator(config) as any;
    rotator.stopQuotaPolling();
    const model = "gemini";
    rotator.accounts[0].quota = [
      {
        modelKey: model,
        displayName: "G3.1Pro",
        percentRemaining: 1,
        resetTime: null,
        timerType: "fresh",
      },
    ];
    rotator.accounts[1].quota = [
      {
        modelKey: model,
        displayName: "G3.1Pro",
        percentRemaining: 99,
        resetTime: null,
        timerType: "7d",
      },
    ];

    assert.equal(
      rotator.pickBestModelAccount(model, Date.now(), -1)?.config.email,
      "a@example.com",
    );
    assert.equal(
      rotator.pickBestModelAccount(model, Date.now(), 0)?.config.email,
      "b@example.com",
    );
  });

  it("exposes the health score components in routing diagnostics", () => {
    const rotator = new AccountRotator(makeConfig()) as any;
    rotator.stopQuotaPolling();
    const account = rotator.accounts[0];
    account.quota = [
      {
        modelKey: "gemini",
        displayName: "G3.1Pro",
        percentRemaining: 50,
        resetTime: null,
        timerType: "7d",
      },
    ];
    account.consecutiveErrors = 2;
    account.cooldownsByModel = { "gemini-3.1-pro": Date.now() + 1000 };
    rotator.refreshHealthScores();

    const diagnostic =
      rotator.getStatus().routingDiagnostics["gemini-3.1-pro"].accounts[0];
    assert.deepEqual(diagnostic.healthBreakdown, {
      quotaComponent: 0.5,
      errorPenalty: 0.2,
      cooldownPenalty: 0.1,
      availabilityPenalty: 0,
      score: 0.2,
    });
    assert.equal(diagnostic.healthScore, 0.2);
  });

  it("accepts plus as a first-class account tier", async () => {
    const rotator = new AccountRotator(makeConfig());
    rotator.stopQuotaPolling();
    const changed = await rotator.setAccountTier("a@example.com", "plus");
    assert.equal(changed, true);
    assert.equal(rotator.getConfig().accounts[0].tier, "plus");
    assert.equal(rotator.getStatus().accounts[0].tier, "plus");
  });

  it("keeps tier-first preference for concurrent requests", async () => {
    const config = makeConfig();
    config.routingPolicy = "tier-first";
    config.maxConcurrentRequestsPerAccount = 5;
    config.maxConcurrentRequestsPerProjectModel = 5;
    config.accounts = [
      {
        email: "plus@example.com",
        refreshToken: "plus-refresh",
        projectId: "plus-project",
        tier: "plus",
      },
      {
        email: "free@example.com",
        refreshToken: "free-refresh",
        projectId: "free-project",
        tier: "free",
      },
    ];
    const rotator = new AccountRotator(config) as any;
    rotator.stopQuotaPolling();
    advertiseGoogleModelForRotator(rotator, "gemini-3.8-flash-high");
    rotator.ensureValidTokenForModel = async () => {};
    rotator.modelState.delete("gemini");
    rotator.defaultIndex = 0;
    for (const account of rotator.accounts) {
      account.quota = [
        {
          modelKey: "gemini",
          displayName: "G3.1Pro",
          percentRemaining: 80,
          resetTime: null,
          timerType: "7d",
        },
      ];
    }

    const first = await rotator.getActiveAccount("gemini-3.8-flash-high");
    assert.equal(first?.config.email, "plus@example.com");
    const second = await rotator.getActiveAccount("gemini-3.8-flash-high");
    assert.equal(
      second?.config.email,
      "plus@example.com",
      "an eligible Plus account must remain preferred over a less-loaded Free account",
    );

    rotator.finishRequest(first, "gemini-3.8-flash-high");
    rotator.finishRequest(second, "gemini-3.8-flash-high");
  });

  it("re-evaluates a persisted lower-tier assignment when tier-first is idle", async () => {
    const config = makeConfig();
    config.routingPolicy = "tier-first";
    config.maxConcurrentRequestsPerAccount = 5;
    config.maxConcurrentRequestsPerProjectModel = 5;
    config.accounts = [
      {
        email: "free@example.com",
        refreshToken: "free-refresh",
        projectId: "free-project",
        tier: "free",
      },
      {
        email: "plus@example.com",
        refreshToken: "plus-refresh",
        projectId: "plus-project",
        tier: "plus",
      },
    ];
    const rotator = new AccountRotator(config) as any;
    rotator.stopQuotaPolling();
    advertiseGoogleModelForRotator(rotator, "gemini-3.8-flash-high");
    rotator.ensureValidTokenForModel = async () => {};
    rotator.defaultIndex = 0;
    rotator.modelState.set("gemini", {
      activeAccountIndex: 0,
      quotaAtRotationStart: 80,
      requestsOnActiveAccount: 0,
    });
    for (const account of rotator.accounts) {
      account.quota = [
        {
          modelKey: "gemini",
          displayName: "G3.1Pro",
          percentRemaining: 80,
          resetTime: null,
          timerType: "7d",
        },
      ];
    }

    const selected = await rotator.getActiveAccount("gemini-3.8-flash-high");
    assert.equal(
      selected?.config.email,
      "plus@example.com",
      "an idle tier-first request must replace a persisted Free assignment when Plus is eligible",
    );

    rotator.finishRequest(selected, "gemini-3.8-flash-high");
  });

  it("debounces model assignment state writes on the request path", async () => {
    const rotator = new AccountRotator(makeConfig()) as any;
    rotator.stopQuotaPolling();
    rotator.modelState.set("gemini-3.1-pro", {
      activeAccountIndex: 0,
      quotaAtRotationStart: -1,
      requestsOnActiveAccount: 0,
    });
    let saves = 0;
    rotator.saveState = () => {
      saves++;
    };

    rotator.countModelAssignment("gemini-3.1-pro");
    assert.equal(
      rotator.modelState.get("gemini-3.1-pro").requestsOnActiveAccount,
      1,
    );
    assert.equal(saves, 0);

    await rotator.flushPendingStateSave();
    assert.equal(saves, 1);
  });

  it("debounces upstream-attempt state writes on the request path", async () => {
    const rotator = new AccountRotator(makeConfig()) as any;
    rotator.stopQuotaPolling();
    let saves = 0;
    rotator.saveState = () => {
      saves++;
    };

    rotator.recordUpstreamAttempt(rotator.accounts[0]);
    assert.equal(rotator.accounts[0].dailyRequestCount, 1);
    assert.equal(rotator.projectRequests.pa, 1);
    assert.equal(saves, 0);

    await rotator.flushPendingStateSave();
    assert.equal(saves, 1);
  });

  it("marks positive-quota accounts as exhausted once local daily safety budget is spent", () => {
    const rotator = new AccountRotator(makeConfig()) as any;
    rotator.stopQuotaPolling();
    advertiseGoogleModelForRotator(rotator, "gemini-3.8-flash-high");
    for (const account of rotator.accounts) {
      account.quota = [
        {
          modelKey: "gemini",
          displayName: "G3.1Pro",
          percentRemaining: 44,
          resetTime: null,
          timerType: "5h",
        },
      ];
      account.dailyRequestCount = 350;
    }

    const best = rotator.pickBestModelAccount("gemini-3.8-flash-high", Date.now(), -1);
    assert.equal(best, null);
    rotator.modelState.set("gemini-3.8-flash-high", { activeAccountIndex: 0, quotaAtRotationStart: 44, requestsOnActiveAccount: 0 });

    const status = rotator.getStatus();
    assert.equal(status.accounts[0].status, "exhausted");
    assert.equal(status.accounts[0].dailyRequestCount, 350);
    assert.equal(
      status.routingDiagnostics["gemini-3.8-flash-high"].accounts[0].rejectedReason,
      "daily-account-stop",
    );
    assert.match(
      status.routingDiagnostics["gemini-3.8-flash-high"].reason,
      /daily account budget exhausted/,
    );
    const retryAfterMs = rotator.getRetryAfterMs("gemini-3.8-flash-high");
    assert.ok(retryAfterMs > 0);
    assert.ok(retryAfterMs <= 24 * 60 * 60 * 1000);
  });

  it("prioritizes daily safety stops in diagnostics even when earlier accounts have zero quota", () => {
    const config = makeConfig();
    config.accounts = [
      {
        email: "zero-1@example.com",
        refreshToken: "a",
        projectId: "p1",
        tier: "free",
      },
      {
        email: "zero-2@example.com",
        refreshToken: "b",
        projectId: "p2",
        tier: "free",
      },
      {
        email: "zero-3@example.com",
        refreshToken: "c",
        projectId: "p3",
        tier: "free",
      },
      {
        email: "budget@example.com",
        refreshToken: "d",
        projectId: "p4",
        tier: "free",
      },
    ];
    const rotator = new AccountRotator(config) as any;
    rotator.stopQuotaPolling();
    advertiseGoogleModelForRotator(rotator);
    for (const account of rotator.accounts.slice(0, 3)) {
      account.quota = [
        {
          modelKey: "gemini",
          displayName: "G3.1Pro",
          percentRemaining: 0,
          resetTime: null,
          timerType: "7d",
        },
      ];
    }
    rotator.accounts[3].quota = [
      {
        modelKey: "gemini",
        displayName: "G3.1Pro",
        percentRemaining: 44,
        resetTime: null,
        timerType: "5h",
      },
    ];
    rotator.accounts[3].dailyRequestCount = 350;

    const reason = rotator.getStatus().routingDiagnostics.gemini.reason;
    assert.match(reason, /daily account budget exhausted/);
    assert.match(reason, /quota is exhausted for this model/);
    assert.ok(
      reason.indexOf("daily account budget exhausted") <
        reason.indexOf("quota is exhausted for this model"),
    );
  });

  it("keeps dual accounts (google + ollama) eligible for google pools", () => {
    const config = makeConfig();
    config.accounts = [
      {
        email: "dual@example.com",
        credentials: [
          { provider: "google-antigravity", refreshToken: "g" },
          { provider: "ollama", apiKey: "o" },
        ],
        projectId: "pd",
        tier: "free",
      },
      {
        email: "google-only@example.com",
        provider: "google-antigravity",
        refreshToken: "g2",
        projectId: "pg",
        tier: "free",
      },
      {
        email: "ollama-only@example.com",
        provider: "ollama",
        apiKey: "o2",
        projectId: "po",
        tier: "free",
      },
    ];
    const rotator = new AccountRotator(config) as any;
    rotator.stopQuotaPolling();

    function quota(modelKey: string) {
      return [
        {
          modelKey,
          displayName: modelKey,
          percentRemaining: 100,
          resetTime: null,
          timerType: "7d",
        },
      ];
    }
    for (const account of rotator.accounts) {
      account.quota = [...quota("claude"), ...quota("session")];
      account.healthScore = 1;
    }

    function allowed(modelKey: string): string | null {
      const available = rotator.accounts
        .filter((a: any) => rotator.isProviderEligibleForKey(a, modelKey))
        .map((a: any) => a.config.email);
      return available[0] ?? null;
    }

    const now = Date.now();
    const claudeBest = rotator.pickBestModelAccount("claude", now, -1);
    assert.equal(allowed("claude"), "dual@example.com");
    assert.equal(claudeBest?.config.email, "dual@example.com");

    const sessionBest = rotator.pickBestModelAccount("session", now, -1);
    assert.equal(sessionBest?.config.email, "dual@example.com");
    assert.equal(allowed("session"), "dual@example.com");
  });

  it("skips ollama accounts when weekly quota is 0% even if session quota is >0%", () => {
    const config = makeConfig();
    config.accounts = [
      {
        email: "exhausted-weekly@example.com",
        provider: "ollama",
        apiKey: "o1",
        tier: "free",
      },
      {
        email: "fresh-ollama@example.com",
        provider: "ollama",
        apiKey: "o2",
        tier: "free",
      },
    ];
    const rotator = new AccountRotator(config) as any;
    rotator.stopQuotaPolling();

    // Account 1: weekly=0% (exhausted), session=50% (still shows remaining)
    rotator.accounts[0].quota = [
      {
        modelKey: "session",
        displayName: "Session",
        percentRemaining: 50,
        resetTime: new Date(Date.now() + 3_600_000).toISOString(),
        timerType: "5h",
        providerId: "ollama",
      },
      {
        modelKey: "weekly",
        displayName: "Weekly",
        percentRemaining: 0,
        resetTime: new Date(Date.now() + 86_400_000).toISOString(),
        timerType: "7d",
        providerId: "ollama",
      },
    ];
    rotator.accounts[0].healthScore = 1;

    // Account 2: both pools healthy
    rotator.accounts[1].quota = [
      {
        modelKey: "session",
        displayName: "Session",
        percentRemaining: 80,
        resetTime: new Date(Date.now() + 3_600_000).toISOString(),
        timerType: "5h",
        providerId: "ollama",
      },
      {
        modelKey: "weekly",
        displayName: "Weekly",
        percentRemaining: 60,
        resetTime: new Date(Date.now() + 86_400_000).toISOString(),
        timerType: "7d",
        providerId: "ollama",
      },
    ];
    rotator.accounts[1].healthScore = 1;

    const now = Date.now();
    const best = rotator.pickBestModelAccount("session", now, -1);
    assert.equal(
      best?.config.email,
      "fresh-ollama@example.com",
      "should skip account with weekly=0% even when session>0%",
    );

    // Also: if BOTH accounts have weekly=0%, neither should be selected
    rotator.accounts[1].quota[1].percentRemaining = 0;
    const bestNone = rotator.pickBestModelAccount("session", now, -1);
    assert.equal(
      bestNone,
      null,
      "should return null when all ollama accounts have weekly=0%",
    );
  });

  it("arms the model breaker on plain 429s but not on quota exhaustion", () => {
    const config = makeConfig();
    config.accounts.push({
      email: "c@example.com",
      refreshToken: "c",
      projectId: "pc",
      tier: "free",
    });
    const rotator = new AccountRotator(config) as any;
    rotator.stopQuotaPolling();
    const now = Date.now();
    const cooldownMs = 60_000;

    rotator.recordProvider429(rotator.accounts[0], "claude", cooldownMs, true);
    rotator.recordProvider429(rotator.accounts[1], "claude", cooldownMs, true);
    assert.equal(
      rotator.modelBreakers["claude"] ?? 0,
      0,
      "quota exhaustion must not arm the model breaker",
    );

    rotator.recordProvider429(rotator.accounts[0], "claude", cooldownMs, false);
    rotator.recordProvider429(
      rotator.accounts[1],
      "claude",
      cooldownMs * 2,
      false,
    );
    assert.equal(
      rotator.modelBreakers["claude"] ?? 0,
      0,
      "below threshold must not arm the breaker",
    );

    rotator.recordProvider429(rotator.accounts[2], "claude", cooldownMs, false);
    assert.ok(
      rotator.modelBreakers["claude"] > now,
      "3 unique accounts with plain 429 must arm the model breaker",
    );
  });

  it("preserves omitted provider credentials when replacing config", async () => {
    const config = makeConfig();
    config.accounts[0].credentials = [
      {
        provider: "google-antigravity",
        refreshToken: "google-refresh",
        projectId: "project-a",
      },
      { provider: "opencode-zen", apiKey: "zen-secret" },
    ];
    const rotator = new AccountRotator(config);
    rotator.stopQuotaPolling();

    await rotator.replaceConfig({
      ...config,
      accounts: [
        {
          email: "a@example.com",
          refreshToken: "google-refresh",
          projectId: "project-a",
        },
      ],
    });

    const account = rotator.getConfig().accounts.find(
      (entry) => entry.email === "a@example.com",
    );
    assert.equal(
      account?.credentials?.find((credential) => credential.provider === "opencode-zen")?.apiKey,
      "zen-secret",
    );
  });

  it("skips invalidated providers during quota polling and auto-warmup kickstart until re-authenticated", async () => {
    const config = makeConfig();
    config.accounts = [
      {
        email: "loop-guard@example.com",
        refreshToken: "google-refresh",
        projectId: "proj-loop",
        credentials: [
          {
            provider: "google-antigravity",
            refreshToken: "google-refresh",
            projectId: "proj-loop",
          },
          { provider: "ollama", apiKey: "ollama-bad-key" },
        ],
      },
    ];
    const rotator = new AccountRotator(config);
    rotator.stopQuotaPolling();
    const account = rotator["accounts"][0];
    account.accessToken = "valid-google-token";
    account.tokenExpires = Date.now() + 60 * 60_000;
    account.providerTokens = {
      "google-antigravity": { accessToken: "valid-google-token", tokenExpires: Date.now() + 60 * 60_000 },
    };
    account.quota = [
      {
        modelKey: "claude",
        displayName: "Claude",
        providerId: "google-antigravity",
        percentRemaining: 100,
        resetTime: null,
        timerType: "fresh",
      },
    ];

    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      if (url.includes("ollama.com")) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (url.includes("generateContent") || url.includes("streamGenerateContent")) {
        return new Response(
          JSON.stringify({
            error: {
              code: 403,
              status: "PERMISSION_DENIED",
              message: "Verify your account to continue.",
              details: [{ reason: "VALIDATION_REQUIRED" }],
            },
          }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ models: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      // First quota poll hits Ollama 401 -> marks ollama invalid
      await rotator.pollAccountQuota(account);
      assert.ok(account.invalidProviders?.ollama, "ollama should be marked invalid after 401");
      const ollamaCallsAfterFirstPoll = calls.filter((u) => u.includes("ollama.com")).length;
      assert.equal(ollamaCallsAfterFirstPoll, 1);

      // Second quota poll must NOT hit Ollama again
      await rotator.pollAccountQuota(account);
      assert.equal(
        calls.filter((u) => u.includes("ollama.com")).length,
        1,
        "invalidated ollama credential must not be re-polled every cycle",
      );

      // First kickstart hits Google 403 VALIDATION_REQUIRED -> marks google-antigravity invalid
      const ks1 = await rotator.kickstartAllFreshTimers(account.config.email);
      assert.equal(ks1.results.length, 1);
      assert.equal(ks1.results[0].status, 403);
      assert.ok(
        account.invalidProviders?.["google-antigravity"],
        "google-antigravity should be marked invalid after 403 enforcement",
      );

      // Second kickstartAllFreshTimers and direct kickstartTimerForAccount must skip without upstream calls
      const callsBeforeSecondKickstart = calls.length;
      const ks2 = await rotator.kickstartAllFreshTimers(account.config.email);
      assert.equal(ks2.results.length, 0, "invalidated provider pools must be skipped by kickstartAllFreshTimers");
      const ksDirect = await rotator.kickstartTimerForAccount(account.config.email, "claude", false);
      assert.equal(ksDirect.ok, false);
      assert.equal(ksDirect.status, 409);
      assert.equal(calls.length, callsBeforeSecondKickstart, "no upstream kickstart call when provider is invalid");

      // Re-authenticating via addOrUpdateAccount clears invalidProviders for the updated provider
      await rotator.addOrUpdateAccount({
        email: account.config.email,
        refreshToken: "new-google-refresh",
        projectId: "proj-loop",
        credentials: [{ provider: "ollama", apiKey: "ollama-new-key" }],
      });
      assert.equal(account.invalidProviders?.ollama, undefined);
      assert.equal(account.invalidProviders?.["google-antigravity"], undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("derives proDetected and wasProAccount from paid account tiers as well as legacy type", () => {
    const config = makeConfig();
    config.accounts = [
      { email: "pro-tier@example.com", refreshToken: "rt1", projectId: "p1", tier: "pro" },
      { email: "ultra-tier@example.com", refreshToken: "rt2", projectId: "p2", tier: "ultra" },
      { email: "plus-tier@example.com", refreshToken: "rt3", projectId: "p3", tier: "plus" },
      { email: "free-override@example.com", refreshToken: "rt4", projectId: "p4", type: "pro", tier: "free" },
      { email: "legacy-pro@example.com", refreshToken: "rt5", projectId: "p5", type: "pro" },
      { email: "unknown-tier@example.com", refreshToken: "rt6", projectId: "p6", tier: "unknown" },
    ];
    const rotator = new AccountRotator(config);
    try {
      const status = rotator.getStatus();
      const byEmail = new Map(status.accounts.map((a) => [a.email, a]));

      assert.equal(byEmail.get("pro-tier@example.com")?.proDetected, true);
      assert.equal(byEmail.get("ultra-tier@example.com")?.proDetected, true);
      assert.equal(byEmail.get("plus-tier@example.com")?.proDetected, true);
      assert.equal(byEmail.get("free-override@example.com")?.proDetected, false);
      assert.equal(byEmail.get("legacy-pro@example.com")?.proDetected, true);
      assert.equal(byEmail.get("unknown-tier@example.com")?.proDetected, false);

      const runtimes = (rotator as unknown as { accounts: Parameters<typeof rotator.getFlagContext>[0][] }).accounts;
      const proCtx = rotator.getFlagContext(runtimes[0], "gemini");
      const freeCtx = rotator.getFlagContext(runtimes[3], "gemini");
      const legacyCtx = rotator.getFlagContext(runtimes[4], "gemini");
      assert.equal(proCtx.wasProAccount, true);
      assert.equal(freeCtx.wasProAccount, false);
      assert.equal(legacyCtx.wasProAccount, true);
    } finally {
      rotator.stopQuotaPolling();
    }
  });
});
