import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { describe, it, mock } from "node:test";
import { applyModelAlias } from "../src/types.js";
import { buildOpenAIModelCatalog } from "../src/compat.js";
import {
  AntigravityAudioSession,
  handleOpenAIAudioTranscriptions,
  transcribeAudioWithAntigravity,
} from "../src/audio-transcription.js";

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

function connectFrame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message));
  const frame = Buffer.alloc(5 + payload.length);
  frame.writeUInt8(0, 0);
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

function mockSuccessfulLanguageServer(): {
  requests: FakeRequest[];
  restore: () => void;
} {
  const requests: FakeRequest[] = [];
  const requestMock = mock.method(
    https,
    "request",
    ((options: Record<string, unknown>, callback?: (response: FakeResponse) => void) => {
      const request = new FakeRequest(options, callback, () => {
        const response = new FakeResponse();
        callback?.(response);
        if (String(options.path).endsWith("/StreamAudioTranscription")) {
          queueMicrotask(() => {
            response.emit("data", connectFrame({ ready: { sessionId: "session-1" } }));
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

function makeWav(seconds: number): Buffer {
  const byteRate = 32_000;
  const dataLength = Math.round(seconds * byteRate);
  const wav = Buffer.alloc(44 + dataLength);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataLength, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataLength, 40);
  return wav;
}

async function listenServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: ReturnType<typeof createServer>; url: string; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Server did not bind to a TCP port");
  }
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
  };
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe("models/proactive-observer-v10 audio transcription support", () => {
  it("translates whisper-1 and proactive-observer aliases to models/proactive-observer-v10", () => {
    assert.equal(applyModelAlias("whisper-1"), "models/proactive-observer-v10");
    assert.equal(applyModelAlias("proactive-observer"), "models/proactive-observer-v10");
    assert.equal(applyModelAlias("proactive-observer-v10"), "models/proactive-observer-v10");
    assert.equal(applyModelAlias("models/proactive-observer-v10"), "models/proactive-observer-v10");
  });

  it("includes models/proactive-observer-v10 and whisper-1 in OpenAI model catalog", () => {
    const catalog = buildOpenAIModelCatalog();
    const proactive = catalog.find((m) => m.id === "models/proactive-observer-v10");
    const whisper = catalog.find((m) => m.id === "whisper-1");

    assert.ok(proactive, "models/proactive-observer-v10 should exist in OpenAI catalog");
    assert.equal(proactive.meta.family, "proactive-observer");

    assert.ok(whisper, "whisper-1 should exist in OpenAI catalog");
    assert.equal(whisper.meta.family, "proactive-observer");
  });

  it("rejects non-multipart requests with 400 Bad Request", async () => {
    const { server, url } = await listenServer((req, res) => {
      handleOpenAIAudioTranscriptions(req, res).catch((err) => {
        res.writeHead(500);
        res.end(err.message);
      });
    });

    try {
      const resp = await fetch(`${url}/v1/audio/transcriptions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "whisper-1" }),
      });

      assert.equal(resp.status, 400);
      const data = (await resp.json()) as { error: { message: string } };
      assert.match(data.error.message, /multipart\/form-data/i);
    } finally {
      await closeServer(server);
    }
  });

  it("rejects multipart requests missing the file field with 400 Bad Request", async () => {
    const { server, url } = await listenServer((req, res) => {
      handleOpenAIAudioTranscriptions(req, res).catch((err) => {
        res.writeHead(500);
        res.end(err.message);
      });
    });

    try {
      const formData = new FormData();
      formData.append("model", "whisper-1");

      const resp = await fetch(`${url}/v1/audio/transcriptions`, {
        method: "POST",
        body: formData,
      });

      assert.equal(resp.status, 400);
      const data = (await resp.json()) as { error: { message: string; param: string } };
      assert.match(data.error.message, /Missing required 'file'/i);
      assert.equal(data.error.param, "file");
    } finally {
      await closeServer(server);
    }
  });

  it("successfully transcribes audio file via POST /v1/audio/transcriptions (default json format)", {
    skip: !fs.existsSync("/tmp/test_hello.wav"),
  }, async () => {
    const { server, url } = await listenServer((req, res) => {
      handleOpenAIAudioTranscriptions(req, res).catch((err) => {
        res.writeHead(500);
        res.end(err.message);
      });
    });

    try {
      const fileBytes = fs.readFileSync("/tmp/test_hello.wav");
      const file = new File([fileBytes], "test_hello.wav", { type: "audio/wav" });

      const formData = new FormData();
      formData.append("file", file);
      formData.append("model", "whisper-1");

      const resp = await fetch(`${url}/v1/audio/transcriptions`, {
        method: "POST",
        body: formData,
      });

      assert.equal(resp.status, 200);
      const data = (await resp.json()) as { text: string };
      assert.equal(typeof data.text, "string");
    } finally {
      await closeServer(server);
    }
  });

  it("successfully transcribes audio with response_format: 'text'", {
    skip: !fs.existsSync("/tmp/test_hello.wav"),
  }, async () => {
    const { server, url } = await listenServer((req, res) => {
      handleOpenAIAudioTranscriptions(req, res).catch((err) => {
        res.writeHead(500);
        res.end(err.message);
      });
    });

    try {
      const fileBytes = fs.readFileSync("/tmp/test_hello.wav");
      const file = new File([fileBytes], "test_hello.wav", { type: "audio/wav" });

      const formData = new FormData();
      formData.append("file", file);
      formData.append("model", "models/proactive-observer-v10");
      formData.append("response_format", "text");

      const resp = await fetch(`${url}/v1/audio/transcriptions`, {
        method: "POST",
        body: formData,
      });

      assert.equal(resp.status, 200);
      const text = await resp.text();
      assert.equal(typeof text, "string");
    } finally {
      await closeServer(server);
    }
  });

  it("upgrades WebSocket connection and sends system_status frame", async () => {
    const { handleAudioWebSocket } = await import("../src/audio-transcription.js");
    const { server, port } = await listenServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    server.on("upgrade", (req, socket) => {
      handleAudioWebSocket(req, socket);
    });

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const msg = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timeout waiting for WS message")), 3000);
        ws.onmessage = (event) => {
          clearTimeout(timer);
          try {
            resolve(JSON.parse(event.data.toString()));
          } catch (e) {
            reject(e);
          }
        };
        ws.onerror = (err) => {
          clearTimeout(timer);
          reject(err);
        };
      });

      assert.equal(msg.type, "system_status");
      assert.ok(msg.antigravity);
      ws.close();
    } finally {
      await closeServer(server);
    }
  });

  it("resolves audio mime types by extension and handles fallbacks", async () => {
    const { resolveMimeType } = await import("../src/audio-transcription.js");
    assert.equal(resolveMimeType("sample.wav"), "audio/wav");
    assert.equal(resolveMimeType("sample.WAV"), "audio/wav");
    assert.equal(resolveMimeType("recording.mp3"), "audio/mp3");
    assert.equal(resolveMimeType("clip.m4a"), "audio/m4a");
    assert.equal(resolveMimeType("stream.webm"), "audio/webm;codecs=opus");
    assert.equal(resolveMimeType("voice.ogg"), "audio/ogg");
    assert.equal(resolveMimeType("track.flac"), "audio/flac");
    assert.equal(resolveMimeType("raw.pcm"), "audio/pcm;rate=16000");
    assert.equal(resolveMimeType("unknown.xyz"), "audio/wav");
    // Explicit mimeType parameter takes priority if starting with audio/
    assert.equal(resolveMimeType("sample.bin", "audio/opus"), "audio/opus");
    assert.equal(resolveMimeType("sample.wav", "application/octet-stream"), "audio/wav");
  });

  it("getAntigravityCredentials returns valid port and csrf token", async () => {
    const { getAntigravityCredentials } = await import("../src/audio-transcription.js");
    const creds1 = getAntigravityCredentials();
    assert.ok(creds1);
    assert.equal(typeof creds1.port, "number");
    assert.ok(creds1.port > 0);
    assert.equal(typeof creds1.csrf, "string");
    assert.ok(creds1.csrf.length > 0);

    // Caching check
    const creds2 = getAntigravityCredentials();
    assert.deepEqual(creds1, creds2);
  });

  it("forwards the optional language hint to the Language Server", async () => {
    const languageServer = mockSuccessfulLanguageServer();
    try {
      assert.equal(
        await transcribeAudioWithAntigravity(Buffer.alloc(0), { language: "fr" } as never),
        "hello",
      );
      const frame = Buffer.concat(languageServer.requests[0].chunks);
      const payload = JSON.parse(frame.subarray(5).toString("utf8")) as Record<string, unknown>;
      assert.equal(payload.language, "fr");
    } finally {
      languageServer.restore();
    }
  });

  it("handles concurrent stream and EndAudioSession transport failures", async () => {
    const requests: FakeRequest[] = [];
    let streamResponse: FakeResponse | null = null;
    const requestMock = mock.method(
      https,
      "request",
      ((options: Record<string, unknown>, callback?: (response: FakeResponse) => void) => {
        const request = new FakeRequest(options, callback, () => {
          if (String(options.path).endsWith("/StreamAudioTranscription")) {
            const response = new FakeResponse();
            streamResponse = response;
            callback?.(response);
            queueMicrotask(() => {
              response.emit("data", connectFrame({ ready: { sessionId: "session-end-error" } }));
            });
          } else if (String(options.path).endsWith("/EndAudioSession")) {
            queueMicrotask(() => streamResponse?.emit("error", new Error("stream ECONNRESET")));
            queueMicrotask(() => request.emit("error", new Error("connect ECONNREFUSED")));
          }
        });
        requests.push(request);
        return request;
      }) as unknown as typeof https.request,
    );

    try {
      await assert.rejects(
        transcribeAudioWithAntigravity(Buffer.alloc(0)),
        /ECONNRESET|ECONNREFUSED/,
      );
      assert.equal(requests[0].destroyed, true);
    } finally {
      requestMock.mock.restore();
    }
  });

  it("does not let stream end mask a pending EndAudioSession failure", async () => {
    const requests: FakeRequest[] = [];
    let streamResponse: FakeResponse | null = null;
    const requestMock = mock.method(
      https,
      "request",
      ((options: Record<string, unknown>, callback?: (response: FakeResponse) => void) => {
        const request = new FakeRequest(options, callback, () => {
          if (String(options.path).endsWith("/StreamAudioTranscription")) {
            const response = new FakeResponse();
            streamResponse = response;
            callback?.(response);
            queueMicrotask(() => {
              response.emit("data", connectFrame({ ready: { sessionId: "session-end-race" } }));
            });
          } else if (String(options.path).endsWith("/EndAudioSession")) {
            queueMicrotask(() => streamResponse?.emit("end"));
            queueMicrotask(() => request.emit("error", new Error("connect ECONNREFUSED")));
          }
        });
        requests.push(request);
        return request;
      }) as unknown as typeof https.request,
    );

    try {
      await assert.rejects(transcribeAudioWithAntigravity(Buffer.alloc(0)), /ECONNREFUSED/);
      assert.equal(requests[0].destroyed, true);
    } finally {
      requestMock.mock.restore();
    }
  });

  it("treats a SendAudioChunk response error as best-effort completion", async () => {
    let streamResponse: FakeResponse | null = null;
    let chunkResponse: FakeResponse | null = null;
    const requestMock = mock.method(
      https,
      "request",
      ((options: Record<string, unknown>, callback?: (response: FakeResponse) => void) =>
        new FakeRequest(options, callback, () => {
          if (String(options.path).endsWith("/StreamAudioTranscription")) {
            const response = new FakeResponse();
            streamResponse = response;
            callback?.(response);
            queueMicrotask(() => {
              response.emit("data", connectFrame({ ready: { sessionId: "session-chunk-error" } }));
              response.emit("data", connectFrame({ transcription: { text: "hello", isFinal: true } }));
            });
          } else if (String(options.path).endsWith("/SendAudioChunk")) {
            chunkResponse = new FakeResponse();
            callback?.(chunkResponse);
          } else if (String(options.path).endsWith("/EndAudioSession")) {
            const response = new FakeResponse();
            callback?.(response);
            queueMicrotask(() => {
              response.emit("end");
              streamResponse?.emit("data", connectFrame({ complete: true }));
            });
          }
        })) as unknown as typeof https.request,
    );
    const transcription = transcribeAudioWithAntigravity(Buffer.alloc(1));
    void transcription.catch(() => {});

    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.ok(chunkResponse);
      assert.doesNotThrow(() => chunkResponse?.emit("error", new Error("chunk ECONNRESET")));
      assert.equal(await transcription, "hello");
    } finally {
      (streamResponse as FakeResponse | null)?.emit("error", new Error("test cleanup"));
      requestMock.mock.restore();
    }
  });

  it("cancels a hanging audio chunk on transcription timeout without starting finalization", async () => {
    const requests: FakeRequest[] = [];
    let chunkRequest: FakeRequest | null = null;
    const requestMock = mock.method(
      https,
      "request",
      ((options: Record<string, unknown>, callback?: (response: FakeResponse) => void) => {
        const request = new FakeRequest(options, callback, () => {
          if (String(options.path).endsWith("/StreamAudioTranscription")) {
            const response = new FakeResponse();
            callback?.(response);
            queueMicrotask(() => response.emit("data", connectFrame({ ready: { sessionId: "timeout-chunk" } })));
          } else if (String(options.path).endsWith("/SendAudioChunk")) {
            chunkRequest = request;
          }
        });
        requests.push(request);
        return request;
      }) as unknown as typeof https.request,
    );
    mock.timers.enable({ apis: ["setTimeout"] });

    try {
      const transcription = transcribeAudioWithAntigravity(Buffer.alloc(1));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.ok(chunkRequest);

      mock.timers.tick(30_000);
      assert.equal(await transcription, "");
      assert.equal((chunkRequest as FakeRequest | null)?.destroyed, true);
      (chunkRequest as FakeRequest | null)?.emit("error", new Error("late chunk cancellation"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        requests.some((request) => String(request.options.path).endsWith("/EndAudioSession")),
        false,
      );
    } finally {
      mock.timers.reset();
      requestMock.mock.restore();
    }
  });

  it("stops later chunks and finalization when a chunk request times out", async () => {
    const requests: FakeRequest[] = [];
    let firstChunk: FakeRequest | null = null;
    const requestMock = mock.method(
      https,
      "request",
      ((options: Record<string, unknown>, callback?: (response: FakeResponse) => void) => {
        const request = new FakeRequest(options, callback, () => {
          if (String(options.path).endsWith("/StreamAudioTranscription")) {
            const response = new FakeResponse();
            callback?.(response);
            queueMicrotask(() => response.emit("data", connectFrame({ ready: { sessionId: "chunk-deadline" } })));
          } else if (String(options.path).endsWith("/SendAudioChunk") && firstChunk === null) {
            firstChunk = request;
          }
        });
        requests.push(request);
        return request;
      }) as unknown as typeof https.request,
    );
    mock.timers.enable({ apis: ["setTimeout"] });
    let transcription: Promise<string> | null = null;

    try {
      transcription = transcribeAudioWithAntigravity(Buffer.alloc(3201));
      void transcription.catch(() => {});
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.ok(firstChunk);
      assert.ok((firstChunk as FakeRequest | null)?.timeoutCallback);

      (firstChunk as FakeRequest | null)?.timeoutCallback?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        requests.filter((request) => String(request.options.path).endsWith("/SendAudioChunk")).length,
        1,
      );
      assert.equal(
        requests.some((request) => String(request.options.path).endsWith("/EndAudioSession")),
        false,
      );
      await assert.rejects(transcription, /SendAudioChunk timed out/);
    } finally {
      mock.timers.tick(30_000);
      await transcription?.catch(() => {});
      mock.timers.reset();
      requestMock.mock.restore();
    }
  });

  it("cancels a hanging EndAudioSession request on transcription timeout", async () => {
    const requests: FakeRequest[] = [];
    let endRequest: FakeRequest | null = null;
    const requestMock = mock.method(
      https,
      "request",
      ((options: Record<string, unknown>, callback?: (response: FakeResponse) => void) => {
        const request = new FakeRequest(options, callback, () => {
          if (String(options.path).endsWith("/StreamAudioTranscription")) {
            const response = new FakeResponse();
            callback?.(response);
            queueMicrotask(() => response.emit("data", connectFrame({ ready: { sessionId: "timeout-end" } })));
          } else if (String(options.path).endsWith("/EndAudioSession")) {
            endRequest = request;
          }
        });
        requests.push(request);
        return request;
      }) as unknown as typeof https.request,
    );
    mock.timers.enable({ apis: ["setTimeout"] });

    try {
      const transcription = transcribeAudioWithAntigravity(Buffer.alloc(0));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.ok(endRequest);

      mock.timers.tick(30_000);
      assert.equal(await transcription, "");
      assert.equal((endRequest as FakeRequest | null)?.destroyed, true);
    } finally {
      mock.timers.reset();
      requestMock.mock.restore();
    }
  });

  it("reports verbose metadata only when supplied or derivable from WAV data", async () => {
    const languageServer = mockSuccessfulLanguageServer();
    const { server, url } = await listenServer((req, res) => {
      handleOpenAIAudioTranscriptions(req, res).catch((err) => {
        res.writeHead(500);
        res.end(err.message);
      });
    });

    try {
      const transcribe = async (bytes: Buffer, name: string, type: string, language?: string) => {
        const formData = new FormData();
        formData.append("file", new File([Uint8Array.from(bytes).buffer], name, { type }));
        formData.append("response_format", "verbose_json");
        if (language) formData.append("language", language);
        const response = await fetch(`${url}/v1/audio/transcriptions`, {
          method: "POST",
          body: formData,
        });
        assert.equal(response.status, 200);
        return response.json() as Promise<Record<string, unknown>>;
      };

      const compressed = await transcribe(Buffer.from("not-real-mp3"), "sample.mp3", "audio/mpeg");
      assert.equal("language" in compressed, false);
      assert.equal("duration" in compressed, false);

      const wav = await transcribe(makeWav(1), "sample.wav", "audio/wav", "en");
      assert.equal(wav.language, "en");
      assert.equal(wav.duration, 1);
    } finally {
      languageServer.restore();
      await closeServer(server);
    }
  });

  it("rejects a non-ready Language Server start and never accepts queued audio", async () => {
    const requests: FakeRequest[] = [];
    let streamResponse!: FakeResponse;
    const requestMock = mock.method(
      https,
      "request",
      ((options: Record<string, unknown>, callback?: (response: FakeResponse) => void) => {
        const request = new FakeRequest(options, callback, () => {
          streamResponse = new FakeResponse(503);
          callback?.(streamResponse);
        });
        requests.push(request);
        return request;
      }) as unknown as typeof https.request,
    );
    const session = new AntigravityAudioSession({ port: 1, csrf: "test" });

    try {
      await assert.rejects(session.start(), /status: 503/);
      assert.doesNotThrow(() => streamResponse.emit("error", new Error("stream ECONNRESET")));
      assert.equal((session as unknown as { sendChunk: (chunk: Buffer) => boolean }).sendChunk(Buffer.alloc(1)), false);
      assert.equal(requests[0].destroyed, true);
    } finally {
      session.destroy();
      requestMock.mock.restore();
    }
  });

  it("times out a Language Server start and destroy clears pending audio", async () => {
    const requests: FakeRequest[] = [];
    const requestMock = mock.method(
      https,
      "request",
      ((options: Record<string, unknown>, callback?: (response: FakeResponse) => void) => {
        const request = new FakeRequest(options, callback, () => {});
        requests.push(request);
        return request;
      }) as unknown as typeof https.request,
    );
    const session = new AntigravityAudioSession(
      { port: 1, csrf: "test" },
      { startTimeoutMs: 20 } as never,
    );
    const start = session.start();
    session.sendChunk(Buffer.alloc(32));

    try {
      await assert.rejects(
        Promise.race([
          start,
          new Promise((_, reject) => setTimeout(() => reject(new Error("start remained pending")), 100)),
        ]),
        /timed out/i,
      );
      assert.equal((session as unknown as { queue: Buffer[] }).queue.length, 0);
      assert.equal(requests[0].destroyed, true);
    } finally {
      session.destroy();
      (session as unknown as { sessionId: string | null }).sessionId = "release-old-loop";
      await new Promise((resolve) => setTimeout(resolve, 30));
      requestMock.mock.restore();
    }
  });

  it("destroy cancels an in-flight unary audio request", async () => {
    const requests: FakeRequest[] = [];
    const requestMock = mock.method(
      https,
      "request",
      ((options: Record<string, unknown>, callback?: (response: FakeResponse) => void) => {
        const request = new FakeRequest(options, callback, () => {
          if (String(options.path).endsWith("/StreamAudioTranscription")) {
            const response = new FakeResponse();
            callback?.(response);
            queueMicrotask(() => {
              response.emit("data", connectFrame({ ready: { sessionId: "session-unary" } }));
            });
          }
        });
        requests.push(request);
        return request;
      }) as unknown as typeof https.request,
    );
    const session = new AntigravityAudioSession({ port: 1, csrf: "test" });

    try {
      await session.start();
      assert.equal(session.sendChunk(Buffer.alloc(32)), true);
      while (requests.length < 2) await new Promise((resolve) => setTimeout(resolve, 1));
      session.destroy();
      assert.equal(requests[1].destroyed, true);
    } finally {
      session.destroy();
      requestMock.mock.restore();
    }
  });

  it("terminalizes a live session when SendAudioChunk stops responding", async () => {
    const requests: FakeRequest[] = [];
    let chunkResponse: FakeResponse | null = null;
    const errors: Error[] = [];
    const requestMock = mock.method(
      https,
      "request",
      ((options: Record<string, unknown>, callback?: (response: FakeResponse) => void) => {
        const request = new FakeRequest(options, callback, () => {
          if (String(options.path).endsWith("/StreamAudioTranscription")) {
            const response = new FakeResponse();
            callback?.(response);
            queueMicrotask(() =>
              response.emit("data", connectFrame({ ready: { sessionId: "silent-chunk" } })),
            );
          } else if (String(options.path).endsWith("/SendAudioChunk")) {
            chunkResponse = new FakeResponse();
            callback?.(chunkResponse);
          }
        });
        requests.push(request);
        return request;
      }) as unknown as typeof https.request,
    );
    const session = new AntigravityAudioSession(
      { port: 1, csrf: "test" },
      { onError: (error: Error) => errors.push(error) },
    );

    try {
      await session.start();
      assert.equal(session.sendChunk(Buffer.alloc(1, 1)), true);
      assert.equal(session.sendChunk(Buffer.alloc(1, 2)), true);
      const ending = session.endSession();
      await new Promise<void>((resolve) => setImmediate(resolve));

      const chunkRequest = requests.find((request) =>
        String(request.options.path).endsWith("/SendAudioChunk"),
      );
      assert.ok(chunkRequest);
      assert.ok(chunkResponse);
      assert.ok(chunkRequest.timeoutCallback);
      chunkRequest.timeoutCallback();
      await ending;

      assert.equal(chunkRequest.destroyed, true);
      assert.equal(requests[0].destroyed, true);
      assert.equal(
        requests.filter((request) => String(request.options.path).endsWith("/SendAudioChunk"))
          .length,
        1,
      );
      assert.equal(
        requests.some((request) => String(request.options.path).endsWith("/EndAudioSession")),
        false,
      );
      assert.equal((session as unknown as { state: string }).state, "destroyed");
      assert.equal(session.sessionId, null);
      assert.equal((session as unknown as { queue: Buffer[] }).queue.length, 0);
      assert.equal((session as unknown as { pendingRequests: Map<unknown, unknown> }).pendingRequests.size, 0);
      assert.deepEqual(errors.map((error) => error.message), ["SendAudioChunk timed out"]);

      (chunkResponse as FakeResponse | null)?.emit("end");
      chunkRequest.emit("error", new Error("late chunk failure"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(errors.length, 1);
    } finally {
      session.destroy();
      requestMock.mock.restore();
    }
  });

  it("terminalizes a live session when EndAudioSession stops responding", async () => {
    const requests: FakeRequest[] = [];
    let endResponse: FakeResponse | null = null;
    const errors: Error[] = [];
    const requestMock = mock.method(
      https,
      "request",
      ((options: Record<string, unknown>, callback?: (response: FakeResponse) => void) => {
        const request = new FakeRequest(options, callback, () => {
          if (String(options.path).endsWith("/StreamAudioTranscription")) {
            const response = new FakeResponse();
            callback?.(response);
            queueMicrotask(() =>
              response.emit("data", connectFrame({ ready: { sessionId: "silent-end" } })),
            );
          } else if (String(options.path).endsWith("/EndAudioSession")) {
            endResponse = new FakeResponse();
            callback?.(endResponse);
          }
        });
        requests.push(request);
        return request;
      }) as unknown as typeof https.request,
    );
    const session = new AntigravityAudioSession(
      { port: 1, csrf: "test" },
      { onError: (error: Error) => errors.push(error) },
    );

    try {
      await session.start();
      const ending = session.endSession();
      await new Promise<void>((resolve) => setImmediate(resolve));

      const endRequest = requests.find((request) =>
        String(request.options.path).endsWith("/EndAudioSession"),
      );
      assert.ok(endRequest);
      assert.ok(endResponse);
      assert.ok(endRequest.timeoutCallback);
      endRequest.timeoutCallback();
      await ending;

      assert.equal(endRequest.destroyed, true);
      assert.equal(requests[0].destroyed, true);
      assert.equal((session as unknown as { state: string }).state, "destroyed");
      assert.equal(session.sessionId, null);
      assert.equal((session as unknown as { pendingEnd: unknown }).pendingEnd, null);
      assert.equal((session as unknown as { pendingRequests: Map<unknown, unknown> }).pendingRequests.size, 0);
      assert.deepEqual(errors.map((error) => error.message), ["EndAudioSession timed out"]);

      (endResponse as FakeResponse | null)?.emit("end");
      endRequest.emit("error", new Error("late end failure"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(errors.length, 1);
      assert.equal((session as unknown as { state: string }).state, "destroyed");
    } finally {
      session.destroy();
      requestMock.mock.restore();
    }
  });

  it("waits for queued audio before terminalizing an ended session", async () => {
    const requests: FakeRequest[] = [];
    const requestMock = mock.method(
      https,
      "request",
      ((options: Record<string, unknown>, callback?: (response: FakeResponse) => void) => {
        const request = new FakeRequest(options, callback, () => {
          if (String(options.path).endsWith("/StreamAudioTranscription")) {
            const response = new FakeResponse();
            callback?.(response);
            queueMicrotask(() => {
              response.emit("data", connectFrame({ ready: { sessionId: "session-ending" } }));
            });
          }
        });
        requests.push(request);
        return request;
      }) as unknown as typeof https.request,
    );
    const session = new AntigravityAudioSession({ port: 1, csrf: "test" });

    try {
      await session.start();
      assert.equal(session.sendChunk(Buffer.alloc(32)), true);
      const ending = session.endSession();
      let ended = false;
      void ending.then(() => {
        ended = true;
      });
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      assert.equal(ended, false);

      const sendResponse = new FakeResponse();
      requests[1].callback?.(sendResponse);
      sendResponse.emit("end");
      while (requests.length < 3) await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(String(requests[2].options.path).endsWith("/EndAudioSession"), true);
      assert.equal(ended, false);

      const endResponse = new FakeResponse();
      requests[2].callback?.(endResponse);
      endResponse.emit("end");
      await ending;

      assert.equal(session.sessionId, null);
      assert.equal(session.sendChunk(Buffer.alloc(32)), false);
    } finally {
      session.destroy();
      requestMock.mock.restore();
    }
  });

  it("bounds queued audio object count for tiny chunks", async () => {
    const requestMock = mock.method(
      https,
      "request",
      ((options: Record<string, unknown>, callback?: (response: FakeResponse) => void) =>
        new FakeRequest(options, callback, () => {})) as unknown as typeof https.request,
    );
    const session = new AntigravityAudioSession({ port: 1, csrf: "test" });
    const start = session.start();
    void start.catch(() => {});

    try {
      const accepted = Array.from({ length: 1025 }, () => session.sendChunk(Buffer.alloc(1)));
      assert.equal(accepted[1023], true);
      assert.equal(accepted[1024], false);
    } finally {
      session.destroy();
      requestMock.mock.restore();
    }
  });
});
