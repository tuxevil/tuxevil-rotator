import { it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureOverview } from "./fixtures/usage-limits/v1/input.js";




it("reserves the read credential outside the summary, including open-admin mode and WebSockets", async t => {
  const directory = await mkdtemp(join(tmpdir(), "usage-proxy-"));
  const previousDir = process.env.TUXEVIL_ROTATOR_DIR;
  process.env.TUXEVIL_ROTATOR_DIR = directory;
  const { startProxy } = await import("../src/proxy.js");
  const { setPersistedAdminToken } = await import("../src/admin-auth.js");
  const { stopNotificationPoller } = await import("../src/notification-poller.js");
  const { stopVersionChecker } = await import("../src/version-check.js");
  const previous = process.env.TUXEVIL_ROTATOR_USAGE_READ_TOKEN;
  process.env.TUXEVIL_ROTATOR_USAGE_READ_TOKEN = "scope-reader-secret";
  t.after(() => { if (previous === undefined) delete process.env.TUXEVIL_ROTATOR_USAGE_READ_TOKEN; else process.env.TUXEVIL_ROTATOR_USAGE_READ_TOKEN = previous; });
  let mutations = 0;
  const server = startProxy({
    saveState() { mutations++; },
    getStatus: () => ({ ...fixtureOverview(), security: { adminTokenConfigured: false } }),
    recordProxyEvent() {},
  } as never, 0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    let upstream = 0;
    const originalFetch = globalThis.fetch;
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).startsWith(base)) { upstream++; throw new Error("Unexpected upstream call"); }
      return originalFetch(input, init);
    });
    const responses = await Promise.all(Array.from({ length: 10 }, () => fetch(base + "/api/usage-limits/v1", { headers: { Authorization: "Bearer scope-reader-secret" } })));
    assert.ok(responses.every(response => response.status === 200));
    const snapshots = await Promise.all(responses.map(response => response.json()));
    assert.equal(new Set(snapshots.map(snapshot => snapshot.instanceId)).size, 1);
    assert.equal(upstream, 0);
    for (const admin of [null, "admin-secret"]) {
      setPersistedAdminToken(admin);
      for (const [path, method] of [
        ["/api/status", "GET"], ["/api/dashboard/snapshot", "GET"], ["/api/config", "PUT"],
        ["/api/config/export", "GET"], ["/api/accounts/enable", "POST"], ["/api/rotate", "POST"],
        ["/api/session", "POST"], ["/auth/antigravity/start", "GET"],
        ["/v1/chat/completions", "POST"], ["/v1/messages", "POST"], ["/v1/responses", "POST"], ["/v1/models", "GET"],
      ]) {
        for (const headers of [{ Authorization: "Bearer scope-reader-secret" }, { "x-api-key": "scope-reader-secret" }] as Record<string, string>[]) {
          const response = await fetch(base + path, { method, headers });
          assert.equal(response.status, 403, `${admin ? "secured" : "open"} ${path}`);
          assert.doesNotMatch(await response.text(), /scope-reader-secret|admin-secret/);
        }
      }
      assert.equal((await fetch(base + "/api/status?token=scope-reader-secret")).status, 403);
      assert.equal((await fetch(base + "/v1/models?key=scope-reader-secret")).status, 403);
      const session = await fetch(base + "/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "scope-reader-secret" }) });
      assert.equal(session.status, 401);
      assert.equal(session.headers.get("set-cookie"), null);
    }
    const socket = connect(port, "127.0.0.1");
    await once(socket, "connect");
    socket.write("GET /ws?key=scope-reader-secret HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
    const [response] = await once(socket, "data");
    assert.match(String(response), /403 Forbidden/); socket.destroy();
    assert.equal(mutations, 0);
    assert.equal((await fetch(base + "/api/usage-limits/v1")).status, 401);
    process.env.TUXEVIL_ROTATOR_USAGE_READ_TOKEN = "admin-secret";
    assert.equal((await fetch(base + "/api/usage-limits/v1", { headers: { Authorization: "Bearer admin-secret" } })).status, 401);
    delete process.env.TUXEVIL_ROTATOR_USAGE_READ_TOKEN;
    assert.equal((await fetch(base + "/api/usage-limits/v1", { headers: { Authorization: "Bearer admin-secret" } })).status, 401);
  } finally {
    setPersistedAdminToken(null); stopNotificationPoller(); stopVersionChecker();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousDir === undefined) delete process.env.TUXEVIL_ROTATOR_DIR; else process.env.TUXEVIL_ROTATOR_DIR = previousDir;
    await rm(directory, { recursive: true, force: true });
  }
});
