import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http, { type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { forwardRequest } from "../src/providers/google-antigravity/forward.js";
import { ANTIGRAVITY_ENDPOINTS } from "../src/types.js";

describe("forwardRequest bounded error body read (714bc6ca)", () => {
  const eps = ANTIGRAVITY_ENDPOINTS as unknown as string[];
  const savedEndpoints = [...eps];
  const openServers: http.Server[] = [];
  const stalledResponses: ServerResponse[] = [];

  afterEach(async () => {
    eps.splice(0, eps.length, ...savedEndpoints);
    for (const res of stalledResponses.splice(0)) {
      try {
        res.destroy();
      } catch {
        // ignore
      }
    }
    for (const s of openServers.splice(0)) {
      s.closeAllConnections?.();
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  it("retries and succeeds when upstream sends 503 headers and stalls the error body", async () => {
    let hits = 0;
    const server = http.createServer((req, res) => {
      hits++;
      req.resume();
      if (hits === 1) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.flushHeaders();
        res.write('{"error":{"code":503,"message":"unav');
        stalledResponses.push(res);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('data: {"response":{"candidates":[]}}\n\n');
    });
    openServers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    eps.splice(0, eps.length, `http://127.0.0.1:${port}`);

    const account = {
      config: { email: "t@example.com", projectId: "p", refreshToken: "r", label: "t" },
      accessToken: "tok",
      tokenExpires: Date.now() + 60_000,
    };

    const result = await forwardRequest(
      account as never,
      { project: "p", model: "gemini-3.1-pro", request: { contents: [] } },
      {},
      undefined,
      { apiRetry: { maxRetries: 1, initialSleepDurationMs: 1, maxSleepDurationMs: 5 } },
    );
    assert.equal(result.response.status, 200);
    assert.equal(hits, 2);
  });
});
