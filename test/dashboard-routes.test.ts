import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { setPersistedAdminToken } from "../src/admin-auth.js";
import { startProxy } from "../src/proxy.js";
import { stopNotificationPoller } from "../src/notification-poller.js";
import { stopVersionChecker } from "../src/version-check.js";

function makeRotator() {
  const state = { accounts: [{ email: "user@example.com", status: "ready" }], enabled: [] as string[] };
  const rotator = {
    saveState: () => Promise.resolve(),
    getStatus() {
      return {
        version: "3.10.0",
        accounts: state.accounts.map((a) => ({
          ...a,
          label: a.email,
          provider: "google-antigravity",
          quota: [],
          activeForModels: [],
          cooldownsByModel: {},
          inFlightByModel: {},
          tokenBucket: { enabled: false, tokens: 0, capacity: 0, nextRefillInMs: 0 },
        })),
        security: { adminTokenConfigured: true, warning: null, bindHost: "127.0.0.1" },
        routingDiagnostics: {},
        circuitBreakers: { model: {}, project: {} },
        requestLog: [],
        recentEvents: [],
        tokenUsage: { minutes: [], hours: [], days: [], months: [], totalInputTokens: 0, totalOutputTokens: 0, totalRequests: 0, tokensByModel: {}, savings: { totalUsd: 0, byModel: {} } },
        latencyStats: {},
      };
    },
    getTokenUsage() {
      return this.getStatus().tokenUsage;
    },
    getLatencyStats() {
      return this.getStatus().latencyStats;
    },
    async enableAccount(email: string) {
      state.enabled.push(email);
      return true;
    },
    recordProxyEvent() {},
  };
  return { rotator, state };
}

