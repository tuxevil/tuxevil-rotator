import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { resolve } from "node:path";
import { test } from "node:test";
import https from "node:https";
import cp from "node:child_process";
import { PostgresSettingsRepository } from "../src/settings-repository.js";
import type { QueryResultRow } from "pg";
import type { IncomingMessage, ClientRequest } from "node:http";

const tmpRoot = resolve(
  ".tmp_audit_poc/de6200e0-2b09-4f4a-b31d-7264d927889c/verificador/ceb5d79d8b21eb32c9af96ea05f7d0e4",
);

test("audio request completes within its original 30-second deadline after a late reset", async () => {
  const oldEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    TUXEVIL_ROTATOR_DATABASE_URL: process.env.TUXEVIL_ROTATOR_DATABASE_URL,
    TUXEVIL_ROTATOR_DIR: process.env.TUXEVIL_ROTATOR_DIR,
    PI_ROTATOR_DIR: process.env.PI_ROTATOR_DIR,
  };
  const oldFetch = globalThis.fetch;
  const oldHttpsRequest = https.request;
  const oldExecSync = cp.execSync;
  const oldDbInit = PostgresSettingsRepository.prototype.init;
  const oldDbQuery = PostgresSettingsRepository.prototype.query;
  const oldDbClose = PostgresSettingsRepository.prototype.close;
  const oldSetTimeout = globalThis.setTimeout;
  const oldClearTimeout = globalThis.clearTimeout;
  const oldDateNow = Date.now;
  const runtimeDir = resolve(tmpRoot, `run-${process.pid}-${oldDateNow()}`);
  let fakeNow = 0;
  let nextTimerId = 1;
  const timers = new Map<number, { id: number; due: number; callback: (...args: unknown[]) => void; args: unknown[] }>();
  let upstreamCalls = 0;
  let fallbackCalls = 0;
  let fallbackStartedAt: number | null = null;
  let activityResolve!: () => void;
  const firstActivity = new Promise<void>((resolveActivity) => (activityResolve = resolveActivity));
  let fallbackResolve!: () => void;
  const fallbackStarted = new Promise<void>((resolveFallback) => (fallbackResolve = resolveFallback));
  let responseResolve!: () => void;
  const responseFinished = new Promise<void>((resolveResponse) => (responseResolve = resolveResponse));
  let rejectUpstream!: (error: Error) => void;
  let activity: "upstream" | "fallback" | null = null;
  let responseEndedAt: number | null = null;
  let dbStore: typeof import("../src/db-store.js") | undefined;
  let spendLogger: typeof import("../src/spend-logger.js") | undefined;
  let request: (Readable & Partial<IncomingMessage>) | undefined;
  type FakeResponse = EventEmitter & {
    writableEnded: boolean;
    destroyed: boolean;
    statusCode?: number;
    body?: string;
    writeHead(statusCode: number): unknown;
    end(body?: string): unknown;
  };
  let response: FakeResponse | undefined;

  class PendingRequest extends EventEmitter {
    destroyed = false;
    path?: string;
    write() { return true; }
    end() { return this; }
    setTimeout() { return this; }
    destroy() { this.destroyed = true; return this; }
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
    for (let i = 0; i < 60; i++) await Promise.resolve();
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
    delete process.env.TUXEVIL_ROTATOR_DATABASE_URL;
    process.env.TUXEVIL_ROTATOR_DIR = resolve(runtimeDir, "config");
    delete process.env.PI_ROTATOR_DIR;
    await mkdir(runtimeDir, { recursive: true });

    PostgresSettingsRepository.prototype.init = async function () {};
    PostgresSettingsRepository.prototype.query = async function <R extends QueryResultRow>(sql: string) {
      return { rows: (sql.includes("COUNT(*)") ? [{ count: "0" }] : []) as unknown as R[], command: "SELECT", rowCount: 0, oid: 0, fields: [] };
    };
    PostgresSettingsRepository.prototype.close = async function () {};
    [dbStore, spendLogger] = await Promise.all([
      import("../src/db-store.js"),
      import("../src/spend-logger.js"),
    ]);
    await dbStore.initDb();
    const audio = await import("../src/audio-transcription.js");

    globalThis.setTimeout = fakeSetTimeout as unknown as typeof setTimeout;
    globalThis.clearTimeout = fakeClearTimeout as unknown as typeof clearTimeout;
    Date.now = () => oldDateNow() + fakeNow;
    cp.execSync = (() => { throw new Error("Language Server discovery disabled by PoC"); }) as typeof cp.execSync;

    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamCalls++;
      activity = "upstream";
      activityResolve();
      return new Promise<Response>((_resolveResponse, reject) => {
        rejectUpstream = reject;
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason ?? new Error("aborted"));
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
      });
    }) as typeof globalThis.fetch;

    https.request = ((options: string | URL | import("node:https").RequestOptions) => {
      fallbackCalls++;
      fallbackStartedAt = fakeNow;
      activity ??= "fallback";
      activityResolve();
      fallbackResolve();
      const pending = new PendingRequest();
      const requestOptions = typeof options === "object" && !(options instanceof URL) ? options : undefined;
      pending.path = requestOptions?.path as string | undefined;
      return pending as unknown as ClientRequest;
    }) as typeof https.request;

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
    const boundary = "poc-audio-timeout";
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
    response = Object.assign(new EventEmitter(), {
      writableEnded: false,
      destroyed: false,
      statusCode: undefined as number | undefined,
      body: undefined as string | undefined,
      writeHead(statusCode: number) {
        this.statusCode = statusCode;
        return this;
      },
      end(bodyText = "") {
        this.body = String(bodyText);
        this.writableEnded = true;
        responseEndedAt = fakeNow;
        responseResolve();
        (this as unknown as EventEmitter).emit("close");
        return this;
      },
    }) as EventEmitter & {
      writableEnded: boolean;
      destroyed: boolean;
      statusCode?: number;
      body?: string;
      writeHead(statusCode: number): unknown;
      end(bodyText?: string): unknown;
    };

    const account = {
      config: { email: "poc@example.invalid", label: "poc-account", provider: "google-antigravity", projectId: "poc-project" },
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

    const testResponse = response;
    const handlerPromise = audio.handleOpenAIAudioTranscriptions(
      request as IncomingMessage,
      testResponse as never,
      rotator as never,
    );
    await firstActivity;
    await flushMicrotasks();

    if (upstreamCalls > 0) {
      await advance(29_999);
      const resetCause = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      rejectUpstream(new TypeError("fetch failed", { cause: resetCause }));
      await Promise.race([fallbackStarted, responseFinished]);
      await flushMicrotasks();
      if (fallbackCalls > 0) {
        assert.equal(fallbackCalls, 1, "transport reset entered the Language Server fallback more than once");
        assert.equal(fallbackStartedAt, 29_999, "fallback did not start immediately after the upstream transport reset");
      }
      await advance(1);
      const completedByOriginalDeadline = testResponse.writableEnded;
      if (!completedByOriginalDeadline) {
        await advance(29_999);
      }
      await handlerPromise;
      assert.equal(
        completedByOriginalDeadline,
        true,
        `request exceeded the original 30000ms deadline after upstream ECONNRESET at t=29999ms; fallback ended at t=${responseEndedAt}ms`,
      );
      assert.ok(responseEndedAt !== null && responseEndedAt <= 30_000, `response ended at t=${responseEndedAt}ms instead of the original deadline`);
    } else {
      await advance(30_000);
      await handlerPromise;
      assert.equal(testResponse.writableEnded, true, "baseline Language Server request did not finish at its own 30-second deadline");
      assert.equal(responseEndedAt, 30_000, "baseline request did not end at the Language Server's 30-second deadline");
    }
  } finally {
    request?.destroy();
    dbStore?.closeDb && await dbStore.closeDb();
    spendLogger?.resetSpendLoggerForTests?.();
    timers.clear();
    await rm(runtimeDir, { recursive: true, force: true });
    globalThis.fetch = oldFetch;
    globalThis.setTimeout = oldSetTimeout;
    globalThis.clearTimeout = oldClearTimeout;
    Date.now = oldDateNow;
    https.request = oldHttpsRequest;
    cp.execSync = oldExecSync;
    PostgresSettingsRepository.prototype.init = oldDbInit;
    PostgresSettingsRepository.prototype.query = oldDbQuery;
    PostgresSettingsRepository.prototype.close = oldDbClose;
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
