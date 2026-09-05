import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, it } from "node:test";
import { startProxy } from "../src/proxy.js";
import { stopNotificationPoller } from "../src/notification-poller.js";
import { stopVersionChecker } from "../src/version-check.js";
import { setPersistedAdminToken } from "../src/admin-auth.js";

function makeRotator() {
  const state = {
    jitterCalls: 0,
    recordedEvents: [] as string[],
  };

  const rotator = {
    saveState() {},
    getStatus() {
      return {
        accounts: [{ email: "test@example.com", tier: "pro", active: true }],
        security: { adminTokenConfigured: true },
      };
    },
    getSafetyJitterMs(_account: unknown) {
      state.jitterCalls++;
      return 1500;
    },
    getGlobalDelayMs() {
      return 0;
    },
    recordProxyEvent(msg: string) {
      state.recordedEvents.push(msg);
    },
  };

  return { rotator, state };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe("proxy audio and live streaming endpoints", () => {
  let server: Server | null = null;
  let baseUrl = "";
  let wsUrl = "";

  beforeEach(async () => {
    process.env.PI_ROTATOR_TELEMETRY = "off";
    setPersistedAdminToken("test-token");
    const { rotator } = makeRotator();
    server = startProxy(rotator as never, 0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    wsUrl = `ws://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    setPersistedAdminToken(null);
    stopVersionChecker();
    stopNotificationPoller();
    if (server) {
      await closeServer(server);
      server = null;
    }
  });

  it("handles OPTIONS preflight requests with 204 and CORS headers", async () => {
    const resp = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
      method: "OPTIONS",
      headers: {
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, content-type",
      },
    });

    assert.equal(resp.status, 204);
    assert.equal(resp.headers.get("access-control-allow-origin"), "*");
    assert.match(resp.headers.get("access-control-allow-methods") || "", /POST/);
  });

  it("attaches CORS headers to normal requests", async () => {
    const resp = await fetch(`${baseUrl}/health`);
    assert.equal(resp.headers.get("access-control-allow-origin"), "*");
  });

  it("upgrades WebSocket on /ws, /ws/audio, /v1/listen, and /v1/audio/transcriptions/stream", async () => {
    const endpoints = [
      `${wsUrl}/ws`,
      `${wsUrl}/ws/audio`,
      `${wsUrl}/v1/listen`,
      `${wsUrl}/v1/audio/transcriptions/stream`,
    ];

    for (const endpoint of endpoints) {
      const ws = new WebSocket(endpoint);
      const msg = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout on ${endpoint}`)), 3000);
        ws.onmessage = (e) => {
          clearTimeout(timer);
          resolve(JSON.parse(e.data.toString()));
        };
        ws.onerror = (err) => {
          clearTimeout(timer);
          reject(err);
        };
      });

      assert.equal(msg.type, "system_status");
      assert.ok(msg.antigravity, "system_status frame should indicate antigravity server info");
      ws.close();
    }
  });

  it("destroys WebSocket connection on unhandled upgrade paths", async () => {
    const ws = new WebSocket(`${wsUrl}/unhandled-websocket-path`);
    const errorOccurred = await new Promise<boolean>((resolve) => {
      ws.onerror = () => resolve(true);
      ws.onclose = () => resolve(true);
      ws.onopen = () => resolve(false);
      setTimeout(() => resolve(true), 1500);
    });

    assert.equal(errorOccurred, true, "WebSocket to unhandled path should be rejected/closed");
  });
});
