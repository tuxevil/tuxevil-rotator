import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it } from "node:test";
import { streamCompatSse } from "../src/compat.js";
import { startSseKeepalive } from "../src/stream-guards.js";
import { validateConfig } from "../src/validators.js";
import { applyConfigDefaults } from "../src/config-defaults.js";

type FakeResponse = ServerResponse & { body: string; emitter: EventEmitter };

function fakeResponse(): FakeResponse {
  const emitter = new EventEmitter();
  let headersSent = false;
  let writableEnded = false;
  const res = {
    body: "",
    emitter,
    destroyed: false,
    writableNeedDrain: false,
    get headersSent() {
      return headersSent;
    },
    get writableEnded() {
      return writableEnded;
    },
    writeHead() {
      headersSent = true;
      return this;
    },
    write(chunk: string | Uint8Array) {
      this.body += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    },
    end(chunk?: string) {
      if (chunk) this.body += chunk;
      writableEnded = true;
      emitter.emit("finish");
      return this;
    },
    once(event: string, listener: () => void) {
      emitter.once(event, listener);
      return this;
    },
    off(event: string, listener: () => void) {
      emitter.off(event, listener);
      return this;
    },
  };
  return res as unknown as FakeResponse;
}

function countPings(body: string): number {
  return body.split(": ping\n\n").length - 1;
}

function delayedUpstream(chunks: Array<{ delayMs: number; text: string }>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const { delayMs, text } of chunks) {
        await sleep(delayMs);
        controller.enqueue(encoder.encode(text));
      }
      controller.close();
    },
  });
}

const geminiChunk = (text: string): string =>
  `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text }] } }] } })}\n\n`;

describe("SSE keepalive", () => {
  it("emits pings between events while the upstream is slow", async () => {
    const res = fakeResponse();
    const completion = await streamCompatSse(
      delayedUpstream([{ delayMs: 120, text: geminiChunk("hello") }]),
      new PassThrough() as unknown as IncomingMessage,
      res,
      "gemini-test",
      "openai",
      undefined,
      undefined,
      undefined,
      "google",
      { keepaliveIntervalMs: 25 },
    );

    assert.equal(completion.streamError, undefined);
    assert.ok(countPings(res.body) >= 2, `expected pings, got body: ${res.body}`);
    const firstContent = res.body.indexOf('"content":"hello"');
    assert.ok(res.body.indexOf(": ping\n\n") < firstContent, "ping precedes first upstream token");
    for (const event of res.body.split("\n\n").filter(Boolean)) {
      assert.ok(event === ": ping" || event.startsWith("data: "), `malformed event: ${event}`);
    }
    assert.ok(res.body.endsWith("data: [DONE]\n\n"));
  });

  it("does not ping while data flows faster than the interval", async () => {
    const res = fakeResponse();
    await streamCompatSse(
      delayedUpstream(
        Array.from({ length: 8 }, (_, i) => ({ delayMs: 10, text: geminiChunk(`t${i}`) })),
      ),
      new PassThrough() as unknown as IncomingMessage,
      res,
      "gemini-test",
      "openai",
      undefined,
      undefined,
      undefined,
      "google",
      { keepaliveIntervalMs: 60 },
    );
    assert.equal(countPings(res.body), 0);
  });

  it("never writes a ping inside a partially written event", async () => {
    const res = fakeResponse();
    const stop = startSseKeepalive(res, 10);
    res.write("data: {\"partial\":");
    await sleep(40);
    assert.equal(countPings(res.body), 0);
    res.write("true}\n\n");
    await sleep(25);
    assert.ok(countPings(res.body) >= 1);
    stop();
  });

  it("clears the timer on client close", async () => {
    const res = fakeResponse();
    const write = res.write;
    startSseKeepalive(res, 10);
    res.emitter.emit("close");
    assert.equal(res.write, write, "write wrapper removed on close");
    await sleep(40);
    assert.equal(countPings(res.body), 0);
    assert.equal(res.emitter.listenerCount("close"), 0);
    assert.equal(res.emitter.listenerCount("finish"), 0);
  });

  it("stops after the response ends and when disabled", async () => {
    const ended = fakeResponse();
    startSseKeepalive(ended, 10);
    ended.end("data: [DONE]\n\n");
    await sleep(30);
    assert.equal(countPings(ended.body), 0);

    const disabled = fakeResponse();
    startSseKeepalive(disabled, 0);
    await sleep(30);
    assert.equal(countPings(disabled.body), 0);
    assert.equal(disabled.emitter.listenerCount("close"), 0);
  });

  it("validates and defaults sseKeepaliveIntervalMs", () => {
    assert.equal(validateConfig({ accounts: [], sseKeepaliveIntervalMs: 0 }).ok, true);
    assert.equal(validateConfig({ accounts: [], sseKeepaliveIntervalMs: 5000 }).ok, true);
    assert.equal(validateConfig({ accounts: [], sseKeepaliveIntervalMs: -1 }).ok, false);
    assert.equal(validateConfig({ accounts: [], sseKeepaliveIntervalMs: "15000" }).ok, false);
    const base = { accounts: [], requestsPerRotation: 5, proxyPort: 1, rotateOnQuotaDrop: 0, quotaPollIntervalMs: 300_000 };
    assert.equal(applyConfigDefaults(base).sseKeepaliveIntervalMs, 15_000);
    assert.equal(applyConfigDefaults({ ...base, sseKeepaliveIntervalMs: 0 }).sseKeepaliveIntervalMs, 0);
  });
});
