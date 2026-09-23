import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mock, test } from "node:test";
import type { QueryResult, QueryResultRow } from "pg";
import { PostgresSettingsRepository } from "../src/settings-repository.js";

const originalDatabaseUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL = "postgresql://audio-auth-poc.invalid/rotator";
process.env.PI_ROTATOR_TELEMETRY = "off";

const keyRows = new Map<string, QueryResultRow>();
function wavBuffer(): Buffer {
  const pcm = Buffer.alloc(32_000);
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
}

function queryResult<R extends QueryResultRow>(rows: R[], command = "SELECT"): QueryResult<R> {
  return { rows, command, rowCount: rows.length, oid: 0, fields: [] };
}

mock.method(PostgresSettingsRepository.prototype, "init", async () => {});
mock.method(
  PostgresSettingsRepository.prototype,
  "query",
  async <R extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<R>> => {
    if (text.includes("COUNT(*)")) {
      return queryResult([{ count: String(keyRows.size) }] as unknown as R[]);
    }
    if (text.includes("SELECT * FROM rotator_virtual_keys")) {
      const row = keyRows.get(String(params?.[0]));
      return queryResult((row ? [row] : []) as R[]);
    }
    return queryResult<R>([], text.trimStart().startsWith("UPDATE") ? "UPDATE" : "SELECT");
  },
);

const [audio, dbStore, virtualKeys] = await Promise.all([
  import("../src/audio-transcription.js"),
  import("../src/db-store.js"),
  import("../src/virtual-keys.js"),
]);
await dbStore.initDb();

test("audio model scope rejects an unscoped requested model even when execution falls back to Gemini", async () => {
  const rawKey = "rk-audio-scope-poc-aeb3920d";
  const tokenHash = virtualKeys.hashKey(rawKey);
  keyRows.set(tokenHash, {
    token_hash: tokenHash,
    key_name: "audio-scope-poc",
    key_alias: "audio-scope-poc",
    user_id: null,
    models: ["models/proactive-observer-v10"],
    metadata: {},
    blocked: false,
    last_active: null,
    created_at: "2026-09-23T00:00:00.000Z",
    created_by: "poc",
  });
  virtualKeys.clearVirtualKeyCache();

  const upstreamModels: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://daily-cloudcode-pa.googleapis.com/")) {
      upstreamModels.push(JSON.parse(String(init?.body ?? "{}")).model);
      return new Response(
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"transcribed"}]},"finishReason":"STOP"}]}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }
    const hostname = new URL(url).hostname;
    if (hostname === "127.0.0.1" || hostname === "localhost") return realFetch(input, init);
    throw new Error(`Unexpected external request blocked by PoC: ${hostname}`);
  }) as typeof fetch;

  const account = {
    config: {
      email: "audio-auth-poc@example.invalid",
      label: "audio-auth-poc",
      credentials: [{ provider: "google-antigravity", refreshToken: "unused", projectId: "poc-project" }],
    },
    accessToken: "mock-access-token",
    tokenExpires: Date.now() + 60_000,
    disabled: false,
    flagged: false,
    requestsSinceRotation: 0,
    totalRequests: 0,
    cooldownsByModel: {},
    inFlightRequests: 0,
    inFlightByModel: {},
    healthScore: 1,
  };
  const rotator = {
    getActiveAccount: async () => account,
    getRetryAfterMs: () => 0,
    getSafetyJitterMs: () => 0,
    getGlobalDelayMs: () => 0,
    recordUpstreamAttempt() {},
    finishRequest() {},
    recordRequest: () => false,
    recordTokenUsage() {},
    markError() {},
    markRateLimited() {},
    markExhausted() {},
    markFlagged() {},
    recordFailure() {},
    recordSuccess() {},
    recordProvider429() {},
    recordProxyEvent() {},
  };

  const server = createServer((req, res) => {
    void audio.handleOpenAIAudioTranscriptions(req, res, rotator as never);
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");

    const form = new FormData();
    form.append("file", new File([new Uint8Array(wavBuffer())], "sample.wav", { type: "audio/wav" }));
    form.append("model", "claude-opus-4-6");
    const response = await realFetch(`http://127.0.0.1:${address.port}/v1/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${rawKey}` },
      body: form,
    });
    const body = await response.text();

    assert.equal(
      response.status,
      403,
      `an observer-only key must be denied for requested model claude-opus-4-6; got HTTP ${response.status}: ${body}`,
    );
    assert.equal(upstreamModels.length, 0, "a denied request must not reach any upstream model");
  } finally {
    globalThis.fetch = realFetch;
    virtualKeys.clearVirtualKeyCache();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    server.closeAllConnections?.();
    await dbStore.closeDb();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    mock.restoreAll();
  }
});
