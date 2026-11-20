import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";

const testDir = mkdtempSync(join(tmpdir(), "rotator-request-queue-"));
process.env.TUXEVIL_ROTATOR_DIR = testDir;
process.env.PI_ROTATOR_DIR = testDir;
delete process.env.DATABASE_URL;
delete process.env.TUXEVIL_ROTATOR_DATABASE_URL;
delete process.env.PI_ROTATOR_DATABASE_URL;
process.env.ANTIGRAVITY_CLIENT_ID = "test-client-id";
process.env.ANTIGRAVITY_CLIENT_SECRET = "test-client-secret";

let AccountRotator: typeof import("../src/rotator.js").AccountRotator;
let getAccountIdentity: typeof import("../src/rotator.js").getAccountIdentity;
let getDefaultConfig: typeof import("../src/config-defaults.js").getDefaultConfig;
let applyConfigDefaults: typeof import("../src/config-defaults.js").applyConfigDefaults;
let closeDb: typeof import("../src/db-store.js").closeDb;
let dynamicCatalog: typeof import("../src/providers/google-antigravity/dynamic-catalog.js").dynamicCatalog;
type AccountConfig = import("../src/types.js").AccountConfig;
type AccountRuntime = import("../src/types.js").AccountRuntime;
type Config = import("../src/types.js").Config;

const GEMINI_MODEL = "gemini-3-flash";
const CLAUDE_MODEL = "claude-opus-4-5-thinking";
const UNKNOWN_MODEL = "custom-antigravity-model";

before(async () => {
  ({ AccountRotator, getAccountIdentity } = await import("../src/rotator.js"));
  ({ getDefaultConfig, applyConfigDefaults } = await import("../src/config-defaults.js"));
  const db = await import("../src/db-store.js");
  closeDb = db.closeDb;
  await db.initDb();
  ({ dynamicCatalog } = await import("../src/providers/google-antigravity/dynamic-catalog.js"));
});

after(async () => {
  await closeDb();
  rmSync(testDir, { recursive: true, force: true });
});

afterEach(() => {
  dynamicCatalog.reset();
});

function makeRotatorFromAccounts(
  accounts: AccountConfig[],
  overrides: Partial<Config> = {},
) {
  const rotator = new AccountRotator({
    proxyPort: 51200,
    requestsPerRotation: 5,
    rotateOnQuotaDrop: 20,
    quotaPollIntervalMs: 300_000,
    maxConcurrentRequestsPerAccount: 5,
    maxConcurrentRequestsPerProjectModel: 5,
    ...overrides,
    accounts,
  });
  rotator.stopQuotaPolling();

  const runtimes = (
    rotator as unknown as { accounts: AccountRuntime[] }
  ).accounts;
  for (const account of runtimes) {
    account.accessToken = `access-${account.config.email}`;
    account.tokenExpires = Date.now() + 60_000;
    account.quota = ["gemini", "claude"].map((modelKey) => ({
      modelKey,
      displayName: modelKey,
      percentRemaining: 100,
      resetTime: null,
      timerType: "fresh",
      providerId: "google-antigravity",
    }));
  }
  return { rotator, accounts: runtimes };
}

