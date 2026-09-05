import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import net, { type Socket } from "node:net";
import { after, beforeEach, describe, it, mock } from "node:test";
import type { QueryResult, QueryResultRow } from "pg";
import { PostgresSettingsRepository } from "../src/settings-repository.js";

const originalDatabaseUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL = "postgresql://audio-security.test/rotator";

const virtualKeyRows = new Map<string, QueryResultRow>();

function queryResult<R extends QueryResultRow>(rows: R[], command = "SELECT"): QueryResult<R> {
  return { rows, command, rowCount: rows.length, oid: 0, fields: [] };
}

mock.method(PostgresSettingsRepository.prototype, "init", async () => {});
mock.method(
  PostgresSettingsRepository.prototype,
  "query",
  async <R extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<R>> => {
    if (text.includes("COUNT(*)")) {
      return queryResult([{ count: String(virtualKeyRows.size) }] as unknown as R[]);
    }
    if (text.includes("SELECT * FROM rotator_virtual_keys")) {
      const row = virtualKeyRows.get(String(params?.[0]));
      return queryResult((row ? [row] : []) as R[]);
    }
    return queryResult<R>([], text.trimStart().startsWith("UPDATE") ? "UPDATE" : "SELECT");
  },
);

const [audio, dbStore, spendLogger, virtualKeys] = await Promise.all([
  import("../src/audio-transcription.js"),
  import("../src/db-store.js"),
  import("../src/spend-logger.js"),
  import("../src/virtual-keys.js"),
]);

await dbStore.initDb();

class FakeResponse extends EventEmitter {
  constructor(public statusCode = 200) {
    super();
  }

  resume(): void {}
}

class FakeRequest extends EventEmitter {
  readonly chunks: Buffer[] = [];
  destroyed = false;
  timeoutCallback: (() => void) | null = null;

  constructor(
    readonly options: Record<string, unknown>,
    private readonly callback: ((response: FakeResponse) => void) | undefined,
    private readonly onEnd: (request: FakeRequest) => void,
  ) {
    super();
  }

  write(data: string | Buffer): boolean {
    this.chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    return true;
  }

  end(data?: string | Buffer): this {
    if (data !== undefined) this.write(data);
    queueMicrotask(() => this.onEnd(this));
    return this;
  }

  setTimeout(_timeout: number, callback: () => void): this {
    this.timeoutCallback = callback;
    return this;
  }

  respond(response: FakeResponse): void {
    this.callback?.(response);
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

function connectFrame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message));
  const frame = Buffer.alloc(5 + payload.length);
  frame.writeUInt8(0, 0);
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

function mockLanguageServer(mode: "success" | "failure" | "pending" = "success"): {
  requests: FakeRequest[];
  restore: () => void;
} {
  const requests: FakeRequest[] = [];
  let sessionNumber = 0;
  const requestMock = mock.method(
    https,
    "request",
    ((options: Record<string, unknown>, callback?: (response: FakeResponse) => void) => {
      const request = new FakeRequest(options, callback, () => {
        if (mode === "pending") return;
        const response = new FakeResponse(mode === "failure" ? 503 : 200);
        request.respond(response);
        if (mode === "failure") return;
        if (String(options.path).endsWith("/StreamAudioTranscription")) {
          const sessionId = `audio-session-${++sessionNumber}`;
          queueMicrotask(() => {
            response.emit("data", connectFrame({ ready: { sessionId } }));
            response.emit("data", connectFrame({ transcription: { text: "hello", isFinal: true } }));
            response.emit("data", connectFrame({ complete: true }));
          });
        } else {
          queueMicrotask(() => response.emit("end"));
        }
      });
      requests.push(request);
      return request;
    }) as unknown as typeof https.request,
  );
  return { requests, restore: () => requestMock.mock.restore() };
}

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
    created_at: "2026-09-04T00:00:00.000Z",
    created_by: "test",
  });
  virtualKeys.clearVirtualKeyCache();
  return tokenHash;
}

