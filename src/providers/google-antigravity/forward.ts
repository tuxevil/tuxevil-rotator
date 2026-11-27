// Google Antigravity request forwarding: build the upstream v1internal SSE
// request with credential swapping + endpoint cascade, and parse the SSE
// stream events (usage + visible text).

import {
  ANTIGRAVITY_ENDPOINTS,
  REQUEST_USER_AGENT,
  applyModelAlias,
} from "../../types.js";
import type { AccountRuntime } from "../../types.js";
import type { RequestBody, ForwardedResponse } from "../../proxy.js";
import { logger } from "../../logger.js";
import type { TokenUsage } from "../adapter.js";
import { DEFAULT_PROVIDER, getProviderProjectId } from "../credential-helpers.js";
import { getAccountProxyDispatcher } from "../proxy-dispatcher.js";
import {
  ANTIGRAVITY_HEADERS_TIMEOUT_MS,
  fetchWithHeadersTimeout,
  isRetryableFetchError,
  runWithAntigravityApiRetry,
  type AntigravityApiRetryOptions,
  type RequestInitWithDispatcher,
} from "../../fetch-with-retry.js";
import {
  extractRetryDelayMs,
  isAntigravityRetryableError,
} from "../../rate-limit-parser.js";
import { applyAntigravityTwinPayload } from "./twin-payload.js";
import {
  forwardAicodeRequestOnce,
  resolveAicodeTarget,
} from "./aicode-forward.js";

const forwardLogger = logger.child("google-forward");

/** Max bytes kept in the SSE event buffer. A single event is rarely >1MB;
 *  if it is, we keep the last 1MB which is still enough to find usage. */
const SSE_EVENT_BUFFER_MAX = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursively search a parsed JSON value for the first usage block we
 *  recognise. Supports Gemini (usageMetadata), OpenAI (usage with
 *  prompt_tokens/completion_tokens), and Anthropic (usage with
 *  input_tokens/output_tokens). */
function findUsageInJson(
  value: unknown,
): TokenUsage | null {
  if (!isRecord(value)) return null;

  // Gemini format
  const usageMetadata = isRecord(value.usageMetadata)
    ? value.usageMetadata
    : null;
  if (usageMetadata) {
    const input =
      typeof usageMetadata.promptTokenCount === "number"
        ? usageMetadata.promptTokenCount
        : typeof usageMetadata.inputTokenCount === "number"
          ? usageMetadata.inputTokenCount
          : 0;
    const output =
      typeof usageMetadata.candidatesTokenCount === "number"
        ? usageMetadata.candidatesTokenCount
        : typeof usageMetadata.outputTokenCount === "number"
          ? usageMetadata.outputTokenCount
          : 0;
    const cached =
      typeof usageMetadata.cachedContentTokenCount === "number"
        ? usageMetadata.cachedContentTokenCount
        : typeof usageMetadata.cached_tokens === "number"
          ? usageMetadata.cached_tokens
          : undefined;
    if (input > 0 || output > 0)
      return {
        inputTokens: input,
        outputTokens: output,
        ...(cached !== undefined ? { cachedTokens: cached } : {}),
      };
  }
  // OpenAI / Anthropic format
  const usage = value.usage;
  if (isRecord(usage)) {
    const input =
      typeof usage.prompt_tokens === "number"
        ? usage.prompt_tokens
        : typeof usage.input_tokens === "number"
          ? usage.input_tokens
          : 0;
    const output =
      typeof usage.completion_tokens === "number"
        ? usage.completion_tokens
        : typeof usage.output_tokens === "number"
          ? usage.output_tokens
          : 0;
    const cached =
      isRecord(usage.prompt_tokens_details) &&
      typeof usage.prompt_tokens_details.cached_tokens === "number"
        ? usage.prompt_tokens_details.cached_tokens
        : typeof usage.cached_tokens === "number"
          ? usage.cached_tokens
          : typeof usage.cache_read_input_tokens === "number"
            ? usage.cache_read_input_tokens
            : undefined;
    if (input > 0 || output > 0)
      return {
        inputTokens: input,
        outputTokens: output,
        ...(cached !== undefined ? { cachedTokens: cached } : {}),
      };
  }
  // Recurse into common nesting locations.
  for (const key of ["candidates", "output", "response", "message"]) {
    const child = value[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        const found = findUsageInJson(item);
        if (found) return found;
      }
    } else if (isRecord(child)) {
      const found = findUsageInJson(child);
      if (found) return found;
    }
  }
  return null;
}

