// Regression coverage for the audio WebSocket path through startProxy: executed-model scopes, rotator
// session failures and accounting, control frames while `stop` is pending, and shutdown. Real src/ code;
// the only doubles are the upstream fetch, the Postgres repository (virtual keys + spend queue), the
// Language Server https.request and its process discovery.
import assert from "node:assert/strict";
import cp from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter, once } from "node:events";
import type { Server } from "node:http";
import https from "node:https";
import net, { type AddressInfo, type Socket } from "node:net";
import { after, beforeEach, describe, it, mock } from "node:test";
import type { QueryResult, QueryResultRow } from "pg";
import { PostgresSettingsRepository } from "../src/settings-repository.js";

const originalDatabaseUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL = "postgresql://audio-ws-regressions.test/rotator";
process.env.PI_ROTATOR_TELEMETRY = "off";

const virtualKeyRows = new Map<string, QueryResultRow>();
// Lets a test hold the virtual-key count query, i.e. keep a WebSocket handshake inside authentication.
const countQuery = { gate: null as Promise<void> | null, onEnter: null as (() => void) | null };

function queryResult<R extends QueryResultRow>(rows: R[], command = "SELECT"): QueryResult<R> {
  return { rows, command, rowCount: rows.length, oid: 0, fields: [] };
}

mock.method(PostgresSettingsRepository.prototype, "init", async () => {});
mock.method(
  PostgresSettingsRepository.prototype,
  "query",
  async <R extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<R>> => {
    if (text.includes("COUNT(*)")) {
      countQuery.onEnter?.();
      if (countQuery.gate) await countQuery.gate;
      return queryResult([{ count: String(virtualKeyRows.size) }] as unknown as R[]);
    }
    if (text.includes("SELECT * FROM rotator_virtual_keys")) {
      const row = virtualKeyRows.get(String(params?.[0]));
      return queryResult((row ? [row] : []) as R[]);
    }
    return queryResult<R>([], text.trimStart().startsWith("UPDATE") ? "UPDATE" : "SELECT");
  },
);

class RefusedRequest extends EventEmitter {
  write(): boolean {
    return true;
  }

  end(): this {
    queueMicrotask(() =>
      this.emit(
        "error",
        Object.assign(new Error("connect ECONNREFUSED (test Language Server)"), { code: "ECONNREFUSED" }),
      ),
    );
    return this;
  }

  setTimeout(): this {
    return this;
  }

  destroy(): this {
    return this;
  }
}

class LanguageServerResponse extends EventEmitter {
  statusCode = 200;
  resume(): void {}
}

const languageServer = { fallbackText: null as string | null, paths: [] as string[] };

class SuccessfulLanguageServerRequest extends EventEmitter {
  private chunks: Buffer[] = [];

  constructor(
    private readonly path: string,
    private readonly callback?: (response: LanguageServerResponse) => void,
  ) {
    super();
  }

  write(data: string | Buffer): boolean {
    this.chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    return true;
  }

  end(data?: string | Buffer): this {
    if (data !== undefined) this.write(data);
    queueMicrotask(() => {
      const response = new LanguageServerResponse();
      this.callback?.(response);
      if (this.path.endsWith("/StreamAudioTranscription")) {
        const connectFrame = (message: unknown): Buffer => {
          const payload = Buffer.from(JSON.stringify(message));
          const frame = Buffer.alloc(5 + payload.length);
          frame.writeUInt32BE(payload.length, 1);
          payload.copy(frame, 5);
          return frame;
        };
        response.emit("data", connectFrame({ ready: { sessionId: "fallback-session" } }));
        response.emit("data", connectFrame({ transcription: { text: languageServer.fallbackText, isFinal: true } }));
        response.emit("data", connectFrame({ complete: true }));
      } else {
        response.emit("end");
      }
    });
    return this;
  }

  setTimeout(): this {
    return this;
  }

  destroy(): this {
    return this;
  }
}

mock.method(https, "request", ((options: { path?: string }, callback?: (response: LanguageServerResponse) => void) => {
  const path = String(options.path);
  languageServer.paths.push(path);
  return languageServer.fallbackText === null
    ? new RefusedRequest()
    : new SuccessfulLanguageServerRequest(path, callback);
}) as unknown as typeof https.request);
mock.method(cp, "execSync", (() => {
  throw new Error("Language Server discovery disabled in tests");
}) as unknown as typeof cp.execSync);

