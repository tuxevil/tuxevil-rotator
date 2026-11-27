import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { fetchWithRetry } from "../src/fetch-with-retry.js";

describe("fetchWithRetry TimeoutError retries (bfe6d6be)", () => {
  const servers: http.Server[] = [];
  const sockets = new Set<Socket>();

  afterEach(async () => {
    for (const s of sockets) s.destroy();
    sockets.clear();
    for (const server of servers.splice(0)) {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("retries when AbortSignal.timeout rejects fetch with TimeoutError", async () => {
    let reqs = 0;
    const server = http.createServer((_req, res) => {
      reqs++;
      if (reqs === 1) return;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    server.on("connection", (s) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

    const res = await fetchWithRetry(url, {
      timeoutMs: 30,
      retries: 2,
      sleepImpl: async () => {},
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
    assert.equal(reqs, 2);
  });
});
