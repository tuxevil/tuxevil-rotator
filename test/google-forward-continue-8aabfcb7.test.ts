import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { forwardRequest } from "../src/providers/google-antigravity/forward.js";
import { openAIToAntigravityBody } from "../src/providers/google-antigravity/translators.js";
import { ANTIGRAVITY_ENDPOINTS } from "../src/types.js";

describe("forwardRequest preserves synthetic Continue turn unwrapped (8aabfcb7)", () => {
  const endpoints = ANTIGRAVITY_ENDPOINTS as unknown as string[];
  const savedEndpoints = [...endpoints];
  const servers: http.Server[] = [];

  afterEach(async () => {
    endpoints.splice(0, endpoints.length, ...savedEndpoints);
    for (const s of servers.splice(0)) {
      s.closeAllConnections?.();
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  it("keeps the synthetic Continue turn unwrapped on the wire when forwarded", async () => {
    const captured: string[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        captured.push(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end("data: {}\n\n");
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    endpoints[0] = `http://127.0.0.1:${port}`;

    const body = openAIToAntigravityBody({
      model: "gemini-3.8-flash-high",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Partial" },
      ],
    });

    const account = {
      config: { email: "test@example.com", label: "test", projectId: "proj", refreshToken: "rt" },
      accessToken: "tok",
    };

    const res = await forwardRequest(account as never, body as never, {}, undefined, { apiRetry: false });
    await res.response.text();

    assert.equal(captured.length, 1);
    const sent = JSON.parse(captured[0]) as {
      request: { contents: Array<{ role: string; parts: Array<{ text: string }> }> };
    };
    assert.equal(sent.request.contents.length, 3);
    assert.equal(sent.request.contents[0].parts[0].text, "<USER_REQUEST>\nHello\n</USER_REQUEST>");
    assert.equal(sent.request.contents[2].role, "user");
    assert.equal(sent.request.contents[2].parts[0].text, "Continue");
  });
});
