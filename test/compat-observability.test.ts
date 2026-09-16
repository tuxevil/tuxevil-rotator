import assert from "node:assert/strict";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, describe, it } from "node:test";
import {
  handleAnthropicMessages,
  handleGeminiGenerateContent,
  handleOpenAIChatCompletions,
  handleOpenAIResponsesCreate,
  resetResponsesStoreForTests,
  streamCompatSse,
  streamResponsesSse,
} from "../src/compat.js";
import { startProxy } from "../src/proxy.js";
import { stopNotificationPoller } from "../src/notification-poller.js";
import { stopVersionChecker } from "../src/version-check.js";
import {
  ANTIGRAVITY_ENDPOINTS,
  OLLAMA_CHAT_ENDPOINTS,
  type AccountRuntime,
} from "../src/types.js";
import type { AccountRotator } from "../src/rotator.js";

type RequestLogCapture = {
  model: string;
  account: string;
  statusCode: number;
  ttfbMs: number;
  totalMs: number;
  inputTokens: number;
  outputTokens: number;
};

type Tracking = {
  requestLogs: RequestLogCapture[];
  latencies: Array<{ model: string | undefined; ttfbMs: number; totalMs: number }>;
  tokenUsage: Array<{ model: string | undefined; inputTokens: number; outputTokens: number }>;
  recordRequests: number;
  finishRequests: number;
};

type ResponseStub = ServerResponse & {
  statusCodeCaptured: number;
  headersCaptured: Record<string, string>;
  body: string;
};

const endpointOverrides = ANTIGRAVITY_ENDPOINTS as unknown as string[];
const originalEndpoints = [...endpointOverrides];
const ollamaEndpointOverrides = OLLAMA_CHAT_ENDPOINTS as unknown as string[];
const originalOllamaEndpoints = [...ollamaEndpointOverrides];
const originalCodexBaseUrl = process.env.CODEX_BASE_URL;
let ollamaCatalog: string[] = [];

afterEach(() => {
  ollamaCatalog = [];
  ollamaEndpointOverrides.splice(
    0,
    ollamaEndpointOverrides.length,
    ...originalOllamaEndpoints,
  );
  endpointOverrides.splice(0, endpointOverrides.length, ...originalEndpoints);
  if (originalCodexBaseUrl === undefined) delete process.env.CODEX_BASE_URL;
  else process.env.CODEX_BASE_URL = originalCodexBaseUrl;
  resetResponsesStoreForTests();
  stopVersionChecker();
  stopNotificationPoller();
});

function createTracking(): Tracking {
  return {
    requestLogs: [],
    latencies: [],
    tokenUsage: [],
    recordRequests: 0,
    finishRequests: 0,
  };
}

function createAccount(): AccountRuntime {
  return {
    config: {
      email: "test@example.com",
      projectId: "test-project",
      refreshToken: "refresh-token",
      label: "test-account",
    },
    accessToken: "access-token",
    tokenExpires: Date.now() + 60_000,
    requestsSinceRotation: 0,
    totalRequests: 0,
    cooldownsByModel: {},
    quotaExhaustedAt: 0,
    quota: [],
    lastQuotaPoll: 0,
    lastUsed: 0,
    lastError: null,
    consecutiveErrors: 0,
    disabled: false,
    flagged: false,
    inFlightRequests: 0,
    inFlightByModel: {},
    allowFreshWindowStartsOverride: false,
    dailyRequestCount: 0,
    dailyRequestDay: "2026-05-16",
    healthScore: 1,
    tokenBucket: {
      tokens: 50,
      lastRefillAt: Date.now(),
    },
  };
}

function createOllamaAccount(): AccountRuntime {
  return {
    config: {
      email: "ollama@example.com",
      projectId: "ollama-project",
      refreshToken: "ollama-refresh",
      label: "ollama-account",
      provider: "ollama",
      apiKey: "ollama-key-test",
    },
    accessToken: "access-token",
    tokenExpires: Date.now() + 60_000,
    requestsSinceRotation: 0,
    totalRequests: 0,
    cooldownsByModel: {},
    quotaExhaustedAt: 0,
    quota: [],
    lastQuotaPoll: 0,
    lastUsed: 0,
    lastError: null,
    consecutiveErrors: 0,
    disabled: false,
    flagged: false,
    inFlightRequests: 0,
    inFlightByModel: {},
    allowFreshWindowStartsOverride: false,
    dailyRequestCount: 0,
    dailyRequestDay: "2026-05-16",
    healthScore: 1,
    tokenBucket: {
      tokens: 50,
      lastRefillAt: Date.now(),
    },
  };
}

