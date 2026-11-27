// Models page switches inside the rotator: provider and per-account
// provider switches take accounts out of routing, and survive a restart.

import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

process.env.TUXEVIL_ROTATOR_DIR = mkdtempSync(join(tmpdir(), "rotator-models-"));

import { initDb } from "../src/db-store.js";
import { AccountRotator } from "../src/rotator.js";
import { withRotation, benchmarkAccount } from "../src/proxy.js";
import { getAccountIdentity } from "../src/account-identity.js";
import { dynamicCatalog } from "../src/providers/google-antigravity/dynamic-catalog.js";
import { ANTIGRAVITY_ENDPOINTS } from "../src/types.js";
import { createServer } from "node:http";
import type { AccountConfig, Config } from "../src/types.js";

before(async () => {
  await initDb();
});

const ACCOUNT: AccountConfig = {
  email: "both@example.com",
  credentials: [
    { provider: "google-antigravity", refreshToken: "1//token", projectId: "proj" },
    { provider: "ollama", apiKey: "ollama-key" },
  ],
};

function makeRotator(overrides: Partial<Config> = {}): any {
  const rotator = new AccountRotator({
    proxyPort: 51200,
    requestsPerRotation: 5,
    rotateOnQuotaDrop: 20,
    quotaPollIntervalMs: 300_000,
    accounts: [structuredClone(ACCOUNT)],
    ...overrides,
  });
  rotator.stopQuotaPolling();
  rotator.setOllamaModels(["gemma4:31b"]);
  return rotator;
}