const UPSTREAM_URL_PREFIX = "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent";
type UpstreamHandler = (body: any, init: RequestInit | undefined, callIndex: number) => Response | Promise<Response>;
const upstream = { handler: null as UpstreamHandler | null, requests: [] as any[] };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith(UPSTREAM_URL_PREFIX)) {
    const body = JSON.parse(String(init?.body ?? "{}"));
    upstream.requests.push(body);
    if (!upstream.handler) throw new TypeError("no upstream double installed");
    return upstream.handler(body, init, upstream.requests.length - 1);
  }
  const { hostname } = new URL(url);
  if (hostname === "127.0.0.1" || hostname === "localhost") return realFetch(input, init);
  throw new TypeError(`blocked non-loopback fetch: ${hostname}`);
}) as typeof fetch;

const [dbStore, spendLogger, virtualKeys, proxy, versionCheck, notificationPoller, audio] = await Promise.all([
  import("../src/db-store.js"),
  import("../src/spend-logger.js"),
  import("../src/virtual-keys.js"),
  import("../src/proxy.js"),
  import("../src/version-check.js"),
  import("../src/notification-poller.js"),
  import("../src/audio-transcription.js"),
]);

await dbStore.initDb();

function addVirtualKey(rawKey: string, models: string[]): string {
  const tokenHash = virtualKeys.hashKey(rawKey);
  virtualKeyRows.set(tokenHash, {
    token_hash: tokenHash,
    key_name: `${rawKey.slice(0, 6)}...`,
    key_alias: rawKey,
    user_id: null,
    models,
    metadata: {},
    blocked: false,
    last_active: null,
    created_at: "2026-09-22T00:00:00.000Z",
    created_by: "test",
  });
  virtualKeys.clearVirtualKeyCache();
  return tokenHash;
}

function makeRotator() {
  const account = {
    config: { email: "rotator-test@example.com", label: "rotator-test", refreshToken: "mock-refresh-token" },
    accessToken: "mock-access-token",
    tokenExpires: Date.now() + 86_400_000,
    disabled: false,
    flagged: false,
    requestsSinceRotation: 0,
    totalRequests: 0,
    cooldownsByModel: {},
    inFlightRequests: 0,
    inFlightByModel: {},
    healthScore: 1,
  };
  return {
    saveState() {},
    getStatus() {
      return {
        accounts: [{ email: account.config.email, tier: "pro", active: true }],
        security: { adminTokenConfigured: true },
      };
    },
    getActiveAccount: async () => account,
    rotateToNext: async () => account,
    finishRequest: () => {},
    recordUpstreamAttempt: () => {},
    recordRequest: () => false,
    recordTokenUsage: () => {},
    markError: () => {},
    markRateLimited: () => {},
    markExhausted: () => {},
    markFlagged: () => {},
    recordFailure: () => {},
    recordSuccess: () => {},
    recordProvider429: () => {},
    getSafetyJitterMs: () => 0,
    getGlobalDelayMs: () => 0,
    getRetryAfterMs: () => 0,
    recordProxyEvent: () => {},
    getFlagContext: () => ({
      timerType: "fresh",
      accountQuotaPercent: 0,
      wasProAccount: false,
      accountRequestsLastHour: 0,
      poolSize: 1,
      poolHealthyCount: 1,
      uptimeSeconds: 0,
    }),
  };
}

interface TestProxy {
  server: Server;
  port: number;
  wsUrl: string;
  close: () => Promise<void>;
}

async function startTestProxy(): Promise<TestProxy> {
  const server: Server = proxy.startProxy(makeRotator() as never, 0, "127.0.0.1");
  const sockets = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    server,
    port,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    async close() {
      versionCheck.stopVersionChecker();
      notificationPoller.stopNotificationPoller();
      for (const socket of sockets) socket.destroy();
      // A second close() on an already closing server still calls back (with ERR_SERVER_NOT_RUNNING).
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Resolves with the value, or with `fallback` once `ms` elapse (bounded observation only). */
function within<T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<F>((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    }),
  ]);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timeout");
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

function voicedPcm(bytes: number): Buffer {
  const pcm = Buffer.alloc(bytes);
  for (let i = 0; i < bytes / 2; i++) pcm.writeInt16LE(Math.round(1500 * Math.sin(i * 0.1)), i * 2);
  return pcm;
}