/** Extract usage from a single complete SSE event (one or more `data:` lines
 *  separated by newlines, terminated by a blank line). The last successful
 *  extraction wins (callers should stop scanning once they find usage). */
export function extractUsageFromSseEvent(
  eventText: string,
): TokenUsage | null {
  const dataLines: string[] = [];
  for (const raw of eventText.split("\n")) {
    if (raw.startsWith("data:")) {
      dataLines.push(raw.slice(5).trim());
    }
  }
  if (dataLines.length === 0) return null;
  const payload = dataLines.join("\n");
  if (payload === "[DONE]" || payload === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    // Fall back to regex on the raw event text. This handles non-standard
    // streams that don't quite produce valid JSON per event.
    return regexExtractUsage(payload);
  }
  return findUsageInJson(parsed);
}

/** Last-resort regex extraction for streams that don't yield parseable JSON. */
function regexExtractUsage(buffer: string): TokenUsage | null {
  try {
    const patterns = [
      /"promptTokenCount"\s*:\s*(\d+).*?"candidatesTokenCount"\s*:\s*(\d+)/s,
      /"input_tokens"\s*:\s*(\d+).*?"output_tokens"\s*:\s*(\d+)/s,
    ];
    for (const pattern of patterns) {
      const match = buffer.match(pattern);
      if (match) {
        return {
          inputTokens: parseInt(match[1], 10),
          outputTokens: parseInt(match[2], 10),
        };
      }
    }
  } catch {
    /* extraction failed */
  }
  return null;
}