describe("Models page switches in the rotator", () => {
  it("restores snapshot availability and ownership before polling", async () => {
    dynamicCatalog.reset();
    const rotator = makeRotator();
    const id = getAccountIdentity(rotator.accounts[0]);
    dynamicCatalog.updateFromEndpointResponse({ models: { "arbitrary-future-high": { maxTokens: 234567 } } }, id);
    await rotator.saveState();
    dynamicCatalog.reset();
    const restarted = makeRotator();
    assert.equal(dynamicCatalog.hasModelForAccount(id, "arbitrary-future-high"), true);
    assert.equal(dynamicCatalog.getModel("arbitrary-future-high")?.ctx, 234567);
    assert.ok(restarted.getModelCatalog().some((m: { id: string }) => m.id === "arbitrary-future-high"));
    const targets: string[] = [];
    const upstream = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk.toString(); });
      req.on("end", () => {
        targets.push(JSON.parse(body).model);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: "restored" }] } }] }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    assert.ok(address && typeof address !== "string");
    const endpoints = ANTIGRAVITY_ENDPOINTS as unknown as string[];
    const original = [...endpoints];
    endpoints.splice(0, endpoints.length, `http://127.0.0.1:${address.port}`);
    restarted.ensureValidTokenForProvider = async () => {};
    restarted.ensureValidToken = async () => {};
    restarted.accounts[0].accessToken = "mock-token";
    restarted.accounts[0].tokenExpires = Date.now() + 60000;
    try {
      const result = await withRotation(restarted, "arbitrary-future-high", {}, {
        project: "test", model: "arbitrary-future-high",
        request: { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
      }, async (response) => response.text());
      assert.equal(result.ok, true);
      assert.deepEqual(targets, ["arbitrary-future-high"]);
    } finally {
      endpoints.splice(0, endpoints.length, ...original);
      await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
    dynamicCatalog.updateFromEndpointResponse({ models: {} }, id);
    await restarted.saveState();
    dynamicCatalog.reset();
    makeRotator();
    assert.equal(dynamicCatalog.getModel("arbitrary-future-high"), undefined);
    assert.equal(dynamicCatalog.wasDiscovered("arbitrary-future-high"), true);
  });

  it("excludes a disabled account snapshot after startup reconciliation", async () => {
    dynamicCatalog.reset();
    const rotator = makeRotator();
    const account = rotator.accounts[0];
    const id = getAccountIdentity(account);
    dynamicCatalog.updateFromEndpointResponse({ models: { "disabled-only-high": {} } }, id);
    account.disabled = true;
    await rotator.saveState();
    dynamicCatalog.reset();
    const restarted = makeRotator();
    assert.equal(restarted.accounts[0].disabled, true);
    assert.equal(dynamicCatalog.getModel("disabled-only-high"), undefined);
    assert.equal(dynamicCatalog.hasModelForAccount(id, "disabled-only-high"), false);
    restarted.accounts[0].disabled = false;
    await restarted.saveState();
  });

  it("turning a provider off stops routing to it but keeps the account's other providers", async () => {
    const rotator = makeRotator();
    const account = rotator.accounts[0];
    assert.equal(rotator.hasActiveProvider("ollama"), true);

    assert.equal(await rotator.setProviderEnabled("ollama", false), true);
    assert.equal(rotator.hasActiveProvider("ollama"), false);
    assert.match(rotator.getProviderEligibilityRejection(account, "monthly").detail, /Ollama Cloud is turned off/);
    assert.equal(rotator.getProviderEligibilityRejection(account, "gemini"), null);
    assert.ok(
      rotator
        .getModelCatalog()
        .filter((entry: { providerId: string }) => entry.providerId === "ollama")
        .every((entry: { offReason: string }) => entry.offReason === "provider"),
    );

    await rotator.setProviderEnabled("ollama", true);
    assert.equal(rotator.getProviderEligibilityRejection(account, "monthly"), null);
    assert.equal(await rotator.setProviderEnabled("nope", false), false);
  });

  it("turns a provider off for one account and remembers it across a restart", async () => {
    const rotator = makeRotator();
    const account = rotator.accounts[0];

    assert.equal(await rotator.setAccountProviderEnabled(ACCOUNT.email, "ollama", false), true);
    assert.deepEqual(rotator.getStatus().accounts[0].disabledProviders, ["ollama"]);
    assert.match(rotator.getProviderEligibilityRejection(account, "monthly").detail, /turned off for this account/);
    assert.equal(rotator.hasActiveProvider("ollama"), false);
    assert.equal(rotator.hasActiveProvider("google-antigravity"), true);

    const restarted = makeRotator();
    assert.deepEqual(restarted.getStatus().accounts[0].disabledProviders, ["ollama"]);

    await restarted.setAccountProviderEnabled(ACCOUNT.email, "ollama", true);
    assert.equal(restarted.getStatus().accounts[0].disabledProviders, undefined);
    assert.equal(await restarted.setAccountProviderEnabled(ACCOUNT.email, "openai-codex", false), false);
  });

  it("refuses to kickstart a pool whose provider is off", async () => {
    const rotator = makeRotator({ disabledProviders: ["google-antigravity"] });
    const result = await rotator.kickstartTimerForAccount(ACCOUNT.email, "gemini", false);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /turned off/);
  });

  it("saves model switches and provider order in the config", async () => {
    const rotator = makeRotator();
    assert.equal(await rotator.setModelsEnabled(["ollama/gemma4:31b"], false), true);
    assert.equal(await rotator.setModelsEnabled(["gemma4:31b"], false), false);
    assert.equal(await rotator.setProviderOrder(["google-antigravity"]), true);
    const config = rotator.getConfig();
    assert.deepEqual(config.disabledModels, ["ollama/gemma4:31b"]);
    assert.deepEqual(config.providerOrder, ["google-antigravity", "opencode-zen", "openai-codex", "ollama"]);
    assert.equal(
      rotator.getModelCatalog().find((entry: { id: string }) => entry.id === "gemma4:31b").offReason,
      "model",
    );
  });
  it("picks the pool of the provider a request is pinned to, even for a dynamic Google id", () => {
    dynamicCatalog.restoreDiscoveredQuotaPools({ "gemini-9-shared": "gemini" });
    const rotator = makeRotator();
    rotator.setOllamaModels(["gemini-9-shared"]);
    assert.equal(rotator.resolveQuotaModelKeyForDisplay("gemini-9-shared", "ollama"), "monthly");
    assert.equal(rotator.resolveQuotaModelKeyForDisplay("gemini-9-shared", "google-antigravity"), "gemini-9-shared");
  });

  it("reports an account whose providers are all off as off, not ready", async () => {
    const rotator = makeRotator({ disabledProviders: ["google-antigravity"] });
    assert.notEqual(rotator.getStatus().accounts[0].status, "off");
    await rotator.setAccountProviderEnabled(ACCOUNT.email, "ollama", false);
    assert.equal(rotator.getStatus().accounts[0].status, "off");
    await rotator.setAccountProviderEnabled(ACCOUNT.email, "ollama", true);
  });

  it("refuses to kickstart with a turned-off model", async () => {
    const rotator = makeRotator({ disabledModels: ["google-antigravity/gemini-3.8-flash-tiered"] });
    const result = await rotator.kickstartTimerForAccount(ACCOUNT.email, "gemini", false);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /model turned off/);
  });

  it("uses an active account model when the default kickstart model is off", async () => {
    dynamicCatalog.reset();
    const rotator = makeRotator({ disabledModels: ["google-antigravity/gemini-3.8-flash-tiered"] });
    const accountId = getAccountIdentity(rotator.accounts[0]);
    dynamicCatalog.updateFromEndpointResponse(
      { models: { "gemini-pro-agent": {} } },
      accountId,
    );
    rotator.accounts[0].accessToken = "mock-token";
    rotator.accounts[0].tokenExpires = Date.now() + 60_000;
    const originalFetch = globalThis.fetch;
    let requestedModel = "";
    globalThis.fetch = (async (_input, init) => {
      requestedModel = (JSON.parse(String(init?.body)) as { model: string }).model;
      return new Response("", { status: 200 });
    }) as typeof fetch;
    try {
      const result = await rotator.kickstartTimerForAccount(ACCOUNT.email, "gemini", false);
      assert.equal(result.ok, true);
      assert.equal(result.upstreamModel, "gemini-pro-agent");
      assert.equal(requestedModel, "gemini-pro-agent");
    } finally {
      globalThis.fetch = originalFetch;
      dynamicCatalog.reset();
    }
  });

  it("kickstarts each independent discovered Gemini quota pool with its own active model", async () => {
    dynamicCatalog.reset();
    const rotator = makeRotator();
    const account = rotator.accounts[0];
    const accountId = getAccountIdentity(account);
    dynamicCatalog.updateFromEndpointResponse(
      {
        models: {
          "gemini-3-flash": {},
          "gemini-4-argon": {},
        },
      },
      accountId,
      undefined,
      undefined,
      new Map([["gemini-4-argon", "gemini-4-argon"]]),
    );
    account.accessToken = "mock-token";
    account.tokenExpires = Date.now() + 60_000;
    account.quota = [
      { modelKey: "gemini", displayName: "Gemini Models", providerId: "google-antigravity", percentRemaining: 100, resetTime: null, timerType: "fresh" },
      { modelKey: "gemini-4-argon", displayName: "Gemini 4 Argon", providerId: "google-antigravity", percentRemaining: 100, resetTime: null, timerType: "fresh" },
    ];
    const requestedModels: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      if (String(input).includes("streamGenerateContent")) {
        requestedModels.push((JSON.parse(String(init?.body)) as { model: string }).model);
      }
      return new Response("", { status: 200 });
    }) as typeof fetch;
    try {
      const result = await rotator.kickstartAllFreshTimers(ACCOUNT.email);
      assert.equal(result.ok, true);
      assert.deepEqual(requestedModels.sort(), ["gemini-3.8-flash-tiered", "gemini-4-argon"].sort());
      assert.deepEqual(result.results.map((entry: any) => entry.quotaPools).sort(), [["gemini"], ["gemini-4-argon"]].sort());
    } finally {
      globalThis.fetch = originalFetch;
      dynamicCatalog.reset();
    }
  });

  it("skips benchmarks for providers that are turned off", async () => {
    const rotator = makeRotator({ disabledProviders: ["google-antigravity"] });
    const result = await benchmarkAccount(rotator, rotator.accounts[0]);
    assert.equal(result.status, "skipped");
    assert.match(result.error ?? "", /turned off/);
  });

  it("loads the live model lists before snapshotting for review", async () => {
    const rotator = makeRotator();
    rotator.refreshModelCatalogs = async () => rotator.setOllamaModels(["gemma4:31b", "late-arrival"]);
    await rotator.setAutoEnableNewModels(false);
    assert.ok(rotator.getConfig().reviewedModels.includes("ollama/late-arrival"));
  });

  it("does not rewrite the config when a switch is already in that state", async () => {
    const rotator = makeRotator();
    const turnedOff = () =>
      rotator.getStatus().recentEvents.filter((event: { message: string }) => /turned Ollama Cloud off/.test(event.message)).length;
    await rotator.setProviderEnabled("ollama", false);
    await rotator.setProviderEnabled("ollama", false);
    assert.equal(turnedOff(), 1);
  });
});


