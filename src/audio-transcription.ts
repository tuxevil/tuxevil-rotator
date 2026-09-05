import type { IncomingMessage, ServerResponse, ClientRequest } from "node:http";
import type { Duplex } from "node:stream";
import https from "node:https";
import cp from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { readLimitedBody } from "./body-limit.js";
import { authenticateVirtualKey, sendAuthErrorResponse, type KeyAuthResult } from "./key-auth.js";
import { logger } from "./logger.js";
import { logSpend } from "./spend-logger.js";
import { applyModelAlias } from "./types.js";
import { hashKey } from "./virtual-keys.js";

const audioLogger = logger.child("audio-transcription");
const AUDIO_SESSION_START_TIMEOUT_MS = 10_000;
const AUDIO_TRANSCRIPTION_TIMEOUT_MS = 30_000;
const AUDIO_UNARY_REQUEST_TIMEOUT_MS = 10_000;
export const MAX_AUDIO_FRAME_BYTES = 256 * 1024;
export const MAX_QUEUED_AUDIO_BYTES = 1024 * 1024;
const MAX_QUEUED_AUDIO_CHUNKS = 1024;
const MAX_WS_INCOMING_BUFFER_BYTES = 2 * MAX_QUEUED_AUDIO_BYTES;

export interface AntigravityCredentials {
  port: number;
  csrf: string;
}

let cachedCreds: AntigravityCredentials | null = null;
let lastCredsCheck = 0;

/**
 * Auto-detect the running Antigravity Language Server credentials.
 * Checks for running language_server instances with their HTTPS listening ports.
 */
export function getAntigravityCredentials(): AntigravityCredentials {
  const now = Date.now();
  if (cachedCreds && now - lastCredsCheck < 30_000) {
    return cachedCreds;
  }

  try {
    const ps = cp.execSync("ps aux | grep language_server | grep -v grep").toString();
    const lines = ps.split("\n");
    // Sort so Hub instance comes first
    lines.sort((a, b) => (b.includes("hub") ? 1 : 0) - (a.includes("hub") ? 1 : 0));
    for (const line of lines) {
      const matchCsrf = line.match(/--csrf_token\s+([a-f0-9-]+)/);
      const matchPid = line.trim().match(/^\S+\s+(\d+)/);
      if (matchCsrf && matchPid) {
        const pid = matchPid[1];
        const csrf = matchCsrf[1];
        const lsof = cp.execSync(`lsof -nP -iTCP -sTCP:LISTEN -a -p ${pid}`).toString();
        const ports = [...lsof.matchAll(/:(\d+)\s+\(LISTEN\)/g)].map((m) => parseInt(m[1], 10));
        if (ports.length > 0) {
          cachedCreds = { port: ports[0], csrf };
          lastCredsCheck = now;
          return cachedCreds;
        }
      }
    }
  } catch (e: unknown) {
    const err = e as Error;
    audioLogger.warn(`Failed to auto-detect language_server: ${err.message}`);
  }

  return cachedCreds ?? { port: 52176, csrf: "ab6faa2f-e834-47f1-994b-cb39112ae062" };
}

export function resolveMimeType(fileName: string, mimeType?: string): string {
  if (mimeType && mimeType.startsWith("audio/")) return mimeType;
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".mp3")) return "audio/mp3";
  if (lower.endsWith(".m4a")) return "audio/m4a";
  if (lower.endsWith(".webm")) return "audio/webm;codecs=opus";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".flac")) return "audio/flac";
  if (lower.endsWith(".pcm")) return "audio/pcm;rate=16000";
  return "audio/wav";
}

export interface TranscribeOptions {
  mimeType?: string;
  model?: string;
  prompt?: string;
  language?: string;
}

/**
 * Transcribes an audio buffer using Antigravity models/proactive-observer-v10.
 */
