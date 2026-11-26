import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Window } from "happy-dom";
import * as preact from "preact";
import { createElement, render } from "preact";
import { act } from "preact/test-utils";
import {
  AICODE_SCOPE,
  type AccountRuntime,
  type Config,
} from "../src/types.js";
import type { DashboardAccount, DashboardOverview } from "../src/dashboard-types.js";

const testDir = mkdtempSync(join(tmpdir(), "tuxevil-aicode-eligibility-"));
process.env.TUXEVIL_ROTATOR_DIR = testDir;
process.env.PI_ROTATOR_DIR = testDir;
delete process.env.DATABASE_URL;
delete process.env.TUXEVIL_ROTATOR_DATABASE_URL;
delete process.env.PI_ROTATOR_DATABASE_URL;

const { applyConfigDefaults } = await import("../src/account-store.js");
const { getCredentialGeneration } = await import("../src/account-identity.js");
const { initDb, closeDb } = await import("../src/db-store.js");
const { buildAccountAuthWarning } = await import(
  "../src/providers/google-antigravity/aicode-eligibility.js"
);
const { AccountRotator } = await import("../src/rotator.js");

function makeAccountRuntime(overrides: Partial<AccountRuntime> = {}): AccountRuntime {
  return {
    config: {
      email: "user@gmail.com",
      provider: "google-antigravity",
      refreshToken: "refresh-1",
      projectId: "aicode-consumers",
      tier: "pro",
    },
    accessToken: "access-1",
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
    dailyRequestDay: "2026-11-26",
    healthScore: 1,
    tokenBucket: { tokens: 15, lastRefillAt: Date.now() },
    ...overrides,
  };
}

function makeConfig(): Config {
  return applyConfigDefaults({
    proxyPort: 0,
    requestsPerRotation: 30,
    rotateOnQuotaDrop: 0,
    quotaPollIntervalMs: 900_000,
    accounts: [
      {
        email: "user@gmail.com",
        provider: "google-antigravity",
        refreshToken: "refresh-1",
        projectId: "aicode-consumers",
        tier: "pro",
      },
    ],
  });
}

