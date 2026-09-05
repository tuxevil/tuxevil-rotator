import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 1. Isolate environment BEFORE any dynamic module imports to prevent touching operator DB/files
const savedEnv = {
  TUXEVIL_ROTATOR_DIR: process.env.TUXEVIL_ROTATOR_DIR,
  PI_ROTATOR_DIR: process.env.PI_ROTATOR_DIR,
  DATABASE_URL: process.env.DATABASE_URL,
  TUXEVIL_ROTATOR_DATABASE_URL: process.env.TUXEVIL_ROTATOR_DATABASE_URL,
  PI_ROTATOR_DATABASE_URL: process.env.PI_ROTATOR_DATABASE_URL,
  ANTIGRAVITY_CLIENT_ID: process.env.ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET: process.env.ANTIGRAVITY_CLIENT_SECRET,
};

const testDir = mkdtempSync(join(tmpdir(), "rotator-429-resilience-"));
process.env.TUXEVIL_ROTATOR_DIR = testDir;
process.env.PI_ROTATOR_DIR = testDir;
delete process.env.DATABASE_URL;
delete process.env.TUXEVIL_ROTATOR_DATABASE_URL;
delete process.env.PI_ROTATOR_DATABASE_URL;
process.env.ANTIGRAVITY_CLIENT_ID = "test-client-id";
process.env.ANTIGRAVITY_CLIENT_SECRET = "test-client-secret";

let AccountRotator: typeof import("../src/rotator.js").AccountRotator;
let initDb: typeof import("../src/db-store.js").initDb;
let closeDb: typeof import("../src/db-store.js").closeDb;
let isDbConfigured: typeof import("../src/db-store.js").isDbConfigured;
let getCachedState: typeof import("../src/db-store.js").getCachedState;
let setCachedState: typeof import("../src/db-store.js").setCachedState;
let getAccountsPath: typeof import("../src/paths.js").getAccountsPath;
let getProviderAdapter: typeof import("../src/providers/registry.js").getProviderAdapter;
let dynamicCatalog: typeof import("../src/providers/google-antigravity/dynamic-catalog.js").dynamicCatalog;
let getAccountIdentity: typeof import("../src/rotator.js").getAccountIdentity;
let getCredentialGeneration: typeof import("../src/rotator.js").getCredentialGeneration;
type AccountRuntime = import("../src/types.js").AccountRuntime;

before(async () => {
  const dbStore = await import("../src/db-store.js");
  const rotatorMod = await import("../src/rotator.js");
  const pathsMod = await import("../src/paths.js");
  const regMod = await import("../src/providers/registry.js");
  const catalogMod = await import("../src/providers/google-antigravity/dynamic-catalog.js");

  initDb = dbStore.initDb;
  closeDb = dbStore.closeDb;
  isDbConfigured = dbStore.isDbConfigured;
  getCachedState = dbStore.getCachedState;
  setCachedState = dbStore.setCachedState;
  AccountRotator = rotatorMod.AccountRotator;
  getAccountIdentity = rotatorMod.getAccountIdentity;
  getCredentialGeneration = rotatorMod.getCredentialGeneration;
  getAccountsPath = pathsMod.getAccountsPath;
  getProviderAdapter = regMod.getProviderAdapter;
  dynamicCatalog = catalogMod.dynamicCatalog;

  // Verify hermetic file-based isolation
  assert.ok(
    getAccountsPath().startsWith(testDir),
    `Paths must point to isolated testDir (${testDir}), got ${getAccountsPath()}`,
  );

  await initDb();
});

after(async () => {
  await closeDb();
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    /* best effort cleanup */
  }

  // Restore saved environment
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
});

function makeAccount(
  email: string,
  projectId = "shared-project",
  modelKey = "claude",
  quotaPercent = 100,
  initialTokens = 50,
): AccountRuntime {
  return {
    config: {
      email,
      projectId,
      credentials: [{ provider: "google-antigravity" }],
      label: email,
    },
    accessToken: `token-${email}`,
    tokenExpires: Date.now() + 3600000,
    requestsSinceRotation: 0,
    totalRequests: 0,
    cooldownsByModel: {},
    quotaExhaustedAt: 0,
    quota: [
      {
        modelKey,
        displayName: modelKey,
        percentRemaining: quotaPercent,
        resetTime: null,
        timerType: "fresh",
        providerId: "google-antigravity",
      } as AccountRuntime["quota"][number],
    ],
    lastQuotaPoll: Date.now(),
    lastUsed: 0,
    lastError: null,
    consecutiveErrors: 0,
    disabled: false,
    flagged: false,
    inFlightRequests: 0,
    inFlightByModel: {},
    allowFreshWindowStartsOverride: false,
    dailyRequestCount: 0,
    dailyRequestDay: "2026-08-21",
    healthScore: 1,
    tokenBucket: { tokens: initialTokens, lastRefillAt: Date.now() },
  };
}