function createCodexAccount(): AccountRuntime {
  const account = createAccount();
  account.config = {
    ...account.config,
    provider: "openai-codex",
    credentials: [{
      provider: "openai-codex",
      refreshToken: "codex-refresh",
      providerAccountId: "codex-account",
    }],
  };
  account.providerTokens = {
    "openai-codex": {
      accessToken: "codex-access-token",
      tokenExpires: Date.now() + 120_000,
    },
  };
  return account;
}

function createRotatorStub(
  tracking: Tracking,
  useOllamaAccount = false,
  useCodexAccount = false,
): AccountRotator {
  const account = useCodexAccount
    ? createCodexAccount()
    : useOllamaAccount
      ? createOllamaAccount()
      : createAccount();
  return {
    getActiveAccount: async () => account,
    getOllamaModels: () => ollamaCatalog,
    getCodexModels: () => useCodexAccount ? ["gpt-5.6-luna"] : [],
    hasActiveProvider: (providerId: string) =>
      providerId === "ollama" && useOllamaAccount,
    getRetryAfterMs: () => 0,
    resolveQuotaModelKeyForDisplay: () => "gemini-3.8-flash-high",
    rotateToNext: async () => null,
    finishRequest: () => {
      tracking.finishRequests++;
    },
    getSafetyJitterMs: () => 0,
    recordUpstreamAttempt: () => {},
    markExhausted: () => {},
    recordProvider429: () => {},
    getFlagContext: () => ({
      timerType: "fresh",
      accountQuotaPercent: 0,
      wasProAccount: false,
      accountRequestsLastHour: 0,
      poolSize: 1,
      poolHealthyCount: 1,
      uptimeSeconds: 0,
    }),
    markFlagged: () => {},
    markError: () => {},
    recordRequest: () => {
      tracking.recordRequests++;
      return false;
    },
    recordProxyEvent: () => {},
    getGlobalDelayMs: () => 0,
    recordLatency: (
      model: string | undefined,
      ttfbMs: number,
      totalMs: number,
    ) => {
      tracking.latencies.push({ model, ttfbMs, totalMs });
    },
    recordRequestLog: (entry: RequestLogCapture) => {
      tracking.requestLogs.push(entry);
    },
    recordTokenUsage: (
      model: string | undefined,
      inputTokens: number,
      outputTokens: number,
    ) => {
      tracking.tokenUsage.push({ model, inputTokens, outputTokens });
    },
    saveState: () => {},
    getStatus: () => ({ accounts: [] }),
  } as unknown as AccountRotator;
}

function requestStream(
  method: string,
  url: string,
  payload?: unknown,
): IncomingMessage & PassThrough {
  const stream = new PassThrough() as IncomingMessage & PassThrough;
  const body = payload === undefined ? "" : JSON.stringify(payload);
  stream.method = method;
  stream.url = url;
  stream.headers = {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    "user-agent": "compat-observability-test",
  };
  process.nextTick(() => stream.end(body));
  return stream;
}

function responseStub(): ResponseStub {
  let headersSent = false;
  let writableEnded = false;
  const res = {
    statusCodeCaptured: 0,
    headersCaptured: {},
    body: "",
    get headersSent() {
      return headersSent;
    },
    get writableEnded() {
      return writableEnded;
    },
    writeHead(status: number, headers?: Record<string, string>) {
      this.statusCodeCaptured = status;
      if (headers) {
        Object.assign(this.headersCaptured, headers);
      }
      headersSent = true;
      return this;
    },
    write(chunk: string) {
      this.body += chunk;
      return true;
    },
    end(chunk?: string) {
      if (chunk) this.body += chunk;
      writableEnded = true;
      return this;
    },
  } as ResponseStub;
  return res;
}

async function listenServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: ReturnType<typeof createServer>; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Server did not bind to a TCP port");
  }
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

async function closeHttpServer(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await closeServer(server);
}

async function startTestProxy(rotator: AccountRotator): Promise<Server> {
  const server = startProxy(rotator, 0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 500,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition was not met before timeout");
}

async function readChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = 1000,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("timed out waiting for streamed response data"));
    }, timeoutMs);
    reader.read().then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function readUntilMarker(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  marker: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes(marker)) {
    const result = await readChunkWithTimeout(reader);
    if (result.done) break;
    text += decoder.decode(result.value, { stream: true });
  }
  assert.match(text, new RegExp(marker));
  return text;
}

async function postAndAbortAfterFirstChunk(
  url: string,
  payload: unknown,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = httpRequest(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(body)),
        },
      },
      (res) => {
        res.once("data", () => {
          res.destroy();
          req.destroy();
          resolve();
        });
      },
    );
    req.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNRESET") return;
      reject(err);
    });
    req.setTimeout(1000, () => {
      req.destroy();
      reject(new Error("timed out waiting for first response chunk"));
    });
    req.end(body);
  });
}