/** Five voiced 100 ms chunks and two silent ones: exactly one natural-pause segment. */
function speechBurst(): Buffer[] {
  const voiced = voicedPcm(3200);
  const silent = Buffer.alloc(3200);
  return [voiced, voiced, voiced, voiced, voiced, silent, silent];
}

function textEvent(text: string, finishReason?: string): unknown {
  return {
    response: {
      candidates: [{ content: { role: "model", parts: [{ text }] }, ...(finishReason ? { finishReason } : {}) }],
    },
  };
}

const UPSTREAM_ERROR_EVENT = { error: { code: 500, message: "Internal error encountered.", status: "INTERNAL" } };

function sse(...events: unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function sseResponse(body: string | ReadableStream<Uint8Array>): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function audioStreamSpend(): Array<{ apiKeyHash: string | null; model: string; status: string; endTime: string }> {
  return spendLogger
    .getSpendQueueItemsForTests()
    .filter((entry) => entry.callType === "audio_stream")
    .map((entry) => ({
      apiKeyHash: entry.apiKeyHash ?? null,
      model: entry.model,
      status: entry.status,
      endTime: entry.endTime,
    }));
}

interface WsMessage {
  type: string;
  text?: string;
  isFinal?: boolean;
  message?: string;
  receivedAt: number;
}

async function openAudioWs(url: string) {
  const ws = new WebSocket(url);
  const messages: WsMessage[] = [];
  const waiters = new Set<{ predicate: (message: WsMessage) => boolean; resolve: (message: WsMessage) => void }>();
  ws.addEventListener("message", (event) => {
    const message = { ...JSON.parse(String(event.data)), receivedAt: Date.now() } as WsMessage;
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(message)) continue;
      waiters.delete(waiter);
      waiter.resolve(message);
    }
  });
  const closed = new Promise<number>((resolve) => ws.addEventListener("close", (event) => resolve(event.code)));
  const opened = new Promise<boolean>((resolve) => {
    ws.addEventListener("open", () => resolve(true), { once: true });
    void closed.then(() => resolve(false));
  });
  assert.equal(await within(opened, 3000, false), true, "WebSocket did not open");

  const waitFor = (predicate: (message: WsMessage) => boolean, label: string): Promise<WsMessage> => {
    const seen = messages.find(predicate);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve: (message: WsMessage) => {
          clearTimeout(timer);
          resolve(message);
        },
      };
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`timeout waiting for ${label}; got ${messages.map((m) => m.type).join(",")}`));
      }, 3000);
      waiters.add(waiter);
    });
  };
  const close = async (): Promise<void> => {
    if (ws.readyState === WebSocket.OPEN) ws.close();
    await within(closed, 2000, -1);
  };
  return { ws, messages, waitFor, closed, close };
}

interface Frame {
  opcode: number;
  payload: Buffer;
  json?: any;
}

/** RFC 6455 client over raw TCP, so pings, pongs, close frames and paused peers are observable. */
class RawWsClient {
  readonly frames: Frame[] = [];
  received = Buffer.alloc(0);
  readonly closed: Promise<void>;
  private buffer = Buffer.alloc(0);
  private upgraded = false;
  private readonly waiters = new Set<{ predicate: () => boolean; resolve: (hit: boolean) => void }>();

  private constructor(readonly socket: Socket) {
    this.closed = new Promise((resolve) => socket.once("close", () => resolve()));
    socket.on("data", (data: Buffer) => this.onData(data));
    socket.on("error", () => {});
  }

  static async connect(port: number, path = "/ws"): Promise<RawWsClient> {
    const socket = net.connect({ port, host: "127.0.0.1" });
    await once(socket, "connect");
    const client = new RawWsClient(socket);
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    return client;
  }

