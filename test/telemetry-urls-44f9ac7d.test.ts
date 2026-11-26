import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveTelemetryEndpoint, TelemetryReporter } from "../src/telemetry.js";
import { resolveTelemetryBase } from "../src/notification-poller.js";

const RECEIVER = path.resolve(process.cwd(), "tools/telemetry-receiver/receiver.js");

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
  });
}

describe("telemetry & notification URL resolution across base and prefix proxy forms (44f9ac7d)", () => {
  const cleanups: Array<() => void> = [];

  after(() => {
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {
        // ignore
      }
    }
  });

  it("aligns resolveTelemetryEndpoint and resolveTelemetryBase for bare base URLs and proxy path prefixes", () => {
    assert.equal(
      resolveTelemetryEndpoint("http://127.0.0.1:3800"),
      "http://127.0.0.1:3800/v1/events",
    );
    assert.equal(
      resolveTelemetryBase("http://127.0.0.1:3800"),
      "http://127.0.0.1:3800",
    );

    assert.equal(
      resolveTelemetryEndpoint("https://example.com/telemetry/v1/events"),
      "https://example.com/telemetry/v1/events",
    );
    assert.equal(
      resolveTelemetryBase("https://example.com/telemetry/v1/events"),
      "https://example.com/telemetry",
    );

    assert.equal(
      resolveTelemetryEndpoint("https://example.com/telemetry"),
      "https://example.com/telemetry/v1/events",
    );
    assert.equal(
      resolveTelemetryBase("https://example.com/telemetry"),
      "https://example.com/telemetry",
    );
  });

  it("delivers events and notifications to the real receiver under both bare base URL and proxy prefix", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "test-44f9ac7d-"));
    cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));

    const dataDir = path.join(tmp, "data");
    const cfgDir = path.join(tmp, "cfg");
    const port = await freePort();
    const child = spawn(process.execPath, [RECEIVER], {
      env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    cleanups.push(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });

    let out = "";
    await new Promise<void>((resolve, reject) => {
      child.on("exit", () => reject(new Error("receiver exited: " + out)));
      child.stdout.on("data", (c) => {
        out += String(c);
        if (out.includes("listening on")) resolve();
      });
      child.stderr.on("data", (c) => {
        out += String(c);
      });
    });

    const prefixServer = http.createServer((req, resp) => {
      if (!req.url?.startsWith("/telemetry/")) {
        resp.writeHead(404);
        resp.end("{}");
        return;
      }
      const up = http.request(
        {
          host: "127.0.0.1",
          port,
          method: req.method,
          path: req.url.slice("/telemetry".length),
          headers: req.headers,
        },
        (ur) => {
          resp.writeHead(ur.statusCode || 500, ur.headers);
          ur.pipe(resp);
        },
      );
      up.on("error", () => {
        resp.writeHead(502);
        resp.end();
      });
      req.pipe(up);
    });
    await new Promise<void>((r) => prefixServer.listen(0, "127.0.0.1", r));
    cleanups.push(() => prefixServer.close());
    const proxyPort = (prefixServer.address() as net.AddressInfo).port;

    for (const configuredUrl of [
      `http://127.0.0.1:${port}`,
      `http://127.0.0.1:${proxyPort}/telemetry/v1/events`,
    ]) {
      const evEndpoint = resolveTelemetryEndpoint(configuredUrl);
      const baseUrl = resolveTelemetryBase(configuredUrl);
      const reporter = new TelemetryReporter(() => ({
        accountCount: 1,
        modelsUsed: ["m"],
        totalRequests: 1,
        uptimeSeconds: 1,
        routingHealthState: "healthy",
        flaggedCount: 0,
        disabledCount: 0,
        proCount: 0,
        freeCount: 1,
        tokensByModel: {},
      }));
      process.env.TUXEVIL_ROTATOR_DIR = cfgDir;
      const payload = reporter._buildPayloadForTest("boot");
      const evRes = await fetch(evEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      assert.equal(evRes.status, 202);
      const ntRes = await fetch(`${baseUrl}/v1/notifications?version=4.4.9`);
      assert.equal(ntRes.status, 200);
    }

    const jsonls = readdirSync(dataDir).filter((f) => f.endsWith(".jsonl"));
    assert.ok(jsonls.length >= 1);
  });
});