async function assertCompatAbortReleasesInFlight(
  path: string,
  payload: unknown,
): Promise<void> {
  let upstreamResponse: ServerResponse | undefined;
  const upstream = await listenServer((req, res) => {
    req.resume();
    req.on("end", () => {
      upstreamResponse = res;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.flushHeaders();
    });
  });
  endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

  const tracking = createTracking();
  const rotator = createRotatorStub(tracking);
  const proxy = await startTestProxy(rotator);
  const port = (proxy.address() as AddressInfo).port;

  try {
    await postAndAbortAfterFirstChunk(
      `http://127.0.0.1:${port}${path}`,
      payload,
    );

    await waitFor(() => tracking.finishRequests === 1);
  } finally {
    upstreamResponse?.destroy();
    await closeHttpServer(proxy);
    await closeHttpServer(upstream.server);
  }
}

function assertCompatObservability(
  tracking: Tracking,
  statusCode: number,
  inputTokens: number,
  outputTokens: number,
): void {
  assert.equal(tracking.requestLogs.length, 1);
  assert.equal(tracking.latencies.length, 1);
  assert.equal(tracking.requestLogs[0].statusCode, statusCode);
  assert.equal(tracking.requestLogs[0].account, "test-account");
  assert.equal(tracking.requestLogs[0].inputTokens, inputTokens);
  assert.equal(tracking.requestLogs[0].outputTokens, outputTokens);
  assert.equal(tracking.requestLogs[0].ttfbMs >= 0, true);
  assert.equal(tracking.requestLogs[0].totalMs >= tracking.requestLogs[0].ttfbMs, true);
  assert.equal(tracking.latencies[0].ttfbMs, tracking.requestLogs[0].ttfbMs);
  assert.equal(tracking.latencies[0].totalMs, tracking.requestLogs[0].totalMs);
}

