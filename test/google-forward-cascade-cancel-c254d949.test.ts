import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { forwardRequest } from "../src/providers/google-antigravity/forward.js";
import { ANTIGRAVITY_ENDPOINTS } from "../src/types.js";

describe("forwardRequestOnce cascade cancels discarded response body (c254d949)", () => {
  const endpoints = ANTIGRAVITY_ENDPOINTS as unknown as string[];
  const saved = [...endpoints];
  const sockets = new Set<net.Socket>();
  const servers: http.Server[] = [];

  afterEach(async () => {
    endpoints.splice(0, endpoints.length, ...saved);
    for (const s of sockets) s.destroy();
    sockets.clear();
    for (const srv of servers.splice(0)) {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it("closes the non-prod socket when cascading on 404 with an open response stream", async () => {
    let closedResolve!: () => void;
    const closedP = new Promise<void>((r) => (closedResolve = r));
    let nonProdHits = 0;
    let prodHits = 0;

    const nonProd = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        nonProdHits++;
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.flushHeaders();
        res.write("open-stream");
      });
      req.socket.on("close", () => closedResolve());
    });
    const prod = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        prodHits++;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end('data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}}\n\n');
      });
    });

    for (const s of [nonProd, prod]) {
      servers.push(s);
      s.on("connection", (sock) => {
        sockets.add(sock);
        sock.on("close", () => sockets.delete(sock));
      });
      s.listen(0, "127.0.0.1");
      await once(s, "listening");
    }

    const nonProdUrl = `http://127.0.0.1:${(nonProd.address() as AddressInfo).port}`;
    const prodUrl = `http://127.0.0.1:${(prod.address() as AddressInfo).port}`;
    endpoints.splice(0, endpoints.length, nonProdUrl, prodUrl);

    const account = {
      config: { email: "a@x", projectId: "p", refreshToken: "rt", label: "a@x" },
      accessToken: "token-a",
      tokenExpires: Date.now() + 60_000,
    };
    const body = {
      project: "x",
      model: "gemini-3-flash",
      request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
    };

    const forwarded = await forwardRequest(account as never, body as never, {}, undefined, {
      apiRetry: false,
    });
    const text = await forwarded.response.text();
    assert.equal(nonProdHits, 1);
    assert.equal(prodHits, 1);
    assert.equal(forwarded.endpoint, prodUrl);
    assert.ok(text.includes("ok"));

    const winner = await Promise.race([
      closedP.then(() => "closed"),
      new Promise<string>((r) => {
        const t = setTimeout(() => r("open"), 1500);
        t.unref?.();
      }),
    ]);
    assert.equal(winner, "closed");
  });
});
