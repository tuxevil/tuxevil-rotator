import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { resolve } from "node:path";
import { test } from "node:test";
import https from "node:https";
import cp from "node:child_process";
import { PostgresSettingsRepository } from "../src/settings-repository.js";
import type { IncomingMessage } from "node:http";
import type { ClientRequest } from "node:http";
import type { QueryResultRow } from "pg";

const runId = "ceb5d79d8b21eb32c9af96ea05f7d0e4";
const tmpDir = ".tmp_audit_poc/01a0cb4f-1df2-78c1-a370-f700d9497efb/r2/promoted-timeout";

test("audio transcription finishes within the rotator's 30-second deadline", async () => {
  const oldEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    TUXEVIL_ROTATOR_DIR: process.env.TUXEVIL_ROTATOR_DIR,
    PI_ROTATOR_TELEMETRY: process.env.PI_ROTATOR_TELEMETRY,
  };
  const oldFetch = globalThis.fetch;
  const oldInit = PostgresSettingsRepository.prototype.init;
  const oldQuery = PostgresSettingsRepository.prototype.query;
  const oldClose = PostgresSettingsRepository.prototype.close;
  const oldHttpsRequest = https.request;
  const oldExecSync = cp.execSync;
  const oldSetTimeout = globalThis.setTimeout;
  const oldClearTimeout = globalThis.clearTimeout;
  const oldDateNow = Date.now;
  let dbStore;
  let audio;
  let spendLogger;
  let testTmp;
  let response;
  let request;
  let fakeNow = 0;
  let nextTimerId = 1;
  const timers = new Map<number, { id: number; due: number; callback: (...args: unknown[]) => void; args: unknown[] }>();
  let upstreamCalls = 0;
  let languageServerCalls = 0;
  let firstStartedResolve!: (value: string) => void;
  const firstStarted = new Promise<string>((resolve) => (firstStartedResolve = resolve));
  let fallbackStartedResolve!: () => void;
  const fallbackStarted = new Promise<void>((resolve) => (fallbackStartedResolve = resolve));

  class PendingRequest extends EventEmitter {
    destroyed = false;
    path?: string;
    write() { return true; }
    end() { return this; }
    setTimeout() { return this; }
    destroy() { this.destroyed = true; return this; }
  }

  class TestResponse extends EventEmitter {
    writableEnded = false;
    destroyed = false;
    statusCode: number | undefined;
    body: string | undefined;
    writeHead(statusCode: number) { this.statusCode = statusCode; return this; }
    end(body = "") {
      this.body = String(body);
      this.writableEnded = true;
      this.emit("close");
      return this;
    }
  }

  const fakeSetTimeout = (callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
    const timer = {
      id: nextTimerId++,
      due: fakeNow + Math.max(0, Number(delay) || 0),
      callback,
      args,
      unref() { return this; },
      ref() { return this; },
      hasRef() { return true; },
    };
    timers.set(timer.id, timer);
    return timer;
  };
  const fakeClearTimeout = (timer: ReturnType<typeof setTimeout> | undefined) => {
    if (timer && typeof timer === "object") timers.delete((timer as unknown as { id: number }).id);
  };
  const flushMicrotasks = async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve();
  };
  const advance = async (milliseconds: number) => {
    const target = fakeNow + milliseconds;
    while (true) {
      const due = [...timers.values()]
        .filter((timer) => timer.due <= target)
        .sort((a, b) => a.due - b.due || a.id - b.id)[0];
      if (!due) break;
      fakeNow = due.due;
      timers.delete(due.id);
      due.callback(...due.args);
      await flushMicrotasks();
    }
    fakeNow = target;
    await flushMicrotasks();
  };

  try {
    process.env.DATABASE_URL = "postgresql://audit.invalid/audio-timeout-poc";
    process.env.TUXEVIL_ROTATOR_DIR = `${testTmp}/config`;
    process.env.PI_ROTATOR_TELEMETRY = "off";
    globalThis.setTimeout = fakeSetTimeout as unknown as typeof setTimeout;
    globalThis.clearTimeout = fakeClearTimeout as typeof clearTimeout;
    Date.now = () => oldDateNow() + fakeNow;

    PostgresSettingsRepository.prototype.init = async function () {};
    PostgresSettingsRepository.prototype.query = async function <R extends QueryResultRow>(sql: string) {
      return { rows: (sql.includes("COUNT(*)") ? [{ count: "0" }] : []) as unknown as R[], command: "SELECT", rowCount: 0, oid: 0, fields: [] };
    };
    PostgresSettingsRepository.prototype.close = async function () {};
    cp.execSync = () => { throw new Error("Language Server discovery disabled by PoC"); };
    https.request = ((options: string | URL | import("node:https").RequestOptions) => {
      languageServerCalls++;
      const pending = new PendingRequest();
      const requestOptions = typeof options === "object" && !(options instanceof URL) ? options : undefined;
      if (languageServerCalls === 1) firstStartedResolve("language-server");
      else fallbackStartedResolve();
      pending.path = requestOptions?.path as string | undefined;
      return pending as unknown as ClientRequest;
    }) as typeof https.request;
    globalThis.fetch = (_input, init = {}) => {
      upstreamCalls++;
      firstStartedResolve("rotator");
      const signal = init.signal;
      return new Promise((_resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason ?? new Error("aborted"));
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
      });
    };

    testTmp = resolve(tmpDir, `run-${process.pid}-${oldDateNow()}`);
    await mkdir(testTmp, { recursive: true });
    [dbStore, audio, spendLogger] = await Promise.all([
      import("../src/db-store.js"),
      import("../src/audio-transcription.js"),
      import("../src/spend-logger.js"),
    ]);
    await dbStore.initDb();

    const wav = Buffer.alloc(44 + 3200);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write("WAVE", 8);
    wav.write("fmt ", 12);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24);
    wav.writeUInt32LE(32000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(wav.length - 44, 40);
    const boundary = `poc-${runId}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="clip.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
      wav,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    request = Readable.from([body]) as Readable & Partial<IncomingMessage>;
    Object.assign(request, {
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": String(body.length),
      },
      socket: { remoteAddress: "127.0.0.1" },
    });
    response = new TestResponse();

    const account = {
      config: { email: "poc@example.invalid", label: "poc-account", refreshToken: "unused" },
      accessToken: "mock-access-token",
      tokenExpires: oldDateNow() + 86_400_000,
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
      getConfig: () => ({ streamRecoveryMaxRetries: 0 }),
      getActiveAccount: async () => account,
      rotateToNext: async () => account,
      finishRequest() {},
      recordUpstreamAttempt() {},
      recordRequest: () => false,
      recordTokenUsage() {},
      markError() {},
      markRateLimited() {},
      markExhausted() {},
      markFlagged() {},
      recordFailure() {},
      recordSuccess() {},
      recordProvider429() {},
      getSafetyJitterMs: () => 0,
      getGlobalDelayMs: () => 0,
      getRetryAfterMs: () => 0,
      getFlagContext: () => ({ timerType: "fresh", accountQuotaPercent: 0, wasProAccount: false, accountRequestsLastHour: 0, poolSize: 1, poolHealthyCount: 1, uptimeSeconds: 0 }),
      recordProxyEvent() {},
      saveState() {},
    };

    const handlerPromise = audio.handleOpenAIAudioTranscriptions(request as IncomingMessage, response as never, rotator as never);
    await Promise.race([firstStarted, handlerPromise.then(() => "finished")]);
    await flushMicrotasks();
    await advance(30_000);

    const completedByFirstDeadline = response.writableEnded;
    if (!completedByFirstDeadline) {
      if (languageServerCalls > 0) await Promise.race([fallbackStarted, flushMicrotasks()]);
      await advance(30_000);
      await handlerPromise;
    } else {
      await handlerPromise;
    }

    assert.equal(
      completedByFirstDeadline,
      true,
      `request exceeded its initial 30000ms deadline: upstreamCalls=${upstreamCalls}, LanguageServer calls=${languageServerCalls}, responseStatus=${response.statusCode}, completedAt=${fakeNow}ms; a second independent fallback timeout was required`,
    );
  } finally {
    if (request && !request.destroyed) request.destroy();
    if (dbStore) {
      await dbStore.closeDb();
    }
    spendLogger?.resetSpendLoggerForTests?.();
    timers.clear();
    if (testTmp) await rm(testTmp, { recursive: true, force: true });
    globalThis.fetch = oldFetch;
    globalThis.setTimeout = oldSetTimeout;
    globalThis.clearTimeout = oldClearTimeout;
    Date.now = oldDateNow;
    PostgresSettingsRepository.prototype.init = oldInit;
    PostgresSettingsRepository.prototype.query = oldQuery;
    PostgresSettingsRepository.prototype.close = oldClose;
    https.request = oldHttpsRequest;
    cp.execSync = oldExecSync;
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
