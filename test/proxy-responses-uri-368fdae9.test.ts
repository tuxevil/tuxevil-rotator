import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import net, { type AddressInfo } from "node:net";
import type { Server } from "node:http";
import { startProxy } from "../src/proxy.js";
import { stopNotificationPoller } from "../src/notification-poller.js";
import { stopVersionChecker } from "../src/version-check.js";

function rawGet(port: number, target: string): Promise<{ status: number | null; body: string }> {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    let buf = "";
    s.setTimeout(5000, () => {
      s.destroy();
      resolve({ status: null, body: buf });
    });
    s.on("connect", () => {
      s.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    });
    s.on("data", (d) => {
      buf += d.toString("utf8");
    });
    s.on("error", () => resolve({ status: null, body: buf }));
    s.on("close", () => {
      const m = /^HTTP\/1\.1 (\d+)/.exec(buf);
      resolve({ status: m ? Number(m[1]) : null, body: buf });
    });
  });
}

describe("proxy /v1/responses/:id percent-encoding validation (368fdae9)", () => {
  let server: Server | null = null;
  const previousTelemetry = process.env.PI_ROTATOR_TELEMETRY;

  beforeEach(() => {
    process.env.PI_ROTATOR_TELEMETRY = "off";
  });

  afterEach(async () => {
    stopVersionChecker();
    stopNotificationPoller();
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
      server = null;
    }
    if (previousTelemetry === undefined) {
      delete process.env.PI_ROTATOR_TELEMETRY;
    } else {
      process.env.PI_ROTATOR_TELEMETRY = previousTelemetry;
    }
  });

  it("returns 400 instead of throwing URIError on malformed percent-escape in /v1/responses/:id", async () => {
    const rotator = new Proxy({}, { get: (_t, k) => (k === "then" ? undefined : () => ({})) });
    server = startProxy(rotator as never, 0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    const control = await rawGet(port, "/v1/responses/abc");
    assert.equal(control.status, 404);

    const malformed1 = await rawGet(port, "/v1/responses/%E0%A4%A");
    assert.equal(malformed1.status, 400);

    const malformed2 = await rawGet(port, "/v1/responses/%ZZ");
    assert.equal(malformed2.status, 400);

    const after = await rawGet(port, "/v1/responses/abc");
    assert.equal(after.status, 404);
  });
});
