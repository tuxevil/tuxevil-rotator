import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { PostgresSettingsRepository } from "../src/settings-repository.js";

describe("Code Assist passthrough virtual key auth (85c973b2)", () => {
  const realFetch = globalThis.fetch;
  const savedDatabaseUrl = process.env.DATABASE_URL;
  const savedDir = process.env.TUXEVIL_ROTATOR_DIR;
  let tmpHome: string | null = null;
  let closeServer: (() => Promise<void>) | null = null;
  let closeDbFn: (() => Promise<void>) | null = null;
  let stopTimers: (() => void) | null = null;

  afterEach(async () => {
    mock.restoreAll();
    globalThis.fetch = realFetch;
    stopTimers?.();
    stopTimers = null;
    if (closeServer) {
      await closeServer();
      closeServer = null;
    }
    if (closeDbFn) {
      await closeDbFn().catch(() => {});
      closeDbFn = null;
    }
    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDatabaseUrl;
    if (savedDir === undefined) delete process.env.TUXEVIL_ROTATOR_DIR;
    else process.env.TUXEVIL_ROTATOR_DIR = savedDir;
    if (tmpHome) {
      fs.rmSync(tmpHome, { recursive: true, force: true });
      tmpHome = null;
    }
  });

  it("requires a valid Virtual Key for /v1internal:<CodeAssistAction> when virtual keys exist", async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "test-85c973b2-"));
    process.env.DATABASE_URL = "postgresql://test-85c973b2.test/rotator";
    process.env.TUXEVIL_ROTATOR_DIR = tmpHome;

    const virtualKeyRows = new Map<string, Record<string, unknown>>();
    const qr = (rows: Record<string, unknown>[], command = "SELECT") => ({
      rows,
      command,
      rowCount: rows.length,
      oid: 0,
      fields: [],
    });

    mock.method(PostgresSettingsRepository.prototype, "init", async () => {});
    mock.method(PostgresSettingsRepository.prototype, "query", async (text: string, params?: unknown[]) => {
      if (text.includes("COUNT(*)")) return qr([{ count: String(virtualKeyRows.size) }]);
      if (text.includes("SELECT * FROM rotator_virtual_keys")) {
        const row = virtualKeyRows.get(String(params?.[0]));
        return qr(row ? [row] : []);
      }
      return qr([], text.trimStart().startsWith("UPDATE") ? "UPDATE" : "SELECT");
    });

    const upstreamCalls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const { hostname } = new URL(url);
      if (hostname === "127.0.0.1" || hostname === "localhost") return realFetch(input, init);
      if (url.includes("/v1internal:")) {
        upstreamCalls.push(url);
        return new Response(JSON.stringify({ done: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new TypeError(`blocked non-loopback fetch: ${hostname}`);
    }) as typeof fetch;

    const [dbStore, virtualKeys, proxy, versionCheck, notificationPoller] = await Promise.all([
      import("../src/db-store.js"),
      import("../src/virtual-keys.js"),
      import("../src/proxy.js"),
      import("../src/version-check.js"),
      import("../src/notification-poller.js"),
    ]);

    closeDbFn = dbStore.closeDb;
    stopTimers = () => {
      versionCheck.stopVersionChecker();
      notificationPoller.stopNotificationPoller();
      virtualKeys.clearVirtualKeyCache();
    };

    await dbStore.initDb();
    const rawKey = "rk-test85c973b2-valid-key";
    const tokenHash = virtualKeys.hashKey(rawKey);
    virtualKeyRows.set(tokenHash, {
      token_hash: tokenHash,
      key_name: "rk-test85...",
      key_alias: rawKey,
      user_id: null,
      models: [],
      metadata: {},
      blocked: false,
      last_active: null,
      created_at: "2026-09-22T00:00:00.000Z",
      created_by: "test",
    });
    virtualKeys.clearVirtualKeyCache();

    const account = {
      config: { email: "test@example.com", label: "test", refreshToken: "mock-refresh", projectId: "test-project" },
      accessToken: "mock-access-token",
      tokenExpires: Date.now() + 86_400_000,
      disabled: false,
      flagged: false,
      requestsSinceRotation: 0,
      totalRequests: 0,
      cooldownsByModel: {},
      inFlightRequests: 0,
      inFlightByModel: {},
      healthScore: 1,
    };
    const rotator = {
      saveState() {},
      getStatus: () => ({ accounts: [{ email: account.config.email, tier: "pro", active: true }], security: { adminTokenConfigured: true } }),
      getActiveAccount: async () => account,
      rotateToNext: async () => account,
      finishRequest() {},
      recordUpstreamAttempt() {},
      recordRequest: () => false,
      recordTokenUsage() {},
      markError() {},
      markRateLimited() {},
      markExhausted() {},
      markFlagged() {},
      recordFailure() {},
      recordSuccess() {},
      recordProvider429() {},
      getSafetyJitterMs: () => 0,
      getGlobalDelayMs: () => 0,
      getRetryAfterMs: () => 0,
      recordProxyEvent() {},
    };

    const server = proxy.startProxy(rotator as never, 0, "127.0.0.1");
    closeServer = async () => {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    };
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const post = async (p: string, body: unknown, headers: Record<string, string> = {}) => {
      const r = await realFetch(base + p, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      await r.text();
      return r.status;
    };

    assert.equal(await virtualKeys.hasAnyVirtualKeys(), true);

    assert.equal(await post("/v1internal:onboardUser", { tierId: "free-tier" }), 401);
    assert.equal(await post("/v1internal:fetchAvailableModels", {}), 401);
    assert.equal(upstreamCalls.length, 0);

    assert.equal(
      await post("/v1internal:onboardUser", { tierId: "free-tier" }, { authorization: `Bearer ${rawKey}` }),
      200,
    );
    assert.equal(
      await post("/v1internal:fetchAvailableModels", {}, { "x-rotator-key": rawKey }),
      200,
    );
    assert.equal(upstreamCalls.length, 2);
  });
});