async function listenServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: ReturnType<typeof createServer>; url: string; port: number }> {
  const server = createServer(handler);
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  (server as typeof server & { testSockets: Set<Socket> }).testSockets = sockets;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  return { server, url: `http://127.0.0.1:${address.port}`, port: address.port };
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  server.closeAllConnections?.();
  for (const socket of (server as typeof server & { testSockets?: Set<Socket> }).testSockets ?? []) {
    socket.destroy();
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function rawUpgrade(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ socket: Socket; response: Buffer }> {
  const socket = net.connect(port, "127.0.0.1");
  await once(socket, "connect");
  socket.write(
    [
      `GET ${path} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      "",
      "",
    ].join("\r\n"),
  );
  const response = await Promise.race([
    once(socket, "data").then(([data]) => data as Buffer),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("upgrade timeout")), 500)),
  ]);
  return { socket, response };
}

function waitForWebSocketEvent<T extends Event>(
  ws: WebSocket,
  type: "open" | "close",
  timeoutMs = 500,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${type} timeout`)), timeoutMs);
    ws.addEventListener(
      type,
      (event) => {
        clearTimeout(timer);
        resolve(event as T);
      },
      { once: true },
    );
  });
}

function waitForWebSocketMessage(
  ws: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
  timeoutMs = 500,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error("message timeout"));
    }, timeoutMs);
    const onMessage = (event: MessageEvent): void => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      resolve(message);
    };
    ws.addEventListener("message", onMessage);
  });
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timeout");
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

function installUpgradeHandler(server: ReturnType<typeof createServer>): void {
  server.on("upgrade", (req, socket) => {
    void audio.handleAudioWebSocket(req, socket);
  });
}

beforeEach(() => {
  virtualKeyRows.clear();
  virtualKeys.clearVirtualKeyCache();
  spendLogger.resetSpendLoggerForTests();
});

after(async () => {
  spendLogger.resetSpendLoggerForTests();
  virtualKeys.clearVirtualKeyCache();
  await dbStore.closeDb();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  mock.restoreAll();
});