function makeRotator(
  projectIds: Array<string | undefined> = [
    "project-a",
    "project-b",
    "project-c",
    "project-d",
    "project-e",
  ],
  overrides: Partial<Config> = {},
) {
  const accounts = projectIds.map((projectId, index): AccountConfig => ({
    email: `account-${index + 1}@example.com`,
    credentials: [{
      provider: "google-antigravity",
      refreshToken: `refresh-${index + 1}`,
      ...(projectId === undefined ? {} : { projectId }),
    }],
  }));
  return makeRotatorFromAccounts(accounts, overrides);
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function fillCapacity(rotator: InstanceType<typeof AccountRotator>) {
  return Promise.all(Array.from({ length: 25 }, async (_, index) => {
    const model = index % 2 === 0 ? GEMINI_MODEL : CLAUDE_MODEL;
    const account = await rotator.getActiveAccount(model);
    assert.ok(account, `request ${index + 1} must receive an account`);
    return {
      account,
      modelKey: rotator.resolveQuotaModelKeyForDisplay(model)!,
    };
  }));
}

function releaseAll(
  rotator: InstanceType<typeof AccountRotator>,
  leases: Array<{ account: AccountRuntime; modelKey: string }>,
): void {
  for (const lease of leases) rotator.finishRequest(lease.account, lease.modelKey);
}

describe("Antigravity request queue", () => {
  it("routes a discovered model only to its advertiser, even when another account has capacity", async () => {
    const { rotator, accounts } = makeRotator(["project-a", "project-b"]);
    dynamicCatalog.reset();
    dynamicCatalog.updateFromEndpointResponse({
      models: {
        "gemini-account-a-only": { quotaInfo: { remainingFraction: 1 } },
        "gemini-3.8-flash-high": { quotaInfo: { remainingFraction: 1 } },
      },
    }, getAccountIdentity(accounts[0]));
    dynamicCatalog.updateFromEndpointResponse({
      models: { "gemini-account-b-only": { quotaInfo: { remainingFraction: 1 } } },
    }, getAccountIdentity(accounts[1]));

    const selected = (rotator as any).pickBestModelAccount(
      "gemini-account-b-only",
      Date.now(),
      -1,
    );
    assert.equal(selected, accounts[1]);

    accounts[0].inFlightByModel.gemini = 5;
    accounts[0].inFlightRequests = 5;
    const unownedSelection = (rotator as any).pickBestModelAccount(
      "gemini-3.8-flash-high",
      Date.now(),
      -1,
    );
    assert.equal(unownedSelection, null, "a different account must not receive a model it did not advertise");
  });

  it("isolates dynamic routing for same-email accounts with different projects", () => {
    const { rotator, accounts } = makeRotatorFromAccounts([
      {
        email: "shared@example.com",
        credentials: [{
          provider: "google-antigravity",
          refreshToken: "refresh-a",
          projectId: "project-a",
        }],
      },
      {
        email: "shared@example.com",
        credentials: [{
          provider: "google-antigravity",
          refreshToken: "refresh-b",
          projectId: "project-b",
        }],
      },
    ]);
    const firstId = getAccountIdentity(accounts[0]);
    const secondId = getAccountIdentity(accounts[1]);
    assert.notEqual(firstId, secondId);

    dynamicCatalog.updateFromEndpointResponse({
      models: { "gemini-project-a-only": { quotaInfo: { remainingFraction: 1 } } },
    }, firstId);
    dynamicCatalog.updateFromEndpointResponse({
      models: { "gemini-project-b-only": { quotaInfo: { remainingFraction: 1 } } },
    }, secondId);

    assert.equal(
      (rotator as any).pickBestModelAccount("gemini-project-a-only", Date.now(), -1),
      accounts[0],
    );
    assert.equal(
      (rotator as any).pickBestModelAccount("gemini-project-b-only", Date.now(), -1),
      accounts[1],
    );
  });

  it("does not route a removed dynamic model through the generic Gemini pool", () => {
    const { rotator, accounts } = makeRotator(["project-a", "project-b"]);
    const accountId = getAccountIdentity(accounts[0]);
    const removedModel = "gemini-ephemeral-preview";
    dynamicCatalog.updateFromEndpointResponse({
      models: { [removedModel]: { quotaInfo: { remainingFraction: 1 } } },
    }, accountId);

    assert.equal(
      (rotator as any).pickBestModelAccount(removedModel, Date.now(), -1),
      accounts[0],
    );

    dynamicCatalog.updateFromEndpointResponse({ models: {} }, accountId);
    assert.equal(dynamicCatalog.getModel(removedModel), undefined);
    assert.equal(
      (rotator as any).pickBestModelAccount(removedModel, Date.now(), -1),
      null,
    );
    assert.ok(
      (rotator as any).pickBestModelAccount(
        "gemini-never-discovered-preview",
        Date.now(),
        -1,
      ),
      "never-discovered IDs must keep the existing Gemini passthrough behavior",
    );
  });

  it("uses the shared quota pool for dynamic-model cooldown state", () => {
    const { rotator, accounts } = makeRotator(["project-a"]);
    const model = "gemini-4.0-flash-preview";
    dynamicCatalog.updateFromEndpointResponse({
      models: { [model]: { quotaInfo: { remainingFraction: 1 } } },
    }, getAccountIdentity(accounts[0]));

    rotator.markExhausted(accounts[0], model, 60_000, "RESOURCE_EXHAUSTED");

    assert.ok(accounts[0].cooldownsByModel.gemini > Date.now());
    assert.equal(accounts[0].cooldownsByModel[model], undefined);
    assert.equal(
      (rotator as any).isAvailableForModel(
        accounts[0],
        "gemini-3.8-flash-high",
        Date.now(),
      ),
      false,
    );
  });

  it("preserves active and historical dynamic IDs in observability", () => {
    const { rotator, accounts } = makeRotator(["project-a"]);
    const model = "gemini-4.0-flash-preview";
    const accountId = getAccountIdentity(accounts[0]);
    dynamicCatalog.updateFromEndpointResponse({
      models: { [model]: { quotaInfo: { remainingFraction: 1 } } },
    }, accountId);

    rotator.recordTokenUsage(model, 10, 20);
    rotator.recordLatency(model, 5, 15);
    dynamicCatalog.updateFromEndpointResponse({ models: {} }, accountId);
    rotator.recordTokenUsage(model, 30, 40);
    rotator.recordLatency(model, 10, 20);

    const usage = rotator.getTokenUsage();
    assert.deepEqual(usage.tokensByModel[model], {
      input: 40,
      output: 60,
      requests: 2,
    });
    assert.equal(usage.tokensByModel["gemini-3-flash"], undefined);
    assert.equal(rotator.getLatencyStats()[model]?.count, 2);
  });

  it("synchronously removes dynamic snapshots when an account becomes ineligible", async () => {
    const { rotator, accounts } = makeRotatorFromAccounts([{
      email: "catalog-disable@example.com",
      credentials: [{
        provider: "google-antigravity",
        projectId: "project-a",
        refreshToken: "catalog-disable-refresh",
      }],
    }]);
    const accountId = getAccountIdentity(accounts[0]);
    dynamicCatalog.updateFromEndpointResponse({
      models: {
        "gemini-disabled-account-only": { quotaInfo: { remainingFraction: 1 } },
      },
    }, accountId);
    assert.ok(dynamicCatalog.getModel("gemini-disabled-account-only"));

    const disabling = rotator.disableAccount(accounts[0].config.email);
    assert.equal(dynamicCatalog.getModel("gemini-disabled-account-only"), undefined);
    await disabling;
  });

  it("synchronously removes dynamic snapshots when an account is removed", async () => {
    const { rotator, accounts } = makeRotatorFromAccounts([{
      email: "catalog-remove@example.com",
      credentials: [{
        provider: "google-antigravity",
        projectId: "project-a",
        refreshToken: "catalog-remove-refresh",
      }],
    }]);
    dynamicCatalog.updateFromEndpointResponse({
      models: {
        "gemini-removed-account-only": { quotaInfo: { remainingFraction: 1 } },
      },
    }, getAccountIdentity(accounts[0]));

    const removing = rotator.removeAccount(accounts[0].config.email);
    assert.equal(dynamicCatalog.getModel("gemini-removed-account-only"), undefined);
    assert.equal(await removing, true);
  });

  it("rejects a late quota snapshot after the account credential generation changes", async () => {
    const { rotator, accounts } = makeRotatorFromAccounts([{
      email: "catalog-race@example.com",
      credentials: [{
        provider: "google-antigravity",
        projectId: "project-a",
        refreshToken: "catalog-race-refresh",
      }],
    }]);
    const account = accounts[0];
    const accountId = getAccountIdentity(account);
    dynamicCatalog.updateFromEndpointResponse({
      models: {
        "gemini-before-reconfigure": { quotaInfo: { remainingFraction: 1 } },
      },
    }, accountId);

    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let announceFetch!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      announceFetch = resolve;
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      announceFetch();
      await fetchGate;
      return new Response(JSON.stringify({
        models: {
          "gemini-stale-in-flight": { quotaInfo: { remainingFraction: 1 } },
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    try {
      const poll = rotator.pollAccountQuota(account);
      await fetchStarted;
      await rotator.replaceConfig({
        ...rotator.getConfig(),
        accounts: [{
          ...account.config,
          credentials: [{
            provider: "google-antigravity",
            projectId: "project-a",
            refreshToken: "replacement-refresh-token",
          }],
        }],
      });
      const removedSynchronously =
        dynamicCatalog.getModel("gemini-before-reconfigure") === undefined;

      releaseFetch();
      await poll;
      assert.equal(removedSynchronously, true);
      assert.equal(dynamicCatalog.getModel("gemini-stale-in-flight"), undefined);
    } finally {
      releaseFetch();
      globalThis.fetch = originalFetch;
    }
  });

  it("defaults to five total concurrent requests per account and project/model", () => {
    const config = getDefaultConfig();
    assert.equal(config.maxConcurrentRequestsPerAccount, 5);
    assert.equal(config.maxConcurrentRequestsPerProjectModel, 5);

    config.maxConcurrentRequestsPerAccount = 1;
    config.maxConcurrentRequestsPerProjectModel = 1;
    const explicit = applyConfigDefaults(config);
    assert.equal(explicit.maxConcurrentRequestsPerAccount, 1);
    assert.equal(explicit.maxConcurrentRequestsPerProjectModel, 1);
  });

  it("reports the effective account cap with total mixed-model utilization", async () => {
    const { rotator } = makeRotator(["project-a"], {
      maxConcurrentRequestsPerAccount: 7,
      maxConcurrentRequestsPerProjectModel: 7,
    });
    const models = [GEMINI_MODEL, CLAUDE_MODEL, UNKNOWN_MODEL];
    const leases = await Promise.all(
      models.map(async (model) => {
        const account = await rotator.getActiveAccount(model);
        assert.ok(account);
        return {
          account,
          modelKey: rotator.resolveQuotaModelKeyForDisplay(model)!,
        };
      }),
    );

    const status = rotator.getStatus();
    assert.equal(status.maxConcurrentRequestsPerAccount, 7);
    assert.equal(status.accounts[0].inFlightRequests, 3);

    releaseAll(rotator, leases);
  });

  it("distributes 25 mixed-pool leases in five layers and queues request 26", async () => {
    const { rotator, accounts } = makeRotator();
    const leases = await fillCapacity(rotator);

    assert.deepEqual(
      leases.map(({ account }) => account.config.email),
      Array.from({ length: 25 }, (_, index) => accounts[index % 5].config.email),
    );
    assert.deepEqual(accounts.map((account) => account.inFlightRequests), [5, 5, 5, 5, 5]);

    let settled = false;
    const queued = rotator.getActiveAccount(GEMINI_MODEL).then((account) => {
      settled = true;
      return account;
    });
    await nextTurn();
    assert.equal(settled, false, "request 26 must wait instead of receiving 503 or a sixth lease");

    const released = leases.shift()!;
    rotator.finishRequest(released.account, released.modelKey);
    const admitted = await queued;
    assert.equal(admitted, released.account);
    assert.equal(accounts.reduce((sum, account) => sum + account.inFlightRequests, 0), 25);
    assert.equal(Math.max(...accounts.map((account) => account.inFlightRequests)), 5);

    releaseAll(rotator, leases);
    rotator.finishRequest(admitted!, "gemini");
  });

  it("applies the same global cap and queue to unresolved Antigravity models", async () => {
    const { rotator, accounts } = makeRotator();
    const leases = await Promise.all(Array.from({ length: 25 }, async () => {
      const account = await rotator.getActiveAccount(UNKNOWN_MODEL);
      assert.ok(account);
      return account;
    }));
    assert.deepEqual(accounts.map((account) => account.inFlightRequests), [5, 5, 5, 5, 5]);

    let settled = false;
    const queued = rotator.getActiveAccount(UNKNOWN_MODEL).then((account) => {
      settled = true;
      return account;
    });
    await nextTurn();
    assert.equal(settled, false);

    rotator.finishRequest(leases.shift()!, "__default__");
    const admitted = await queued;
    assert.ok(admitted);
    assert.equal(Math.max(...accounts.map((account) => account.inFlightRequests)), 5);

    for (const account of leases) rotator.finishRequest(account, "__default__");
    rotator.finishRequest(admitted, "__default__");
  });

  it("keeps FIFO order, removes an aborted middle waiter, and never double-leases", async () => {
    const { rotator, accounts } = makeRotator();
    const leases = await fillCapacity(rotator);
    const middle = new AbortController();
    const order: string[] = [];

    const request26 = rotator.getActiveAccount(GEMINI_MODEL).then((account) => {
      if (account) order.push("26");
      return account;
    });
    const request27 = rotator.getActiveAccount(CLAUDE_MODEL, middle.signal);
    const request28 = rotator.getActiveAccount(GEMINI_MODEL).then((account) => {
      if (account) order.push("28");
      return account;
    });
    await nextTurn();
    middle.abort();
    assert.equal(await request27, null);

    const firstReleased = leases.shift()!;
    rotator.finishRequest(firstReleased.account, firstReleased.modelKey);
    const admitted26 = await request26;
    assert.deepEqual(order, ["26"]);

    let request28Settled = false;
    void request28.then(() => { request28Settled = true; });
    await nextTurn();
    assert.equal(request28Settled, false);

    const secondReleased = leases.shift()!;
    rotator.finishRequest(secondReleased.account, secondReleased.modelKey);
    const admitted28 = await request28;
    assert.deepEqual(order, ["26", "28"]);
    assert.equal(accounts.reduce((sum, account) => sum + account.inFlightRequests, 0), 25);
    assert.equal(Math.max(...accounts.map((account) => account.inFlightRequests)), 5);

    releaseAll(rotator, leases);
    rotator.finishRequest(admitted26!, "gemini");
    rotator.finishRequest(admitted28!, "gemini");
  });

  it("does not let an admissible Claude tail bypass a blocked Gemini head", async () => {
    const { rotator } = makeRotator(
      ["shared-project", "shared-project"],
      {
        maxConcurrentRequestsPerAccount: 1,
        maxConcurrentRequestsPerProjectModel: 1,
      },
    );
    const activeGemini = await rotator.getActiveAccount(GEMINI_MODEL);
    const activeClaude = await rotator.getActiveAccount(CLAUDE_MODEL);
    assert.ok(activeGemini);
    assert.ok(activeClaude);
    assert.notEqual(activeGemini, activeClaude);

    const order: string[] = [];
    const head = rotator.getActiveAccount(GEMINI_MODEL).then((account) => {
      if (account) order.push("head");
      return account;
    });
    const tail = rotator.getActiveAccount(CLAUDE_MODEL).then((account) => {
      if (account) order.push("tail");
      return account;
    });
    await nextTurn();

    rotator.finishRequest(activeClaude, "claude");
    await nextTurn();
    await nextTurn();
    const tailBarged = order.includes("tail");

    rotator.finishRequest(activeGemini, "gemini");
    const [admittedHead, admittedTail] = await Promise.all([head, tail]);
    if (admittedHead) rotator.finishRequest(admittedHead, "gemini");
    if (admittedTail) rotator.finishRequest(admittedTail, "claude");

    assert.equal(tailBarged, false, "the global queue must not scan past its head");
    assert.deepEqual(order, ["head", "tail"]);
  });

  it("does not let a saturated Codex queue block an available Gemini account", async () => {
    const { rotator, accounts } = makeRotatorFromAccounts(
      [
        {
          email: "codex@example.com",
          credentials: [{
            provider: "openai-codex",
            refreshToken: "codex-refresh",
            providerAccountId: "codex-account",
          }],
        },
        {
          email: "gemini@example.com",
          credentials: [{
            provider: "google-antigravity",
            refreshToken: "google-refresh",
            projectId: "gemini-project",
          }],
        },
      ],
      {
        maxConcurrentRequestsPerAccount: 1,
        maxConcurrentRequestsPerProjectModel: 1,
      },
    );
    accounts[0].providerTokens = {
      "openai-codex": {
        accessToken: "codex-access",
        tokenExpires: Date.now() + 3_600_000,
      },
    };

    const codexModel = "gpt-5.6-luna";
    const activeCodex = await rotator.getActiveAccount(codexModel);
    assert.equal(activeCodex, accounts[0]);

    let codexWaiterSettled = false;
    const queuedCodex = rotator.getActiveAccount(codexModel).then((account) => {
      codexWaiterSettled = true;
      return account;
    });
    await nextTurn();
    assert.equal(codexWaiterSettled, false);

    const activeGemini = await rotator.getActiveAccount(GEMINI_MODEL);
    assert.equal(activeGemini, accounts[1]);
    assert.equal(codexWaiterSettled, false, "the Codex waiter must remain queued");

    rotator.finishRequest(activeCodex!, rotator.resolveQuotaModelKeyForDisplay(codexModel));
    const admittedCodex = await queuedCodex;
    assert.equal(admittedCodex, accounts[0]);
    rotator.finishRequest(admittedCodex!, rotator.resolveQuotaModelKeyForDisplay(codexModel));
    rotator.finishRequest(activeGemini!, "gemini");
  });

  it("expires a saturated waiter after exactly 300 seconds without waiting in real time", async (t) => {
    const { rotator, accounts } = makeRotator();
    const leases = await fillCapacity(rotator);
    t.mock.timers.enable({ apis: ["setTimeout"] });

    let settled = false;
    const queued = rotator.getActiveAccount(GEMINI_MODEL).then((account) => {
      settled = true;
      return account;
    });
    await Promise.resolve();
    await Promise.resolve();
    t.mock.timers.tick(299_999);
    await Promise.resolve();
    assert.equal(settled, false);
    t.mock.timers.tick(1);
    assert.equal(await queued, null);
    assert.deepEqual(accounts.map((account) => account.inFlightRequests), [5, 5, 5, 5, 5]);

    releaseAll(rotator, leases);
  });

  it("does not queue when concurrency masks a non-concurrency gate", async () => {
    const { rotator, accounts } = makeRotator(["project-a"]);
    accounts[0].inFlightByModel.gemini = 5;
    accounts[0].inFlightRequests = 5;
    accounts[0].quota.find((quota) => quota.modelKey === "gemini")!.percentRemaining = 0;
    const controller = new AbortController();
    let settled = false;
    const rejected = rotator.getActiveAccount(GEMINI_MODEL, controller.signal).then(
      (account) => {
        settled = true;
        return account;
      },
    );

    await nextTurn();
    const waited = !settled;
    if (waited) controller.abort();
    assert.equal(waited, false, "quota exhaustion must not become a queue wait");
    assert.equal(await rejected, null);
    assert.equal(
      (rotator as unknown as { requestWaiters: unknown[] }).requestWaiters.length,
      0,
    );
  });

  it("enforces the project/model cap from nested Google credentials", async () => {
    const { rotator } = makeRotator(["shared-project", "shared-project"]);
    const leases: Array<{ account: AccountRuntime; modelKey: string }> = [];
    for (let index = 0; index < 5; index++) {
      const account = await rotator.getActiveAccount(GEMINI_MODEL);
      assert.ok(account);
      leases.push({ account, modelKey: "gemini" });
    }

    let settled = false;
    const sixth = rotator.getActiveAccount(GEMINI_MODEL).then((account) => {
      settled = true;
      return account;
    });
    await nextTurn();
    assert.equal(settled, false);
    assert.equal(
      (rotator as unknown as { requestWaiters: unknown[] }).requestWaiters.length,
      1,
      "the nested shared-project cap must queue the sixth request",
    );
    const released = leases.shift()!;
    rotator.finishRequest(released.account, released.modelKey);
    const admitted = await sixth;
    assert.ok(admitted);

    releaseAll(rotator, leases);
    rotator.finishRequest(admitted, "gemini");
  });

  it("wakes a saturated waiter when a short alternative-account cooldown expires", async () => {
    const { rotator, accounts } = makeRotator(
      ["project-a", "project-b"],
      { maxConcurrentRequestsPerAccount: 1 },
    );
    const active = await rotator.getActiveAccount(GEMINI_MODEL);
    assert.ok(active);
    const cooling = accounts.find((account) => account !== active)!;
    cooling.cooldownsByModel.gemini = Date.now() + 150;

    const controller = new AbortController();
    let settled = false;
    const queued = rotator.getActiveAccount(GEMINI_MODEL, controller.signal).then(
      (account) => {
        settled = true;
        return account;
      },
    );
    await nextTurn();
    assert.equal(settled, false);

    const timeout = Symbol("timeout");
    const admitted = await Promise.race([
      queued,
      new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), 2000)),
    ]);
    if (admitted === timeout) {
      controller.abort();
      await queued;
    }
    rotator.finishRequest(active!, "gemini");
    if (admitted !== timeout && admitted) rotator.finishRequest(admitted, "gemini");

    assert.notEqual(admitted, timeout, "cooldown expiry must trigger a queue recheck");
    assert.equal(admitted, cooling);
  });

  it("rechecks a cooldown waiter when its wake timer fires before the deadline", async (t) => {
    let nowMs = 1_000_000;
    t.mock.method(Date, "now", () => nowMs);
    t.mock.timers.enable({ apis: ["setTimeout"], now: nowMs });

    try {
      const { rotator, accounts } = makeRotator(
        ["project-a", "project-b"],
        { maxConcurrentRequestsPerAccount: 1 },
      );
      const active = await rotator.getActiveAccount(GEMINI_MODEL);
      assert.ok(active);
      const cooling = accounts.find((account) => account !== active)!;
      cooling.cooldownsByModel.gemini = nowMs + 150;

      const queued = rotator.getActiveAccount(GEMINI_MODEL);
      await nextTurn();

      // Simulate a platform timer callback that runs 1ms before its deadline.
      nowMs += 149;
      t.mock.timers.tick(150);
      nowMs += 1;
      await nextTurn();
      t.mock.timers.tick(1);

      const admitted = await queued;
      rotator.finishRequest(active, "gemini");
      if (admitted) rotator.finishRequest(admitted, "gemini");
      assert.equal(admitted, cooling);
    } finally {
      t.mock.timers.reset();
    }
  });

  it("caps long cooldown wake timers at Node's maximum delay", () => {
    const { rotator } = makeRotator(["project-a"]);
    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    const mockedSetTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      delays.push(Number(timeout ?? 0));
      return originalSetTimeout(handler, timeout, ...args);
    }) as typeof setTimeout;

    // Replace only for this synchronous private-scheduler check. The timer is
    // cleared below, so the test does not leave a 24-day handle behind.
    globalThis.setTimeout = mockedSetTimeout;
    try {
      (rotator as unknown as { scheduleRequestWaiterWake(wakeAt: number): void })
        .scheduleRequestWaiterWake(Date.now() + 30 * 24 * 60 * 60 * 1000);
      assert.equal(delays.length, 1);
      assert.ok(delays[0] <= 2_147_483_647);
    } finally {
      (rotator as unknown as { clearRequestWaiterWake(): void }).clearRequestWaiterWake();
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it("wakes a waiter when replaceConfig raises the account capacity", async () => {
    const { rotator } = makeRotator(
      ["project-a"],
      { maxConcurrentRequestsPerAccount: 1 },
    );
    const active = await rotator.getActiveAccount(GEMINI_MODEL);
    assert.ok(active);

    const controller = new AbortController();
    let settled = false;
    const queued = rotator.getActiveAccount(GEMINI_MODEL, controller.signal).then(
      (account) => {
        settled = true;
        return account;
      },
    );
    await nextTurn();
    assert.equal(settled, false);

    await rotator.replaceConfig({
      ...rotator.getConfig(),
      maxConcurrentRequestsPerAccount: 2,
    });
    await nextTurn();
    const admittedImmediately = settled;
    if (!settled) controller.abort();
    const admitted = await queued;

    rotator.finishRequest(active, "gemini");
    if (admitted) rotator.finishRequest(admitted, "gemini");
    assert.equal(admittedImmediately, true, "capacity changes must drain queued requests");
    assert.equal(admitted, active);
  });

  it("wakes a waiter when an idle account is re-enabled", async () => {
    const { rotator } = makeRotator(
      ["project-a", "project-b"],
      { maxConcurrentRequestsPerAccount: 1 },
    );
    const disabledLease = await rotator.getActiveAccount(GEMINI_MODEL);
    const otherLease = await rotator.getActiveAccount(GEMINI_MODEL);
    assert.ok(disabledLease);
    assert.ok(otherLease);
    assert.notEqual(disabledLease, otherLease);

    const queued = rotator.getActiveAccount(GEMINI_MODEL);
    await nextTurn();
    disabledLease.disabled = true;
    rotator.finishRequest(disabledLease, "gemini");
    await nextTurn();

    await rotator.enableAccount(disabledLease.config.email);
    const timeout = Symbol("timeout");
    const wakeResult = await Promise.race([
      queued,
      new Promise<typeof timeout>((resolve) =>
        setTimeout(() => resolve(timeout), 100),
      ),
    ]);
    const wokeOnEnable = wakeResult !== timeout;

    rotator.finishRequest(otherLease, "gemini");
    const admitted = wakeResult === timeout ? await queued : wakeResult;
    if (admitted) rotator.finishRequest(admitted, "gemini");

    assert.equal(wokeOnEnable, true, "re-enabling an account must drain the queue");
    assert.equal(admitted, disabledLease);
  });

  it("wakes a queued default model when a catalog assigns it to Ollama or Codex", async () => {
    const cases = [
      {
        provider: "ollama",
        model: "queue-wakeup-model:latest",
        credential: { provider: "ollama", apiKey: "ollama-key" },
      },
      {
        provider: "openai-codex",
        model: "gpt-5.99-queue-wakeup",
        credential: {
          provider: "openai-codex",
          refreshToken: "codex-refresh",
        },
      },
    ] as const;
    const wokeOnCatalog: boolean[] = [];

    for (const testCase of cases) {
      const { rotator, accounts } = makeRotatorFromAccounts(
        [
          {
            email: `google-${testCase.provider}@example.com`,
            credentials: [{
              provider: "google-antigravity",
              refreshToken: "google-refresh",
              projectId: "google-project",
            }],
          },
          {
            email: `${testCase.provider}@example.com`,
            credentials: [testCase.credential],
          },
        ],
        { maxConcurrentRequestsPerAccount: 1 },
      );
      if (testCase.provider === "openai-codex") {
        accounts[1].providerTokens = {
          "openai-codex": {
            accessToken: "codex-access",
            tokenExpires: Date.now() + 3_600_000,
          },
        };
      }

      const active = await rotator.getActiveAccount(GEMINI_MODEL);
      assert.equal(active, accounts[0]);
      const queued = rotator.getActiveAccount(testCase.model);
      await nextTurn();
      assert.equal(
        (rotator as unknown as { requestWaiters: unknown[] }).requestWaiters.length,
        1,
      );

      if (testCase.provider === "ollama") {
        rotator.setOllamaModels([testCase.model]);
      } else {
        rotator.setCodexModels([testCase.model]);
      }
      const timeout = Symbol("timeout");
      const wakeResult = await Promise.race([
        queued,
        new Promise<typeof timeout>((resolve) =>
          setTimeout(() => resolve(timeout), 100),
        ),
      ]);
      wokeOnCatalog.push(wakeResult !== timeout);

      rotator.finishRequest(active!, "gemini");
      const admitted = wakeResult === timeout ? await queued : wakeResult;
      assert.equal(admitted, accounts[1]);
      if (admitted) {
        rotator.finishRequest(
          admitted,
          rotator.resolveQuotaModelKeyForDisplay(testCase.model),
        );
      }
    }

    assert.deepEqual(wokeOnCatalog, [true, true]);
  });

  it("does not merge accounts with missing project IDs into one project cap", async () => {
    const { rotator } = makeRotator(
      [undefined, undefined],
      { maxConcurrentRequestsPerProjectModel: 1 },
    );
    const first = await rotator.getActiveAccount(GEMINI_MODEL);
    assert.ok(first);

    const controller = new AbortController();
    const secondPromise = rotator.getActiveAccount(GEMINI_MODEL, controller.signal);
    await nextTurn();
    const queued =
      (rotator as unknown as { requestWaiters: unknown[] }).requestWaiters.length > 0;
    if (queued) controller.abort();
    const second = await secondPromise;

    rotator.finishRequest(first!, "gemini");
    if (second) rotator.finishRequest(second, "gemini");
    assert.equal(queued, false, "an absent projectId is not a shared project identity");
    assert.ok(second);
    assert.notEqual(second, first);
  });

  it("uses trimmed nested-to-legacy project fallback for admission and daily accounting", async () => {
    const { rotator, accounts } = makeRotatorFromAccounts(
      [
        {
          email: "legacy@example.com",
          projectId: " shared-project ",
          credentials: [{
            provider: "google-antigravity",
            refreshToken: "legacy-refresh",
            projectId: "   ",
          }],
        },
        {
          email: "nested@example.com",
          projectId: "different-legacy-project",
          credentials: [{
            provider: "google-antigravity",
            refreshToken: "nested-refresh",
            projectId: " shared-project ",
          }],
        },
      ],
      { maxConcurrentRequestsPerProjectModel: 1 },
    );

    rotator.recordUpstreamAttempt(accounts[0]);
    rotator.recordUpstreamAttempt(accounts[1]);
    assert.deepEqual(
      (rotator as unknown as { projectRequests: Record<string, number> }).projectRequests,
      { "shared-project": 2 },
    );

    const first = await rotator.getActiveAccount(GEMINI_MODEL);
    assert.ok(first);
    const controller = new AbortController();
    let settled = false;
    const secondPromise = rotator.getActiveAccount(GEMINI_MODEL, controller.signal).then(
      (account) => {
        settled = true;
        return account;
      },
    );
    await nextTurn();
    const queued = !settled;
    if (queued) {
      rotator.finishRequest(first!, "gemini");
    } else if (first) {
      rotator.finishRequest(first, "gemini");
    }
    const second = await secondPromise;
    if (second) rotator.finishRequest(second, "gemini");

    assert.equal(queued, true, "both credential shapes must resolve to one project cap");
    assert.ok(second);
  });
});