describe("AICode 3-rule re-auth warning", () => {
  before(async () => {
    await initDb();
  });

  after(async () => {
    await closeDb();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("emits authWarning only when all 3 rules match", () => {
    const seed = makeAccountRuntime();
    const gen = getCredentialGeneration(seed, "google-antigravity");
    const base = makeAccountRuntime({
      tokenScopes: [
        "https://www.googleapis.com/auth/cloud-platform",
        "https://www.googleapis.com/auth/cclog",
      ],
      aicodeEligibility: {
        credentialGeneration: gen,
        checkedAt: Date.now(),
        personalConsumer: true,
        useAicodeMendel: true,
        userTierId: "g1-pro-tier",
      },
    });
    const matched = buildAccountAuthWarning(base);
    assert.ok(matched);
    assert.equal(matched.code, "missing-aicode-scope");
    assert.deepEqual(matched.rules, {
      personalConsumer: true,
      useAicodeMendel: true,
      missingAicodeScope: true,
    });

    assert.equal(
      buildAccountAuthWarning(
        makeAccountRuntime({
          ...base,
          aicodeEligibility: { ...base.aicodeEligibility!, personalConsumer: false },
        }),
      ),
      null,
    );

    assert.equal(
      buildAccountAuthWarning(
        makeAccountRuntime({
          ...base,
          aicodeEligibility: { ...base.aicodeEligibility!, useAicodeMendel: false },
        }),
      ),
      null,
    );

    assert.equal(
      buildAccountAuthWarning(
        makeAccountRuntime({
          ...base,
          tokenScopes: [...base.tokenScopes!, AICODE_SCOPE],
        }),
      ),
      null,
    );

    assert.equal(
      buildAccountAuthWarning(
        makeAccountRuntime({
          ...base,
          tokenScopes: undefined,
        }),
      ),
      null,
    );
  });

  it("captures tokenScopes on refresh, caches loadCodeAssist + listExperiments, and surfaces warning in getStatus", async () => {
    const originalFetch = globalThis.fetch;
    let loadCalls = 0;
    let expCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(
          JSON.stringify({
            access_token: "fresh-access-token",
            expires_in: 3600,
            scope: "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/cclog",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("fetchAvailableModels")) {
        return new Response(
          JSON.stringify({
            models: {
              "gemini-3-flash": {
                quotaInfo: { remainingFraction: 0.9 },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("retrieveUserQuotaSummary")) {
        return new Response(JSON.stringify({ groups: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("loadCodeAssist")) {
        loadCalls += 1;
        return new Response(
          JSON.stringify({
            gcpManaged: false,
            currentTier: { id: "free-tier" },
            paidTier: { id: "g1-pro-tier" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("listExperiments")) {
        expCalls += 1;
        return new Response(
          JSON.stringify({
            flags: [{ name: "use-aicode-mendel", boolValue: true }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }) as typeof fetch;

    const rotator = new AccountRotator(makeConfig()) as any;
    rotator.stopQuotaPolling();
    try {
      const acc = rotator.accounts[0] as AccountRuntime;
      await rotator.ensureValidTokenForProvider(acc, "google-antigravity");
      assert.deepEqual(acc.tokenScopes, [
        "https://www.googleapis.com/auth/cloud-platform",
        "https://www.googleapis.com/auth/cclog",
      ]);

      await rotator.pollAccountQuota(acc);
      await rotator.pollAccountQuota(acc);

      assert.equal(loadCalls, 1, "loadCodeAssist should be cached per credential generation");
      assert.equal(expCalls, 1, "listExperiments should be cached per credential generation");

      const status = rotator.getStatus();
      assert.equal(status.accounts[0].authWarning?.code, "missing-aicode-scope");
      assert.deepEqual(status.accounts[0].authWarning?.rules, {
        personalConsumer: true,
        useAicodeMendel: true,
        missingAicodeScope: true,
      });

      // Re-login clears cached eligibility until refreshed with new scopes
      await rotator.addOrUpdateAccount({
        email: "user@gmail.com",
        provider: "google-antigravity",
        refreshToken: "refresh-2-with-aicode",
        projectId: "aicode-consumers",
        tier: "pro",
      });
      assert.equal(rotator.getStatus().accounts[0].authWarning, null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("renders the auth warning on Accounts cards, list rows, and AccountDetail", async () => {
    const win = new Window({ url: "http://localhost/dashboard/accounts" });
    const prevWindow = globalThis.window;
    const prevDoc = globalThis.document;
    const prevLoc = globalThis.location;
    const prevHist = globalThis.history;
    const prevReact = (globalThis as Record<string, unknown>).React;
    const originalInterval = globalThis.setInterval;
    Object.assign(globalThis, {
      React: preact,
      window: win,
      document: win.document,
      location: win.location,
      history: win.history,
    });
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      const timer = originalInterval(...args);
      timer.unref();
      return timer;
    }) as typeof setInterval;

    const storePath = "../src/web/state/store.js";
    const accountsPagePath = "../src/web/pages/Accounts.js";
    const accountDetailPath = "../src/web/pages/AccountDetail.js";
    const { overview: overviewSignal } = (await import(storePath)) as {
      overview: { value: DashboardOverview | null };
    };
    const { AccountsPage } = (await import(accountsPagePath)) as {
      AccountsPage: preact.FunctionComponent;
    };
    const { AccountDetail } = (await import(accountDetailPath)) as {
      AccountDetail: preact.FunctionComponent<{ email: string; onClose: () => void }>;
    };
    globalThis.setInterval = originalInterval;

    const authWarning = {
      code: "missing-aicode-scope" as const,
      message: "Re-authenticate required: missing aicode scope.",
      rules: {
        personalConsumer: true,
        useAicodeMendel: true,
        missingAicodeScope: true,
      },
    };
    const acct: DashboardAccount = {
      email: "user@gmail.com",
      label: "User",
      provider: "google-antigravity",
      status: "ready",
      activeForModels: [],
      requestsSinceRotation: 0,
      totalRequests: 1,
      dailyRequestCount: 1,
      dailyAccountStopRequests: 5000,
      dailyProjectRequestCount: 1,
      dailyProjectStopRequests: 5000,
      cooldownsByModel: {},
      lastUsed: 0,
      lastError: null,
      consecutiveErrors: 0,
      hasValidToken: true,
      quota: [],
      inFlightRequests: 0,
      inFlightByModel: {},
      proDetected: true,
      tier: "pro",
      healthScore: 1,
      tokenBucket: { enabled: false, tokens: 0, capacity: 0, nextRefillAt: null },
      allowFreshWindowStartsOverride: false,
      effectiveFreshWindowStartsAllowed: true,
      authWarning,
    };
    const fakeOverview: DashboardOverview = {
      generatedAt: Date.now(),
      version: "4.4.9",
      proxyPort: 51200,
      startedAt: Date.now() - 10_000,
      requestsPerRotation: 30,
      maxConcurrentRequestsPerAccount: 2,
      totalRequestsAllAccounts: 1,
      activeAccounts: {},
      accounts: [acct],
      protectivePause: { until: 0, reason: null },
      operatorControls: { allowFreshWindowStarts: true, autoWarmupEnabled: false },
      security: { adminTokenConfigured: true, warning: null, bindHost: "127.0.0.1" },
      routingHealth: {
        state: "healthy",
        reason: "",
        nextRetryAt: null,
        availableCount: 1,
        readyCount: 1,
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
      hostedOAuthConfigured: true,
      capabilities: { database: false },
      usage: { totalRequests: 0, totalInputTokens: 0, totalOutputTokens: 0, savingsUsd: 0 },
      traffic: [],
      recentRequestsByModel: {},
    };

    const prevOverview = overviewSignal.value;
    overviewSignal.value = fakeOverview;
    const root = win.document.createElement("div");
    win.document.body.append(root);
    try {
      await act(async () => {
        render(createElement(AccountsPage, {}), root);
      });
      assert.match(root.textContent ?? "", /Re-authenticate required: missing aicode scope/);

      await act(async () => {
        render(createElement(AccountDetail, { email: "user@gmail.com", onClose: () => {} }), root);
      });
      assert.match(root.textContent ?? "", /Re-authentication required/);
      assert.match(root.textContent ?? "", /personal consumer.*use-aicode-mendel active.*missing aicode scope/);
    } finally {
      render(null, root);
      overviewSignal.value = prevOverview;
      root.remove();
      win.happyDOM.abort();
      Object.assign(globalThis, {
        React: prevReact,
        window: prevWindow,
        document: prevDoc,
        location: prevLoc,
        history: prevHist,
      });
    }
  });
});