export async function transcribeAudioWithAntigravity(
  audioBuffer: Buffer,
  options: TranscribeOptions = {},
): Promise<string> {
  const creds = getAntigravityCredentials();
  const rawModel = options.model || "models/proactive-observer-v10";
  const model = applyModelAlias(rawModel);
  const mimeType = options.mimeType || "audio/wav";
  const prompt = options.prompt || "";

  return new Promise((resolve, reject) => {
    let sessionId: string | null = null;
    let finalText = "";
    let lastInterim = "";
    let isResolved = false;
    let endStarted = false;
    let endComplete = false;
    let streamFinished = false;
    const pendingUnaryRequests = new Map<ClientRequest, () => void>();

    const payload = JSON.stringify({
      mimeType,
      model,
      cascadeId: `transcribe-${Date.now()}`,
      preCursorText: prompt,
      continuous: false,
      language: options.language,
    });
    const payloadBuf = Buffer.from(payload, "utf8");
    const frame = Buffer.alloc(5 + payloadBuf.length);
    frame.writeUInt8(0, 0);
    frame.writeUInt32BE(payloadBuf.length, 1);
    payloadBuf.copy(frame, 5);

    const streamReq = https.request(
      {
        hostname: "127.0.0.1",
        port: creds.port,
        path: "/exa.language_server_pb.LanguageServerService/StreamAudioTranscription",
        method: "POST",
        rejectUnauthorized: false,
        headers: {
          "Content-Type": "application/connect+json",
          "Connect-Protocol-Version": "1",
          "X-Codeium-Csrf-Token": creds.csrf,
        },
      },
      (res) => {
        res.on("error", fail);
        if (res.statusCode !== 200) {
          fail(new Error(`Antigravity StreamAudioTranscription error: HTTP ${res.statusCode}`));
          return;
        }

        let buf = Buffer.alloc(0);
        res.on("data", (chunk: Buffer) => {
          buf = Buffer.concat([buf, chunk]);
          while (buf.length >= 5) {
            const flag = buf.readUInt8(0);
            const len = buf.readUInt32BE(1);
            if (buf.length < 5 + len) break;
            const msgBuf = buf.subarray(5, 5 + len);
            buf = buf.subarray(5 + len);

            if (flag === 0) {
              try {
                const msg = JSON.parse(msgBuf.toString("utf8"));
                if (msg.ready?.sessionId && !endStarted) {
                  sessionId = msg.ready.sessionId;
                  endStarted = true;
                  void sendChunksAndEnd().then(() => {
                    endComplete = true;
                    maybeFinish();
                  }, fail);
                } else if (msg.transcription) {
                  const text = msg.transcription.text || "";
                  if (msg.transcription.isFinal) {
                    finalText += (finalText ? " " : "") + text;
                  } else {
                    lastInterim = text;
                  }
                } else if (msg.complete) {
                  finishStream();
                }
              } catch (err: unknown) {
                audioLogger.warn(`Failed to parse transcription message: ${err}`);
              }
            } else if (flag === 2) {
              finishStream();
            }
          }
        });

        res.on("end", () => {
          finishStream();
        });
      },
    );

    streamReq.on("error", (err) => {
      fail(err);
    });

    streamReq.write(frame);
    streamReq.end();

    const timeout = setTimeout(() => {
      succeed(finalText || lastInterim);
    }, AUDIO_TRANSCRIPTION_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      for (const [request, finish] of pendingUnaryRequests) {
        try {
          request.destroy();
        } catch {
          // ignore cleanup error
        }
        finish();
      }
      try {
        streamReq.destroy();
      } catch {
        // ignore cleanup error
      }
    }

    function succeed(text = (finalText || lastInterim).trim()) {
      if (isResolved) return;
      isResolved = true;
      cleanup();
      resolve(text);
    }

    function finishStream() {
      streamFinished = true;
      maybeFinish();
    }

    function maybeFinish() {
      if (streamFinished && (!endStarted || endComplete)) succeed();
    }

    function fail(error: Error) {
      if (isResolved) return;
      isResolved = true;
      cleanup();
      reject(error);
    }

    async function sendChunksAndEnd() {
      if (!sessionId || isResolved) return;
      const chunkSize = 3200; // 100ms at 16kHz
      let seq = 0;

      for (let i = 0; i < audioBuffer.length; i += chunkSize) {
        if (isResolved) return;
        const chunk = audioBuffer.subarray(i, Math.min(i + chunkSize, audioBuffer.length));
        const data = JSON.stringify({
          sessionId,
          data: chunk.toString("base64"),
          sequenceNumber: String(seq++),
        });

        await new Promise<void>((resolveChunk, rejectChunk) => {
          let settled = false;
          function finish(error?: Error): void {
            if (settled) return;
            settled = true;
            pendingUnaryRequests.delete(req);
            if (error) rejectChunk(error);
            else resolveChunk();
          }
          const req = https.request(
            {
              hostname: "127.0.0.1",
              port: creds.port,
              path: "/exa.language_server_pb.LanguageServerService/SendAudioChunk",
              method: "POST",
              rejectUnauthorized: false,
              headers: {
                "Content-Type": "application/json",
                "X-Codeium-Csrf-Token": creds.csrf,
                "Content-Length": Buffer.byteLength(data),
              },
            },
            (resp) => {
              resp.resume();
              resp.on("end", finish);
              resp.on("error", () => finish());
            },
          );
          pendingUnaryRequests.set(req, finish);
          req.setTimeout(AUDIO_UNARY_REQUEST_TIMEOUT_MS, () => {
            const error = new Error("SendAudioChunk timed out");
            audioLogger.warn(error.message);
            try {
              req.destroy();
            } catch {
              // ignore cleanup error
            }
            finish(error);
          });
          req.on("error", () => finish());
          req.write(data);
          req.end();
        });
        if (isResolved) return;
      }

      // End session
      if (isResolved) return;
      const endData = JSON.stringify({ sessionId });
      await new Promise<void>((resolveEnd, rejectEnd) => {
        let settled = false;
        function finish(error?: Error): void {
          if (settled) return;
          settled = true;
          pendingUnaryRequests.delete(req);
          if (error) rejectEnd(error);
          else resolveEnd();
        }
        const req = https.request(
          {
            hostname: "127.0.0.1",
            port: creds.port,
            path: "/exa.language_server_pb.LanguageServerService/EndAudioSession",
            method: "POST",
            rejectUnauthorized: false,
            headers: {
              "Content-Type": "application/json",
              "X-Codeium-Csrf-Token": creds.csrf,
              "Content-Length": Buffer.byteLength(endData),
            },
          },
          (resp) => {
            resp.resume();
            resp.on("end", finish);
            resp.on("error", finish);
          },
        );
        pendingUnaryRequests.set(req, () => finish());
        req.setTimeout(AUDIO_UNARY_REQUEST_TIMEOUT_MS, () => {
          const error = new Error("EndAudioSession timed out");
          try {
            req.destroy();
          } catch {
            // ignore cleanup error
          }
          finish(error);
        });
        req.on("error", finish);
        req.end(endData);
      });
    }
  });
}