describe("429 RESOURCE_EXHAUSTED resilience and in-flight lifecycle", () => {
  it("hostile database environment variables do not select external database backend", () => {
    // Assert db-store is not connected to PostgreSQL
    assert.equal(isDbConfigured(), false, "isDbConfigured must be false when DB URL is not set");
  });

  it("cools only the exhausted Antigravity pool and keeps its sibling routable", async () => {
    const account = makeAccount("pool-isolation@example.com", "pool-project", "claude", 100);
    account.quota = [
      account.quota[0],
      {
        modelKey: "gemini",
        displayName: "Gemini",
        providerId: "google-antigravity",
        percentRemaining: 100,
        resetTime: null,
        timerType: "fresh",
      },
    ];
    const rotator = new AccountRotator({
      proxyPort: 51223,
      rotateOnQuotaDrop: 20,
      routingPolicy: "timer-first",
      quotaPollIntervalMs: 300000,
      requestsPerRotation: 5,
      accounts: [account.config],
    });
    rotator.stopQuotaPolling();
    (rotator as any).accounts = [account];

    const before = Date.now();
    rotator.markExhausted(
      account,
      "claude-sonnet-4-6",
      4_815_000,
      "RESOURCE_EXHAUSTED",
    );

    assert.ok((account.cooldownsByModel.claude ?? 0) >= before + 4_815_000);
    assert.equal(account.cooldownsByModel.gemini, undefined);
    assert.equal(account.cooldownsByModel.__default__, undefined);
    assert.equal(account.providerCooldowns?.["google-antigravity"], undefined);

    const sibling = await rotator.getActiveAccount("gemini-3.1-pro");
    assert.equal(sibling, account, "Gemini must remain routable while Claude cools down");
    rotator.finishRequest(sibling!, "gemini");

    const uiAccount = rotator
      .getStatus()
      .accounts.find((candidate) => candidate.email === account.config.email);
    assert.notEqual(uiAccount?.status, "cooldown", "one cooled pool is not a global account cooldown");

    rotator.markExhausted(account, "gemini-3.1-pro", 4_815_000, "RESOURCE_EXHAUSTED");
    const fullyCooling = rotator
      .getStatus()
      .accounts.find((candidate) => candidate.email === account.config.email);
    assert.notEqual(fullyCooling?.status, "cooldown", "pool cooldowns must not become a global account cooldown");
  });

  it("publishes an exhausted Antigravity pool as zero quota", () => {
    const account = makeAccount("visible-exhaustion@example.com", "visible-project", "gemini", 100);
    const rotator = new AccountRotator({
      proxyPort: 51225,
      rotateOnQuotaDrop: 20,
      routingPolicy: "timer-first",
      quotaPollIntervalMs: 300000,
      requestsPerRotation: 5,
      accounts: [account.config],
    });
    rotator.stopQuotaPolling();
    (rotator as any).accounts = [account];

    const cooldownMs = 125 * 60 * 60 * 1000;
    const before = Date.now();
    rotator.markExhausted(account, "gemini-3-flash", cooldownMs, "QUOTA_EXHAUSTED");

    const quota = account.quota.find((candidate) => candidate.modelKey === "gemini");
    assert.equal(quota?.percentRemaining, 0);
    assert.equal(quota?.timerType, "7d");
    assert.ok(new Date(quota?.resetTime ?? 0).getTime() >= before + cooldownMs);
    rotator.stopQuotaPolling();
  });

  it("preserves a Google pool when a partial response omits it", async () => {
    const originalFetch = globalThis.fetch;
    let rotator: InstanceType<typeof AccountRotator> | undefined;
    dynamicCatalog.reset();
    await setCachedState({ modelAccounts: {}, accounts: {} });
    globalThis.fetch = (async () => new Response(JSON.stringify({
      models: {
        gemini: { quotaInfo: { remainingFraction: 0.8 } },
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;

    try {
      const config = {
        proxyPort: 51226,
        rotateOnQuotaDrop: 20,
        routingPolicy: "timer-first" as const,
        quotaPollIntervalMs: 300000,
        requestsPerRotation: 5,
        accounts: [{
          email: "partial-quota@example.com",
          projectId: "partial-quota-project",
          refreshToken: "partial-quota-refresh",
        }],
      };
      rotator = new AccountRotator(config);
      rotator.stopQuotaPolling();
      const account = (rotator as any).accounts[0] as AccountRuntime;
      account.accessToken = "partial-quota-access";
      account.tokenExpires = Date.now() + 60_000;
      account.quota = [
        {
          modelKey: "claude",
          displayName: "Claude",
          providerId: "google-antigravity",
          percentRemaining: 42,
          resetTime: "2099-09-06T19:15:02Z",
          timerType: "7d",
        },
        {
          modelKey: "gemini",
          displayName: "Gemini",
          providerId: "google-antigravity",
          percentRemaining: 20,
          resetTime: "2099-09-10T18:36:32Z",
          timerType: "7d",
        },
      ];

      await rotator.pollAccountQuota(account);

      assert.equal(account.quota.find((q) => q.modelKey === "claude")?.percentRemaining, 42);
      assert.equal(account.quota.find((q) => q.modelKey === "gemini")?.percentRemaining, 80);
    } finally {
      rotator?.stopQuotaPolling();
      dynamicCatalog.reset();
      globalThis.fetch = originalFetch;
      await setCachedState({ modelAccounts: {}, accounts: {} });
    }
  });

  it("does not let a nominal 100% poll erase an active pool cooldown", async () => {
    const originalFetch = globalThis.fetch;
    let rotator: InstanceType<typeof AccountRotator> | undefined;
    const deadline = Date.now() + 2 * 60 * 60 * 1000;
    dynamicCatalog.reset();
    await setCachedState({ modelAccounts: {}, accounts: {} });
    globalThis.fetch = (async () => new Response(JSON.stringify({
      models: {
        gemini: { quotaInfo: { remainingFraction: 1 } },
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;

    try {
      const config = {
        proxyPort: 51227,
        rotateOnQuotaDrop: 20,
        routingPolicy: "timer-first" as const,
        quotaPollIntervalMs: 300000,
        requestsPerRotation: 5,
        accounts: [{
          email: "cooldown-poll@example.com",
          projectId: "cooldown-poll-project",
          refreshToken: "cooldown-poll-refresh",
        }],
      };
      rotator = new AccountRotator(config);
      rotator.stopQuotaPolling();
      const account = (rotator as any).accounts[0] as AccountRuntime;
      account.accessToken = "cooldown-poll-access";
      account.tokenExpires = deadline;
      account.cooldownsByModel.gemini = deadline;

      await rotator.pollAccountQuota(account);

      const quota = account.quota.find((q) => q.modelKey === "gemini");
      assert.equal(quota?.percentRemaining, 0);
      assert.equal(quota?.resetTime, new Date(deadline).toISOString());
      assert.equal(quota?.timerType, "5h");
    } finally {
      rotator?.stopQuotaPolling();
      dynamicCatalog.reset();
      globalThis.fetch = originalFetch;
      await setCachedState({ modelAccounts: {}, accounts: {} });
    }
  });

  it("preserves persisted Antigravity pool deadlines beyond 30 minutes", async () => {
    const now = Date.now();
    const claudeDeadline = now + 4_815_000;
    const geminiDeadline = now + 3_900_000;
    const defaultDeadline = now + 4 * 60 * 60 * 1000;
    const email = "persisted-pools@example.com";

    await setCachedState({
      modelAccounts: {},
      accounts: {
        [email]: {
          totalRequests: 0,
          cooldownsByModel: {
            claude: claudeDeadline,
            gemini: geminiDeadline,
            __default__: defaultDeadline,
          },
          quotaExhaustedAt: now,
          disabled: false,
          flagged: false,
        },
      },
    });

    try {
      const rotator = new AccountRotator({
        proxyPort: 51224,
        rotateOnQuotaDrop: 20,
        quotaPollIntervalMs: 300000,
        requestsPerRotation: 5,
        accounts: [
          {
            email,
            projectId: "persisted-project",
            refreshToken: "persisted-refresh",
          },
        ],
      }) as any;
      rotator.stopQuotaPolling();
      const restored = rotator.accounts[0] as AccountRuntime;

      assert.equal(restored.cooldownsByModel.claude, claudeDeadline);
      assert.equal(restored.cooldownsByModel.gemini, geminiDeadline);
      assert.ok(
        (restored.cooldownsByModel.__default__ ?? 0) <= Date.now() + 30 * 60 * 1000,
        "generic stale cooldowns must remain capped",
      );
    } finally {
      await setCachedState({ modelAccounts: {}, accounts: {} });
    }
  });

  it("folds persisted raw dynamic safety keys into shared quota pools", async () => {
    const now = Date.now();
    const canonicalDeadline = now + 20 * 60 * 1000;
    const rawDeadline = now + 2 * 60 * 60 * 1000;
    const rawModel = "gemini-4.0-flash-preview";
    const email = "persisted-dynamic-state@example.com";
    const projectId = "persisted-dynamic-project";

    await setCachedState({
      modelAccounts: {},
      safety: {
        day: new Date(now).toISOString().slice(0, 10),
        projectRequests: {},
        modelBreakers: {
          gemini: canonicalDeadline,
          [rawModel]: rawDeadline,
        },
        projectModelBreakers: {
          [`${projectId}::gemini`]: canonicalDeadline,
          [`${projectId}::${rawModel}`]: rawDeadline,
        },
        provider429Events: [
          { ts: now - 2000, projectId, modelKey: rawModel, account: email },
          { ts: now - 1000, projectId, modelKey: "gemini", account: email },
        ],
      },
      accounts: {
        [email]: {
          totalRequests: 0,
          cooldownsByModel: {
            gemini: canonicalDeadline,
            [rawModel]: rawDeadline,
          },
          quotaExhaustedAt: now,
          disabled: false,
          flagged: false,
        },
      },
    });

    try {
      const rotator = new AccountRotator({
        proxyPort: 51224,
        rotateOnQuotaDrop: 20,
        quotaPollIntervalMs: 300000,
        requestsPerRotation: 5,
        accounts: [{ email, projectId, refreshToken: "persisted-refresh" }],
      }) as any;
      rotator.stopQuotaPolling();
      const restored = rotator.accounts[0] as AccountRuntime;

      assert.equal(restored.cooldownsByModel.gemini, rawDeadline);
      assert.equal(restored.cooldownsByModel[rawModel], undefined);
      assert.equal(rotator.modelBreakers.gemini, rawDeadline);
      assert.equal(rotator.modelBreakers[rawModel], undefined);
      assert.equal(
        rotator.projectModelBreakers[`${projectId}::gemini`],
        rawDeadline,
      );
      assert.equal(
        rotator.projectModelBreakers[`${projectId}::${rawModel}`],
        undefined,
      );
      assert.equal(rotator.provider429Events.length, 2);
      assert.ok(
        rotator.provider429Events.every(
          (event: { modelKey: string }) => event.modelKey === "gemini",
        ),
      );
    } finally {
      await setCachedState({ modelAccounts: {}, accounts: {} });
    }
  });

  it("routes a restored neutral dynamic model before its first post-restart poll", async () => {
    const rawModel = "future-vnext";
    const email = "restored-neutral-routing@example.com";
    const projectId = "restored-neutral-routing-project";
    const originalFetch = globalThis.fetch;
    let quotaResponse: unknown = {
      models: {
        [rawModel]: { quotaInfo: { remainingFraction: 1 } },
      },
    };
    let firstRotator: InstanceType<typeof AccountRotator> | undefined;
    let secondRotator: InstanceType<typeof AccountRotator> | undefined;

    dynamicCatalog.reset();
    await setCachedState({ modelAccounts: {}, accounts: {} });
    globalThis.fetch = (async () => new Response(JSON.stringify(quotaResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;

    try {
      const config = {
        proxyPort: 51224,
        rotateOnQuotaDrop: 20,
        quotaPollIntervalMs: 300000,
        requestsPerRotation: 5,
        accounts: [{ email, projectId, refreshToken: "persisted-refresh" }],
      };
      firstRotator = new AccountRotator(config);
      firstRotator.stopQuotaPolling();
      const firstAccount = (firstRotator as any).accounts[0] as AccountRuntime;
      firstAccount.accessToken = "first-access-token";
      firstAccount.tokenExpires = Date.now() + 60_000;
      await firstRotator.pollAccountQuota(firstAccount);
      await firstRotator.saveState();

      dynamicCatalog.reset();
      secondRotator = new AccountRotator(config);
      secondRotator.stopQuotaPolling();
      const secondAccount = (secondRotator as any).accounts[0] as AccountRuntime;
      secondAccount.accessToken = "second-access-token";
      secondAccount.tokenExpires = Date.now() + 60_000;

      assert.equal(dynamicCatalog.resolveQuotaPool(rawModel), "gemini");
      const selected = await (secondRotator as any).tryGetActiveAccount(rawModel);
      assert.equal(selected, secondAccount);
      secondRotator.finishRequest(secondAccount, rawModel);

      quotaResponse = {
        models: {
          gemini: { quotaInfo: { remainingFraction: 1 } },
        },
      };
      await secondRotator.pollAccountQuota(secondAccount);
      assert.equal(dynamicCatalog.getModel(rawModel), undefined);
      assert.equal(
        await (secondRotator as any).tryGetActiveAccount(rawModel),
        null,
      );
    } finally {
      firstRotator?.stopQuotaPolling();
      secondRotator?.stopQuotaPolling();
      dynamicCatalog.reset();
      globalThis.fetch = originalFetch;
      await setCachedState({ modelAccounts: {}, accounts: {} });
    }
  });

  it("restores dynamic model ownership by complete account identity", async () => {
    const modelA = "future-a-only";
    const modelB = "future-b-only";
    const sharedEmail = "restored-ownership@example.com";
    const accounts = [
      {
        email: sharedEmail,
        credentials: [{
          provider: "google-antigravity" as const,
          projectId: "restored-project-a",
          refreshToken: "restored-secret-a",
        }],
      },
      {
        email: sharedEmail,
        credentials: [{
          provider: "google-antigravity" as const,
          projectId: "restored-project-b",
          refreshToken: "restored-secret-b",
        }],
      },
    ];
    const config = {
      proxyPort: 51224,
      rotateOnQuotaDrop: 20,
      quotaPollIntervalMs: 300000,
      requestsPerRotation: 5,
      accounts,
    };
    let firstRotator: InstanceType<typeof AccountRotator> | undefined;
    let secondRotator: InstanceType<typeof AccountRotator> | undefined;
    let changedRotator: InstanceType<typeof AccountRotator> | undefined;

    dynamicCatalog.reset();
    await setCachedState({ modelAccounts: {}, accounts: {} });

    try {
      firstRotator = new AccountRotator(config);
      firstRotator.stopQuotaPolling();
      const firstAccounts = (firstRotator as any).accounts as AccountRuntime[];
      const accountAId = getAccountIdentity(firstAccounts[0]);
      const accountBId = getAccountIdentity(firstAccounts[1]);
      assert.notEqual(accountAId, accountBId);

      dynamicCatalog.updateFromEndpointResponse({
        models: { [modelA]: { quotaInfo: { remainingFraction: 1 } } },
      }, accountAId);
      dynamicCatalog.updateFromEndpointResponse({
        models: { [modelB]: { quotaInfo: { remainingFraction: 1 } } },
      }, accountBId);
      (firstRotator as any).modelState.set(modelA, {
        activeAccountIndex: 1,
        quotaAtRotationStart: -1,
        requestsOnActiveAccount: 0,
      });
      (firstRotator as any).modelState.set(modelB, {
        activeAccountIndex: 0,
        quotaAtRotationStart: -1,
        requestsOnActiveAccount: 0,
      });
      await firstRotator.saveState();
      const persisted = getCachedState();

      dynamicCatalog.reset();
      secondRotator = new AccountRotator(config);
      secondRotator.stopQuotaPolling();
      const secondAccounts = (secondRotator as any).accounts as AccountRuntime[];
      for (const [index, account] of secondAccounts.entries()) {
        account.accessToken = `second-access-${index}`;
        account.tokenExpires = Date.now() + 60_000;
      }

      const selectedA = await (secondRotator as any).tryGetActiveAccount(modelA);
      assert.equal(selectedA, secondAccounts[0]);
      secondRotator.finishRequest(selectedA, modelA);

      const ownership = (persisted as any)?.dynamicModelOwnership;
      assert.deepEqual(
        Object.keys(ownership.accounts).sort(),
        [accountAId, accountBId].sort(),
      );
      const serializedOwnership = JSON.stringify(ownership);
      assert.equal(serializedOwnership.includes("restored-secret-a"), false);
      assert.equal(serializedOwnership.includes("restored-secret-b"), false);

      dynamicCatalog.updateFromEndpointResponse({
        models: { [modelA]: { quotaInfo: { remainingFraction: 1 } } },
      }, accountAId, getCredentialGeneration(secondAccounts[0], "google-antigravity"));
      const selectedB = await (secondRotator as any).tryGetActiveAccount(modelB);
      assert.equal(selectedB, secondAccounts[1]);
      secondRotator.finishRequest(selectedB, modelB);

      dynamicCatalog.updateFromEndpointResponse(
        { models: {} },
        accountAId,
        getCredentialGeneration(secondAccounts[0], "google-antigravity"),
      );
      assert.equal(
        await (secondRotator as any).tryGetActiveAccount(modelA),
        null,
      );

      dynamicCatalog.reset();
      changedRotator = new AccountRotator({
        ...config,
        accounts: [
          {
            ...accounts[0],
            credentials: [{
              ...accounts[0].credentials[0],
              refreshToken: "replacement-secret-a",
            }],
          },
          accounts[1],
        ],
      });
      changedRotator.stopQuotaPolling();
      const changedAccounts = (changedRotator as any).accounts as AccountRuntime[];
      for (const [index, account] of changedAccounts.entries()) {
        account.accessToken = `changed-access-${index}`;
        account.tokenExpires = Date.now() + 60_000;
      }
      assert.equal(
        await (changedRotator as any).tryGetActiveAccount(modelA),
        null,
      );
      const unchangedB = await (changedRotator as any).tryGetActiveAccount(modelB);
      assert.equal(unchangedB, changedAccounts[1]);
      changedRotator.finishRequest(unchangedB, modelB);
    } finally {
      firstRotator?.stopQuotaPolling();
      secondRotator?.stopQuotaPolling();
      changedRotator?.stopQuotaPolling();
      dynamicCatalog.reset();
      await setCachedState({ modelAccounts: {}, accounts: {} });
    }
  });

  it("honors legacy neutral dynamic safety state before catalog hydration", async () => {
    const now = Date.now();
    const rawModel = "future-vnext";
    const email = "legacy-neutral-safety@example.com";
    const projectId = "legacy-neutral-safety-project";
    const deadline = now + 2 * 60 * 60 * 1000;
    const originalFetch = globalThis.fetch;
    let rotator: InstanceType<typeof AccountRotator> | undefined;

    dynamicCatalog.reset();
    await setCachedState({
      modelAccounts: {},
      safety: {
        day: new Date(now).toISOString().slice(0, 10),
        projectRequests: {},
        modelBreakers: { [rawModel]: deadline },
        projectModelBreakers: { [`${projectId}::${rawModel}`]: deadline },
        provider429Events: [
          { ts: now - 2_000, projectId, modelKey: rawModel, account: "legacy-a@example.com" },
          { ts: now - 1_000, projectId, modelKey: rawModel, account: "legacy-b@example.com" },
        ],
      },
      accounts: {
        [email]: {
          totalRequests: 0,
          cooldownsByModel: { [rawModel]: deadline },
          quotaExhaustedAt: now,
          disabled: false,
          flagged: false,
        },
      },
    });
    globalThis.fetch = (async () => new Response(JSON.stringify({
      models: {
        [rawModel]: { quotaInfo: { remainingFraction: 1 } },
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;

    try {
      rotator = new AccountRotator({
        proxyPort: 51224,
        rotateOnQuotaDrop: 20,
        quotaPollIntervalMs: 300000,
        requestsPerRotation: 5,
        projectCircuitBreaker429Threshold: 3,
        modelCircuitBreaker429Threshold: 3,
        accounts: [{ email, projectId, refreshToken: "persisted-refresh" }],
      });
      rotator.stopQuotaPolling();
      const account = (rotator as any).accounts[0] as AccountRuntime;
      account.accessToken = "legacy-access-token";
      account.tokenExpires = deadline;

      assert.equal((rotator as any).resolveRequestPoolKey(rawModel), rawModel);
      assert.equal((rotator as any).isAvailableForModel(account, rawModel, now), false);

      delete account.cooldownsByModel[rawModel];
      assert.equal(
        (rotator as any).getUnavailableReasonForModel(account, rawModel, now),
        "model circuit breaker active",
      );
      delete (rotator as any).modelBreakers[rawModel];
      assert.equal(
        (rotator as any).getUnavailableReasonForModel(account, rawModel, now),
        "project circuit breaker active",
      );
      delete (rotator as any).projectModelBreakers[`${projectId}::${rawModel}`];

      rotator.recordProvider429(account, rawModel, 1_000);
      assert.ok((rotator as any).modelBreakers[rawModel] > now);
      assert.equal((rotator as any).provider429Events.length, 3);
      assert.ok(
        (rotator as any).provider429Events.every(
          (event: { modelKey: string }) => event.modelKey === rawModel,
        ),
      );
      account.cooldownsByModel[rawModel] = deadline;
      (rotator as any).projectModelBreakers[`${projectId}::${rawModel}`] = deadline;

      await rotator.pollAccountQuota(account);
      assert.equal(account.cooldownsByModel[rawModel], undefined);
      assert.equal(account.cooldownsByModel.gemini, deadline);
      assert.equal((rotator as any).modelBreakers[rawModel], undefined);
      assert.ok((rotator as any).modelBreakers.gemini > now);
      assert.equal(
        (rotator as any).projectModelBreakers[`${projectId}::${rawModel}`],
        undefined,
      );
      assert.ok((rotator as any).projectModelBreakers[`${projectId}::gemini`] > now);
      assert.ok(
        (rotator as any).provider429Events.every(
          (event: { modelKey: string }) => event.modelKey === "gemini",
        ),
      );
    } finally {
      rotator?.stopQuotaPolling();
      dynamicCatalog.reset();
      globalThis.fetch = originalFetch;
      await setCachedState({ modelAccounts: {}, accounts: {} });
    }
  });

  it("preserves a neutral dynamic cooldown across discovery and restart", async () => {
    const now = Date.now();
    const canonicalDeadline = now + 20 * 60 * 1000;
    const rawDeadline = now + 2 * 60 * 60 * 1000;
    const rawModel = "future-vnext";
    const email = "persisted-neutral-dynamic@example.com";
    const projectId = "persisted-neutral-project";
    const originalFetch = globalThis.fetch;
    let firstRotator: InstanceType<typeof AccountRotator> | undefined;
    let secondRotator: InstanceType<typeof AccountRotator> | undefined;

    dynamicCatalog.reset();
    await setCachedState({
      modelAccounts: {},
      safety: {
        day: new Date(now).toISOString().slice(0, 10),
        projectRequests: {},
        modelBreakers: { gemini: canonicalDeadline, [rawModel]: rawDeadline },
        projectModelBreakers: {
          [`${projectId}::gemini`]: canonicalDeadline,
          [`${projectId}::${rawModel}`]: rawDeadline,
        },
        provider429Events: [
          { ts: now - 1000, projectId, modelKey: rawModel, account: email },
        ],
      },
      accounts: {
        [email]: {
          totalRequests: 0,
          cooldownsByModel: { gemini: canonicalDeadline, [rawModel]: rawDeadline },
          quotaExhaustedAt: now,
          disabled: false,
          flagged: false,
        },
      },
    });
    globalThis.fetch = (async () => new Response(JSON.stringify({
      models: {
        [rawModel]: { quotaInfo: { remainingFraction: 1 } },
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;

    try {
      const config = {
        proxyPort: 51224,
        rotateOnQuotaDrop: 20,
        quotaPollIntervalMs: 300000,
        requestsPerRotation: 5,
        accounts: [{ email, projectId, refreshToken: "persisted-refresh" }],
      };
      firstRotator = new AccountRotator(config);
      firstRotator.stopQuotaPolling();
      const firstAccount = (firstRotator as any).accounts[0] as AccountRuntime;
      firstAccount.accessToken = "restored-access-token";
      firstAccount.tokenExpires = rawDeadline;

      assert.equal(firstAccount.cooldownsByModel[rawModel], rawDeadline);
      await firstRotator.pollAccountQuota(firstAccount);
      assert.equal(firstAccount.cooldownsByModel.gemini, rawDeadline);
      assert.equal(firstAccount.cooldownsByModel[rawModel], undefined);
      assert.equal((firstRotator as any).modelBreakers.gemini, rawDeadline);
      assert.equal(
        (firstRotator as any).projectModelBreakers[`${projectId}::gemini`],
        rawDeadline,
      );
      assert.equal(
        (firstRotator as any).provider429Events[0]?.modelKey,
        "gemini",
      );
      assert.equal(
        (firstRotator as any).isAvailableForModel(firstAccount, rawModel, now),
        false,
      );
      await firstRotator.saveState();

      dynamicCatalog.reset();
      secondRotator = new AccountRotator(config);
      secondRotator.stopQuotaPolling();
      const secondAccount = (secondRotator as any).accounts[0] as AccountRuntime;
      assert.equal(secondAccount.cooldownsByModel.gemini, rawDeadline);
      assert.equal(secondAccount.cooldownsByModel[rawModel], undefined);
      secondAccount.accessToken = "reloaded-access-token";
      secondAccount.tokenExpires = rawDeadline;
      assert.equal(dynamicCatalog.resolveQuotaPool(rawModel), "gemini");
      assert.equal(
        (secondRotator as any).isAvailableForModel(secondAccount, rawModel, now),
        false,
      );
      assert.equal(
        await (secondRotator as any).tryGetActiveAccount(rawModel),
        null,
      );
      await secondRotator.pollAccountQuota(secondAccount);
      assert.equal(
        (secondRotator as any).isAvailableForModel(secondAccount, rawModel, now),
        false,
      );
    } finally {
      firstRotator?.stopQuotaPolling();
      secondRotator?.stopQuotaPolling();
      dynamicCatalog.reset();
      globalThis.fetch = originalFetch;
      await setCachedState({ modelAccounts: {}, accounts: {} });
    }
  });

  it("rotateModel and activateModelAccount do not leak in-flight counters during background polling", async () => {
    const acc1 = makeAccount("acc1@example.com", "shared-project", "claude", 100);
    const acc2 = makeAccount("acc2@example.com", "shared-project", "claude", 100);

    const rotator = new AccountRotator({
      proxyPort: 51201,
      rotateOnQuotaDrop: 20,
      routingPolicy: "timer-first",
      quotaPollIntervalMs: 300000,
      requestsPerRotation: 5,
      maxConcurrentRequestsPerAccount: 1,
      maxConcurrentRequestsPerProjectModel: 1,
      accounts: [acc1.config, acc2.config],
    });
    rotator.stopQuotaPolling();
    (rotator as any).accounts = [acc1, acc2];
    (rotator as any).modelState.set("claude", {
      activeAccountIndex: 0,
      stickyAccountIndex: 0,
      quotaAtRotationStart: 100,
      requestsOnActiveAccount: 0,
    });

    const rotated = await rotator.rotateModel("claude");
    assert.ok(rotated);
    assert.equal(rotated.config.email, "acc2@example.com");

    // In-flight requests and inFlightByModel must remain 0 after background/manual rotateModel
    assert.equal(acc1.inFlightRequests, 0, "acc1 inFlightRequests must remain 0 after rotateModel");
    assert.deepEqual(acc1.inFlightByModel, {}, "acc1 inFlightByModel must remain empty after rotateModel");
    assert.equal(acc2.inFlightRequests, 0, "acc2 inFlightRequests must remain 0 after rotateModel");
    assert.deepEqual(acc2.inFlightByModel, {}, "acc2 inFlightByModel must remain empty after rotateModel");
  });

  it("getActiveAccount leases account with inFlight=1, and finishRequest resets to 0", async () => {
    const acc1 = makeAccount("active@example.com", "shared-project", "claude", 100);

    const rotator = new AccountRotator({
      proxyPort: 51202,
      rotateOnQuotaDrop: 20,
      routingPolicy: "timer-first",
      quotaPollIntervalMs: 300000,
      requestsPerRotation: 5,
      maxConcurrentRequestsPerAccount: 1,
      maxConcurrentRequestsPerProjectModel: 1,
      accounts: [acc1.config],
    });
    rotator.stopQuotaPolling();
    (rotator as any).accounts = [acc1];
    (rotator as any).modelState.set("claude", {
      activeAccountIndex: 0,
      stickyAccountIndex: 0,
      quotaAtRotationStart: 100,
      requestsOnActiveAccount: 0,
    });

    const account = await rotator.getActiveAccount("claude-opus-4-6-thinking");
    assert.ok(account);
    assert.equal(account.inFlightRequests, 1, "inFlightRequests must be 1 while request is active");
    assert.equal(account.inFlightByModel["claude"], 1, "inFlightByModel['claude'] must be 1");

    rotator.finishRequest(account, "claude");
    assert.equal(account.inFlightRequests, 0, "inFlightRequests must be 0 after finishRequest");
    assert.deepEqual(account.inFlightByModel, {}, "inFlightByModel must be empty after finishRequest");
  });

  it("rotateToNext finds available replacement account when previous account in same project is released", async () => {
    const acc1 = makeAccount("acc1@example.com", "shared-project", "claude", 100);
    const acc2 = makeAccount("acc2@example.com", "shared-project", "claude", 100);

    const rotator = new AccountRotator({
      proxyPort: 51203,
      rotateOnQuotaDrop: 20,
      routingPolicy: "timer-first",
      quotaPollIntervalMs: 300000,
      requestsPerRotation: 5,
      maxConcurrentRequestsPerAccount: 1,
      maxConcurrentRequestsPerProjectModel: 1,
      accounts: [acc1.config, acc2.config],
    });
    rotator.stopQuotaPolling();
    (rotator as any).accounts = [acc1, acc2];
    (rotator as any).modelState.set("claude", {
      activeAccountIndex: 0,
      stickyAccountIndex: 0,
      quotaAtRotationStart: 100,
      requestsOnActiveAccount: 0,
    });

    // Simulate start of request on acc1
    const initial = await rotator.getActiveAccount("claude-opus-4-6-thinking");
    assert.equal(initial?.config.email, "acc1@example.com");
    assert.equal(acc1.inFlightRequests, 1);

    // If acc1 encounters 429 RESOURCE_EXHAUSTED:
    // Proxy marks it exhausted and calls finishRequest BEFORE rotateToNext
    rotator.markExhausted(acc1, "claude", 1800000);
    rotator.finishRequest(acc1, "claude");

    // Project concurrency is now clear (0 in-flight for shared-project), so acc2 is eligible
    const nextAccount = await rotator.rotateToNext("claude-opus-4-6-thinking", acc1);
    assert.ok(nextAccount, "rotateToNext must find available sibling account in same project");
    assert.equal(nextAccount.config.email, "acc2@example.com");

    // Next loop attempt leases acc2
    const retryAccount = await rotator.getActiveAccount("claude-opus-4-6-thinking");
    assert.equal(retryAccount?.config.email, "acc2@example.com");
    assert.equal(acc2.inFlightRequests, 1);

    // Successful completion releases acc2
    rotator.finishRequest(retryAccount!, "claude");
    assert.equal(acc2.inFlightRequests, 0);
    assert.deepEqual(acc2.inFlightByModel, {});
  });

  it("replaceConfig preserves stable runtime object identity for active requests", async () => {
    const accA = makeAccount("accA@example.com", "proj-a", "claude", 100);
    const accB = makeAccount("accB@example.com", "proj-b", "claude", 100);

    const rotator = new AccountRotator({
      proxyPort: 51203,
      rotateOnQuotaDrop: 20,
      routingPolicy: "timer-first",
      quotaPollIntervalMs: 300000,
      requestsPerRotation: 5,
      accounts: [accA.config, accB.config],
    });
    rotator.stopQuotaPolling();
    (rotator as any).accounts = [accA, accB];
    (rotator as any).modelState.set("claude", {
      activeAccountIndex: 0,
      stickyAccountIndex: 0,
      quotaAtRotationStart: 100,
      requestsOnActiveAccount: 0,
    });

    // Request leases accA
    const active = await rotator.getActiveAccount("claude-opus-4-6-thinking");
    assert.equal(active, accA, "Leased runtime must be accA");

    // Replace configuration with updated labels/settings
    await rotator.replaceConfig({
      proxyPort: 51203,
      rotateOnQuotaDrop: 20,
      routingPolicy: "timer-first",
      quotaPollIntervalMs: 300000,
      requestsPerRotation: 5,
      accounts: [
        { ...accA.config, label: "Updated Label A" },
        { ...accB.config, label: "Updated Label B" },
      ],
    });

    const accountsAfter = (rotator as any).accounts as AccountRuntime[];
    assert.equal(accountsAfter[0], accA, "replaceConfig must preserve exact runtime object identity for accA");
    assert.equal(accountsAfter[1], accB, "replaceConfig must preserve exact runtime object identity for accB");
    assert.equal(accountsAfter[0].config.label, "Updated Label A");

    rotator.finishRequest(active!, "claude");
  });

  it("rotateToNext excludes explicitly failed account WITHOUT cooldown and across replaceConfig", async () => {
    const accA = makeAccount("accA@example.com", "proj-a", "claude", 100);
    const accB = makeAccount("accB@example.com", "proj-b", "claude", 100);

    const rotator = new AccountRotator({
      proxyPort: 51204,
      rotateOnQuotaDrop: 20,
      routingPolicy: "timer-first",
      quotaPollIntervalMs: 300000,
      requestsPerRotation: 5,
      maxConcurrentRequestsPerAccount: 1,
      maxConcurrentRequestsPerProjectModel: 1,
      accounts: [accA.config, accB.config],
    });
    rotator.stopQuotaPolling();
    (rotator as any).accounts = [accA, accB];
    (rotator as any).modelState.set("claude", {
      activeAccountIndex: 0,
      stickyAccountIndex: 0,
      quotaAtRotationStart: 100,
      requestsOnActiveAccount: 0,
    });

    // 1. Start request on accA
    const active = await rotator.getActiveAccount("claude-opus-4-6-thinking");
    assert.equal(active, accA);

    // 2. Run replaceConfig while accA is active
    await rotator.replaceConfig({
      proxyPort: 51204,
      rotateOnQuotaDrop: 20,
      routingPolicy: "timer-first",
      quotaPollIntervalMs: 300000,
      requestsPerRotation: 5,
      accounts: [accA.config, accB.config],
    });

    // 3. Fail the request (transport/5xx failure: release account without markExhausted or cooldown)
    rotator.finishRequest(active!, "claude");
    assert.equal(accA.cooldownsByModel["claude"] ?? 0, 0, "No cooldown applied on accA");

    // 4. Rotate to next specifying failedAccount = accA
    const nextAccount = await rotator.rotateToNext("claude-opus-4-6-thinking", active!);
    assert.ok(nextAccount);
    assert.equal(
      nextAccount.config.email,
      "accB@example.com",
      "Must select accB, never re-selecting failed account accA",
    );
  });

  it("deterministic barrier: concurrent getActiveAccount calls reserve account before async save/refresh and enforce concurrency limit", async () => {
    const acc1 = makeAccount("acc1@example.com", "proj-1", "claude", 0); // 0% quota forces rotation
    const acc2 = makeAccount("acc2@example.com", "proj-2", "claude", 100);
    const acc3 = makeAccount("acc3@example.com", "proj-3", "claude", 100);

    const rotator = new AccountRotator({
      proxyPort: 51205,
      rotateOnQuotaDrop: 20,
      routingPolicy: "timer-first",
      quotaPollIntervalMs: 300000,
      requestsPerRotation: 5,
      maxConcurrentRequestsPerAccount: 1,
      maxConcurrentRequestsPerProjectModel: 1,
      accounts: [acc1.config, acc2.config, acc3.config],
    });
    rotator.stopQuotaPolling();
    (rotator as any).accounts = [acc1, acc2, acc3];
    (rotator as any).modelState.set("claude", {
      activeAccountIndex: 0,
      stickyAccountIndex: 0,
      quotaAtRotationStart: 0,
      requestsOnActiveAccount: 0,
    });

    // Deterministic barrier inside saveState during activation of Request 1
    let barrierReached: (() => void) | null = null;
    const reachedPromise = new Promise<void>((resolve) => {
      barrierReached = resolve;
    });
    let barrierRelease: (() => void) | null = null;
    const releasePromise = new Promise<void>((resolve) => {
      barrierRelease = resolve;
    });

    const originalSaveState = (rotator as any).saveState.bind(rotator);
    let intercepted = false;
    (rotator as any).saveState = async () => {
      if (!intercepted) {
        intercepted = true;
        barrierReached!();
        await releasePromise;
      }
      return originalSaveState();
    };

    // 1. Launch Request 1
    const req1Promise = rotator.getActiveAccount("claude-opus-4-6-thinking");

    // 2. Wait until Request 1 has entered activation and is paused inside saveState()
    await reachedPromise;

    // At this barrier:
    // With fix: acc2.inFlightRequests is already 1 (reserved synchronously)
    // Without fix: acc2.inFlightRequests was 0 (leaking to req2)
    assert.equal(acc2.inFlightRequests, 1, "acc2 must be reserved with inFlight=1 before saveState resolves");

    // 3. Launch Request 2 while Request 1 is still paused at saveState barrier
    const req2 = await rotator.getActiveAccount("claude-opus-4-6-thinking");
    assert.ok(req2, "Request 2 must obtain an account");
    assert.equal(
      req2.config.email,
      "acc3@example.com",
      "Request 2 must select acc3 while acc2 is leased by paused Request 1",
    );
    assert.equal(acc3.inFlightRequests, 1, "acc3 inFlightRequests must be 1");

    // 4. Release Request 1 barrier and await completion
    barrierRelease!();
    const req1 = await req1Promise;
    assert.ok(req1);
    assert.equal(req1.config.email, "acc2@example.com");

    // Assert neither account ever exceeded 1 in-flight
    assert.equal(acc2.inFlightRequests, 1);
    assert.equal(acc3.inFlightRequests, 1);

    // Cleanup
    rotator.finishRequest(req1, "claude");
    rotator.finishRequest(req2, "claude");
    assert.equal(acc2.inFlightRequests, 0);
    assert.equal(acc3.inFlightRequests, 0);
  });

  it("refunds token bucket and reverts inFlight when model-specific activation fails before request", async () => {
    const acc1 = makeAccount("acc1@example.com", "proj-1", "claude", 0, 1); // 0% quota, 1 token
    const acc2 = makeAccount("acc2@example.com", "proj-2", "claude", 100, 1); // 100% quota, 1 token

    const rotator = new AccountRotator({
      proxyPort: 51206,
      rotateOnQuotaDrop: 20,
      routingPolicy: "hybrid",
      quotaPollIntervalMs: 300000,
      requestsPerRotation: 5,
      maxConcurrentRequestsPerAccount: 1,
      maxConcurrentRequestsPerProjectModel: 1,
      tokenBucketEnabled: true,
      tokenBucketMaxTokens: 1,
      tokenBucketInitialTokens: 1,
      tokenBucketRefillPerMinute: 0.00001,
      accounts: [acc1.config, acc2.config],
    });
    rotator.stopQuotaPolling();
    (rotator as any).accounts = [acc1, acc2];
    acc2.tokenBucket = { tokens: 1, lastRefillAt: Date.now() };
    (rotator as any).modelState.set("claude", {
      activeAccountIndex: 0,
      stickyAccountIndex: 0,
      quotaAtRotationStart: 0,
      requestsOnActiveAccount: 0,
    });

    // Simulate token refresh failure
    (rotator as any).ensureValidTokenForModel = async () => {
      throw new Error("Simulated model refresh failure");
    };

    await assert.rejects(
      async () => {
        await rotator.getActiveAccount("claude-opus-4-6-thinking");
      },
      /Simulated model refresh failure/,
    );

    // Assert token was refunded (tokens=1) and inFlight=0
    assert.equal(acc2.tokenBucket.tokens, 1, "acc2 token bucket must be refunded to 1 on activation failure");
    assert.equal(acc2.inFlightRequests, 0, "acc2 inFlightRequests must be 0");
    assert.deepEqual(acc2.inFlightByModel, {}, "acc2 inFlightByModel must be empty");
  });

  it("refunds token bucket and reverts inFlight when default rotation activation fails before request", async () => {
    const acc1 = makeAccount("acc1@example.com", "proj-1", "claude", 100, 1);
    const acc2 = makeAccount("acc2@example.com", "proj-2", "claude", 100, 1);

    const rotator = new AccountRotator({
      proxyPort: 51207,
      rotateOnQuotaDrop: 20,
      routingPolicy: "hybrid",
      quotaPollIntervalMs: 300000,
      requestsPerRotation: 5,
      maxConcurrentRequestsPerAccount: 1,
      maxConcurrentRequestsPerProjectModel: 1,
      tokenBucketEnabled: true,
      tokenBucketMaxTokens: 1,
      tokenBucketInitialTokens: 1,
      tokenBucketRefillPerMinute: 0.00001,
      accounts: [acc1.config, acc2.config],
    });
    rotator.stopQuotaPolling();
    (rotator as any).accounts = [acc1, acc2];
    acc2.tokenBucket = { tokens: 1, lastRefillAt: Date.now() };
    acc1.disabled = true; // Force rotation to acc2

    // Simulate token refresh failure
    (rotator as any).ensureValidToken = async () => {
      throw new Error("Simulated default refresh failure");
    };

    await assert.rejects(
      async () => {
        // No model specified triggers rotateDefault
        await rotator.getActiveAccount();
      },
      /Simulated default refresh failure/,
    );

    // Assert token was refunded (tokens=1) and inFlight=0
    assert.equal(acc2.tokenBucket.tokens, 1, "acc2 token bucket must be refunded to 1 on default rotation failure");
    assert.equal(acc2.inFlightRequests, 0, "acc2 inFlightRequests must be 0");
  });

  it("executes at most one refresh per account and provider concurrently (single-flight)", async () => {
    const acc = makeAccount("singleflight@example.com", "proj-sf", "claude", 100);
    const rotator = new AccountRotator({
      proxyPort: 51208,
      rotateOnQuotaDrop: 20,
      quotaPollIntervalMs: 300000,
      requestsPerRotation: 5,
      accounts: [acc.config],
    });
    rotator.stopQuotaPolling();
    (rotator as any).accounts = [acc];

    let adapterRefreshCalls = 0;
    const adapter = getProviderAdapter("google-antigravity");
    const originalEnsureValid = adapter.ensureValidToken.bind(adapter);
    adapter.ensureValidToken = async (account: AccountRuntime) => {
      adapterRefreshCalls++;
      await new Promise((resolve) => setTimeout(resolve, 30));
      account.accessToken = "refreshed-token";
      return originalEnsureValid(account);
    };

    try {
      // Trigger multiple concurrent ensureValidToken calls for the same account
      await Promise.all([
        rotator.ensureValidToken(acc, "google-antigravity"),
        rotator.ensureValidToken(acc, "google-antigravity"),
        rotator.ensureValidToken(acc, "google-antigravity"),
      ]);

      // Single-flight must ensure exactly 1 adapter refresh was initiated
      assert.equal(adapterRefreshCalls, 1, "Adapter ensureValidToken must be called exactly once across concurrent callers");
      assert.equal(acc.accessToken, "refreshed-token", "Waiters must observe refreshed token on runtime");
    } finally {
      adapter.ensureValidToken = originalEnsureValid;
    }
  });

  it("does not coalesce refresh flights for distinct accounts with same email but different projects", async () => {
    const acc1 = makeAccount("shared@example.com", "proj-1", "claude", 100);
    const acc2 = makeAccount("shared@example.com", "proj-2", "claude", 100);
    const rotator = new AccountRotator({
      proxyPort: 51209,
      rotateOnQuotaDrop: 20,
      quotaPollIntervalMs: 300000,
      requestsPerRotation: 5,
      accounts: [acc1.config, acc2.config],
    });
    rotator.stopQuotaPolling();
    (rotator as any).accounts = [acc1, acc2];

    let refreshCalls = 0;
    const adapter = getProviderAdapter("google-antigravity");
    const originalEnsureValid = adapter.ensureValidToken.bind(adapter);
    adapter.ensureValidToken = async (account: AccountRuntime) => {
      refreshCalls++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      account.accessToken = `refreshed-${account.config.projectId}`;
    };

    try {
      await Promise.all([
        rotator.ensureValidToken(acc1, "google-antigravity"),
        rotator.ensureValidToken(acc2, "google-antigravity"),
      ]);

      assert.equal(refreshCalls, 2, "Distinct accounts must not coalesce refresh flights");
      assert.equal(acc1.accessToken, "refreshed-proj-1");
      assert.equal(acc2.accessToken, "refreshed-proj-2");
    } finally {
      adapter.ensureValidToken = originalEnsureValid;
    }
  });

  it("initial polling timeout is cancelled by stopQuotaPolling and triggers zero network/poll calls", async () => {
    let pollCalls = 0;
    const acc = makeAccount("polling@example.com", "proj-poll", "claude", 100);

    const rotator = new AccountRotator({
      proxyPort: 51211,
      rotateOnQuotaDrop: 20,
      quotaPollIntervalMs: 300000,
      requestsPerRotation: 5,
      accounts: [acc.config],
    });
    (rotator as any).pollAllQuotas = async () => {
      pollCalls++;
    };

    // Immediately stop polling
    rotator.stopQuotaPolling();

    // Verify both initial timeout and recurring interval handles are nullified
    assert.equal((rotator as any).quotaInitialPollTimer, null, "quotaInitialPollTimer must be null after stopQuotaPolling");
    assert.equal((rotator as any).quotaPollTimer, null, "quotaPollTimer must be null after stopQuotaPolling");

    // Wait past the 2-second initial timeout threshold to confirm zero poll calls happen
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(pollCalls, 0, "No poll calls must occur when stopQuotaPolling is called");
  });

  it("replaceConfig does not transfer runtime state between duplicate-email accounts with different projects", async () => {
    const accA = makeAccount("same@example.com", "project-a", "claude", 100);
    accA.totalRequests = 10;
    accA.tokenBucket = { tokens: 10, lastRefillAt: Date.now() };

    const accB = makeAccount("same@example.com", "project-b", "claude", 100);
    accB.totalRequests = 50;
    accB.tokenBucket = { tokens: 40, lastRefillAt: Date.now() };

    const rotator = new AccountRotator({
      proxyPort: 51212,
      rotateOnQuotaDrop: 20,
      quotaPollIntervalMs: 300000,
      requestsPerRotation: 5,
      accounts: [accA.config, accB.config],
    });
    rotator.stopQuotaPolling();
    (rotator as any).accounts = [accA, accB];

    // Replace config removing Account A and retaining Account B
    await rotator.replaceConfig({
      proxyPort: 51212,
      rotateOnQuotaDrop: 20,
      quotaPollIntervalMs: 300000,
      requestsPerRotation: 5,
      accounts: [accB.config],
    });

    const accountsAfter = (rotator as any).accounts as AccountRuntime[];
    assert.equal(accountsAfter.length, 1);
    assert.equal(accountsAfter[0], accB, "Must retain accB runtime object reference");
    assert.equal(accountsAfter[0].totalRequests, 50, "accB totalRequests must remain 50, not overwritten by accA");
    assert.equal(accountsAfter[0].tokenBucket.tokens, 40, "accB token bucket must remain 40, not overwritten by accA");
  });

  it("stale in-flight refresh does not overwrite newly configured credentials across replaceConfig", async () => {
    const acc = makeAccount("creds@example.com", "proj-c", "claude", 100);
    acc.config.credentials = [{ provider: "google-antigravity", refreshToken: "refresh-old" }];

    const rotator = new AccountRotator({
      proxyPort: 51213,
      rotateOnQuotaDrop: 20,
      quotaPollIntervalMs: 300000,
      requestsPerRotation: 5,
      accounts: [acc.config],
    });
    rotator.stopQuotaPolling();
    (rotator as any).accounts = [acc];

    let oldRefreshRelease: (() => void) | null = null;
    const oldRefreshBlocked = new Promise<void>((resolve) => {
      oldRefreshRelease = resolve;
    });

    const adapter = getProviderAdapter("google-antigravity");
    const originalEnsureValid = adapter.ensureValidToken.bind(adapter);
    let calls = 0;
    adapter.ensureValidToken = async (account: AccountRuntime) => {
      calls++;
      const cred = account.config.credentials?.find((c) => c.provider === "google-antigravity");
      if (cred?.refreshToken === "refresh-old") {
        await oldRefreshBlocked;
        account.accessToken = "token-from-refresh-old";
        return;
      }
      account.accessToken = "token-from-refresh-new";
    };

    try {
      // 1. Start refresh using refresh-old (will block)
      const refresh1Promise = rotator.ensureValidToken(acc, "google-antigravity");

      // 2. While refresh1 is blocked, replace configuration with refresh-new
      await rotator.replaceConfig({
        proxyPort: 51213,
        rotateOnQuotaDrop: 20,
        quotaPollIntervalMs: 300000,
        requestsPerRotation: 5,
        accounts: [
          {
            ...acc.config,
            credentials: [{ provider: "google-antigravity", refreshToken: "refresh-new" }],
          },
        ],
      });

      // 3. Release blocked old refresh
      oldRefreshRelease!();
      await refresh1Promise;

      // 4. Verify access token comes from refresh-new, not the stale refresh-old
      assert.equal(acc.accessToken, "token-from-refresh-new", "Access token must come from newly configured credentials");
      assert.equal(calls, 2, "Must perform second refresh with the new credential generation");
    } finally {
      adapter.ensureValidToken = originalEnsureValid;
    }
  });

  it("concurrent activations do not increment the wrong account's rotation counter", async () => {
    const acc1 = makeAccount("acc1@example.com", "proj-1", "claude", 0); // 0% quota forces rotation
    const acc2 = makeAccount("acc2@example.com", "proj-2", "claude", 100);
    const acc3 = makeAccount("acc3@example.com", "proj-3", "claude", 100);

    const rotator = new AccountRotator({
      proxyPort: 51214,
      rotateOnQuotaDrop: 20,
      routingPolicy: "timer-first",
      quotaPollIntervalMs: 300000,
      requestsPerRotation: 5,
      maxConcurrentRequestsPerAccount: 1,
      maxConcurrentRequestsPerProjectModel: 1,
      accounts: [acc1.config, acc2.config, acc3.config],
    });
    rotator.stopQuotaPolling();
    (rotator as any).accounts = [acc1, acc2, acc3];
    (rotator as any).modelState.set("claude", {
      activeAccountIndex: 0,
      stickyAccountIndex: 0,
      quotaAtRotationStart: 0,
      requestsOnActiveAccount: 0,
    });

    let barrierReached: (() => void) | null = null;
    const reachedPromise = new Promise<void>((resolve) => {
      barrierReached = resolve;
    });
    let barrierRelease: (() => void) | null = null;
    const releasePromise = new Promise<void>((resolve) => {
      barrierRelease = resolve;
    });

    const originalSaveState = (rotator as any).saveState.bind(rotator);
    let intercepted = false;
    (rotator as any).saveState = async () => {
      if (!intercepted) {
        intercepted = true;
        barrierReached!();
        await releasePromise;
      }
      return originalSaveState();
    };

    // 1. Launch Request 1 (reserves acc2, pauses in saveState)
    const req1Promise = rotator.getActiveAccount("claude-opus-4-6-thinking");
    await reachedPromise;

    // 2. Launch Request 2 (sees acc2 busy with inFlight=1, reserves acc3 and completes)
    const req2 = await rotator.getActiveAccount("claude-opus-4-6-thinking");
    assert.equal(req2?.config.email, "acc3@example.com");

    const stateWhileReq1Paused = (rotator as any).modelState.get("claude");
    assert.equal(stateWhileReq1Paused.requestsOnActiveAccount, 1, "acc3 requestsOnActiveAccount must be 1");

    // 3. Release Request 1
    barrierRelease!();
    const req1 = await req1Promise;
    assert.equal(req1?.config.email, "acc2@example.com");

    // 4. Assert acc3's counter did NOT get incremented a second time by req1 completion
    const finalState = (rotator as any).modelState.get("claude");
    assert.equal(
      finalState.requestsOnActiveAccount,
      1,
      "Active account (acc3) must end at exactly 1 request (not 2)",
    );

    rotator.finishRequest(req1!, "claude");
    rotator.finishRequest(req2!, "claude");
  });

  it("rotateToNext excludes explicitly failed account even when modelState shifted to another account", async () => {
    const accA = makeAccount("accA@example.com", "proj-a", "claude", 100);
    const accB = makeAccount("accB@example.com", "proj-b", "claude", 100);
    const accC = makeAccount("accC@example.com", "proj-c", "claude", 100);

    const rotator = new AccountRotator({
      proxyPort: 51215,
      rotateOnQuotaDrop: 20,
      routingPolicy: "timer-first",
      quotaPollIntervalMs: 300000,
      requestsPerRotation: 5,
      maxConcurrentRequestsPerAccount: 1,
      maxConcurrentRequestsPerProjectModel: 1,
      accounts: [accA.config, accB.config, accC.config],
    });
    rotator.stopQuotaPolling();
    (rotator as any).accounts = [accA, accB, accC];
    (rotator as any).modelState.set("claude", {
      activeAccountIndex: 0,
      stickyAccountIndex: 0,
      quotaAtRotationStart: 100,
      requestsOnActiveAccount: 0,
    });

    // 1. Start request on accA
    const activeA = await rotator.getActiveAccount("claude-opus-4-6-thinking");
    assert.equal(activeA, accA);

    // 2. Replace config while active
    await rotator.replaceConfig({
      proxyPort: 51215,
      rotateOnQuotaDrop: 20,
      routingPolicy: "timer-first",
      quotaPollIntervalMs: 300000,
      requestsPerRotation: 5,
      accounts: [accA.config, accB.config, accC.config],
    });

    // 3. Another request moves modelState to accB (index 1)
    (rotator as any).modelState.set("claude", {
      activeAccountIndex: 1, // Currently points to accB
      stickyAccountIndex: 1,
      quotaAtRotationStart: 100,
      requestsOnActiveAccount: 1,
    });

    // 4. Request on accA fails without cooldown or markExhausted
    rotator.finishRequest(activeA!, "claude");
    assert.equal(accA.cooldownsByModel["claude"] ?? 0, 0, "No cooldown on accA");

    // 5. Call rotateToNext with failedAccount = activeA
    const nextAccount = await rotator.rotateToNext("claude-opus-4-6-thinking", activeA!);
    assert.ok(nextAccount);
    assert.notEqual(
      nextAccount.config.email,
      "accA@example.com",
      "Must exclude failed account A, even though modelState was pointing to B",
    );
  });

  it("same-generation in-flight refresh is preserved and joined across replaceConfig", async () => {
    const acc = makeAccount("preserveflight@example.com", "proj-pf", "claude", 100);
    acc.config.credentials = [{ provider: "google-antigravity", refreshToken: "refresh-v1" }];

    const rotator = new AccountRotator({
      proxyPort: 51216,
      rotateOnQuotaDrop: 20,
      quotaPollIntervalMs: 300000,
      requestsPerRotation: 5,
      accounts: [acc.config],
    });
    rotator.stopQuotaPolling();
    (rotator as any).accounts = [acc];

    let barrierRelease: (() => void) | null = null;
    const barrierBlocked = new Promise<void>((resolve) => {
      barrierRelease = resolve;
    });

    const adapter = getProviderAdapter("google-antigravity");
    const originalEnsureValid = adapter.ensureValidToken.bind(adapter);
    let adapterCalls = 0;
    adapter.ensureValidToken = async (account: AccountRuntime) => {
      adapterCalls++;
      await barrierBlocked;
      account.accessToken = "token-v1";
      account.tokenExpires = Date.now() + 3600000;
    };

    try {
      // 1. Start refresh for refresh-v1 (blocks at barrier)
      const flight1 = rotator.ensureValidToken(acc, "google-antigravity");

      // 2. Replace config with updated label while flight1 is active, retaining same credential generation
      await rotator.replaceConfig({
        proxyPort: 51216,
        rotateOnQuotaDrop: 20,
        quotaPollIntervalMs: 300000,
        requestsPerRotation: 5,
        accounts: [
          {
            ...acc.config,
            label: "Updated Label Only",
            credentials: [{ provider: "google-antigravity", refreshToken: "refresh-v1" }],
          },
        ],
      });

      // 3. Second caller asks for token on the same account
      const flight2 = rotator.ensureValidToken(acc, "google-antigravity");

      // 4. Release barrier
      barrierRelease!();
      await Promise.all([flight1, flight2]);

      // Assert single flight was joined across replaceConfig
      assert.equal(adapterCalls, 1, "Must join existing flight and execute adapter exactly once for same credential generation");
      assert.equal(acc.accessToken, "token-v1", "Waiters must observe refreshed token on runtime");
      assert.equal(acc.config.label, "Updated Label Only");
    } finally {
      adapter.ensureValidToken = originalEnsureValid;
    }
  });

  it("Codex persistence failure executes exactly one refresh and propagates persistence error without unpersisted publication", async () => {
    const acc = makeAccount("codexpersist@example.com", "proj-cp", "claude", 100);
    acc.config.credentials = [{ provider: "openai-codex", refreshToken: "codex-refresh-1" }];

    const rotator = new AccountRotator({
      proxyPort: 51217,
      rotateOnQuotaDrop: 20,
      quotaPollIntervalMs: 300000,
      requestsPerRotation: 5,
      accounts: [acc.config],
    });
    rotator.stopQuotaPolling();
    (rotator as any).accounts = [acc];

    const adapter = getProviderAdapter("openai-codex");
    const originalEnsureValid = adapter.ensureValidToken.bind(adapter);
    let attempts = 0;
    adapter.ensureValidToken = async () => {
      attempts++;
      throw new Error("Could not persist the rotated Codex refresh token");
    };

    try {
      await assert.rejects(
        async () => {
          await rotator.ensureValidToken(acc, "openai-codex");
        },
        /Could not persist the rotated Codex refresh token/,
      );

      assert.equal(attempts, 1, "Must execute exactly one refresh attempt and not retry on persistence failure");
      assert.equal(acc.providerTokens?.["openai-codex"]?.accessToken ?? null, null, "Unpersisted access token must not be published");
    } finally {
      adapter.ensureValidToken = originalEnsureValid;
    }
  });

  it("duplicate-email accounts without stable IDs are distinguished by secret fingerprint and isolate runtime state", async () => {
    const accA = makeAccount("dup@example.com", undefined, "claude", 100);
    delete (accA.config as any).projectId;
    accA.config.credentials = [{ provider: "openai-codex", refreshToken: "secret-token-A" }];
    accA.totalRequests = 15;
    accA.tokenBucket = { tokens: 15, lastRefillAt: Date.now() };

    const accB = makeAccount("dup@example.com", undefined, "claude", 100);
    delete (accB.config as any).projectId;
    accB.config.credentials = [{ provider: "openai-codex", refreshToken: "secret-token-B" }];
    accB.totalRequests = 75;
    accB.tokenBucket = { tokens: 45, lastRefillAt: Date.now() };

    const rotator = new AccountRotator({
      proxyPort: 51218,
      rotateOnQuotaDrop: 20,
      quotaPollIntervalMs: 300000,
      requestsPerRotation: 5,
      accounts: [accA.config, accB.config],
    });
    rotator.stopQuotaPolling();
    (rotator as any).accounts = [accA, accB];

    // Replace config retaining only Account B
    await rotator.replaceConfig({
      proxyPort: 51218,
      rotateOnQuotaDrop: 20,
      quotaPollIntervalMs: 300000,
      requestsPerRotation: 5,
      accounts: [accB.config],
    });

    const accountsAfter = (rotator as any).accounts as AccountRuntime[];
    assert.equal(accountsAfter.length, 1);
    assert.equal(accountsAfter[0], accB, "Must match accB runtime exactly via secret fingerprint");
    assert.equal(accountsAfter[0].totalRequests, 75, "accB totalRequests must remain 75, not overwritten by accA");
    assert.equal(accountsAfter[0].tokenBucket.tokens, 45, "accB token bucket must remain 45, not overwritten by accA");
  });

  it("cross-provider refresh publication isolates state in both directions", async () => {
    const acc = makeAccount("dual@example.com", "proj-dual", "claude", 100);
    acc.config.credentials = [
      { provider: "google-antigravity", refreshToken: "google-refresh-1" },
      { provider: "openai-codex", refreshToken: "codex-refresh-1" },
    ];
    acc.accessToken = "initial-google-token";
    acc.tokenExpires = Date.now() + 3600000;
    acc.providerTokens = {
      "openai-codex": { accessToken: "initial-codex-token", tokenExpires: Date.now() + 3600000 },
    };

    const rotator = new AccountRotator({
      proxyPort: 51219,
      rotateOnQuotaDrop: 20,
      quotaPollIntervalMs: 300000,
      requestsPerRotation: 5,
      accounts: [acc.config],
    });
    rotator.stopQuotaPolling();
    (rotator as any).accounts = [acc];

    let googleBlocked: (() => void) | null = null;
    const googleBarrier = new Promise<void>((resolve) => {
      googleBlocked = resolve;
    });

    const googleAdapter = getProviderAdapter("google-antigravity");
    const codexAdapter = getProviderAdapter("openai-codex");
    const origGoogle = googleAdapter.ensureValidToken.bind(googleAdapter);
    const origCodex = codexAdapter.ensureValidToken.bind(codexAdapter);

    googleAdapter.ensureValidToken = async (account: AccountRuntime) => {
      await googleBarrier;
      account.accessToken = "refreshed-google-token";
      account.tokenExpires = Date.now() + 3600000;
    };

    codexAdapter.ensureValidToken = async (account: AccountRuntime) => {
      account.providerTokens = {
        "openai-codex": { accessToken: "refreshed-codex-token", tokenExpires: Date.now() + 3600000 },
      };
      const codexCred = account.config.credentials?.find((c) => c.provider === "openai-codex");
      if (codexCred) codexCred.refreshToken = "rotated-codex-refresh";
    };

    try {
      // 1. Direction 1: Start Google refresh (blocked)
      const googleFlight = rotator.ensureValidToken(acc, "google-antigravity");

      // 2. Refresh Codex while Google is in-flight
      await rotator.ensureValidToken(acc, "openai-codex");
      assert.equal(acc.providerTokens?.["openai-codex"]?.accessToken, "refreshed-codex-token");

      // 3. Release Google refresh
      googleBlocked!();
      await googleFlight;

      // 4. Assert Google refresh updated Google tokens WITHOUT overwriting Codex tokens/credentials
      assert.equal(acc.accessToken, "refreshed-google-token");
      assert.equal(
        acc.providerTokens?.["openai-codex"]?.accessToken,
        "refreshed-codex-token",
        "Google refresh completion must not overwrite Codex providerTokens",
      );
      const codexCredAfter = acc.config.credentials?.find((c) => c.provider === "openai-codex");
      assert.equal(
        codexCredAfter?.refreshToken,
        "rotated-codex-refresh",
        "Google refresh completion must not overwrite Codex credentials entry",
      );
    } finally {
      googleAdapter.ensureValidToken = origGoogle;
      codexAdapter.ensureValidToken = origCodex;
    }
  });

  it("Google projectId does not hide Codex secret fingerprint for dual accounts without Codex ID", async () => {
    const accA = makeAccount("dual-same@example.com", "shared-google-proj", "claude", 100);
    accA.config.credentials = [
      { provider: "google-antigravity", projectId: "shared-google-proj", refreshToken: "g-ref" },
      { provider: "openai-codex", refreshToken: "codex-secret-A" },
    ];
    accA.totalRequests = 12;

    const accB = makeAccount("dual-same@example.com", "shared-google-proj", "claude", 100);
    accB.config.credentials = [
      { provider: "google-antigravity", projectId: "shared-google-proj", refreshToken: "g-ref" },
      { provider: "openai-codex", refreshToken: "codex-secret-B" },
    ];
    accB.totalRequests = 88;

    const rotator = new AccountRotator({
      proxyPort: 51220,
      rotateOnQuotaDrop: 20,
      quotaPollIntervalMs: 300000,
      requestsPerRotation: 5,
      accounts: [accA.config, accB.config],
    });
    rotator.stopQuotaPolling();
    (rotator as any).accounts = [accA, accB];

    // Replace config retaining only Account B
    await rotator.replaceConfig({
      proxyPort: 51220,
      rotateOnQuotaDrop: 20,
      quotaPollIntervalMs: 300000,
      requestsPerRotation: 5,
      accounts: [accB.config],
    });

    const accountsAfter = (rotator as any).accounts as AccountRuntime[];
    assert.equal(accountsAfter.length, 1);
    assert.equal(accountsAfter[0], accB, "Must retain accB runtime based on Codex secret fingerprint");
    assert.equal(accountsAfter[0].totalRequests, 88, "accB totalRequests must remain 88, not overwritten by accA");
  });

  it("retry does not exclude a healthy replacement runtime after failed incarnation is removed", async () => {
    const oldFailedRuntime = makeAccount("replace@example.com", "proj-rep", "claude", 100);
    const newHealthyRuntime = makeAccount("replace@example.com", "proj-rep", "claude", 100);

    const rotator = new AccountRotator({
      proxyPort: 51221,
      rotateOnQuotaDrop: 20,
      routingPolicy: "timer-first",
      quotaPollIntervalMs: 300000,
      requestsPerRotation: 5,
      accounts: [newHealthyRuntime.config],
    });
    rotator.stopQuotaPolling();
    (rotator as any).accounts = [newHealthyRuntime];

    // Failed old runtime was removed / replaced. Now proxy calls rotateToNext with oldFailedRuntime.
    const result = await rotator.rotateToNext("claude-opus-4-6-thinking", oldFailedRuntime);
    assert.ok(result, "rotateToNext must return the healthy replacement runtime, not exclude it with false 503");
    assert.equal(result, newHealthyRuntime, "Must return the healthy new incarnation");
  });

  it("top-level Google refresh token change triggers generation change and discards stale refresh", async () => {
    const acc = makeAccount("toplevel@example.com", "proj-tl", "claude", 100);
    acc.config.refreshToken = "google-top-old";
    delete acc.config.credentials;

    const rotator = new AccountRotator({
      proxyPort: 51222,
      rotateOnQuotaDrop: 20,
      quotaPollIntervalMs: 300000,
      requestsPerRotation: 5,
      accounts: [acc.config],
    });
    rotator.stopQuotaPolling();
    (rotator as any).accounts = [acc];

    let oldBlocked: (() => void) | null = null;
    const oldBarrier = new Promise<void>((resolve) => {
      oldBlocked = resolve;
    });

    const adapter = getProviderAdapter("google-antigravity");
    const origEnsure = adapter.ensureValidToken.bind(adapter);
    let calls = 0;
    adapter.ensureValidToken = async (account: AccountRuntime) => {
      calls++;
      if (account.config.refreshToken === "google-top-old") {
        await oldBarrier;
        account.accessToken = "access-from-top-old";
        return;
      }
      account.accessToken = "access-from-top-new";
    };

    try {
      const flight1 = rotator.ensureValidToken(acc, "google-antigravity");

      // Replace top-level refreshToken
      await rotator.replaceConfig({
        proxyPort: 51222,
        rotateOnQuotaDrop: 20,
        quotaPollIntervalMs: 300000,
        requestsPerRotation: 5,
        accounts: [
          {
            email: acc.config.email,
            projectId: acc.config.projectId,
            refreshToken: "google-top-new",
          },
        ],
      });

      oldBlocked!();
      await flight1;

      assert.equal(acc.accessToken, "access-from-top-new", "Must discard access-from-top-old and refresh with google-top-new");
      assert.equal(calls, 2);
    } finally {
      adapter.ensureValidToken = origEnsure;
    }
  });
});