describe("dashboard routes", () => {
  let server: Server | null = null;
  let base = "";
  const previousTelemetry = process.env.PI_ROTATOR_TELEMETRY;

  async function start(rotator: unknown) {
    server = startProxy(rotator as never, 0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async function signIn(): Promise<string> {
    const res = await fetch(`${base}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "secret" }),
    });
    assert.equal(res.status, 200);
    const cookie = res.headers.get("set-cookie") ?? "";
    assert.match(cookie, /tuxevil_session=/);
    return cookie.split(";")[0];
  }

  beforeEach(() => {
    process.env.PI_ROTATOR_TELEMETRY = "off";
    setPersistedAdminToken("secret");
  });

  afterEach(async () => {
    setPersistedAdminToken(null);
    stopVersionChecker();
    stopNotificationPoller();
    if (server) {
      await new Promise<void>((resolve, reject) => server!.close((err) => (err ? reject(err) : resolve())));
      server = null;
    }
    if (previousTelemetry === undefined) delete process.env.PI_ROTATOR_TELEMETRY;
    else process.env.PI_ROTATOR_TELEMETRY = previousTelemetry;
  });

  it("serves the app shell for every dashboard path without auth", async () => {
    await start(makeRotator().rotator);
    for (const path of ["/dashboard", "/dashboard/accounts/user%40example.com", "/dashboard/keys"]) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get("content-security-policy") ?? "", /script-src 'self'/);
      assert.match(await res.text(), /<div id="app"><\/div>/);
    }
    const root = await fetch(`${base}/?mask=1`, { redirect: "manual" });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get("location"), "/dashboard?mask=1");
  });

  it("trades a ?token= link for a session cookie and strips the token", async () => {
    await start(makeRotator().rotator);
    const good = await fetch(`${base}/dashboard/usage?token=secret&range=7d`, { redirect: "manual" });
    assert.equal(good.status, 302);
    assert.equal(good.headers.get("location"), "/dashboard/usage?range=7d");
    assert.match(good.headers.get("set-cookie") ?? "", /tuxevil_session=.+HttpOnly.+SameSite=Strict/);

    const bad = await fetch(`${base}/dashboard?token=nope`, { redirect: "manual" });
    assert.equal(bad.status, 302);
    assert.equal(bad.headers.get("location"), "/dashboard?auth=invalid");
    assert.equal(bad.headers.get("set-cookie"), null);
  });

  it("protects dashboard data and accepts the session cookie", async () => {
    await start(makeRotator().rotator);
    assert.equal((await fetch(`${base}/api/dashboard/snapshot`)).status, 401);
    assert.deepEqual(await (await fetch(`${base}/api/session`)).json(), { authRequired: true, authenticated: false });

    const cookie = await signIn();
    const snapshot = await fetch(`${base}/api/dashboard/snapshot`, { headers: { cookie } });
    assert.equal(snapshot.status, 200);
    const body = await snapshot.json();
    assert.equal(body.overview.accounts[0].email, "user@example.com");
    assert.deepEqual(body.requests, []);
    assert.deepEqual(await (await fetch(`${base}/api/session`, { headers: { cookie } })).json(), {
      authRequired: true,
      authenticated: true,
    });

    const usage = await fetch(`${base}/api/dashboard/usage?range=24h`, { headers: { cookie } });
    assert.equal(usage.status, 200);
    assert.equal((await usage.json()).range, "24h");
    assert.equal((await fetch(`${base}/api/dashboard/usage?range=2y`, { headers: { cookie } })).status, 400);

    const csv = await fetch(`${base}/api/dashboard/usage/export?format=csv`, { headers: { cookie } });
    assert.match(csv.headers.get("content-disposition") ?? "", /rotator-token-usage\.csv/);
  });

  it("rejects wrong tokens and clears the session on sign-out", async () => {
    await start(makeRotator().rotator);
    const wrong = await fetch(`${base}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "guess" }),
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get("set-cookie"), null);

    const cookie = await signIn();
    const out = await fetch(`${base}/api/session`, { method: "DELETE", headers: { cookie } });
    assert.match(out.headers.get("set-cookie") ?? "", /Max-Age=0/);
    assert.equal((await fetch(`${base}/api/dashboard/snapshot`, { headers: { cookie } })).status, 401, "the signed-out cookie is revoked");
  });

  it("requires same-origin for cookie-authenticated writes", async () => {
    const { rotator, state } = makeRotator();
    await start(rotator);
    const cookie = await signIn();
    const url = `${base}/api/enable/user%40example.com`;

    const crossSite = await fetch(url, { method: "POST", headers: { cookie, origin: "http://evil.example" } });
    assert.equal(crossSite.status, 403, "refused, but not treated as a signed-out session");
    assert.deepEqual(state.enabled, []);

    const sameOrigin = await fetch(url, { method: "POST", headers: { cookie, "sec-fetch-site": "same-origin" } });
    assert.equal(sameOrigin.status, 200);
    assert.deepEqual(state.enabled, ["user@example.com"]);

    const withToken = await fetch(url, { method: "POST", headers: { "x-rotator-admin-token": "secret" } });
    assert.equal(withToken.status, 200, "API clients with the token need no origin");
  });

  it("streams a snapshot and then only account changes", async () => {
    const { rotator, state } = makeRotator();
    await start(rotator);
    const cookie = await signIn();
    const controller = new AbortController();
    const res = await fetch(`${base}/api/dashboard/stream`, { headers: { cookie }, signal: controller.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const readUntil = async (pattern: RegExp) => {
      while (!pattern.test(text)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    };
    await readUntil(/event: snapshot\ndata: .*\n\n/);
    state.accounts = [{ email: "user@example.com", status: "disabled" }];
    void (rotator as { saveState: () => Promise<void> }).saveState();
    await readUntil(/event: accounts\ndata: .*\n\n/);
    const patch = JSON.parse(text.split("event: accounts\ndata: ")[1].split("\n")[0]);
    assert.equal(patch.upsert.length, 1);
    assert.equal(patch.upsert[0].status, "disabled");
    controller.abort();
  });
});