export function getAudioDurationSeconds(audioBuffer: Buffer, mimeType: string): number | undefined {
  if (!mimeType.toLowerCase().startsWith("audio/wav")) return undefined;
  if (
    audioBuffer.length < 12 ||
    audioBuffer.toString("ascii", 0, 4) !== "RIFF" ||
    audioBuffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    return undefined;
  }

  let byteRate: number | undefined;
  let dataLength: number | undefined;
  for (let offset = 12; offset + 8 <= audioBuffer.length; ) {
    const chunkId = audioBuffer.toString("ascii", offset, offset + 4);
    const chunkLength = audioBuffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const chunkEnd = dataOffset + chunkLength;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > audioBuffer.length) return undefined;
    if (chunkId === "fmt " && chunkLength >= 12) {
      byteRate = audioBuffer.readUInt32LE(dataOffset + 8);
    } else if (chunkId === "data") {
      dataLength = chunkLength;
    }
    if (byteRate && dataLength !== undefined) return dataLength / byteRate;
    offset = chunkEnd + (chunkLength % 2);
  }
  return undefined;
}

/**
 * Handles standard OpenAI-compatible POST /v1/audio/transcriptions
 */
export async function handleOpenAIAudioTranscriptions(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const requestStartedAt = Date.now();
  const initialAuth = await authenticateVirtualKey(req);
  if (!initialAuth.authenticated) {
    sendAuthErrorResponse(res, initialAuth);
    return;
  }
  let apiKeyHash = initialAuth.key?.tokenHash || (initialAuth.rawKey ? hashKey(initialAuth.rawKey) : null);
  let spendModel = "models/proactive-observer-v10";
  let spendLogged = false;
  const logRequest = (status: "success" | "failure"): void => {
    if (spendLogged) return;
    spendLogged = true;
    const endTime = Date.now();
    logSpend({
      apiKeyHash,
      model: applyModelAlias(spendModel),
      callType: "audio_transcription",
      status,
      promptTokens: 0,
      completionTokens: 0,
      startTime: new Date(requestStartedAt).toISOString(),
      endTime: new Date(endTime).toISOString(),
      durationMs: endTime - requestStartedAt,
      requesterIp: req.socket?.remoteAddress || null,
    });
  };

  const contentType = req.headers["content-type"] || "";
  if (!contentType.includes("multipart/form-data")) {
    logRequest("failure");
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message: "Content-Type must be multipart/form-data for audio transcriptions",
          type: "invalid_request_error",
          param: null,
          code: null,
        },
      }),
    );
    return;
  }

  let rawBody: Buffer;
  try {
    rawBody = await readLimitedBody(req);
  } catch (err: unknown) {
    const error = err as Error;
    logRequest("failure");
    res.writeHead(413, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message: error.message || "Payload too large",
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  let formData: FormData;
  try {
    const responseWrapper = new Response(new Uint8Array(rawBody), {
      headers: { "content-type": contentType },
    });
    formData = await responseWrapper.formData();
  } catch (err: unknown) {
    const error = err as Error;
    logRequest("failure");
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message: `Failed to parse multipart/form-data: ${error.message}`,
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  const fileEntry = formData.get("file");
  if (!fileEntry || typeof fileEntry === "string") {
    logRequest("failure");
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message: "Missing required 'file' parameter",
          type: "invalid_request_error",
          param: "file",
        },
      }),
    );
    return;
  }

  const model = String(formData.get("model") || "models/proactive-observer-v10");
  spendModel = model;
  const modelAuth = await authenticateVirtualKey(req, model);
  if (!modelAuth.authenticated) {
    logRequest("failure");
    sendAuthErrorResponse(res, modelAuth);
    return;
  }
  apiKeyHash = modelAuth.key?.tokenHash || (modelAuth.rawKey ? hashKey(modelAuth.rawKey) : apiKeyHash);
  const prompt = formData.get("prompt") ? String(formData.get("prompt")) : undefined;
  const language = formData.get("language") ? String(formData.get("language")) : undefined;
  const responseFormat = String(formData.get("response_format") || "json").toLowerCase();

  const fileName = (fileEntry as File).name || "audio.wav";
  const mimeType = resolveMimeType(fileName, fileEntry.type);
  const arrayBuf = await fileEntry.arrayBuffer();
  const audioBuffer = Buffer.from(arrayBuf);

  try {
    const transcribedText = await transcribeAudioWithAntigravity(audioBuffer, {
      mimeType,
      model,
      prompt,
      language,
    });

    if (responseFormat === "text") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(transcribedText);
      logRequest("success");
      return;
    }

    if (responseFormat === "verbose_json") {
      const verbose: Record<string, unknown> = {
        task: "transcribe",
        text: transcribedText,
        segments: [],
      };
      if (language) verbose.language = language;
      const duration = getAudioDurationSeconds(audioBuffer, mimeType);
      if (duration !== undefined) verbose.duration = duration;
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(verbose));
      logRequest("success");
      return;
    }

    // Default: json
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ text: transcribedText }));
    logRequest("success");
  } catch (err: unknown) {
    const error = err as Error;
    logRequest("failure");
    audioLogger.error(`Transcription failed: ${error.message}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message: `Transcription error: ${error.message}`,
          type: "api_error",
        },
      }),
    );
  }
}

/**
 * Antigravity real-time streaming audio transcription session.
 */
export class AntigravityAudioSession {
  private port: number;
  private csrf: string;
  public model: string;
  public cascadeId: string;
  public preCursorText: string;
  public postCursorText: string;
  public continuous: boolean;
  public language?: string;
  public sessionId: string | null = null;
  private seq = 0;
  private streamReq: ClientRequest | null = null;
  private streamBuffer = Buffer.alloc(0);
  private queue: Buffer[] = [];
  private queuedAudioBytes = 0;
  private isProcessingQueue = false;
  private pendingEnd: { promise: Promise<void>; resolve: () => void } | null = null;
  private state: "idle" | "starting" | "ready" | "ending" | "ended" | "failed" | "destroyed" =
    "idle";
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private startReject: ((error: Error) => void) | null = null;
  private readonly startTimeoutMs: number;
  private readonly pendingRequests = new Map<ClientRequest, () => void>();
  private onEvent: (event: any) => void;
  private onError: (err: Error) => void;

  constructor(
    creds: AntigravityCredentials,
    options: {
      model?: string;
      cascadeId?: string;
      preCursorText?: string;
      postCursorText?: string;
      continuous?: boolean;
      language?: string;
      startTimeoutMs?: number;
      onEvent?: (event: any) => void;
      onError?: (err: Error) => void;
    } = {},
  ) {
    this.port = creds.port;
    this.csrf = creds.csrf;
    this.model = applyModelAlias(options.model || "models/proactive-observer-v10");
    this.cascadeId = options.cascadeId || `stream-${Date.now()}`;
    this.preCursorText = options.preCursorText || "";
    this.postCursorText = options.postCursorText || "";
    this.continuous = options.continuous ?? false;
    this.language = options.language;
    this.startTimeoutMs = Math.max(1, options.startTimeoutMs ?? AUDIO_SESSION_START_TIMEOUT_MS);
    this.onEvent = options.onEvent || (() => {});
    this.onError = options.onError || (() => {});
  }

  public start(): Promise<string> {
    if (this.state !== "idle") {
      return Promise.reject(new Error("Antigravity audio session has already been started"));
    }
    this.state = "starting";
    return new Promise((resolve, reject) => {
      this.startReject = reject;
      this.startTimer = setTimeout(() => {
        this.failStart(new Error(`Antigravity audio session start timed out after ${this.startTimeoutMs}ms`));
      }, this.startTimeoutMs);
      const payload = JSON.stringify({
        mimeType: "audio/pcm;rate=16000",
        model: this.model,
        cascadeId: this.cascadeId,
        preCursorText: this.preCursorText,
        postCursorText: this.postCursorText,
        continuous: this.continuous,
        language: this.language,
      });
      const payloadBuf = Buffer.from(payload, "utf8");
      const frame = Buffer.alloc(5 + payloadBuf.length);
      frame.writeUInt8(0, 0);
      frame.writeUInt32BE(payloadBuf.length, 1);
      payloadBuf.copy(frame, 5);

      this.streamReq = https.request(
        {
          hostname: "127.0.0.1",
          port: this.port,
          path: "/exa.language_server_pb.LanguageServerService/StreamAudioTranscription",
          method: "POST",
          rejectUnauthorized: false,
          headers: {
            "Content-Type": "application/connect+json",
            "Connect-Protocol-Version": "1",
            "X-Codeium-Csrf-Token": this.csrf,
          },
        },
        (res) => {
          res.on("error", (err) => this.handleStreamError(err));
          if (res.statusCode !== 200) {
            const err = new Error(`Antigravity stream error status: ${res.statusCode}`);
            res.resume();
            this.failStart(err);
            return;
          }
          res.on("data", (chunk: Buffer) => {
            if (this.state === "destroyed" || this.state === "failed") return;
            this.streamBuffer = Buffer.concat([this.streamBuffer, chunk]);
            while (this.streamBuffer.length >= 5) {
              const flag = this.streamBuffer.readUInt8(0);
              const len = this.streamBuffer.readUInt32BE(1);
              if (this.streamBuffer.length < 5 + len) break;
              const msgBuf = this.streamBuffer.subarray(5, 5 + len);
              this.streamBuffer = this.streamBuffer.subarray(5 + len);

              if (flag === 0) {
                try {
                  const msg = JSON.parse(msgBuf.toString("utf8"));
                  if (msg.ready?.sessionId && this.state === "starting") {
                    const sessionId = String(msg.ready.sessionId);
                    this.sessionId = sessionId;
                    this.state = "ready";
                    this.clearStartWait();
                    resolve(sessionId);
                    void this.processQueue();
                  }
                  this.onEvent(msg);
                } catch (e) {
                  audioLogger.error(`Antigravity JSON parse error: ${e}`);
                }
              } else if (flag === 2) {
                this.onEvent({ complete: true });
              }
            }
          });

          res.on("end", () => {
            if (this.state === "starting") {
              this.failStart(new Error("Antigravity audio stream ended before becoming ready"));
              return;
            }
            if (this.state === "ready") {
              this.handleStreamError(new Error("Antigravity audio stream ended unexpectedly"));
            }
          });
        },
      );

      this.streamReq.on("error", (err) => {
        this.handleStreamError(err);
      });

      this.streamReq.write(frame);
      this.streamReq.end();
    });
  }

  public sendChunk(pcmBuffer: Buffer): boolean {
    if (
      (this.state !== "starting" && this.state !== "ready") ||
      this.pendingEnd !== null ||
      pcmBuffer.length === 0 ||
      pcmBuffer.length > MAX_AUDIO_FRAME_BYTES ||
      this.queue.length >= MAX_QUEUED_AUDIO_CHUNKS ||
      this.queuedAudioBytes + pcmBuffer.length > MAX_QUEUED_AUDIO_BYTES
    ) {
      return false;
    }
    this.queue.push(pcmBuffer);
    this.queuedAudioBytes += pcmBuffer.length;
    if (this.state === "ready") void this.processQueue();
    return true;
  }

  private async processQueue(): Promise<void> {
    if (
      this.isProcessingQueue ||
      (this.state !== "ready" && this.state !== "ending") ||
      !this.sessionId
    )
      return;
    this.isProcessingQueue = true;

    while (
      this.queue.length > 0 &&
      (this.state === "ready" || this.state === "ending") &&
      this.sessionId
    ) {
      const chunk = this.queue.shift();
      if (chunk) {
        this.queuedAudioBytes -= chunk.length;
        await this.sendChunkUnary(chunk);
      }
    }

    this.isProcessingQueue = false;

    if (this.pendingEnd && (this.state === "ready" || this.state === "ending")) {
      this.state = "ending";
      await this.executeEndSession();
    }
  }

  private sendChunkUnary(pcmBuffer: Buffer): Promise<void> {
    if (!this.sessionId) return Promise.resolve();
    const data = JSON.stringify({
      sessionId: this.sessionId,
      data: pcmBuffer.toString("base64"),
      sequenceNumber: String(this.seq++),
    });

    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        this.pendingRequests.delete(req);
        resolve();
      };
      const req = https.request(
        {
          hostname: "127.0.0.1",
          port: this.port,
          path: "/exa.language_server_pb.LanguageServerService/SendAudioChunk",
          method: "POST",
          rejectUnauthorized: false,
          headers: {
            "Content-Type": "application/json",
            "X-Codeium-Csrf-Token": this.csrf,
            "Content-Length": Buffer.byteLength(data),
          },
        },
        (res) => {
          res.resume();
          res.on("end", finish);
          res.on("error", finish);
        },
      );
      this.pendingRequests.set(req, finish);
      req.setTimeout(AUDIO_UNARY_REQUEST_TIMEOUT_MS, () => {
        const error = new Error("SendAudioChunk timed out");
        audioLogger.warn(error.message);
        this.failSession(error);
      });
      req.on("error", (e) => {
        audioLogger.warn(`SendAudioChunk error: ${e.message}`);
        finish();
      });
      req.write(data);
      req.end();
    });
  }

  public endSession(): Promise<void> {
    if (this.state === "ended" || this.state === "failed" || this.state === "destroyed") {
      return Promise.resolve();
    }
    if (this.pendingEnd) return this.pendingEnd.promise;

    let resolveEnd!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveEnd = resolve;
    });
    this.pendingEnd = { promise, resolve: resolveEnd };
    if (this.state === "ready") this.state = "ending";
    if (!this.isProcessingQueue && this.queue.length === 0 && this.sessionId) {
      void this.executeEndSession();
    }
    return promise;
  }

  private executeEndSession(): Promise<void> {
    if (!this.sessionId) return Promise.resolve();
    const sessionId = this.sessionId;
    const data = JSON.stringify({ sessionId });
    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        this.pendingRequests.delete(req);
        if (this.sessionId === sessionId) this.sessionId = null;
        if (this.state !== "destroyed") this.state = "ended";
        const pendingEnd = this.pendingEnd;
        this.pendingEnd = null;
        pendingEnd?.resolve();
        resolve();
      };
      const req = https.request(
        {
          hostname: "127.0.0.1",
          port: this.port,
          path: "/exa.language_server_pb.LanguageServerService/EndAudioSession",
          method: "POST",
          rejectUnauthorized: false,
          headers: {
            "Content-Type": "application/json",
            "X-Codeium-Csrf-Token": this.csrf,
            "Content-Length": Buffer.byteLength(data),
          },
        },
        (res) => {
          res.resume();
          res.on("end", finish);
          res.on("error", finish);
        },
      );
      this.pendingRequests.set(req, finish);
      req.setTimeout(AUDIO_UNARY_REQUEST_TIMEOUT_MS, () => {
        const error = new Error("EndAudioSession timed out");
        audioLogger.warn(error.message);
        this.failSession(error);
      });
      req.on("error", (error) => {
        audioLogger.warn(`EndAudioSession error: ${error.message}`);
        finish();
      });
      req.write(data);
      req.end();
    });
  }

  public destroy(): void {
    if (this.state === "destroyed") return;
    const rejectStart = this.startReject;
    this.state = "destroyed";
    this.clearStartWait();
    this.queue = [];
    this.queuedAudioBytes = 0;
    const pendingEnd = this.pendingEnd;
    this.pendingEnd = null;
    pendingEnd?.resolve();
    this.sessionId = null;
    this.streamBuffer = Buffer.alloc(0);
    for (const [request, finish] of [...this.pendingRequests]) {
      try {
        request.destroy();
      } catch {
        // ignore destroy error
      }
      finish();
    }
    if (this.streamReq) {
      try {
        this.streamReq.destroy();
      } catch {
        // ignore destroy error
      }
      this.streamReq = null;
    }
    rejectStart?.(new Error("Antigravity audio session was destroyed before becoming ready"));
  }

  private clearStartWait(): void {
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
    this.startReject = null;
  }

  private failStart(error: Error): void {
    if (this.state !== "starting") return;
    const reject = this.startReject;
    this.state = "failed";
    this.clearStartWait();
    this.queue = [];
    this.queuedAudioBytes = 0;
    const pendingEnd = this.pendingEnd;
    this.pendingEnd = null;
    pendingEnd?.resolve();
    this.streamBuffer = Buffer.alloc(0);
    if (this.streamReq) {
      try {
        this.streamReq.destroy();
      } catch {
        // ignore destroy error
      }
      this.streamReq = null;
    }
    reject?.(error);
  }

  private failSession(error: Error): void {
    if (this.state !== "ready" && this.state !== "ending") return;
    this.onError(error);
    this.destroy();
  }

  private handleStreamError(error: Error): void {
    if (this.state === "starting") {
      this.failStart(error);
      return;
    }
    if (this.state === "ready") {
      this.failSession(error);
    }
  }
}

interface AudioWsClient {
  socket: Duplex;
  antigravity: AntigravityAudioSession | null;
  authorizeModel: (model: string) => Promise<KeyAuthResult>;
  apiKeyHash: string | null;
  requesterIp: string | null;
  spendStartedAt: number | null;
  spendModel: string;
  closed: boolean;
  tStartTime: number | null;
  tFirstAntigravity: number | null;
  tStopTime: number | null;
  send: (obj: unknown) => void;
}

function destroyClientSession(client: AudioWsClient): void {
  if (client.antigravity) {
    client.antigravity.destroy();
    client.antigravity = null;
  }
}

function beginClientSpend(client: AudioWsClient, model: string): void {
  client.spendStartedAt = Date.now();
  client.spendModel = applyModelAlias(model);
}

function finishClientSpend(client: AudioWsClient, status: "success" | "failure"): void {
  if (client.spendStartedAt === null) return;
  const startedAt = client.spendStartedAt;
  client.spendStartedAt = null;
  const endTime = Date.now();
  logSpend({
    apiKeyHash: client.apiKeyHash,
    model: client.spendModel,
    callType: "audio_stream",
    status,
    promptTokens: 0,
    completionTokens: 0,
    startTime: new Date(startedAt).toISOString(),
    endTime: new Date(endTime).toISOString(),
    durationMs: endTime - startedAt,
    requesterIp: client.requesterIp,
  });
}

function cleanupClient(client: AudioWsClient, status: "success" | "failure" = "failure"): void {
  finishClientSpend(client, status);
  destroyClientSession(client);
}

function closeClient(client: AudioWsClient, code: number, reason: string): void {
  if (client.closed) return;
  client.closed = true;
  cleanupClient(client);
  const reasonBuffer = Buffer.from(reason, "utf8").subarray(0, 123);
  const frame = Buffer.alloc(4 + reasonBuffer.length);
  frame[0] = 0x88;
  frame[1] = 2 + reasonBuffer.length;
  frame.writeUInt16BE(code, 2);
  reasonBuffer.copy(frame, 4);
  try {
    client.socket.end(frame);
  } catch {
    client.socket.destroy();
  }
}

async function authorizeClientModel(client: AudioWsClient, model: string): Promise<boolean> {
  if (client.closed) return false;
  const auth = await client.authorizeModel(model);
  if (client.closed) return false;
  if (auth.authenticated) return true;
  client.send({
    type: "antigravity_error",
    event: "error",
    message: auth.error || "Authentication failed",
  });
  closeClient(client, 1008, "Model is not allowed");
  return false;
}

function createClientSession(
  client: AudioWsClient,
  model: string,
  options: { preCursorText?: string; postCursorText?: string; continuous?: boolean; language?: string },
): AntigravityAudioSession {
  const creds = getAntigravityCredentials();
  client.tStartTime = Date.now();
  client.tFirstAntigravity = null;
  client.tStopTime = null;
  beginClientSpend(client, model);
  const session = new AntigravityAudioSession(creds, {
    model,
    ...options,
    onEvent: (event) => {
      if (client.antigravity !== session || client.closed) return;
      const now = Date.now();
      if (event.ready) {
        client.send({
          type: "antigravity_ready",
          event: "ready",
          sessionId: event.ready.sessionId,
        });
      } else if (event.transcription) {
        if (!client.tFirstAntigravity) client.tFirstAntigravity = now;
        client.send({
          type: "antigravity_transcript",
          event: "transcript",
          text: event.transcription.text || "",
          isFinal: !!event.transcription.isFinal,
          is_final: !!event.transcription.isFinal,
          ttftMs: client.tStartTime ? now - client.tStartTime : 0,
          latencyFromStopMs: client.tStopTime ? now - client.tStopTime : null,
          timestamp: now,
        });
      } else if (event.complete) {
        client.send({
          type: "antigravity_complete",
          event: "complete",
          totalDurationMs: client.tStartTime ? now - client.tStartTime : 0,
          timestamp: now,
        });
        finishClientSpend(client, "success");
      }
    },
    onError: (err) => {
      if (client.antigravity !== session || client.closed) return;
      client.send({ type: "antigravity_error", event: "error", message: err.message });
      closeClient(client, 1011, "Antigravity audio stream failed");
    },
  });
  return session;
}

async function handleClientCommand(client: AudioWsClient, cmd: any): Promise<void> {
  if (client.closed) return;
  if (cmd.type === "start") {
    const model = String(cmd.antigravityModel || cmd.model || "models/proactive-observer-v10");
    if (!(await authorizeClientModel(client, model))) return;
    if (client.antigravity) {
      finishClientSpend(client, "success");
      destroyClientSession(client);
    }

    client.send({
      type: "session_starting",
      event: "session_starting",
      timestamp: Date.now(),
    });

    const session = createClientSession(client, model, {
      preCursorText: cmd.preCursorText || "",
      postCursorText: cmd.postCursorText || "",
      continuous: cmd.continuous ?? false,
      language: typeof cmd.language === "string" ? cmd.language : undefined,
    });
    client.antigravity = session;

    try {
      await session.start();
    } catch (e: any) {
      if (client.antigravity === session) {
        client.send({ type: "antigravity_error", event: "error", message: e.message || String(e) });
        finishClientSpend(client, "failure");
        destroyClientSession(client);
      }
      return;
    }

    if (client.closed || client.antigravity !== session) return;
    client.send({
      type: "ready_to_receive_audio",
      event: "ready_to_receive_audio",
    });
  } else if (cmd.type === "stop") {
    client.tStopTime = Date.now();
    client.send({
      type: "audio_stopped",
      event: "audio_stopped",
      timestamp: client.tStopTime,
    });

    if (client.antigravity) {
      const session = client.antigravity;
      await session.endSession();
      if (client.antigravity === session) {
        finishClientSpend(client, "success");
        destroyClientSession(client);
      }
    }
  } else if (cmd.type === "test_sample") {
    await runTestSample(client, cmd.sample || "es");
  }
}

async function handleAudioChunk(client: AudioWsClient, pcmBuffer: Buffer): Promise<void> {
  if (client.closed) return;
  if (pcmBuffer.length > MAX_AUDIO_FRAME_BYTES) {
    closeClient(client, 1009, "Audio frame is too large");
    return;
  }
  // If Antigravity session was not explicitly started via JSON command, start it automatically
  if (!client.antigravity) {
    const model = "models/proactive-observer-v10";
    if (!(await authorizeClientModel(client, model))) return;
    const session = createClientSession(client, model, {
      continuous: true,
    });
    client.antigravity = session;
    void session.start().catch((err) => {
      if (client.antigravity !== session) return;
      audioLogger.error(`Auto-start Antigravity session failed: ${err}`);
      client.send({ type: "antigravity_error", event: "error", message: err.message || String(err) });
      finishClientSpend(client, "failure");
      destroyClientSession(client);
    });
  }

  if (!client.antigravity.sendChunk(pcmBuffer)) {
    closeClient(client, 1009, "Queued audio limit exceeded");
  }
}

async function runTestSample(client: AudioWsClient, _lang: string): Promise<void> {
  const samplePath = "/tmp/test_hello.wav";
  if (!fs.existsSync(samplePath)) {
    try {
      cp.execSync(
        'say -o /tmp/test_hello.aiff "Hello Antigravity, testing audio transcription" && afconvert -f WAVE -d LEI16@16000 /tmp/test_hello.aiff /tmp/test_hello.wav',
      );
    } catch {
      client.send({
        type: "antigravity_error",
        message: "No test sample found and afconvert not available.",
      });
      return;
    }
  }

  const wav = fs.readFileSync(samplePath);
  const rawPcm = wav.subarray(44);

  await handleClientCommand(client, {
    type: "start",
    language: "en",
    deepgramApiKey: process.env.DEEPGRAM_API_KEY,
  });

  let attempts = 0;
  while ((!client.antigravity || !client.antigravity.sessionId) && attempts++ < 60) {
    await new Promise((r) => setTimeout(r, 50));
  }

  const chunkSize = 3200; // 100ms
  for (let i = 0; i < rawPcm.length; i += chunkSize) {
    const chunk = rawPcm.subarray(i, Math.min(i + chunkSize, rawPcm.length));
    await handleAudioChunk(client, chunk);
    await new Promise((r) => setTimeout(r, 40));
  }

  await handleClientCommand(client, { type: "stop" });
}

/**
 * Handles WebSocket streaming on /ws, /ws/audio, /v1/audio/transcriptions/stream, or /v1/listen
 */
export async function handleAudioWebSocket(req: IncomingMessage, socket: Duplex): Promise<void> {
  const auth = await authenticateVirtualKey(req);
  if (!auth.authenticated) {
    const statusCode = auth.statusCode || 401;
    const body = JSON.stringify({
      error: {
        message: auth.error || "Authentication failed",
        type: statusCode === 403 ? "permission_error" : "authentication_error",
      },
    });
    socket.end(
      `HTTP/1.1 ${statusCode} ${statusCode === 403 ? "Forbidden" : "Unauthorized"}\r\n` +
        "Content-Type: application/json\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        "Connection: close\r\n\r\n" +
        body,
    );
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " +
      accept +
      "\r\n\r\n",
  );

  const client: AudioWsClient = {
    socket,
    antigravity: null,
    authorizeModel: (model) => authenticateVirtualKey(req, model),
    apiKeyHash: auth.key?.tokenHash || (auth.rawKey ? hashKey(auth.rawKey) : null),
    requesterIp: req.socket?.remoteAddress || null,
    spendStartedAt: null,
    spendModel: "models/proactive-observer-v10",
    closed: false,
    tStartTime: null,
    tFirstAntigravity: null,
    tStopTime: null,
    send(obj: unknown) {
      try {
        const str = JSON.stringify(obj);
        const buf = Buffer.from(str, "utf8");
        let header: Buffer;
        if (buf.length < 126) {
          header = Buffer.alloc(2);
          header[0] = 0x81;
          header[1] = buf.length;
        } else if (buf.length < 65536) {
          header = Buffer.alloc(4);
          header[0] = 0x81;
          header[1] = 126;
          header.writeUInt16BE(buf.length, 2);
        } else {
          header = Buffer.alloc(10);
          header[0] = 0x81;
          header[1] = 127;
          header.writeBigUInt64BE(BigInt(buf.length), 2);
        }
        socket.write(Buffer.concat([header, buf]));
      } catch {
        // socket write error or closed
      }
    },
  };

  // Send initial system info
  const creds = getAntigravityCredentials();
  client.send({
    type: "system_status",
    event: "system_status",
    antigravity: { detected: true, port: creds.port },
  });

  let incomingBuffer = Buffer.alloc(0);
  let processing = false;

  const processFrames = async (): Promise<void> => {
    if (processing || client.closed) return;
    processing = true;
    try {
      while (incomingBuffer.length >= 2 && !client.closed) {
      const firstByte = incomingBuffer[0];
      const secondByte = incomingBuffer[1];
      const opcode = firstByte & 0x0f;
      const isMasked = (secondByte & 0x80) !== 0;
      let payloadLength = secondByte & 0x7f;

      let offset = 2;
      if (payloadLength === 126) {
        if (incomingBuffer.length < 4) break;
        payloadLength = incomingBuffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (incomingBuffer.length < 10) break;
        const largePayloadLength = incomingBuffer.readBigUInt64BE(2);
        if (largePayloadLength > BigInt(MAX_AUDIO_FRAME_BYTES)) {
          closeClient(client, 1009, "WebSocket frame is too large");
          incomingBuffer = Buffer.alloc(0);
          return;
        }
        payloadLength = Number(largePayloadLength);
        offset = 10;
      }

      if (payloadLength > MAX_AUDIO_FRAME_BYTES) {
        closeClient(client, 1009, "WebSocket frame is too large");
        incomingBuffer = Buffer.alloc(0);
        return;
      }

      const maskLength = isMasked ? 4 : 0;
      if (incomingBuffer.length < offset + maskLength + payloadLength) break;

      let mask: Buffer | null = null;
      if (isMasked) {
        mask = incomingBuffer.subarray(offset, offset + 4);
        offset += 4;
      }

      const rawPayload = incomingBuffer.subarray(offset, offset + payloadLength);
      incomingBuffer = incomingBuffer.subarray(offset + payloadLength);

      const payload = Buffer.alloc(payloadLength);
      if (isMasked && mask) {
        for (let i = 0; i < payloadLength; i++) {
          payload[i] = rawPayload[i] ^ mask[i % 4];
        }
      } else {
        rawPayload.copy(payload);
      }

      // Handle frame
      if (opcode === 8) {
        // Close
        client.closed = true;
        cleanupClient(client);
        socket.end();
        break;
      } else if (opcode === 9) {
        // Ping -> Pong
        const pong = Buffer.alloc(2);
        pong[0] = 0x8a;
        pong[1] = 0;
        socket.write(pong);
      } else if (opcode === 1) {
        // Text frame (JSON command)
        try {
          const cmd = JSON.parse(payload.toString("utf8"));
          await handleClientCommand(client, cmd);
        } catch (e) {
          audioLogger.error(`Error processing text frame: ${e}`);
        }
      } else if (opcode === 2) {
        // Binary frame (Audio PCM 16kHz Chunk)
        await handleAudioChunk(client, payload);
      }
      if (client.closed) {
        incomingBuffer = Buffer.alloc(0);
        return;
      }
      }
    } finally {
      processing = false;
    }
  };

  socket.on("data", (chunk: Buffer) => {
    if (client.closed) return;
    if (incomingBuffer.length + chunk.length > MAX_WS_INCOMING_BUFFER_BYTES) {
      closeClient(client, 1009, "WebSocket input buffer is too large");
      incomingBuffer = Buffer.alloc(0);
      return;
    }
    incomingBuffer = Buffer.concat([incomingBuffer, chunk]);
    void processFrames();
  });

  socket.on("close", () => {
    client.closed = true;
    cleanupClient(client);
    incomingBuffer = Buffer.alloc(0);
  });

  socket.on("error", () => {
    client.closed = true;
    cleanupClient(client);
    incomingBuffer = Buffer.alloc(0);
  });
}