describe("audio virtual-key security boundary", () => {
  it("authenticates before parsing multipart content", async () => {
    addVirtualKey("rk-required-audio-key", ["*"]);
    const { server, url } = await listenServer((req, res) => {
      void audio.handleOpenAIAudioTranscriptions(req, res);
    });
    try {
      const response = await fetch(`${url}/v1/audio/transcriptions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      assert.equal(response.status, 401);
    } finally {
      await closeServer(server);
    }
  });

  it("accepts every supported virtual-key transport before multipart parsing", async () => {
    const rawKey = "rk-audio-key-transports";
    addVirtualKey(rawKey, ["*"]);
    const { server, url } = await listenServer((req, res) => {
      void audio.handleOpenAIAudioTranscriptions(req, res);
    });
    const cases: Array<{ path: string; headers: Record<string, string> }> = [
      { path: "", headers: { Authorization: `Bearer ${rawKey}` } },
      { path: "", headers: { "x-rotator-key": rawKey } },
      { path: "", headers: { "x-api-key": rawKey } },
      { path: `?rotator_key=${rawKey}`, headers: {} },
      { path: `?key=${rawKey}`, headers: {} },
      { path: `?api_key=${rawKey}`, headers: {} },
    ];
    try {
      for (const testCase of cases) {
        const response = await fetch(`${url}/v1/audio/transcriptions${testCase.path}`, {
          method: "POST",
          headers: { ...testCase.headers, "Content-Type": "application/json" },
          body: "{}",
        });
        assert.equal(response.status, 400);
      }
    } finally {
      await closeServer(server);
    }
  });

  it("enforces the multipart-selected model and logs one attributed HTTP request", async () => {
    const rawKey = "rk-audio-model-scope";
    const tokenHash = addVirtualKey(rawKey, ["models/proactive-observer-v10"]);
    const languageServer = mockLanguageServer();
    const { server, url } = await listenServer((req, res) => {
      void audio.handleOpenAIAudioTranscriptions(req, res);
    });

    const post = async (model: string): Promise<Response> => {
      const formData = new FormData();
      formData.append("file", new File([Buffer.alloc(44)], "sample.wav", { type: "audio/wav" }));
      formData.append("model", model);
      return fetch(`${url}/v1/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${rawKey}` },
        body: formData,
      });
    };

    try {
      const denied = await post("other-model");
      assert.equal(denied.status, 403);
      assert.equal(languageServer.requests.length, 0);
      assert.deepEqual(
        spendLogger.getSpendQueueItemsForTests().map((entry) => ({
          apiKeyHash: entry.apiKeyHash,
          model: entry.model,
          status: entry.status,
        })),
        [{ apiKeyHash: tokenHash, model: "other-model", status: "failure" }],
      );

      const allowed = await post("models/proactive-observer-v10");
      assert.equal(allowed.status, 200);
      await allowed.arrayBuffer();

      const logs = spendLogger.getSpendQueueItemsForTests();
      assert.equal(logs.length, 2);
      assert.equal(logs[1].apiKeyHash, tokenHash);
      assert.equal(logs[1].model, "models/proactive-observer-v10");
      assert.equal(logs[1].callType, "audio_transcription");
    } finally {
      languageServer.restore();
      await closeServer(server);
    }
  });
});

describe("audio WebSocket security boundary", () => {
  it("rejects an unauthenticated upgrade before sending 101", async () => {
    addVirtualKey("rk-required-ws-key", ["*"]);
    const { server, port } = await listenServer((_req, res) => res.end());
    installUpgradeHandler(server);
    let socket: Socket | undefined;
    try {
      const upgrade = await rawUpgrade(port, "/ws");
      socket = upgrade.socket;
      assert.match(upgrade.response.toString("utf8"), /^HTTP\/1\.1 401 /);
      assert.doesNotMatch(upgrade.response.toString("utf8"), /101 Switching Protocols/);
    } finally {
      socket?.destroy();
      await closeServer(server);
    }
  });

  it("accepts every supported virtual-key transport on upgrade", async () => {
    const rawKey = "rk-ws-key-transports";
    addVirtualKey(rawKey, ["*"]);
    const { server, port } = await listenServer((_req, res) => res.end());
    installUpgradeHandler(server);
    const cases: Array<{ path: string; headers: Record<string, string> }> = [
      { path: "/ws", headers: { Authorization: `Bearer ${rawKey}` } },
      { path: "/ws", headers: { "x-rotator-key": rawKey } },
      { path: "/ws", headers: { "x-api-key": rawKey } },
      { path: `/ws?rotator_key=${rawKey}`, headers: {} },
      { path: `/ws?key=${rawKey}`, headers: {} },
      { path: `/ws?api_key=${rawKey}`, headers: {} },
    ];
    try {
      for (const testCase of cases) {
        const { socket, response } = await rawUpgrade(port, testCase.path, testCase.headers);
        assert.match(response.toString("utf8"), /^HTTP\/1\.1 101 Switching Protocols/);
        socket.destroy();
      }
    } finally {
      await closeServer(server);
    }
  });

  it("enforces the start model scope before opening a Language Server stream", async () => {
    const rawKey = "rk-ws-model-scope";
    addVirtualKey(rawKey, ["models/proactive-observer-v10"]);
    const languageServer = mockLanguageServer("pending");
    const { server, port } = await listenServer((_req, res) => res.end());
    installUpgradeHandler(server);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?key=${rawKey}`);
    const messages: Array<Record<string, unknown>> = [];
    ws.onmessage = (event) => messages.push(JSON.parse(String(event.data)) as Record<string, unknown>);

    try {
      await waitForWebSocketEvent(ws, "open");
      ws.send(JSON.stringify({ type: "start", model: "other-model" }));
      const close = await waitForWebSocketEvent<CloseEvent>(ws, "close", 300);
      assert.equal(close.code, 1008);
      assert.equal(languageServer.requests.length, 0);
      assert.equal(messages.some((message) => message.type === "ready_to_receive_audio"), false);
    } finally {
      ws.close();
      languageServer.restore();
      await closeServer(server);
    }
  });

  it("reports Language Server start failure without announcing audio readiness", async () => {
    const rawKey = "rk-ws-start-failure";
    addVirtualKey(rawKey, ["*"]);
    const languageServer = mockLanguageServer("failure");
    const { server, port } = await listenServer((_req, res) => res.end());
    installUpgradeHandler(server);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?key=${rawKey}`);
    const messages: Array<Record<string, unknown>> = [];
    ws.onmessage = (event) => messages.push(JSON.parse(String(event.data)) as Record<string, unknown>);

    try {
      await waitForWebSocketEvent(ws, "open");
      const errorMessage = waitForWebSocketMessage(ws, (message) => message.type === "antigravity_error");
      ws.send(JSON.stringify({ type: "start", model: "models/proactive-observer-v10" }));
      await errorMessage;
      assert.equal(messages.some((message) => message.type === "antigravity_error"), true);
      assert.equal(messages.some((message) => message.type === "ready_to_receive_audio"), false);
      assert.equal(languageServer.requests[0]?.destroyed, true);
    } finally {
      ws.close();
      languageServer.restore();
      await closeServer(server);
    }
  });

  it("bounds queued audio, closes with 1009, destroys the pending stream, and logs once", async () => {
    const rawKey = "rk-ws-bounded-audio";
    const tokenHash = addVirtualKey(rawKey, ["*"]);
    const languageServer = mockLanguageServer("pending");
    const { server, port } = await listenServer((_req, res) => res.end());
    installUpgradeHandler(server);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?api_key=${rawKey}`);

    try {
      await waitForWebSocketEvent(ws, "open");
      for (let i = 0; i < 5; i++) ws.send(Buffer.alloc(256 * 1024));
      const close = await waitForWebSocketEvent<CloseEvent>(ws, "close");
      assert.equal(close.code, 1009);
      assert.equal(languageServer.requests[0]?.destroyed, true);
      const logs = spendLogger.getSpendQueueItemsForTests();
      assert.equal(logs.length, 1);
      assert.equal(logs[0].apiKeyHash, tokenHash);
      assert.equal(logs[0].callType, "audio_stream");
    } finally {
      ws.close();
      languageServer.restore();
      await closeServer(server);
    }
  });

  it("closes with 1009 on an empty binary audio frame", async () => {
    const rawKey = "rk-ws-empty-audio";
    addVirtualKey(rawKey, ["*"]);
    const languageServer = mockLanguageServer("pending");
    const { server, port } = await listenServer((_req, res) => res.end());
    installUpgradeHandler(server);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?key=${rawKey}`);

    try {
      await waitForWebSocketEvent(ws, "open");
      ws.send(Buffer.alloc(0));
      const close = await waitForWebSocketEvent<CloseEvent>(ws, "close", 300);
      assert.equal(close.code, 1009);
    } finally {
      ws.close();
      languageServer.restore();
      await closeServer(server);
    }
  });

  it("does not reuse an ended session after stop or explicit restart", async () => {
    const rawKey = "rk-ws-stop-session";
    addVirtualKey(rawKey, ["*"]);
    const languageServer = mockLanguageServer();
    const { server, port } = await listenServer((_req, res) => res.end());
    installUpgradeHandler(server);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?key=${rawKey}`);

    try {
      await waitForWebSocketEvent(ws, "open");
      let ready = waitForWebSocketMessage(ws, (message) => message.type === "ready_to_receive_audio");
      ws.send(JSON.stringify({ type: "start", model: "models/proactive-observer-v10" }));
      await ready;

      ws.send(Buffer.alloc(1, 1));
      ws.send(JSON.stringify({ type: "stop" }));
      await waitForWebSocketMessage(ws, (message) => message.type === "audio_stopped");

      const antigravityReady = waitForWebSocketMessage(
        ws,
        (message) => message.type === "antigravity_ready" && message.sessionId === "audio-session-2",
      );
      ws.send(Buffer.alloc(1, 2));
      await antigravityReady;
      await waitForCondition(
        () =>
          languageServer.requests.filter((request) =>
            String(request.options.path).endsWith("/SendAudioChunk"),
          ).length >= 2,
      );

      ready = waitForWebSocketMessage(ws, (message) => message.type === "ready_to_receive_audio");
      ws.send(JSON.stringify({ type: "start", model: "models/proactive-observer-v10" }));
      await ready;
      ws.send(Buffer.alloc(1, 3));
      await waitForCondition(
        () =>
          languageServer.requests.filter((request) =>
            String(request.options.path).endsWith("/SendAudioChunk"),
          ).length >= 3,
      );

      const sentSessionIds = languageServer.requests
        .filter((request) => String(request.options.path).endsWith("/SendAudioChunk"))
        .map((request) => JSON.parse(Buffer.concat(request.chunks).toString("utf8")).sessionId);
      assert.deepEqual(sentSessionIds, ["audio-session-1", "audio-session-2", "audio-session-3"]);
    } finally {
      ws.close();
      languageServer.restore();
      await closeServer(server);
    }
  });

  it("terminalizes a ready client when its upstream stream ends unexpectedly", async () => {
    const rawKey = "rk-ws-unexpected-stream-end";
    const tokenHash = addVirtualKey(rawKey, ["*"]);
    const requests: FakeRequest[] = [];
    let streamResponse: FakeResponse | null = null;
    const requestMock = mock.method(
      https,
      "request",
      ((options: Record<string, unknown>, callback?: (response: FakeResponse) => void) => {
        const request = new FakeRequest(options, callback, () => {
          if (String(options.path).endsWith("/StreamAudioTranscription")) {
            streamResponse = new FakeResponse();
            request.respond(streamResponse);
            queueMicrotask(() =>
              streamResponse?.emit("data", connectFrame({ ready: { sessionId: "unexpected-end" } })),
            );
          }
        });
        requests.push(request);
        return request;
      }) as unknown as typeof https.request,
    );
    const { server, port } = await listenServer((_req, res) => res.end());
    installUpgradeHandler(server);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?key=${rawKey}`);

    try {
      await waitForWebSocketEvent(ws, "open");
      const ready = waitForWebSocketMessage(ws, (message) => message.type === "ready_to_receive_audio");
      ws.send(JSON.stringify({ type: "start", model: "models/proactive-observer-v10" }));
      await ready;

      const error = waitForWebSocketMessage(ws, (message) => message.type === "antigravity_error");
      const close = waitForWebSocketEvent<CloseEvent>(ws, "close");
      void close.catch(() => {});
      (streamResponse as FakeResponse | null)?.emit("end");
      ws.send(Buffer.alloc(1));

      await error;
      assert.equal((await close).code, 1011);
      assert.equal(
        requests.some((request) => String(request.options.path).endsWith("/SendAudioChunk")),
        false,
      );
      assert.deepEqual(
        spendLogger.getSpendQueueItemsForTests().map((entry) => ({
          apiKeyHash: entry.apiKeyHash,
          status: entry.status,
        })),
        [{ apiKeyHash: tokenHash, status: "failure" }],
      );
    } finally {
      ws.close();
      requestMock.mock.restore();
      await closeServer(server);
    }
  });

  it("does not report a stream error while a client session is ending normally", async () => {
    const rawKey = "rk-ws-normal-stream-end";
    addVirtualKey(rawKey, ["*"]);
    const requests: FakeRequest[] = [];
    let streamResponse: FakeResponse | null = null;
    let endRequest: FakeRequest | null = null;
    const requestMock = mock.method(
      https,
      "request",
      ((options: Record<string, unknown>, callback?: (response: FakeResponse) => void) => {
        const request = new FakeRequest(options, callback, () => {
          if (String(options.path).endsWith("/StreamAudioTranscription")) {
            streamResponse = new FakeResponse();
            request.respond(streamResponse);
            queueMicrotask(() =>
              streamResponse?.emit("data", connectFrame({ ready: { sessionId: "normal-end" } })),
            );
          } else if (String(options.path).endsWith("/EndAudioSession")) {
            endRequest = request;
          }
        });
        requests.push(request);
        return request;
      }) as unknown as typeof https.request,
    );
    const { server, port } = await listenServer((_req, res) => res.end());
    installUpgradeHandler(server);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?key=${rawKey}`);
    const messages: Array<Record<string, unknown>> = [];
    ws.onmessage = (event) => messages.push(JSON.parse(String(event.data)) as Record<string, unknown>);

    try {
      await waitForWebSocketEvent(ws, "open");
      const ready = waitForWebSocketMessage(ws, (message) => message.type === "ready_to_receive_audio");
      ws.send(JSON.stringify({ type: "start", model: "models/proactive-observer-v10" }));
      await ready;

      ws.send(JSON.stringify({ type: "stop" }));
      await waitForWebSocketMessage(ws, (message) => message.type === "audio_stopped");
      await waitForCondition(() => endRequest !== null);
      (streamResponse as FakeResponse | null)?.emit("end");
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(messages.some((message) => message.type === "antigravity_error"), false);

      const endResponse = new FakeResponse();
      (endRequest as FakeRequest | null)?.respond(endResponse);
      endResponse.emit("end");
      await waitForCondition(() => spendLogger.getSpendQueueItemsForTests().length === 1);
      assert.equal(spendLogger.getSpendQueueItemsForTests()[0].status, "success");
    } finally {
      ws.close();
      requestMock.mock.restore();
      await closeServer(server);
    }
  });

  it("fails a stopped client when EndAudioSession stops responding", async () => {
    const rawKey = "rk-ws-silent-end";
    const tokenHash = addVirtualKey(rawKey, ["*"]);
    const requests: FakeRequest[] = [];
    let sessionNumber = 0;
    let endResponse: FakeResponse | null = null;
    const requestMock = mock.method(
      https,
      "request",
      ((options: Record<string, unknown>, callback?: (response: FakeResponse) => void) => {
        const request = new FakeRequest(options, callback, () => {
          if (String(options.path).endsWith("/StreamAudioTranscription")) {
            const response = new FakeResponse();
            request.respond(response);
            const sessionId = `silent-end-${++sessionNumber}`;
            queueMicrotask(() => response.emit("data", connectFrame({ ready: { sessionId } })));
          } else if (String(options.path).endsWith("/EndAudioSession")) {
            endResponse = new FakeResponse();
            request.respond(endResponse);
          }
        });
        requests.push(request);
        return request;
      }) as unknown as typeof https.request,
    );
    const { server, port } = await listenServer((_req, res) => res.end());
    installUpgradeHandler(server);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?key=${rawKey}`);
    const messages: Array<Record<string, unknown>> = [];
    ws.onmessage = (event) => messages.push(JSON.parse(String(event.data)) as Record<string, unknown>);

    try {
      await waitForWebSocketEvent(ws, "open");
      const ready = waitForWebSocketMessage(ws, (message) => message.type === "ready_to_receive_audio");
      ws.send(JSON.stringify({ type: "start", model: "models/proactive-observer-v10" }));
      await ready;

      const close = waitForWebSocketEvent<CloseEvent>(ws, "close");
      void close.catch(() => {});
      ws.send(JSON.stringify({ type: "stop" }));
      await waitForCondition(() =>
        requests.some((request) => String(request.options.path).endsWith("/EndAudioSession")),
      );
      ws.send(JSON.stringify({ type: "start", model: "models/proactive-observer-v10" }));

      const endRequest = requests.find((request) =>
        String(request.options.path).endsWith("/EndAudioSession"),
      );
      assert.ok(endRequest);
      assert.ok(endResponse);
      assert.ok(endRequest.timeoutCallback);
      endRequest.timeoutCallback();

      assert.equal((await close).code, 1011);
      assert.equal(endRequest.destroyed, true);
      assert.equal(
        requests.filter((request) =>
          String(request.options.path).endsWith("/StreamAudioTranscription"),
        ).length,
        1,
      );
      assert.equal(messages.filter((message) => message.type === "ready_to_receive_audio").length, 1);
      assert.deepEqual(
        spendLogger.getSpendQueueItemsForTests().map((entry) => ({
          apiKeyHash: entry.apiKeyHash,
          status: entry.status,
        })),
        [{ apiKeyHash: tokenHash, status: "failure" }],
      );

      (endResponse as FakeResponse | null)?.emit("end");
      endRequest.emit("error", new Error("late end failure"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(spendLogger.getSpendQueueItemsForTests().length, 1);
    } finally {
      ws.close();
      requestMock.mock.restore();
      await closeServer(server);
    }
  });

  it("stops processing buffered frames after closing the client", async () => {
    const rawKey = "rk-ws-buffered-close";
    addVirtualKey(rawKey, ["*"]);
    const languageServer = mockLanguageServer("pending");
    const { server, port } = await listenServer((_req, res) => res.end());
    installUpgradeHandler(server);
    let socket: Socket | undefined;

    try {
      const upgrade = await rawUpgrade(port, `/ws?key=${rawKey}`);
      socket = upgrade.socket;
      const closed = once(socket, "close");
      socket.resume();
      socket.write(Buffer.from([0x82, 0, 0x82, 1, 1]));
      await Promise.race([
        closed,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("close timeout")), 500)),
      ]);
      assert.equal(
        languageServer.requests.filter((request) =>
          String(request.options.path).endsWith("/StreamAudioTranscription"),
        ).length,
        1,
      );
    } finally {
      socket?.destroy();
      languageServer.restore();
      await closeServer(server);
    }
  });

  it("rejects an unsafe uint64 frame length with close code 1009", async () => {
    const rawKey = "rk-ws-uint64-limit";
    addVirtualKey(rawKey, ["*"]);
    const { server, port } = await listenServer((_req, res) => res.end());
    installUpgradeHandler(server);
    let socket: Socket | undefined;

    try {
      const upgrade = await rawUpgrade(port, `/ws?key=${rawKey}`);
      socket = upgrade.socket;
      await new Promise((resolve) => setTimeout(resolve, 20));
      while (socket.read() !== null) {
        // Drain the initial system_status frame before checking the close frame.
      }
      const header = Buffer.alloc(10);
      header[0] = 0x82;
      header[1] = 0x7f;
      header.writeBigUInt64BE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 2);
      socket.write(header);
      const [closeFrame] = await Promise.race([
        once(socket, "data"),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("uint64 close timeout")), 300)),
      ]);
      const frame = closeFrame as Buffer;
      assert.equal(frame[0] & 0x0f, 8);
      assert.equal(frame.readUInt16BE(2), 1009);
    } finally {
      socket?.destroy();
      await closeServer(server);
    }
  });
});
