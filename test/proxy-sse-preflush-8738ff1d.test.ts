import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { startProxy } from "../src/proxy.js";
import { stopNotificationPoller } from "../src/notification-poller.js";
import { stopVersionChecker } from "../src/version-check.js";
import { ANTIGRAVITY_ENDPOINTS } from "../src/types.js";
import { setAntigravityModelsForTest } from "./fixtures/antigravity-catalog.js";

function makeAccount(email: string) {
  return {
    config: { email, projectId: "test-project", refreshToken: "rt", label: email },
    accessToken: `token-${email}`,
    tokenExpires: Date.now() + 60_000,
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
    dailyRequestDay: "2026-05-16",
    healthScore: 1,
    tokenBucket: { tokens: 50, lastRefillAt: Date.now() },
  };
}

describe("proxy SSE pre-flush rotation (8738ff1d)", () => {
  const endpoints = ANTIGRAVITY_ENDPOINTS as unknown as string[];
  const original = [...endpoints];
  let proxy: ReturnType<typeof startProxy> | null = null;
  let upstream: ReturnType<typeof createServer> | null = null;

  afterEach(async () => {
    endpoints.splice(0, endpoints.length, ...original);
    stopVersionChecker();
    stopNotificationPoller();
    if (proxy) {
      proxy.closeAllConnections?.();
      await new Promise<void>((r) => proxy!.close(() => r()));
      proxy = null;
    }
    if (upstream) {
      upstream.closeAllConnections?.();
      await new Promise<void>((r) => upstream!.close(() => r()));
      upstream = null;
    }
  });

  it("rotates to the next account when upstream sends 200 SSE headers and closes before any chunk", async () => {
    setAntigravityModelsForTest(["gemini-3-flash"]);

    let calls = 0;
    upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
      req.resume();
      req.on("end", () => {
        calls += 1;
        if (calls === 1) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.flushHeaders();
          res.socket?.destroySoon();
          return;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end('data: {"response":{"candidates":[{"content":{"parts":[{"text":"recovered"}]}}]}}\n\n');
      });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    endpoints.splice(0, endpoints.length, `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`);

    const accounts = [makeAccount("a@example.com"), makeAccount("b@example.com")];
    let active = 0;
    let rotations = 0;
    const rotator = {
      getActiveAccount: async () => accounts[active],
      getRetryAfterMs: () => 0,
      rotateToNext: async () => {
        if (active >= accounts.length - 1) return null;
        active++;
        rotations++;
        return accounts[active];
      },
      finishRequest: () => {},
      getSafetyJitterMs: () => 0,
      recordUpstreamAttempt: () => {},
      markExhausted: () => {},
      recordProvider429: () => {},
      getFlagContext: () => ({
        timerType: "fresh",
        accountQuotaPercent: 0,
        wasProAccount: false,
        accountRequestsLastHour: 0,
        poolSize: 2,
        poolHealthyCount: 2,
        uptimeSeconds: 0,
      }),
      markFlagged: () => {},
      markError: () => {},
      recordRequest: () => false,
      recordProxyEvent: () => {},
      getGlobalDelayMs: () => 0,
      getConfig: () => ({ streamRecoveryMaxRetries: 2 }),
      getAccountCount: () => 2,
      saveState: async () => {},
      getStatus: () => ({ accounts: [] }),
      getOllamaModels: () => [],
      resolveQuotaModelKeyForDisplay: (m: string) => m,
      recordRequestLog: () => {},
      recordLatency: () => {},
      recordTokenUsage: () => {},
    };

    proxy = startProxy(rotator as never, 0, "127.0.0.1");
    await once(proxy, "listening");
    const port = (proxy.address() as AddressInfo).port;
    const resp = await fetch(`http://127.0.0.1:${port}/v1internal:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3-flash",
        request: { contents: [{ role: "user", parts: [{ text: "ping" }] }] },
      }),
    });
    const text = await resp.text();
    assert.equal(resp.status, 200);
    assert.equal(calls, 2);
    assert.equal(rotations, 1);
    assert.ok(text.includes("recovered"));
  });
});