  private onData(data: Buffer): void {
    this.received = Buffer.concat([this.received, data]);
    this.buffer = Buffer.concat([this.buffer, data]);
    if (!this.upgraded) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0 || !this.buffer.toString("latin1", 0, 12).startsWith("HTTP/1.1 101")) return;
      this.buffer = this.buffer.subarray(headerEnd + 4);
      this.upgraded = true;
    }
    while (this.buffer.length >= 2) {
      let length = this.buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) break;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) break;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (this.buffer.length < offset + length) break;
      const frame: Frame = { opcode: this.buffer[0] & 0x0f, payload: Buffer.from(this.buffer.subarray(offset, offset + length)) };
      if (frame.opcode === 1) frame.json = JSON.parse(frame.payload.toString("utf8"));
      this.buffer = this.buffer.subarray(offset + length);
      this.frames.push(frame);
    }
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate()) continue;
      this.waiters.delete(waiter);
      waiter.resolve(true);
    }
  }

  /** Resolves true as soon as `predicate` holds after a received frame, false after `timeoutMs`. */
  waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
    if (predicate()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiter = {
        predicate,
        resolve: (hit: boolean) => {
          clearTimeout(timer);
          resolve(hit);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve(false);
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  hasMessage(type: string): boolean {
    return this.frames.some((frame) => frame.json?.type === type);
  }

  waitForMessage(type: string): Promise<boolean> {
    return this.waitUntil(() => this.hasMessage(type));
  }

  send(opcode: number, payload: Buffer): void {
    const mask = crypto.randomBytes(4);
    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    } else {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    }
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  sendJson(value: unknown): void {
    this.send(1, Buffer.from(JSON.stringify(value)));
  }

  destroy(): void {
    this.socket.destroy();
  }
}

beforeEach(() => {
  virtualKeyRows.clear();
  virtualKeys.clearVirtualKeyCache();
  spendLogger.resetSpendLoggerForTests();
  upstream.handler = null;
  upstream.requests.length = 0;
  languageServer.fallbackText = null;
  languageServer.paths.length = 0;
  countQuery.gate = null;
  countQuery.onEnter = null;
});

after(async () => {
  spendLogger.resetSpendLoggerForTests();
  virtualKeys.clearVirtualKeyCache();
  globalThis.fetch = realFetch;
  await dbStore.closeDb();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  mock.restoreAll();
});

describe("audio WebSocket authorizes the executed model (H-302, H-308)", () => {
  it("denies a claude-scoped key on start and on auto-start without calling upstream", async () => {
    const rawKey = "rk-ws-claude-only";
    addVirtualKey(rawKey, ["claude-opus-4-6"]);
    upstream.handler = () => sseResponse(sse(textEvent("should never run", "STOP")));
    const server = await startTestProxy();
    const started = await openAudioWs(`${server.wsUrl}?key=${rawKey}`);
    const autoStarted = await openAudioWs(`${server.wsUrl}?key=${rawKey}`);
    try {
      await started.waitFor((m) => m.type === "system_status", "system_status");
      started.ws.send(JSON.stringify({ type: "start", model: "claude-opus-4-6" }));
      const denied = await started.waitFor((m) => m.type === "antigravity_error", "antigravity_error");
      assert.match(String(denied.message), /gemini-3\.8-flash-low/);
      assert.equal(await within(started.closed, 2000, null), 1008);

      await autoStarted.waitFor((m) => m.type === "system_status", "system_status");
      autoStarted.ws.send(voicedPcm(3200));
      assert.equal(await within(autoStarted.closed, 2000, null), 1008);
      assert.equal(upstream.requests.length, 0);
      assert.equal(started.messages.some((m) => m.type === "ready_to_receive_audio"), false);
    } finally {
      await started.close();
      await autoStarted.close();
      await server.close();
    }
  });

  it("streams with the default model for a v3.7.0 audio key and accounts the executed model", async () => {
    const rawKey = "rk-ws-v370-observer";
    const tokenHash = addVirtualKey(rawKey, ["models/proactive-observer-v10"]);
    upstream.handler = () => sseResponse(sse(textEvent("hola", "STOP")));
    const server = await startTestProxy();
    const client = await openAudioWs(`${server.wsUrl}?key=${rawKey}`);
    try {
      await client.waitFor((m) => m.type === "system_status", "system_status");
      client.ws.send(JSON.stringify({ type: "start" }));
      await client.waitFor((m) => m.type === "ready_to_receive_audio", "ready_to_receive_audio");
      for (const chunk of speechBurst()) client.ws.send(chunk);
      await client.waitFor((m) => m.type === "antigravity_transcript" && m.isFinal === true, "final transcript");
      client.ws.send(JSON.stringify({ type: "stop" }));
      await client.waitFor((m) => m.type === "antigravity_complete", "antigravity_complete");
      assert.equal(upstream.requests[0]?.model, "gemini-3.8-flash-low");
      assert.deepEqual(
        audioStreamSpend().map(({ apiKeyHash, model, status }) => ({ apiKeyHash, model, status })),
        [{ apiKeyHash: tokenHash, model: "gemini-3.8-flash-low", status: "success" }],
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("rotator WebSocket sessions (H-201, H-103, H-305, H-306)", () => {
  it("falls back to the Language Server when a live rotator segment fails", async () => {
    upstream.handler = () => sseResponse(sse(UPSTREAM_ERROR_EVENT));
    languageServer.fallbackText = "fallback transcript";
    const server = await startTestProxy();
    const client = await openAudioWs(server.wsUrl);
    try {
      await client.waitFor((m) => m.type === "system_status", "system_status");
      client.ws.send(JSON.stringify({ type: "start", model: "gemini-3.8-flash-low" }));
      await client.waitFor((m) => m.type === "ready_to_receive_audio", "ready_to_receive_audio");
      client.ws.send(voicedPcm(16_000));
      client.ws.send(JSON.stringify({ type: "stop" }));
      const transcript = await client.waitFor(
        (m) => m.type === "antigravity_transcript" && m.isFinal === true,
        "fallback transcript",
      );
      await client.waitFor((m) => m.type === "antigravity_complete", "antigravity_complete");

      assert.equal(transcript.text, "fallback transcript");
      assert.equal(languageServer.paths.some((path) => path.endsWith("/StreamAudioTranscription")), true);
      assert.equal(client.messages.some((m) => m.type === "antigravity_error"), false);
      assert.deepEqual(audioStreamSpend().map((row) => row.status), ["success"]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("falls back to the Language Server when a live rotator segment times out", async (t) => {
    const upstreamStarted = deferred();
    upstream.handler = (_body, init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
        },
      });
      upstreamStarted.resolve();
      return sseResponse(stream);
    };
    languageServer.fallbackText = "transcribed after timeout";
    const events: Array<{ transcription?: { text: string; isFinal: boolean }; complete?: boolean }> = [];
    const errors: Error[] = [];
    const session = new audio.RotatorAudioSession(makeRotator() as never, {
      model: "gemini-3.8-flash-low",
      onEvent: (event) => events.push(event),
      onError: (error) => errors.push(error),
    });

    try {
      await session.start();
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const transcription = (session as unknown as {
        processSegment: (item: { seqId: number; pcm: Buffer }) => Promise<void>;
      }).processSegment({ seqId: 0, pcm: voicedPcm(16_000) });
      await upstreamStarted.promise;
      t.mock.timers.tick(20_000);
      await transcription;

      assert.equal(languageServer.paths.some((path) => path.endsWith("/StreamAudioTranscription")), true);
      assert.equal(events.some((event) => event.transcription?.text === "transcribed after timeout" && event.transcription.isFinal), true);
      await session.endSession();
      assert.equal(events.some((event) => event.complete), true);
      assert.deepEqual(errors, []);
    } finally {
      session.destroy();
      t.mock.timers.reset();
    }
  });

  it("does not start the Language Server fallback after client cancellation", async () => {
    const upstreamStarted = deferred();
    upstream.handler = (_body, init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
        },
      });
      upstreamStarted.resolve();
      return sseResponse(stream);
    };
    languageServer.fallbackText = "should never appear";
    const server = await startTestProxy();
    const client = await openAudioWs(server.wsUrl);
    try {
      await client.waitFor((m) => m.type === "system_status", "system_status");
      client.ws.send(JSON.stringify({ type: "start", model: "gemini-3.8-flash-low" }));
      await client.waitFor((m) => m.type === "ready_to_receive_audio", "ready_to_receive_audio");
      client.ws.send(voicedPcm(16_000));
      client.ws.send(JSON.stringify({ type: "stop" }));
      await upstreamStarted.promise;
      await client.close();
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.deepEqual(languageServer.paths, []);
      assert.equal(client.messages.some((m) => m.type === "antigravity_transcript" && m.isFinal), false);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("reports a failed segment as antigravity_error and never commits its partial text", async () => {
    upstream.handler = () => sseResponse(sse(textEvent("PRIMERA MITAD "), UPSTREAM_ERROR_EVENT));
    const server = await startTestProxy();
    const client = await openAudioWs(server.wsUrl);
    try {
      await client.waitFor((m) => m.type === "system_status", "system_status");
      client.ws.send(JSON.stringify({ type: "start", model: "gemini-3.8-flash-low" }));
      await client.waitFor((m) => m.type === "ready_to_receive_audio", "ready_to_receive_audio");
      client.ws.send(voicedPcm(16_000));
      client.ws.send(JSON.stringify({ type: "stop" }));
      await client.waitFor((m) => m.type === "antigravity_error", "antigravity_error");
      await waitForCondition(() => audioStreamSpend().length === 1);

      assert.deepEqual(audioStreamSpend().map((row) => row.status), ["failure"]);
      assert.equal(
        client.messages.some((m) => m.type === "antigravity_transcript" && m.isFinal && /PRIMERA/.test(String(m.text))),
        false,
      );
      assert.equal(client.messages.some((m) => m.type === "antigravity_complete"), false);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("accounts a session that survives a failed segment once, as a success at completion", async () => {
    upstream.handler = (_body, _init, callIndex) =>
      sseResponse(callIndex === 0 ? sse(UPSTREAM_ERROR_EVENT) : sse(textEvent("hello world", "STOP")));
    const server = await startTestProxy();
    const client = await openAudioWs(server.wsUrl);
    try {
      await client.waitFor((m) => m.type === "system_status", "system_status");
      client.ws.send(JSON.stringify({ type: "start", model: "gemini-3.8-flash-low" }));
      await client.waitFor((m) => m.type === "ready_to_receive_audio", "ready_to_receive_audio");
      for (const chunk of speechBurst()) client.ws.send(chunk);
      await client.waitFor((m) => m.type === "antigravity_error", "segment error");
      assert.deepEqual(audioStreamSpend(), [], "a failed segment does not settle the session spend");

      for (const chunk of speechBurst()) client.ws.send(chunk);
      const final = await client.waitFor(
        (m) => m.type === "antigravity_transcript" && m.isFinal === true && m.text === "hello world",
        "final transcript",
      );
      client.ws.send(JSON.stringify({ type: "stop" }));
      await client.waitFor((m) => m.type === "antigravity_complete", "antigravity_complete");

      const rows = audioStreamSpend();
      assert.equal(upstream.requests.length, 2);
      assert.deepEqual(rows.map((row) => row.status), ["success"]);
      assert.ok(Date.parse(rows[0].endTime) >= final.receivedAt, `endTime=${rows[0].endTime}`);
    } finally {
      await client.close();
      await server.close();
    }
  });

  for (const testCase of [
    { label: "a short final word", chunks: () => [voicedPcm(4096)], transcript: "palabra" },
    {
      label: "a sentence the old filters discarded",
      chunks: () => Array.from({ length: 12 }, () => voicedPcm(3200)),
      transcript: "the last sentence is important to me",
    },
  ]) {
    it(`transcribes ${testCase.label}`, async () => {
      upstream.handler = () => sseResponse(sse(textEvent(testCase.transcript, "STOP")));
      const server = await startTestProxy();
      const client = await openAudioWs(server.wsUrl);
      try {
        await client.waitFor((m) => m.type === "system_status", "system_status");
        client.ws.send(JSON.stringify({ type: "start", model: "gemini-3.8-flash-low" }));
        await client.waitFor((m) => m.type === "ready_to_receive_audio", "ready_to_receive_audio");
        for (const chunk of testCase.chunks()) client.ws.send(chunk);
        client.ws.send(JSON.stringify({ type: "stop" }));
        await client.waitFor((m) => m.type === "antigravity_complete", "antigravity_complete");

        const finals = client.messages.filter((m) => m.type === "antigravity_transcript" && m.isFinal);
        assert.equal(upstream.requests.length, 1);
        assert.equal(finals.at(-1)?.text, testCase.transcript);
      } finally {
        await client.close();
        await server.close();
      }
    });
  }
});

describe("control frames are answered while stop is pending (H-104)", () => {
  it("answers a ping and echoes a close while stop awaits the held segment", async () => {
    const release: Array<() => void> = [];
    const upstreamStarted = deferred();
    upstream.handler = (_body, init) => {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      init?.signal?.addEventListener(
        "abort",
        () => {
          try {
            controller.error(init.signal?.reason);
          } catch {
            // already closed
          }
        },
        { once: true },
      );
      release.push(() => {
        try {
          controller.enqueue(new TextEncoder().encode(sse(textEvent("hello world", "STOP"))));
          controller.close();
        } catch {
          // already errored by the abort
        }
      });
      upstreamStarted.resolve();
      return sseResponse(body);
    };
    const server = await startTestProxy();
    const client = await RawWsClient.connect(server.port);
    const pongs = () => client.frames.filter((frame) => frame.opcode === 10);
    try {
      assert.equal(await client.waitForMessage("system_status"), true);
      client.send(9, Buffer.from("idle"));
      assert.equal(await client.waitUntil(() => pongs().length === 1), true, "idle ping answered");
      assert.equal(pongs()[0].payload.toString("utf8"), "idle");

      client.sendJson({ type: "start", model: "gemini-3.8-flash-low" });
      assert.equal(await client.waitForMessage("ready_to_receive_audio"), true);
      for (const chunk of speechBurst()) client.send(2, chunk);
      await upstreamStarted.promise;
      client.sendJson({ type: "stop" });
      assert.equal(await client.waitForMessage("audio_stopped"), true);

      client.send(9, Buffer.from("during-stop"));
      assert.equal(await client.waitUntil(() => pongs().length === 2), true, "ping answered while stop is pending");
      assert.equal(pongs()[1].payload.toString("utf8"), "during-stop");
      client.send(8, Buffer.from([0x03, 0xe8]));
      const echoed = await client.waitUntil(() => client.frames.some((frame) => frame.opcode === 8));
      assert.equal(echoed, true, "close echoed while stop is pending");
      assert.equal(client.frames.find((frame) => frame.opcode === 8)?.payload.readUInt16BE(0), 1000);
      assert.equal(client.hasMessage("antigravity_complete"), false, "the segment was still held upstream");
    } finally {
      for (const releaseSegment of release) releaseSegment();
      client.destroy();
      await server.close();
    }
  });
});

describe("proxy shutdown does not wait on audio WebSocket peers (H-101)", () => {
  it("completes server.close() when a registered peer never answers the close handshake", async () => {
    const server = await startTestProxy();
    const peer = await RawWsClient.connect(server.port);
    try {
      assert.equal(await peer.waitForMessage("system_status"), true);
      peer.socket.pause(); // stops reading: never processes the close frame or the FIN
      const closed = await within(new Promise<boolean>((resolve) => server.server.close(() => resolve(true))), 3000, false);
      assert.equal(closed, true, "server.close() callback did not fire");
    } finally {
      peer.destroy();
      await server.close();
    }
  });

  it("drops an upgrade that arrives after close() started", async () => {
    const server = await startTestProxy();
    const closing: { done: Promise<boolean> | null } = { done: null };
    server.server.prependOnceListener("upgrade", () => {
      closing.done = new Promise<boolean>((resolve) => server.server.close(() => resolve(true)));
    });
    const peer = await RawWsClient.connect(server.port);
    try {
      assert.equal(await within(peer.closed, 3000, "open"), undefined, "late upgrade was not dropped");
      assert.equal(peer.received.includes("101 Switching Protocols"), false);
      assert.ok(closing.done, "close() started inside the upgrade");
      assert.equal(await within(closing.done, 3000, false), true, "server.close() callback did not fire");
    } finally {
      peer.destroy();
      await server.close();
    }
  });

  it("drops a handshake that is still authenticating when close() starts", async () => {
    const rawKey = "rk-ws-authenticating";
    addVirtualKey(rawKey, ["*"]);
    const gate = deferred();
    const entered = deferred();
    const server = await startTestProxy();
    countQuery.gate = gate.promise;
    countQuery.onEnter = entered.resolve;
    const peer = await RawWsClient.connect(server.port, `/ws?key=${rawKey}`);
    try {
      await entered.promise;
      const serverClosed = new Promise<boolean>((resolve) => server.server.close(() => resolve(true)));
      gate.resolve();
      assert.equal(await within(peer.closed, 3000, "open"), undefined, "authenticating handshake was not dropped");
      assert.equal(peer.received.includes("101 Switching Protocols"), false);
      assert.equal(await within(serverClosed, 3000, false), true, "server.close() callback did not fire");
    } finally {
      gate.resolve();
      peer.destroy();
      await server.close();
    }
  });
});
