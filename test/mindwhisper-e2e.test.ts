import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import https from "node:https";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { startProxy } from "../src/proxy.js";
import { stopNotificationPoller } from "../src/notification-poller.js";
import { stopVersionChecker } from "../src/version-check.js";
import { setPersistedAdminToken } from "../src/admin-auth.js";

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
    readonly callback: ((response: FakeResponse) => void) | undefined,
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

  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

function connectFrame(message: unknown, flag = 0): Buffer {
  const payload = Buffer.from(JSON.stringify(message));
  const frame = Buffer.alloc(5 + payload.length);
  frame.writeUInt8(flag, 0);
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

function makeRotator() {
  const state = {
    recordedEvents: [] as string[],
  };

  const rotator = {
    saveState() {},
    getStatus() {
      return {
        accounts: [{ email: "mindwhisper-test@example.com", tier: "pro", active: true }],
        security: { adminTokenConfigured: true },
      };
    },
    getSafetyJitterMs(_account: unknown) {
      return 0;
    },
    getGlobalDelayMs() {
      return 0;
    },
    recordProxyEvent(msg: string) {
      state.recordedEvents.push(msg);
    },
  };

  return { rotator, state };
}

async function closeServer(server: Server): Promise<void> {
  if (typeof (server as any).closeAllConnections === "function") {
    (server as any).closeAllConnections();
  }
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe("MindWhisperAI Live Audio WebSocket E2E (VITE_OPENAI_AUDIO_WS_URL=ws://127.0.0.1:51200/ws)", () => {
  let server: Server | null = null;
  let wsUrl = "";

  beforeEach(async () => {
    process.env.PI_ROTATOR_TELEMETRY = "off";
    setPersistedAdminToken("test-token");
    const { rotator } = makeRotator();
    server = startProxy(rotator as never, 0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    wsUrl = `ws://127.0.0.1:${address.port}/ws`;
  });

  afterEach(async () => {
    setPersistedAdminToken(null);
    stopVersionChecker();
    stopNotificationPoller();
    if (server) {
      await closeServer(server);
      server = null;
    }
  });

  it("replicates MindWhisperAI connection lifecycle: start, streaming audio chunks, receiving transcript, and stop", async () => {
    let streamResponse: FakeResponse | null = null;
    const requestMock = mock.method(
      https,
      "request",
      ((options: Record<string, unknown>, callback?: (response: FakeResponse) => void) => {
        const request = new FakeRequest(options, callback, () => {
          const response = new FakeResponse();
          if (String(options.path).endsWith("/StreamAudioTranscription")) {
            streamResponse = response;
            callback?.(response);
            queueMicrotask(() => {
              response.emit("data", connectFrame({ ready: { sessionId: "session-mw-1" } }));
              response.emit(
                "data",
                connectFrame({ transcription: { text: "Hello", isFinal: false } }),
              );
              response.emit(
                "data",
                connectFrame({ transcription: { text: "Hello MindWhisper world", isFinal: true } }),
              );
            });
          } else if (String(options.path).endsWith("/SendAudioChunk")) {
            callback?.(response);
            queueMicrotask(() => response.emit("end"));
          } else if (String(options.path).endsWith("/EndAudioSession")) {
            callback?.(response);
            queueMicrotask(() => {
              response.emit("end");
              streamResponse?.emit("data", connectFrame({ complete: true }));
              streamResponse?.emit("end");
            });
          }
        });
        return request;
      }) as unknown as typeof https.request,
    );

    try {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";

      const receivedMessages: any[] = [];
      let closeEvent: { code: number; reason: string } | null = null;

      // 1. Wait for connection and initial system_status frame
      const initialMsg = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timeout waiting for initial system_status")), 3000);
        ws.onmessage = (e) => {
          clearTimeout(timer);
          resolve(JSON.parse(e.data.toString()));
        };
        ws.onerror = (err) => {
          clearTimeout(timer);
          reject(err);
        };
      });

      receivedMessages.push(initialMsg);
      assert.equal(initialMsg.type, "system_status");

      // Setup continuous message collector
      ws.onmessage = (e) => {
        receivedMessages.push(JSON.parse(e.data.toString()));
      };
      ws.onclose = (e) => {
        closeEvent = { code: e.code, reason: e.reason };
      };

      // 2. Send start payload exactly as MindWhisperAI LiveTranscriptPanel does
      ws.send(
        JSON.stringify({
          type: "start",
          target: "antigravity",
          antigravityModel: "gemini-3.8-flash-low",
        }),
      );

      // 3. MindWhisperAI sends PCM chunks continuously
      const pcmChunk = Buffer.alloc(3200);
      for (let i = 0; i < 5; i++) {
        ws.send(pcmChunk);
      }

      // 4. Wait for ready_to_receive_audio and antigravity_transcript
      await new Promise<void>((resolve, reject) => {
        const start = Date.now();
        const check = () => {
          const hasTranscript = receivedMessages.some(
            (m) => m.type === "antigravity_transcript" && m.text === "Hello MindWhisper world",
          );
          if (hasTranscript) {
            resolve();
          } else if (Date.now() - start > 5000) {
            reject(
              new Error(
                `Timeout waiting for transcript. Received: ${JSON.stringify(receivedMessages)}`,
              ),
            );
          } else {
            setTimeout(check, 50);
          }
        };
        check();
      });

      // Verify received events
      const types = receivedMessages.map((m) => m.type);
      assert.ok(types.includes("session_starting"), "Should receive session_starting");
      assert.ok(types.includes("antigravity_ready"), "Should receive antigravity_ready");
      assert.ok(types.includes("ready_to_receive_audio"), "Should receive ready_to_receive_audio");

      // Verify transcript content
      const transcripts = receivedMessages.filter((m) => m.type === "antigravity_transcript");
      assert.ok(transcripts.length >= 2, "Should receive interim and final transcripts");
      assert.equal(transcripts[0].text, "Hello");
      assert.equal(transcripts[0].isFinal, false);
      assert.equal(transcripts[1].text, "Hello MindWhisper world");
      assert.equal(transcripts[1].isFinal, true);

      // 5. Stop session as MindWhisperAI does
      ws.send(JSON.stringify({ type: "stop" }));

      // Wait for complete
      await new Promise<void>((resolve, reject) => {
        const start = Date.now();
        const check = () => {
          const hasComplete = receivedMessages.some((m) => m.type === "antigravity_complete");
          if (hasComplete) {
            resolve();
          } else if (Date.now() - start > 5000) {
            reject(
              new Error(
                `Timeout waiting for complete. Received: ${JSON.stringify(receivedMessages)}`,
              ),
            );
          } else {
            setTimeout(check, 50);
          }
        };
        check();
      });

      assert.equal(closeEvent, null, "WebSocket should not be closed prematurely");
      ws.close();
    } finally {
      requestMock.mock.restore();
    }
  });

  it("handles audio chunks sent immediately upon connect before ready (MindWhisperAI onaudioprocess race)", async () => {
    let streamResponse: FakeResponse | null = null;
    const requestMock = mock.method(
      https,
      "request",
      ((options: Record<string, unknown>, callback?: (response: FakeResponse) => void) => {
        const request = new FakeRequest(options, callback, () => {
          const response = new FakeResponse();
          streamResponse = response;
          callback?.(response);
          if (String(options.path).endsWith("/StreamAudioTranscription")) {
            setTimeout(() => {
              response.emit("data", connectFrame({ ready: { sessionId: "session-mw-race" } }));
              response.emit(
                "data",
                connectFrame({ transcription: { text: "race test passed", isFinal: true } }),
              );
              response.emit("data", connectFrame({ complete: true }));
            }, 100);
          } else if (String(options.path).endsWith("/SendAudioChunk")) {
            queueMicrotask(() => response.emit("end"));
          } else if (String(options.path).endsWith("/EndAudioSession")) {
            queueMicrotask(() => {
              response.emit("end");
              streamResponse?.emit("end");
            });
          }
        });
        return request;
      }) as unknown as typeof https.request,
    );

    try {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      const receivedMessages: any[] = [];
      let closeEvent: { code: number; reason: string } | null = null;

      // Wait for initial message
      const initial = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timeout initial frame")), 3000);
        ws.onmessage = (e) => {
          clearTimeout(timer);
          resolve(JSON.parse(e.data.toString()));
        };
        ws.onerror = (err) => {
          clearTimeout(timer);
          reject(err);
        };
      });
      receivedMessages.push(initial);

      ws.onmessage = (e) => {
        receivedMessages.push(JSON.parse(e.data.toString()));
      };
      ws.onclose = (e) => {
        closeEvent = { code: e.code, reason: e.reason };
      };

      // Send start and IMMEDIATELY send audio chunks before ready arrives
      ws.send(
        JSON.stringify({
          type: "start",
          target: "antigravity",
          antigravityModel: "gemini-3.8-flash-low",
        }),
      );

      const chunk = Buffer.alloc(1600);
      for (let i = 0; i < 10; i++) {
        ws.send(chunk);
      }

      // Wait for transcript
      await new Promise<void>((resolve, reject) => {
        const start = Date.now();
        const check = () => {
          if (receivedMessages.some((m) => m.type === "antigravity_transcript")) {
            resolve();
          } else if (closeEvent) {
            reject(new Error(`WebSocket closed unexpectedly: ${closeEvent.code} ${closeEvent.reason}`));
          } else if (Date.now() - start > 5000) {
            reject(new Error("Timeout waiting for transcript in race condition test"));
          } else {
            setTimeout(check, 50);
          }
        };
        check();
      });

      assert.equal(closeEvent, null, "WebSocket should not be closed with 1009/1011 during initial audio burst");
      ws.close();
    } finally {
      requestMock.mock.restore();
    }
  });

  it("reports Language Server failure cleanly via antigravity_error without unhandled rejections", async () => {
    const requestMock = mock.method(
      https,
      "request",
      ((options: Record<string, unknown>, callback?: (response: FakeResponse) => void) => {
        const request = new FakeRequest(options, callback, () => {
          const response = new FakeResponse(500);
          callback?.(response);
          queueMicrotask(() => response.emit("end"));
        });
        return request;
      }) as unknown as typeof https.request,
    );

    try {
      const ws = new WebSocket(wsUrl);
      const receivedMessages: any[] = [];

      // Wait for initial message
      const initial = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timeout initial frame")), 3000);
        ws.onmessage = (e) => {
          clearTimeout(timer);
          resolve(JSON.parse(e.data.toString()));
        };
        ws.onerror = (err) => {
          clearTimeout(timer);
          reject(err);
        };
      });
      receivedMessages.push(initial);

      ws.onmessage = (e) => {
        receivedMessages.push(JSON.parse(e.data.toString()));
      };

      ws.send(
        JSON.stringify({
          type: "start",
          target: "antigravity",
          antigravityModel: "gemini-3.8-flash-low",
        }),
      );

      await new Promise<void>((resolve, reject) => {
        const start = Date.now();
        const check = () => {
          const hasError = receivedMessages.some((m) => m.type === "antigravity_error");
          if (hasError) {
            resolve();
          } else if (Date.now() - start > 5000) {
            reject(new Error("Timeout waiting for antigravity_error"));
          } else {
            setTimeout(check, 50);
          }
        };
        check();
      });

      const err = receivedMessages.find((m) => m.type === "antigravity_error");
      assert.ok(err, "Should receive antigravity_error");
      assert.match(err.message, /500/);
      ws.close();
    } finally {
      requestMock.mock.restore();
    }
  });
});