describe("durable dynamic snapshots in independent processes", () => {
  it("persists discovery, withdrawal and recovery without sharing repository caches", () => {
    const dir = mkdtempSync(join(tmpdir(), "dynamic-independent-"));
    const env: NodeJS.ProcessEnv = { ...process.env, TUXEVIL_ROTATOR_DIR: dir, PI_ROTATOR_DIR: dir };
    delete env.DATABASE_URL;
    delete env.TUXEVIL_ROTATOR_DATABASE_URL;
    delete env.PI_ROTATOR_DATABASE_URL;
    const run = (...args: string[]) => execFileSync(process.execPath, ["--import", "tsx/esm", "test/fixtures/dynamic-restart.ts", ...args], { env, timeout: 15000, stdio: "pipe" });
    try {
      run("write");
      run("read-metadata", "future-only");
      run("failure");
      run("read", "recovered-only");
      run("poll-discover");
      run("read", "future-only");
      run("poll-malformed");
      run("read", "future-only");
      run("poll-empty");
      run("read", "none");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const blocked of ["disabled", "flagged", "legacy"]) {
    it(`reconciles ${blocked} state with snapshots still present on disk`, () => {
      const dir = mkdtempSync(join(tmpdir(), "dynamic-startup-"));
      const env: NodeJS.ProcessEnv = { ...process.env, TUXEVIL_ROTATOR_DIR: dir, PI_ROTATOR_DIR: dir };
      delete env.DATABASE_URL;
      delete env.TUXEVIL_ROTATOR_DATABASE_URL;
      delete env.PI_ROTATOR_DATABASE_URL;
      const run = (...args: string[]) => execFileSync(process.execPath, ["--import", "tsx/esm", "test/fixtures/dynamic-restart.ts", ...args], { env, timeout: 15000, stdio: "pipe" });
      try {
        run("write");
        const path = join(dir, "state.json");
        const state = JSON.parse(readFileSync(path, "utf8"));
        assert.equal(Object.keys(state.dynamicModelSnapshots.accounts).length, 2);
        if (blocked === "legacy") {
          delete state.dynamicModelSnapshots;
        } else {
          state.accounts["a@example.test"][blocked] = true;
        }
        writeFileSync(path, JSON.stringify(state));
        run(blocked === "legacy" ? "read-legacy" : "read", "none");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