function extractTextFromSseEvent(eventText: string): string | null {
  const dataLines: string[] = [];
  for (const raw of eventText.split("\n")) {
    if (raw.startsWith("data:")) {
      dataLines.push(raw.slice(5).trim());
    }
  }
  if (dataLines.length === 0) return null;
  const payload = dataLines.join("\n");
  if (payload === "[DONE]" || payload === "") return null;
  try {
    const parsed = JSON.parse(payload);
    if (parsed && typeof parsed === "object") {
      const p = isRecord(parsed.response) ? parsed.response : parsed;
      if (
        Array.isArray(p.candidates) &&
        p.candidates[0] &&
        typeof p.candidates[0] === "object"
      ) {
        const cand = p.candidates[0] as Record<string, unknown>;
        if (cand.content && typeof cand.content === "object") {
          const content = cand.content as Record<string, unknown>;
          if (Array.isArray(content.parts)) {
            return content.parts
              .map((part) =>
                part &&
                typeof part === "object" &&
                (part as Record<string, unknown>).thought !== true &&
                typeof (part as Record<string, unknown>).text === "string"
                  ? (part as Record<string, unknown>).text
                  : "",
              )
              .join("");
          }
        }
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** State for the SSE event accumulator used by streamResponseBody. */
export class SseEventAccumulator {
  private buffer = "";
  private accumulatedText = "";
  private readonly maxBytes: number;
  constructor(maxBytes: number = SSE_EVENT_BUFFER_MAX) {
    this.maxBytes = maxBytes;
  }

  /** Append a chunk, return any usage extracted from newly-completed events. */
  append(chunkText: string): TokenUsage | null {
    this.buffer += chunkText;
    if (this.buffer.length > this.maxBytes) {
      this.buffer = this.buffer.slice(-this.maxBytes);
    }
    let extracted: TokenUsage | null = null;
    let boundary = this.buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const eventText = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const usage = extractUsageFromSseEvent(eventText);
      if (usage && !extracted) extracted = usage;
      const text = extractTextFromSseEvent(eventText);
      if (text && this.accumulatedText.length < 100000) {
        this.accumulatedText += text;
      }
      boundary = this.buffer.indexOf("\n\n");
    }
    return extracted;
  }

  getText(): string {
    return this.accumulatedText;
  }

  /** Flush any partial event at end-of-stream. */
  final(): TokenUsage | null {
    if (!this.buffer) return null;
    const usage = extractUsageFromSseEvent(this.buffer);
    const text = extractTextFromSseEvent(this.buffer);
    if (text && this.accumulatedText.length < 100000) {
      this.accumulatedText += text;
    }
    this.buffer = "";
    return usage;
  }
}

const BENCHMARK_MODEL = "gemini-3-flash";
const BENCHMARK_PROMPT = "Reply with exactly: OK";
const BENCHMARK_MAX_OUTPUT_TOKENS = 16;
const BENCHMARK_TIMEOUT_MS = 30_000;

function benchmarkRequestBody(account: AccountRuntime): RequestBody {
  return applyAntigravityTwinPayload({
    project: getProviderProjectId(account.config, DEFAULT_PROVIDER),
    model: BENCHMARK_MODEL,
    request: {
      contents: [
        {
          role: "user",
          parts: [{ text: BENCHMARK_PROMPT }],
        },
      ],
      generationConfig: {
        maxOutputTokens: BENCHMARK_MAX_OUTPUT_TOKENS,
      },
    },
  });
}

function benchmarkUsage(raw: string): { outputTokens: number } | null {
  let outputTokens = 0;
  for (const event of raw.split(/\r?\n\r?\n/)) {
    const usage = extractUsageFromSseEvent(event);
    if (usage) {
      // Antigravity repeats cumulative usage in content and final events.
      outputTokens = Math.max(outputTokens, usage.outputTokens);
    }
  }
  return { outputTokens };
}

export function getBenchmarkSpec(account: AccountRuntime): {
  body: RequestBody;
  parseUsage(raw: string): { outputTokens: number } | null;
  parseText(raw: string): string;
} {
  return {
    body: benchmarkRequestBody(account),
    parseUsage: benchmarkUsage,
    parseText: (raw: string) => {
      const lines: string[] = [];
      for (const event of raw.split(/\r?\n\r?\n/)) {
        const text = extractTextFromSseEvent(event);
        if (text) lines.push(text);
      }
      return lines.join("");
    },
  };
}

export const GOOGLE_BENCHMARK_CONSTANTS = {
  model: BENCHMARK_MODEL,
  prompt: BENCHMARK_PROMPT,
  maxOutputTokens: BENCHMARK_MAX_OUTPUT_TOKENS,
  timeoutMs: BENCHMARK_TIMEOUT_MS,
} as const;

export interface ForwardRequestOptions {
  /**
   * Controls Antigravity single-account / non-rotating retry handling via
   * `runWithAntigravityApiRetry`. Defaults to true for standalone calls; pass
   * `{ apiRetry: false }` when an outer multi-account rotation loop owns retries.
   */
  apiRetry?:
    | boolean
    | Partial<Omit<AntigravityApiRetryOptions<ForwardedResponse>, "fn">>;
}

/**
 * Strict Antigravity CCPA wire header allowlist (twin to `ccpahttp` +
 * `codeassistclient.setHeaders`): never leak third-party SDK or proxy headers.
 */
export function buildAntigravityWireHeaders(
  account: AccountRuntime,
  originalHeaders: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${account.accessToken ?? ""}`,
    "User-Agent": REQUEST_USER_AGENT,
  };
  let requestReason = "";
  let userProjectHeader = "";
  for (const [key, value] of Object.entries(originalHeaders)) {
    const lower = key.toLowerCase();
    if (lower === "x-goog-request-reason" && typeof value === "string" && value.trim()) {
      requestReason = value.trim();
    } else if (lower === "x-goog-user-project" && typeof value === "string" && value.trim()) {
      userProjectHeader = value.trim();
    }
  }
  requestReason ||= process.env.GOOG_REQUEST_REASON?.trim() || "";
  // Never default to the account projectId: Google-managed Antigravity projects
  // lack the Cloud Code Private API for billing and answer 403 PERMISSION_DENIED.
  userProjectHeader ||= process.env.GOOG_USER_PROJECT?.trim() || "";
  if (requestReason) {
    headers["X-Goog-Request-Reason"] = requestReason;
  }
  if (userProjectHeader) {
    headers["X-Goog-User-Project"] = userProjectHeader;
  }
  return headers;
}

class RetryableAntigravityHttpError extends Error {
  readonly status: number;
  readonly serverRetryDelayMs?: number;
  readonly fallbackResult: ForwardedResponse;

  constructor(
    status: number,
    message: string,
    serverRetryDelayMs: number | undefined,
    fallbackResult: ForwardedResponse,
  ) {
    super(message);
    this.name = "RetryableAntigravityHttpError";
    this.status = status;
    this.serverRetryDelayMs = serverRetryDelayMs;
    this.fallbackResult = fallbackResult;
  }
}

async function forwardRequestOnce(
  account: AccountRuntime,
  forwardHeaders: Record<string, string>,
  requestBody: string,
  signal?: AbortSignal,
): Promise<ForwardedResponse> {
  // Try endpoints with cascade only on 404 (missing route), never replaying 401/403
  for (
    let endpointIdx = 0;
    endpointIdx < ANTIGRAVITY_ENDPOINTS.length;
    endpointIdx++
  ) {
    const endpoint = ANTIGRAVITY_ENDPOINTS[endpointIdx];
    const url = `${endpoint}/v1internal:streamGenerateContent?alt=sse`;
    const isProd = endpointIdx === ANTIGRAVITY_ENDPOINTS.length - 1;

    const controller = !isProd ? new AbortController() : undefined;
    const timeout = controller
      ? setTimeout(() => controller.abort(), 10_000)
      : undefined;
    try {
      const requestSignal =
        controller?.signal && signal
          ? AbortSignal.any([controller.signal, signal])
          : signal ?? controller?.signal;

      const response = await fetchWithHeadersTimeout(url, {
        method: "POST",
        headers: forwardHeaders,
        body: requestBody,
        signal: requestSignal,
        timeoutMs: ANTIGRAVITY_HEADERS_TIMEOUT_MS,
        dispatcher: getAccountProxyDispatcher(account, "google-antigravity"),
      } as RequestInitWithDispatcher);

      if (
        response.status === 404 &&
        endpointIdx < ANTIGRAVITY_ENDPOINTS.length - 1
      ) {
        forwardLogger.log("info",
          `Endpoint ${endpoint} returned ${response.status}, cascading...`,
        );
        await response.body?.cancel().catch(() => undefined);
        continue;
      }

      return { response, endpoint };
    } catch (err) {
      if (signal?.aborted) throw err;
      if (endpointIdx < ANTIGRAVITY_ENDPOINTS.length - 1) {
        forwardLogger.log("info",
          `Endpoint ${endpoint} failed: ${
            err instanceof Error ? err.message : err
          }, cascading...`,
        );
        continue;
      }
      throw err;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  throw new Error("All endpoints failed");
}

const ERROR_BODY_READ_TIMEOUT_MS = 500;
const ERROR_BODY_MAX_BYTES = 262_144;

async function readBoundedErrorResponseText(
  response: Response,
  signal?: AbortSignal,
  timeoutMs = ERROR_BODY_READ_TIMEOUT_MS,
  maxBytes = ERROR_BODY_MAX_BYTES,
): Promise<{ text: string; truncatedOrTimedOut: boolean }> {
  const cloned = response.clone();
  if (!cloned.body) {
    const text = await cloned.text().catch(() => "");
    return { text, truncatedOrTimedOut: false };
  }
  const reader = cloned.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let totalBytes = 0;
  let truncatedOrTimedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    timer.unref?.();
  });
  const aborted = signal
    ? new Promise<"abort">((resolve) => {
        if (signal.aborted) {
          resolve("abort");
          return;
        }
        onAbort = () => resolve("abort");
        signal.addEventListener("abort", onAbort, { once: true });
      })
    : null;

  try {
    while (true) {
      const racers: Array<Promise<ReadableStreamReadResult<Uint8Array> | "timeout" | "abort">> = [
        reader.read(),
        deadline,
      ];
      if (aborted) racers.push(aborted);
      const step = await Promise.race(racers);
      if (step === "timeout" || step === "abort") {
        truncatedOrTimedOut = true;
        break;
      }
      if (step.done) break;
      const chunk = step.value;
      if (chunk.byteLength > 0) {
        const remaining = maxBytes - totalBytes;
        if (remaining <= 0) {
          truncatedOrTimedOut = true;
          break;
        }
        const slice = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
        totalBytes += slice.byteLength;
        text += decoder.decode(slice, { stream: true });
        if (totalBytes >= maxBytes) {
          truncatedOrTimedOut = true;
          break;
        }
      }
    }
    text += decoder.decode();
  } catch {
    // Ignore stream read errors on error payloads; return whatever was buffered.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    // Do not await branch cancel before the caller cancels the original body;
    // in WHATWG ReadableStream tee(), awaiting one branch can wait for the other.
    void reader.cancel().catch(() => undefined);
  }
  return { text, truncatedOrTimedOut };
}

/**
 * Forward a request to the real Antigravity endpoint with credential swapping.
 */
export async function forwardRequest(
  account: AccountRuntime,
  body: RequestBody,
  originalHeaders: Record<string, string>,
  signal?: AbortSignal,
  options?: ForwardRequestOptions,
): Promise<ForwardedResponse> {
  // Swap credentials
  body.project = getProviderProjectId(account.config, DEFAULT_PROVIDER);

  // Map internal display/compat names to Google upstream names (single source
  // of truth: src/types.ts:applyModelAlias)
  body.model = applyModelAlias(body.model);

  const {
    displayModel: _displayModel,
    requestedModel: _requestedModel,
    catalogModel: _catalogModel,
    providerId: _providerId,
    selectionMode: _selectionMode,
    selectionConfidence: _selectionConfidence,
    selectionReason: _selectionReason,
    preservePrompt,
    ...strippedBody
  } = body;
  const bodyToForward = applyAntigravityTwinPayload(strippedBody, {
    skipPromptInjection: preservePrompt === true,
  });
  const requestBody = JSON.stringify(bodyToForward);
  const forwardHeaders = buildAntigravityWireHeaders(account, originalHeaders);

  const executeOnce = async (): Promise<ForwardedResponse> => {
    const aicodeTarget = await resolveAicodeTarget(
      account,
      body.model,
      originalHeaders,
      signal,
    );
    if (aicodeTarget) {
      const { result, scopeInsufficientFallback } = await forwardAicodeRequestOnce(
        account,
        aicodeTarget,
        bodyToForward,
        originalHeaders,
        signal,
        readBoundedErrorResponseText,
      );
      if (!scopeInsufficientFallback) {
        return result;
      }
    }
    return forwardRequestOnce(account, forwardHeaders, requestBody, signal);
  };

  const retrySpec = options?.apiRetry;
  if (retrySpec === false) {
    return executeOnce();
  }

  const retryOptions =
    typeof retrySpec === "object" && retrySpec !== null ? retrySpec : {};
  const label = account.config.label || account.config.email;

  try {
    return await runWithAntigravityApiRetry({
      ...retryOptions,
      signal: retryOptions.signal ?? signal,
      classifyError: (error) => {
        if (error instanceof RetryableAntigravityHttpError) {
          return {
            retryable: true,
            serverRetryDelayMs: error.serverRetryDelayMs,
          };
        }
        return { retryable: isRetryableFetchError(error) };
      },
      onRetry: (info) => {
        forwardLogger.log(
          "warn",
          `[${label}] Single-account Antigravity retry #${info.attempt + 1} in ${info.delayMs}ms`,
        );
        retryOptions.onRetry?.(info);
      },
      fn: async () => {
        const result = await executeOnce();
        const status = result.response.status;
        if (status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
          const { text: errorText, truncatedOrTimedOut } = await readBoundedErrorResponseText(
            result.response,
            signal,
          );
          if (signal?.aborted) {
            await result.response.body?.cancel().catch(() => undefined);
            throw signal.reason ?? new DOMException("Aborted", "AbortError");
          }
          if (
            isAntigravityRetryableError({
              status,
              errorText,
              headers: result.response.headers,
            })
          ) {
            const serverRetryDelayMs =
              extractRetryDelayMs(errorText, result.response.headers) ?? undefined;
            const fallbackResponse = new Response(errorText, {
              status: result.response.status,
              statusText: result.response.statusText,
              headers: result.response.headers,
            });
            await result.response.body?.cancel().catch(() => undefined);
            throw new RetryableAntigravityHttpError(
              status,
              errorText || `HTTP ${status}`,
              serverRetryDelayMs,
              { response: fallbackResponse, endpoint: result.endpoint },
            );
          }
          if (truncatedOrTimedOut) {
            await result.response.body?.cancel().catch(() => undefined);
            return {
              endpoint: result.endpoint,
              response: new Response(errorText, {
                status: result.response.status,
                statusText: result.response.statusText,
                headers: result.response.headers,
              }),
            };
          }
        }
        return result;
      },
    });
  } catch (err) {
    if (err instanceof RetryableAntigravityHttpError) {
      return err.fallbackResult;
    }
    throw err;
  }
}

export function createGoogleStreamAccumulator(): SseEventAccumulator {
  return new SseEventAccumulator();
}