describe("MindWhisperAI Live Audio with Rotator Native Session (Opción 1)", () => {
  let server: Server | null = null;
  let wsUrl = "";

  function makeActiveRotator() {
    const account = {
      config: {
        email: "rotator-test@example.com",
        label: "rotator-test",
        refreshToken: "mock-refresh-token",
      },
      accessToken: "mock-access-token",
      tokenExpires: Date.now() + 86400000,
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
      saveState() {},
      getStatus() {
        return {
          accounts: [{ email: "rotator-test@example.com", tier: "pro", active: true }],
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
    return rotator;
  }

  beforeEach(async () => {
    process.env.PI_ROTATOR_TELEMETRY = "off";
    setPersistedAdminToken("test-token");
    const rotator = makeActiveRotator();
    server = startProxy(rotator as never, 0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    wsUrl = `ws://127.0.0.1:${address.port}/ws`;
  });

  afterEach(async () => {
    setPersistedAdminToken(null);
    stopVersionChecker();
    stopNotificationPoller();
    if (server) {
      await closeServer(server);
      server = null;
    }
  });

  it("completes full streaming lifecycle natively using rotator without language_server", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = mock.fn(async (input: any, init?: any) => {
      const urlStr = String(input);
      if (urlStr.includes("streamGenerateContent")) {
        const sseBody = `data: {"candidates":[{"content":{"parts":[{"text":"Hello from rotator multimodal transcription"}]},"finishReason":"STOP"}]}\n\n`;
        return new Response(sseBody, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return originalFetch(input, init);
    });
    globalThis.fetch = fetchMock as any;

    try {
      const ws = new WebSocket(wsUrl);
      const receivedMessages: any[] = [];
      let closedPrematurely = false;

      ws.onclose = (e) => {
        if (e.code === 1011) closedPrematurely = true;
      };

      // 1. Initial message
      const initial = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timeout waiting for initial message")), 3000);
        ws.onmessage = (e) => {
          clearTimeout(timer);
          resolve(JSON.parse(e.data.toString()));
        };
        ws.onerror = (err) => {
          clearTimeout(timer);
          reject(err);
        };
      });
      receivedMessages.push(initial);
      assert.equal(initial.type, "system_status");

      ws.onmessage = (e) => {
        receivedMessages.push(JSON.parse(e.data.toString()));
      };

      // 2. Send start
      ws.send(
        JSON.stringify({
          type: "start",
          target: "antigravity",
          antigravityModel: "gemini-2.5-flash",
        }),
      );

      // Wait for ready_to_receive_audio
      await new Promise<void>((resolve, reject) => {
        const start = Date.now();
        const check = () => {
          if (receivedMessages.some((m) => m.type === "ready_to_receive_audio")) {
            resolve();
          } else if (Date.now() - start > 4000) {
            reject(new Error("Timeout waiting for ready_to_receive_audio"));
          } else {
            setTimeout(check, 50);
          }
        };
        check();
      });

      // 3. Send audio PCM chunks (voiced speech tone ~500 RMS)
      const pcmChunk = Buffer.alloc(3200);
      for (let j = 0; j < 1600; j++) {
        pcmChunk.writeInt16LE(Math.round(1500 * Math.sin(j * 0.1)), j * 2);
      }
      for (let i = 0; i < 5; i++) {
        ws.send(pcmChunk);
      }

      // 4. Send stop
      ws.send(JSON.stringify({ type: "stop" }));

      // 5. Wait for antigravity_transcript and antigravity_complete
      await new Promise<void>((resolve, reject) => {
        const start = Date.now();
        const check = () => {
          const hasTranscript = receivedMessages.some(
            (m) =>
              m.type === "antigravity_transcript" &&
              m.text.includes("Hello from rotator multimodal transcription"),
          );
          const hasComplete = receivedMessages.some((m) => m.type === "antigravity_complete");
          if (hasTranscript && hasComplete) {
            resolve();
          } else if (Date.now() - start > 5000) {
            reject(
              new Error(
                `Timeout waiting for transcript/complete. Messages: ${JSON.stringify(receivedMessages)}`,
              ),
            );
          } else {
            setTimeout(check, 50);
          }
        };
        check();
      });

      assert.equal(closedPrematurely, false, "Should not close socket with 1011");
      const types = receivedMessages.map((m) => m.type);
      assert.ok(types.includes("session_starting"));
      assert.ok(types.includes("antigravity_ready"));
      assert.ok(types.includes("ready_to_receive_audio"));
      assert.ok(types.includes("audio_stopped"));
      assert.ok(types.includes("antigravity_transcript"));
      assert.ok(types.includes("antigravity_complete"));
      ws.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

