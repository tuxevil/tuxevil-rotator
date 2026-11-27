import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { streamCompatSse, streamResponsesSse } from "../src/compat.js";

function makeBody(chunks: Uint8Array[], gate?: Promise<void>): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i > 0 && gate) await gate;
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
}

function makeRes(onWrite?: (s: string) => void) {
  const em = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const writes: string[] = [];
  em.writes = writes;
  em.writableEnded = false;
  em.destroyed = false;
  em.headersSent = false;
  em.writeHead = () => {
    em.headersSent = true;
    return em;
  };
  em.write = (s: unknown) => {
    writes.push(String(s));
    onWrite?.(String(s));
    return true;
  };
  em.end = (s?: unknown) => {
    if (s !== undefined) writes.push(String(s));
    em.writableEnded = true;
    return em;
  };
  return em as unknown as ServerResponse;
}

const sse = (t: string) =>
  `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: t }] } }] } })}\n\n`;

describe("SSE stream UTF-8 multibyte boundary & trailing line flush (16e6cd5d)", () => {
  const enc = new TextEncoder();

  it("preserves split multibyte UTF-8 characters and flushes trailing event without newline in streamCompatSse and streamResponsesSse", async () => {
    const full = enc.encode(sse("\u20ac"));
    const idx = full.indexOf(0xe2);
    assert.ok(idx >= 0);
    const pre = enc.encode(sse("ini"));
    const chunksA = [Uint8Array.from([...pre, ...full.slice(0, idx + 1)]), full.slice(idx + 1)];
    const finalNoNl = enc.encode(
      `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "fin" }] } }] } })}`,
    );
    const chunksB = [enc.encode(sse("ini")), finalNoNl];

    {
      let open!: () => void;
      const gate = new Promise<void>((r) => (open = r));
      const cA = await streamCompatSse(
        makeBody(chunksA, gate),
        new EventEmitter() as unknown as IncomingMessage,
        makeRes((w) => {
          if (w.includes("ini")) open();
        }),
        "m",
        "openai",
        undefined,
        undefined,
        null,
        "google",
        { keepaliveIntervalMs: 0 },
      );
      assert.equal(cA.text, "ini\u20ac");

      const cB = await streamCompatSse(
        makeBody(chunksB),
        new EventEmitter() as unknown as IncomingMessage,
        makeRes(),
        "m",
        "openai",
        undefined,
        undefined,
        null,
        "google",
        { keepaliveIntervalMs: 0 },
      );
      assert.equal(cB.text, "inifin");
    }

    {
      let open!: () => void;
      const gate = new Promise<void>((r) => (open = r));
      const rA = await streamResponsesSse(
        makeBody(chunksA, gate),
        new EventEmitter() as unknown as IncomingMessage,
        makeRes((w) => {
          if (w.includes("ini")) open();
        }),
        { model: "m", input: "x" },
        "resp_1",
        null,
        0,
        undefined,
        undefined,
        null,
        "google",
        { keepaliveIntervalMs: 0 },
      );
      assert.equal(rA.text, "ini\u20ac");

      const rB = await streamResponsesSse(
        makeBody(chunksB),
        new EventEmitter() as unknown as IncomingMessage,
        makeRes(),
        { model: "m", input: "x" },
        "resp_2",
        null,
        0,
        undefined,
        undefined,
        null,
        "google",
        { keepaliveIntervalMs: 0 },
      );
      assert.equal(rB.text, "inifin");
    }
  });
});
