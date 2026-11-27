import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { ANTIGRAVITY_ENDPOINTS } from "../src/types.js";
import { stopVersionChecker } from "../src/version-check.js";
import { stopNotificationPoller } from "../src/notification-poller.js";

describe("in-flight lease symmetry across dynamic catalog changes (f60b1777)", () => {
  const endpoints = ANTIGRAVITY_ENDPOINTS as unknown as string[];
  const savedEndpoints = [...endpoints];
  const savedDir = process.env.TUXEVIL_ROTATOR_DIR;
  let tmpDir: string | null = null;
  let proxy: Server | null = null;
  let upstream: Server | null = null;
  const cleanupFns: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    endpoints.splice(0, endpoints.length, ...savedEndpoints);
    stopVersionChecker();
    stopNotificationPoller();
    for (const fn of cleanupFns.splice(0)) {
      await Promise.resolve(fn()).catch(() => {});
    }
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
    if (savedDir === undefined) delete process.env.TUXEVIL_ROTATOR_DIR;
    else process.env.TUXEVIL_ROTATOR_DIR = savedDir;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it("releases the exact startRequest key in handleCodeAssistPassthrough and mid-admission dynamic catalog updates", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "test-f60b1777-"));
    process.env.TUXEVIL_ROTATOR_DIR = tmpDir;

    const [{ closeDb, initDb }, { AccountRotator }, { startProxy, withRotation }, { dynamicCatalog }, { getAccountIdentity, getCredentialGeneration }] = await Promise.all([
      import("../src/db-store.js"),
      import("../src/rotator.js"),
      import("../src/proxy.js"),
      import("../src/providers/google-antigravity/dynamic-catalog.js"),
      import("../src/account-identity.js"),
    ]);

    cleanupFns.push(
      () => dynamicCatalog.reset(),
      () => closeDb(),
    );

    await initDb();

    let hits = 0;
    upstream = createServer((req, res) => {
      hits++;
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "ok" }] } }] } }));
      });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upPort = (upstream.address() as AddressInfo).port;
    endpoints.splice(0, endpoints.length, `http://127.0.0.1:${upPort}`);

    const rotator = new AccountRotator({
      proxyPort: 0,
      requestsPerRotation: 5,
      rotateOnQuotaDrop: 20,
      quotaPollIntervalMs: 300_000,
      maxConcurrentRequestsPerAccount: 2,
      accounts: [
        {
          email: "test@example.com",
          tier: "pro",
          credentials: [{ provider: "google-antigravity", refreshToken: "rt", projectId: "proj-test" }],
        },
      ],
    });
    rotator.stopQuotaPolling();
    cleanupFns.unshift(() => rotator.stopQuotaPolling());

    const acc = (rotator as unknown as { accounts: Array<{ accessToken?: string; tokenExpires?: number; inFlightRequests: number; inFlightByModel: Record<string, number> }> }).accounts[0];
    acc.accessToken = "tok";
    acc.tokenExpires = Date.now() + 3_600_000;
    const id = getAccountIdentity(acc as never);
    const gen = getCredentialGeneration(acc as never, "google-antigravity");
    dynamicCatalog.retainAccounts([{ id, generation: gen }]);
    dynamicCatalog.updateFromEndpointResponse(
      { models: { "gemini-3-flash": { quotaInfo: { remainingFraction: 1 } } } },
      id,
      gen,
    );

    proxy = startProxy(rotator, 0, "127.0.0.1");
    await once(proxy, "listening");
    const port = (proxy.address() as AddressInfo).port;

    for (let i = 0; i < 3; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/v1internal:countTokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gemini-3-flash", request: {} }),
      });
      await r.text();
      assert.equal(r.status, 200);
    }
    assert.equal(hits, 3);
    assert.equal(acc.inFlightRequests, 0);
    assert.deepEqual(acc.inFlightByModel, {});

    // Also verify withRotation releases the granted key if dynamicCatalog changes mid-admission.
    const origEnsure = rotator.ensureValidToken.bind(rotator);
    rotator.ensureValidToken = async (account, provider) => {
      dynamicCatalog.reset();
      return origEnsure(account, provider);
    };
    const outcome = await withRotation(
      rotator,
      "gemini-3-flash",
      {},
      { project: "proj-test", model: "gemini-3-flash", request: {} },
      async (response) => response.text(),
    );
    assert.equal(outcome.ok, true, `unexpected outcome: ${JSON.stringify(outcome)}`);
    assert.equal(acc.inFlightRequests, 0);
    assert.deepEqual(acc.inFlightByModel, {});
  });
});