describe("compat observability", () => {
  it("records Codex Chat and Responses requests in spend and token usage tracking", async () => {
    const upstream = await listenServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end([
          "event: response.output_text.delta",
          'data: {"type":"response.output_text.delta","delta":"pong"}',
          "",
          "event: response.completed",
          'data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"pong"}]}],"usage":{"input_tokens":13,"output_tokens":5}}}',
          "",
        ].join("\n"));
      });
    });
    process.env.CODEX_BASE_URL = upstream.url;

    const tracking = createTracking();
    const proxy = await startTestProxy(createRotatorStub(tracking, false, true));
    const port = (proxy.address() as AddressInfo).port;

    try {
      const chatResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-luna",
          messages: [{ role: "user", content: "ping" }],
        }),
      });
      assert.equal(chatResponse.status, 200);
      await chatResponse.text();

      const streamedChatResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-luna",
          messages: [{ role: "user", content: "ping" }],
          stream: true,
        }),
      });
      assert.equal(streamedChatResponse.status, 200);
      await streamedChatResponse.text();

      const responsesResponse = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-luna",
          input: "ping",
          stream: true,
        }),
      });
      assert.equal(responsesResponse.status, 200);
      await responsesResponse.text();

      await waitFor(() => tracking.requestLogs.length === 3);
      assert.deepEqual(
        tracking.requestLogs.map((entry) => [entry.model, entry.statusCode, entry.inputTokens, entry.outputTokens]),
        [
          ["gpt-5.6-luna", 200, 13, 5],
          ["gpt-5.6-luna", 200, 13, 5],
          ["gpt-5.6-luna", 200, 13, 5],
        ],
      );
      assert.deepEqual(
        tracking.tokenUsage.map((entry) => [entry.model, entry.inputTokens, entry.outputTokens]),
        [
          ["gpt-5.6-luna", 13, 5],
          ["gpt-5.6-luna", 13, 5],
          ["gpt-5.6-luna", 13, 5],
        ],
      );
    } finally {
      await closeHttpServer(proxy);
      await closeServer(upstream.server);
    }
  });

  it("records failed Codex upstream responses without token usage", async () => {
    const upstream = await listenServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid Codex request" } }));
      });
    });
    process.env.CODEX_BASE_URL = upstream.url;

    const tracking = createTracking();
    const proxy = await startTestProxy(createRotatorStub(tracking, false, true));
    const port = (proxy.address() as AddressInfo).port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-luna",
          messages: [{ role: "user", content: "ping" }],
        }),
      });
      assert.equal(response.status, 400);
      await response.text();
      await waitFor(() => tracking.requestLogs.length === 1);
      assert.equal(tracking.requestLogs[0].model, "gpt-5.6-luna");
      assert.equal(tracking.requestLogs[0].statusCode, 400);
      assert.equal(tracking.requestLogs[0].inputTokens, 0);
      assert.equal(tracking.requestLogs[0].outputTokens, 0);
      assert.equal(tracking.tokenUsage.length, 0);
    } finally {
      await closeHttpServer(proxy);
      await closeServer(upstream.server);
    }
  });

  it("records request log, latency, and token usage for successful compat routes", async () => {
    const upstream = await listenServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(
          'data: {"response":{"candidates":[{"content":{"parts":[{"text":"pong"}]}}],"usageMetadata":{"promptTokenCount":11,"candidatesTokenCount":7}}}\n\n',
        );
      });
    });
    endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

    try {
      const cases: Array<{
        name: string;
        request: IncomingMessage & PassThrough;
        run: (
          req: IncomingMessage,
          res: ServerResponse,
          rotator: AccountRotator,
        ) => Promise<void>;
      }> = [
        {
          name: "openai chat",
          request: requestStream("POST", "/v1/chat/completions", {
            model: "gemini-3.8-flash-high",
            messages: [{ role: "user", content: "ping" }],
          }),
          run: handleOpenAIChatCompletions,
        },
        {
          name: "anthropic messages",
          request: requestStream("POST", "/v1/messages", {
            model: "claude-sonnet-4-6",
            max_tokens: 128,
            messages: [{ role: "user", content: "ping" }],
          }),
          run: handleAnthropicMessages,
        },
        {
          name: "gemini generateContent",
          request: requestStream(
            "POST",
            "/v1beta/models/gemini-3-flash:generateContent",
            {
              contents: [{ role: "user", parts: [{ text: "ping" }] }],
            },
          ),
          run: handleGeminiGenerateContent,
        },
      ];

      for (const testCase of cases) {
        const tracking = createTracking();
        const rotator = createRotatorStub(tracking);
        const res = responseStub();
        await testCase.run(testCase.request, res, rotator);

        assert.equal(res.statusCodeCaptured, 200, testCase.name);
        assertCompatObservability(tracking, 200, 11, 7);
        assert.equal(tracking.tokenUsage.length, 1, testCase.name);
        assert.equal(tracking.tokenUsage[0].inputTokens, 11);
        assert.equal(tracking.tokenUsage[0].outputTokens, 7);
        assert.equal(tracking.recordRequests, 1, testCase.name);
        assert.equal(res.headersCaptured["X-Rotator-Account"], "te***nt", testCase.name);
        assert.ok(res.headersCaptured["X-Rotator-Model"], testCase.name);
        assert.equal(res.headersCaptured["X-Rotator-Tokens-Input"], "11", testCase.name);
        assert.equal(res.headersCaptured["X-Rotator-Tokens-Output"], "7", testCase.name);
        assert.ok(res.headersCaptured["X-Rotator-Cost-Usd"], testCase.name);
        assert.equal(res.headersCaptured["X-Rotator-Health-Score"], "1.00", testCase.name);
        assert.equal(res.headersCaptured["X-Rotator-Routing-Policy"], "timer-first", testCase.name);
      }
    } finally {
      await closeServer(upstream.server);
    }
  });

  it("preserves cached token counts in native Gemini responses", async () => {
    const upstream = await listenServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(
          'data: {"response":{"candidates":[{"content":{"parts":[{"text":"pong"}]}}],"usageMetadata":{"promptTokenCount":1200,"candidatesTokenCount":50,"cachedContentTokenCount":1000}}}\n\n',
        );
      });
    });
    endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

    try {
      const res = responseStub();
      await handleGeminiGenerateContent(
        requestStream("POST", "/v1beta/models/gemini-3-flash:generateContent", {
          contents: [{ role: "user", parts: [{ text: "ping" }] }],
        }),
        res,
        createRotatorStub(createTracking()),
      );

      assert.equal(res.statusCodeCaptured, 200);
      const payload = JSON.parse(res.body) as {
        usageMetadata?: { cachedContentTokenCount?: number };
      };
      assert.equal(payload.usageMetadata?.cachedContentTokenCount, 1000);
    } finally {
      await closeServer(upstream.server);
    }
  });

  it("records failed compat upstream responses without token double-counting", async () => {
    const upstream = await listenServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "temporarily down" }));
      });
    });
    endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

    try {
      const tracking = createTracking();
      const rotator = createRotatorStub(tracking);
      const req = requestStream("POST", "/v1/chat/completions", {
        model: "gemini-3.8-flash-high",
        messages: [{ role: "user", content: "ping" }],
      });
      const res = responseStub();
      await handleOpenAIChatCompletions(req, res, rotator);

      assert.equal(res.statusCodeCaptured, 503);
      assertCompatObservability(tracking, 503, 0, 0);
      assert.equal(tracking.tokenUsage.length, 0);
      assert.equal(tracking.recordRequests, 0);
    } finally {
      await closeServer(upstream.server);
    }
  });

  it("records Responses streaming observability with parsed usage", async () => {
    const upstream = await listenServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(
          [
            'data: {"response":{"candidates":[{"content":{"parts":[{"text":"po"}]}}]}}',
            'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ng"}]}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3}}}',
            "",
          ].join("\n"),
        );
      });
    });
    endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

    try {
      const tracking = createTracking();
      const rotator = createRotatorStub(tracking);
      const req = requestStream("POST", "/v1/responses", {
        model: "gemini-3.8-flash-high",
        input: "ping",
        stream: true,
      });
      const res = responseStub();
      await handleOpenAIResponsesCreate(req, res, rotator);

      assert.equal(res.statusCodeCaptured, 200);
      assert.match(res.body, /"type":"response.completed"/);
      assertCompatObservability(tracking, 200, 5, 3);
      assert.equal(tracking.tokenUsage.length, 1);
      assert.equal(tracking.tokenUsage[0].inputTokens, 5);
      assert.equal(tracking.tokenUsage[0].outputTokens, 3);
    } finally {
      await closeServer(upstream.server);
    }
  });

  it("emits a terminal error event when an OpenAI stream fails mid-response", async () => {
    const upstream = await listenServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(
          'data: {"response":{"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}}\n\n',
        );
        setTimeout(() => res.destroy(), 20);
      });
    });
    endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

    const tracking = createTracking();
    const proxy = await startTestProxy(createRotatorStub(tracking));
    const port = (proxy.address() as AddressInfo).port;

    try {
      const body = JSON.stringify({
        model: "gemini-3.8-flash-high",
        messages: [{ role: "user", content: "ping" }],
        stream: true,
      });
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      const responseBody = await response.text();

      assert.equal(response.status, 200);
      assert.match(responseBody, /"type":"server_error"/);
      assert.match(responseBody, /data: \[DONE\]/);
      await waitFor(() => tracking.requestLogs.length === 1);
      assert.equal(tracking.requestLogs[0].statusCode, 502);
    } finally {
      await closeHttpServer(proxy);
      await closeHttpServer(upstream.server);
    }
  });

  it("emits terminal error events for Responses, Anthropic, and native streams", async () => {
    const upstream = await listenServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.flushHeaders();
        res.write(
          'data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n',
        );
        setTimeout(() => {
          res.write(
            'data: {"candidates":[{"content":{"parts":[{"text":"more"}]}}]}\n\n',
          );
        }, 100);
        setTimeout(() => res.destroy(), 200);
      });
    });
    endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

    const tracking = createTracking();
    const proxy = await startTestProxy(createRotatorStub(tracking));
    const port = (proxy.address() as AddressInfo).port;
    const cases = [
      {
        path: "/v1/responses",
        payload: {
          model: "gemini-3.8-flash-high",
          input: "ping",
          stream: true,
        },
        marker: /"code":"stream_error"/,
      },
      {
        path: "/v1/messages",
        payload: {
          model: "claude-sonnet-4-6",
          max_tokens: 32,
          messages: [{ role: "user", content: "ping" }],
          stream: true,
        },
        marker: /event: error/,
      },
      {
        path: "/v1internal:streamGenerateContent?alt=sse",
        payload: {
          model: "gemini-3-flash",
          request: { contents: [{ role: "user", parts: [{ text: "ping" }] }] },
        },
        marker: /BAD_GATEWAY/,
      },
    ];

    try {
      for (const testCase of cases) {
        const response = await fetch(`http://127.0.0.1:${port}${testCase.path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(testCase.payload),
        });
        const responseBody = await response.text();
        assert.equal(response.status, 200, testCase.path);
        assert.match(responseBody, testCase.marker, testCase.path);
      }
      await waitFor(() => tracking.requestLogs.length === cases.length);
    } finally {
      await closeHttpServer(proxy);
      await closeHttpServer(upstream.server);
    }
  });

  it("delivers stream tokens before the upstream response completes", async () => {
    const cases = [
      {
        path: "/v1/chat/completions",
        payload: {
          model: "gemini-3.8-flash-high",
          messages: [{ role: "user", content: "ping" }],
          stream: true,
        },
      },
      {
        path: "/v1/responses",
        payload: {
          model: "gemini-3.8-flash-high",
          input: "ping",
          stream: true,
        },
      },
      {
        path: "/v1/messages",
        payload: {
          model: "claude-sonnet-4-6",
          max_tokens: 32,
          messages: [{ role: "user", content: "ping" }],
          stream: true,
        },
      },
      {
        path: "/v1internal:streamGenerateContent?alt=sse",
        payload: {
          model: "gemini-3-flash",
          request: { contents: [{ role: "user", parts: [{ text: "ping" }] }] },
        },
      },
    ];

    for (const testCase of cases) {
      let upstreamCompleted = false;
      let releaseSecondChunk = (): void => {};
      const secondChunk = new Promise<void>((resolve) => {
        releaseSecondChunk = resolve;
      });
      const upstream = await listenServer((req, res) => {
        req.resume();
        req.on("end", () => {
          void (async () => {
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            res.flushHeaders();
            res.write(
              'data: {"candidates":[{"content":{"parts":[{"text":"first-token"}]}}]}\n\n',
            );
            await secondChunk;
            res.write(
              'data: {"candidates":[{"content":{"parts":[{"text":"second-token"}]}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3}}\n\n',
            );
            res.end();
            upstreamCompleted = true;
          })();
        });
      });
      endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

      const tracking = createTracking();
      const proxy = await startTestProxy(createRotatorStub(tracking));
      const port = (proxy.address() as AddressInfo).port;

      try {
        const response = await fetch(`http://127.0.0.1:${port}${testCase.path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(testCase.payload),
        });
        assert.equal(response.status, 200, testCase.path);
        const reader = response.body?.getReader();
        if (!reader) throw new Error("streaming response body is unavailable");

        const firstChunk = await readUntilMarker(reader, "first-token");
        assert.match(firstChunk, /first-token/);
        assert.equal(upstreamCompleted, false, testCase.path);

        releaseSecondChunk();
        let remainder = "";
        const decoder = new TextDecoder();
        while (true) {
          const result = await readChunkWithTimeout(reader);
          if (result.done) break;
          remainder += decoder.decode(result.value, { stream: true });
        }
        assert.match(remainder, /second-token/);
        assert.equal(upstreamCompleted, true, testCase.path);
      } finally {
        releaseSecondChunk();
        await closeHttpServer(proxy);
        await closeServer(upstream.server);
      }
    }
  });

  it("releases an in-flight compat chat request when the client disconnects before upstream completes", async () => {
    await assertCompatAbortReleasesInFlight("/v1/chat/completions", {
      model: "gemini-3.8-flash-high",
      messages: [{ role: "user", content: "hold the stream open" }],
      stream: true,
    });
  });

  it("releases an in-flight Responses request when the client disconnects before upstream completes", async () => {
    await assertCompatAbortReleasesInFlight("/v1/responses", {
      model: "gemini-3.8-flash-high",
      input: "hold the stream open",
      stream: true,
    });
  });

  it("terminates compatibility streams that stay idle after headers", async () => {
    const silentBody = new ReadableStream<Uint8Array>({
      start() {
        // Keep the upstream open without producing any data.
      },
    });

    const chatRes = responseStub();
    const chatCompletion = await streamCompatSse(
      silentBody,
      new PassThrough() as unknown as IncomingMessage,
      chatRes,
      "gemini-3.8-flash-medium",
      "openai",
      undefined,
      undefined,
      undefined,
      "google",
      { idleTimeoutMs: 10 },
    );
    assert.match(chatCompletion.streamError ?? "", /idle timeout/);
    assert.equal(chatRes.writableEnded, true);
    assert.match(chatRes.body, /server_error/);

    const responsesRes = responseStub();
    const responsesCompletion = await streamResponsesSse(
      new ReadableStream<Uint8Array>({
        start() {
          // Keep the upstream open without producing any data.
        },
      }),
      new PassThrough() as unknown as IncomingMessage,
      responsesRes,
      {
        model: "gemini-3.8-flash-medium",
        input: "ping",
        stream: true,
      },
      "resp_idle_test",
      null,
      Math.floor(Date.now() / 1000),
      undefined,
      undefined,
      undefined,
      "google",
      { idleTimeoutMs: 10 },
    );
    assert.match(responsesCompletion.streamError ?? "", /idle timeout/);
    assert.equal(responsesRes.writableEnded, true);
    assert.match(responsesRes.body, /stream_error/);
  });

  it("preserves OpenCode cached tokens in Responses streaming usage", async () => {
    const body = new Response([
      'data: {"choices":[{"delta":{"content":"hello"}}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":500,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":400}}}',
      "data: [DONE]",
      "",
    ].join("\n")).body;
    assert.ok(body);

    const res = responseStub();
    const completion = await streamResponsesSse(
      body,
      new PassThrough() as unknown as IncomingMessage,
      res,
      { model: "muse-spark-1.3-contributor-free", input: "ping", stream: true },
      "resp_opencode_cache",
      null,
      Math.floor(Date.now() / 1000),
      undefined,
      undefined,
      undefined,
      "opencode-zen",
    );

    assert.equal(completion.cachedTokens, 400);
    assert.match(res.body, /"cached_tokens":400/);
  });

  it("cancels a queued non-stream compat request before it can be admitted", async () => {
    let upstreamCalls = 0;
    const upstream = await listenServer((req, res) => {
      upstreamCalls++;
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(
          'data: {"response":{"candidates":[{"content":{"parts":[{"text":"late"}]}}]}}\n\n',
        );
      });
    });
    endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

    const tracking = createTracking();
    const rotator = createRotatorStub(tracking);
    const account = createAccount();
    let capturedSignal: AbortSignal | undefined;
    let admit = (): void => {};
    let queuedResolve!: () => void;
    const queued = new Promise<void>((resolve) => {
      queuedResolve = resolve;
    });
    rotator.getActiveAccount = async (_model?: string, signal?: AbortSignal) => {
      capturedSignal = signal;
      queuedResolve();
      return new Promise<AccountRuntime | null>((resolve) => {
        let settled = false;
        const onAbort = (): void => {
          if (settled) return;
          settled = true;
          resolve(null);
        };
        admit = () => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          resolve(account);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    };

    const proxy = await startTestProxy(rotator);
    const port = (proxy.address() as AddressInfo).port;
    const body = JSON.stringify({
      model: "gemini-3.8-flash-high",
      messages: [{ role: "user", content: "wait in queue" }],
      stream: false,
    });
    let clientRequest: ReturnType<typeof httpRequest> | undefined;

    try {
      const clientClosed = new Promise<void>((resolve, reject) => {
        let closed = false;
        const settle = (): void => {
          if (closed) return;
          closed = true;
          resolve();
        };
        clientRequest = httpRequest(
          `http://127.0.0.1:${port}/v1/chat/completions`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": String(Buffer.byteLength(body)),
            },
          },
          (response) => {
            response.resume();
            response.once("end", settle);
          },
        );
        clientRequest.once("close", settle);
        clientRequest.once("error", (error: NodeJS.ErrnoException) => {
          if (error.code === "ECONNRESET") settle();
          else reject(error);
        });
        clientRequest.end(body);
      });

      await queued;
      clientRequest?.destroy();
      await clientClosed;
      for (let attempt = 0; attempt < 20 && !capturedSignal?.aborted; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const abortedWhileQueued = capturedSignal?.aborted === true;
      admit();
      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.equal(abortedWhileQueued, true, "non-stream admission must receive the client signal");
      assert.equal(upstreamCalls, 0, "a closed client must never consume a later lease");
      assert.equal(tracking.finishRequests, 0);
    } finally {
      clientRequest?.destroy();
      admit();
      await closeHttpServer(proxy);
      await closeHttpServer(upstream.server);
    }
  });

  it("lists ollama models on /v1/models with owned_by ollama", async () => {
    ollamaCatalog = ["gpt-oss:20b", "nemotron-nano:8b"];
    const tracking = createTracking();
    const rotator = createRotatorStub(tracking, true);
    const proxy = await startTestProxy(rotator);
    const port = (proxy.address() as AddressInfo).port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/models`);
      const payload = (await response.json()) as {
        data: Array<Record<string, unknown>>;
      };
      assert.equal(response.status, 200);
      const ids = payload.data.map((m) => m.id);
      assert.ok(ids.includes("gpt-oss:20b"));
      assert.ok(ids.includes("nemotron-nano:8b"));
      const ollamaEntry = payload.data.find((m) => m.id === "gpt-oss:20b");
      assert.equal(ollamaEntry?.owned_by, "ollama");
    } finally {
      await closeHttpServer(proxy);
    }
  });

  it("translates openai chat completions to the ollama body and reads NDJSON responses", async () => {
    let receivedBody: unknown = null;
    const upstream = await listenServer((req, res) => {
      const bodyChunks: Buffer[] = [];
      req.on("data", (c: Buffer) => bodyChunks.push(c));
      req.on("end", () => {
        try {
          receivedBody = JSON.parse(Buffer.concat(bodyChunks).toString());
        } catch {
          // ignore malformed test payload
        }
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        const chunks = [
          { model: "gpt-oss:20b", message: { role: "assistant", content: "Hel" }, done: false },
          { model: "gpt-oss:20b", message: { role: "assistant", content: "lo" }, done: false },
          { model: "gpt-oss:20b", message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 11, eval_count: 7 },
        ];
        res.end(chunks.map((c) => JSON.stringify(c)).join("\n"));
      });
    });
    ollamaEndpointOverrides.splice(0, ollamaEndpointOverrides.length, upstream.url);
    ollamaCatalog = ["gpt-oss:20b"];

    const tracking = createTracking();
    const rotator = createRotatorStub(tracking, true);
    const proxy = await startTestProxy(rotator);
    const port = (proxy.address() as AddressInfo).port;
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "gpt-oss:20b",
            stream: false,
            temperature: 0.3,
            max_tokens: 96,
            messages: [
              { role: "system", content: "Be brief" },
              { role: "user", content: "ping" },
            ],
          }),
        },
      );
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      assert.equal(response.status, 200);
      assert.equal(payload.choices?.[0]?.message?.content, "Hello");
      assert.equal(payload.usage?.prompt_tokens, 11);
      assert.equal(payload.usage?.completion_tokens, 7);

      // Upstream received the translated ollama-native body.
      const request = (receivedBody ?? {}) as Record<string, unknown>;
      assert.equal(request.model, "gpt-oss:20b");
      assert.equal(request.stream, false);
      const messages = request.messages as Array<Record<string, unknown>>;
      assert.deepEqual(messages, [
        { role: "system", content: "Be brief" },
        { role: "user", content: "ping" },
      ]);
      const options = request.options as Record<string, unknown>;
      assert.equal(options.temperature, 0.3);
      assert.equal(options.num_predict, 96);
    } finally {
      await closeHttpServer(proxy);
      await closeServer(upstream.server);
    }
  });

  it("streams ollama NDJSON deltas as openai chat completion chunks", async () => {
    const upstream = await listenServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.write(
          JSON.stringify({ model: "gpt-oss:20b", message: { role: "assistant", content: "Hel" }, done: false }) + "\n",
        );
        res.write(
          JSON.stringify({ model: "gpt-oss:20b", message: { role: "assistant", content: "lo" }, done: false }) + "\n",
        );
        res.end(
          JSON.stringify({ model: "gpt-oss:20b", message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 5, eval_count: 9 }) + "\n",
        );
      });
    });
    ollamaEndpointOverrides.splice(0, ollamaEndpointOverrides.length, upstream.url);
    ollamaCatalog = ["gpt-oss:20b"];

    const tracking = createTracking();
    const rotator = createRotatorStub(tracking, true);
    const proxy = await startTestProxy(rotator);
    const port = (proxy.address() as AddressInfo).port;
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "gpt-oss:20b",
            stream: true,
            messages: [{ role: "user", content: "ping" }],
          }),
        },
      );
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.match(body, /delta":\{[^}]*"content":"Hel"/);
      assert.match(body, /"content":"lo"/);
      assert.match(body, /finish_reason":"stop"/);
      assert.match(body, /"usage":\{[^}]*"prompt_tokens":5/);
      assert.match(body, /"completion_tokens":9/);
      assert.ok(body.includes("data: [DONE]"));
    } finally {
      await closeHttpServer(proxy);
      await closeServer(upstream.server);
    }
  });

  it("streams ollama NDJSON deltas as anthropic message events", async () => {
    const upstream = await listenServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.write(
          JSON.stringify({ model: "gpt-oss:20b", message: { role: "assistant", content: "Sal" }, done: false }) + "\n",
        );
        res.end(
          JSON.stringify({ model: "gpt-oss:20b", message: { role: "assistant", content: "ud" }, done: true, done_reason: "stop", prompt_eval_count: 3, eval_count: 4 }) + "\n",
        );
      });
    });
    ollamaEndpointOverrides.splice(0, ollamaEndpointOverrides.length, upstream.url);
    ollamaCatalog = ["gpt-oss:20b"];

    const tracking = createTracking();
    const rotator = createRotatorStub(tracking, true);
    const proxy = await startTestProxy(rotator);
    const port = (proxy.address() as AddressInfo).port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-oss:20b",
          max_tokens: 128,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.match(body, /event: content_block_start/);
      assert.match(body, /event: content_block_delta/);
      assert.match(body, /type":"text_delta","text":"Sal"/);
      assert.match(body, /event: message_delta/);
      assert.match(body, /event: message_stop/);
    } finally {
      await closeHttpServer(proxy);
      await closeServer(upstream.server);
    }
  });

  it("streams ollama NDJSON deltas as responses api output_text events", async () => {
    const upstream = await listenServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.write(
          JSON.stringify({ model: "gpt-oss:20b", message: { role: "assistant", content: "Re" }, done: false }) + "\n",
        );
        res.end(
          JSON.stringify({ model: "gpt-oss:20b", message: { role: "assistant", content: "dy" }, done: true, done_reason: "stop", prompt_eval_count: 2, eval_count: 6 }) + "\n",
        );
      });
    });
    ollamaEndpointOverrides.splice(0, ollamaEndpointOverrides.length, upstream.url);
    ollamaCatalog = ["gpt-oss:20b"];

    const tracking = createTracking();
    const rotator = createRotatorStub(tracking, true);
    const proxy = await startTestProxy(rotator);
    const port = (proxy.address() as AddressInfo).port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-oss:20b",
          stream: true,
          input: "ping",
        }),
      });
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.match(body, /response.output_text.delta/);
      assert.match(body, /"delta":"Re"/);
      assert.match(body, /"delta":"dy"/);
      assert.match(body, /response.completed/);
    } finally {
      await closeHttpServer(proxy);
      await closeServer(upstream.server);
    }
  });
});
