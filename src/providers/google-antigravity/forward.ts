// Google Antigravity request forwarding: build the upstream v1internal SSE
// request with credential swapping + endpoint cascade, and parse the SSE
// stream events (usage + visible text).

import {
  ANTIGRAVITY_ENDPOINTS,
  REQUEST_CLIENT_METADATA,
  REQUEST_GOOG_API_CLIENT,
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
  fetchWithHeadersTimeout,
  type RequestInitWithDispatcher,
} from "../../fetch-with-retry.js";

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
      return { inputTokens: input, outputTokens: output, cachedTokens: cached };
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
      return { inputTokens: input, outputTokens: output, cachedTokens: cached };
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
      const p = parsed as Record<string, unknown>;
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
  return {
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
  };
}

function benchmarkUsage(raw: string): { outputTokens: number } | null {
  let outputTokens = 0;
  for (const event of raw.split(/\r?\n\r?\n/)) {
    const usage = extractUsageFromSseEvent(event);
    if (usage) {
      outputTokens += usage.outputTokens;
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

/**
 * Forward a request to the real Antigravity endpoint with credential swapping.
 */
export async function forwardRequest(
  account: AccountRuntime,
  body: RequestBody,
  originalHeaders: Record<string, string>,
  signal?: AbortSignal,
): Promise<ForwardedResponse> {
  // Swap credentials
  body.project = getProviderProjectId(account.config, DEFAULT_PROVIDER);

  // Map internal display/compat names to Google upstream names (single source
  // of truth: src/types.ts:applyModelAlias)
  body.model = applyModelAlias(body.model);

  const { displayModel: _displayModel, ...bodyToForward } = body;
  const requestBody = JSON.stringify(bodyToForward);

  // Build headers: keep originals but swap Authorization
  const forwardHeaders: Record<string, string> = {
    ...originalHeaders,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  // Remove original authorization (any case), provider-set headers, and
  // hop-by-hop headers per RFC 7230 §6.1. The hop-by-hop list prevents
  // leaking client IP (X-Forwarded-For) and prevents IP spoofing in
  // upstream logs (Via).
  const HOP_BY_HOP = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    // Forwarding / proxying artefacts that should never reach the upstream
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-forwarded-port",
    "x-real-ip",
    "forwarded",
    "via",
  ]);
  for (const key of Object.keys(forwardHeaders)) {
    const lowerKey = key.toLowerCase();
    if (
      HOP_BY_HOP.has(lowerKey) ||
      lowerKey === "authorization" ||
      lowerKey === "user-agent" ||
      lowerKey === "x-goog-api-client" ||
      lowerKey === "client-metadata"
    ) {
      delete forwardHeaders[key];
    }
  }
  forwardHeaders["Authorization"] = `Bearer ${account.accessToken}`;
  forwardHeaders["User-Agent"] = REQUEST_USER_AGENT;
  forwardHeaders["X-Goog-Api-Client"] = REQUEST_GOOG_API_CLIENT;
  forwardHeaders["Client-Metadata"] = REQUEST_CLIENT_METADATA;
  // Claude models on Cloud Code Assist (Antigravity) require this beta header to
  // return interleaved thinking blocks. Mirrors pi-mono's needsClaudeThinkingBetaHeader.
  if (/^claude-/i.test(body.model)) {
    forwardHeaders["anthropic-beta"] = "interleaved-thinking-2025-05-14";
  }
  delete forwardHeaders["host"];
  delete forwardHeaders["connection"];
  delete forwardHeaders["transfer-encoding"];
  delete forwardHeaders["content-length"];

  // Try endpoints with cascade on 401/403/404
  for (
    let endpointIdx = 0;
    endpointIdx < ANTIGRAVITY_ENDPOINTS.length;
    endpointIdx++
  ) {
    const endpoint = ANTIGRAVITY_ENDPOINTS[endpointIdx];
    const url = `${endpoint}/v1internal:streamGenerateContent?alt=sse`;
    const isProd = endpointIdx === ANTIGRAVITY_ENDPOINTS.length - 1;

    try {
      const controller = !isProd ? new AbortController() : undefined;
      const timeout = controller
        ? setTimeout(() => controller.abort(), 10_000)
        : undefined;
      const requestSignal =
        controller?.signal && signal
          ? AbortSignal.any([controller.signal, signal])
          : signal ?? controller?.signal;

      const response = await fetchWithHeadersTimeout(url, {
        method: "POST",
        headers: forwardHeaders,
        body: requestBody,
        signal: requestSignal,
        dispatcher: getAccountProxyDispatcher(account, "google-antigravity"),
      } as RequestInitWithDispatcher);
      if (timeout) clearTimeout(timeout);

      if (
        (response.status === 401 ||
          response.status === 403 ||
          response.status === 404) &&
        endpointIdx < ANTIGRAVITY_ENDPOINTS.length - 1
      ) {
        forwardLogger.log("info",
          `Endpoint ${endpoint} returned ${response.status}, cascading...`,
        );
        response.text().catch(() => {});
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
    }
  }

  throw new Error("All endpoints failed");
}

export function createGoogleStreamAccumulator(): SseEventAccumulator {
  return new SseEventAccumulator();
}
