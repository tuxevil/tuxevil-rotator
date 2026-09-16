// OpenCode Zen request forwarding and SSE stream accumulation.

import { randomUUID } from "node:crypto";
import type { AccountRuntime } from "../../types.js";
import type { ForwardedResponse, RequestBody } from "../../proxy.js";
import type { StreamAccumulator, TokenUsage } from "../adapter.js";
import { getAccountProxyDispatcher } from "../proxy-dispatcher.js";
import {
  fetchWithHeadersTimeout,
  type RequestInitWithDispatcher,
} from "../../fetch-with-retry.js";
import { getOpenCodeZenApiKey, OPENCODE_ZEN_PROVIDER_ID } from "./credentials.js";
import {
  isOpenCodeZenResponsesModel,
  OPENCODE_ZEN_CHAT_URL,
  OPENCODE_ZEN_RESPONSES_URL,
} from "./catalog.js";
import { isRecord } from "../../compat/schema-sanitizer.js";
import type {
  CompatCompletion,
  OpenAIToolCall,
} from "../google-antigravity/translators.js";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-real-ip",
  "forwarded",
  "via",
]);

export function buildOpenCodeZenPayload(body: RequestBody): Record<string, unknown> {
  const request = isRecord(body.request) ? body.request : {};
  // OpenCode Zen does not support the `developer` role (an OpenAI o1/o3 extension).
  // Normalise it to `system` so the upstream deserialises the request correctly.
  const messages = Array.isArray(request.messages)
    ? (request.messages as unknown[]).map((msg) => {
        if (isRecord(msg) && msg.role === "developer") {
          return { ...msg, role: "system" };
        }
        return msg;
      })
    : request.messages;
  return {
    ...request,
    ...(messages !== request.messages ? { messages } : {}),
    model: body.model,
    stream: Boolean(request.stream),
  };
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (!isRecord(part)) return "";
      return typeof part.text === "string" ? part.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function responsesContent(value: unknown, role: string): unknown {
  if (typeof value === "string") {
    return [{
      type: role === "assistant" ? "output_text" : "input_text",
      text: value,
    }];
  }
  if (!Array.isArray(value)) return value ?? [];
  return value.map((part) => {
    if (!isRecord(part)) return part;
    if (
      part.type === "text" ||
      part.type === "input_text" ||
      part.type === "output_text"
    ) {
      return {
        type: role === "assistant" ? "output_text" : "input_text",
        text: typeof part.text === "string" ? part.text : "",
      };
    }
    if (part.type === "image_url" && isRecord(part.image_url)) {
      return {
        type: "input_image",
        image_url: part.image_url.url,
      };
    }
    return part;
  });
}

function responsesTool(value: unknown): unknown {
  if (!isRecord(value) || value.type !== "function" || !isRecord(value.function)) {
    return value;
  }
  const fn = value.function;
  const tool: Record<string, unknown> = {
    type: "function",
    name: fn.name,
  };
  for (const field of ["description", "parameters", "strict"]) {
    if (fn[field] !== undefined) tool[field] = fn[field];
  }
  return tool;
}

function responsesToolChoice(value: unknown): unknown {
  if (!isRecord(value) || value.type !== "function" || !isRecord(value.function)) {
    return value;
  }
  return { type: "function", name: value.function.name };
}

/** Convert the common Chat Completions envelope into OpenAI Responses input. */
export function buildOpenCodeZenResponsesPayload(
  body: RequestBody,
): Record<string, unknown> {
  const request = isRecord(body.request) ? body.request : {};

  // Keep already-native Responses requests intact. This is useful for callers
  // of /v1/responses and avoids throwing away fields the compatibility layer
  // does not need to interpret.
  if ("input" in request) {
    const payload: Record<string, unknown> = { ...request, model: body.model, store: false };
    if (payload.max_output_tokens === undefined && payload.max_tokens !== undefined) {
      payload.max_output_tokens = payload.max_tokens;
    }
    delete payload.max_tokens;
    return payload;
  }

  const input: unknown[] = [];
  const instructions: string[] = [];
  const messages = Array.isArray(request.messages) ? request.messages : [];

  for (const rawMessage of messages) {
    if (!isRecord(rawMessage)) continue;
    const role = typeof rawMessage.role === "string" ? rawMessage.role : "user";

    if (role === "system" || role === "developer") {
      const text = textFromContent(rawMessage.content);
      if (text) instructions.push(text);
      continue;
    }

    if (role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: rawMessage.tool_call_id,
        output: typeof rawMessage.content === "string"
          ? rawMessage.content
          : JSON.stringify(rawMessage.content ?? ""),
      });
      continue;
    }

    if (Array.isArray(rawMessage.tool_calls)) {
      for (const rawCall of rawMessage.tool_calls) {
        if (!isRecord(rawCall) || !isRecord(rawCall.function)) continue;
        input.push({
          type: "function_call",
          call_id: rawCall.id,
          name: rawCall.function.name,
          arguments: typeof rawCall.function.arguments === "string"
            ? rawCall.function.arguments
            : JSON.stringify(rawCall.function.arguments ?? {}),
        });
      }
    }

    if (rawMessage.content !== undefined && rawMessage.content !== null) {
      input.push({
        role: role === "assistant" ? "assistant" : "user",
        content: responsesContent(rawMessage.content, role),
      });
    }
  }

  const payload: Record<string, unknown> = {
    model: body.model,
    input,
    stream: request.stream === true,
    store: false,
  };
  if (instructions.length > 0) payload.instructions = instructions.join("\n\n");
  if (typeof request.max_output_tokens === "number") {
    payload.max_output_tokens = request.max_output_tokens;
  } else if (typeof request.max_tokens === "number") {
    payload.max_output_tokens = request.max_tokens;
  }
  for (const field of [
    "temperature",
    "top_p",
    "parallel_tool_calls",
    "reasoning",
    "metadata",
    "stop",
  ]) {
    if (request[field] !== undefined) payload[field] = request[field];
  }
  if (typeof request.reasoning_effort === "string" && payload.reasoning === undefined) {
    payload.reasoning = { effort: request.reasoning_effort };
  }
  if (Array.isArray(request.tools) && request.tools.length > 0) {
    payload.tools = request.tools.map(responsesTool);
  }
  if (request.tool_choice !== undefined) {
    payload.tool_choice = responsesToolChoice(request.tool_choice);
  }
  return payload;
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && value.trim()) return value;
  }
  return undefined;
}

function buildOpenCodeZenHeaders(
  originalHeaders: Record<string, string>,
  body: RequestBody,
  account: AccountRuntime,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(originalHeaders)) {
    const lower = key.toLowerCase();
    if (
      !HOP_BY_HOP.has(lower) &&
      lower !== "authorization" &&
      lower !== "content-type" &&
      lower !== "accept"
    ) {
      headers[key] = value;
    }
  }

  // OpenCode's free tier requires these context headers. Native OpenCode
  // emits them only for provider IDs beginning with `opencode`; the rotator
  // is commonly configured under a custom provider ID, so fill safe defaults.
  if (!headerValue(headers, "x-opencode-session")) {
    headers["x-opencode-session"] = `zen-session-${body.requestId || randomUUID()}`;
  }
  if (!headerValue(headers, "x-opencode-request")) {
    headers["x-opencode-request"] = `zen-request-${body.requestId || randomUUID()}`;
  }
  if (!headerValue(headers, "x-opencode-client")) {
    headers["x-opencode-client"] = "tuxevil-rotator";
  }
  if (!headerValue(headers, "user-agent")) {
    headers["User-Agent"] = "tuxevil-rotator/opencode-zen";
  }

  headers.Authorization = `Bearer ${getOpenCodeZenApiKey(account.config) ?? ""}`;
  return headers;
}

export async function forwardRequest(
  account: AccountRuntime,
  body: RequestBody,
  originalHeaders: Record<string, string>,
  signal?: AbortSignal,
): Promise<ForwardedResponse> {
  const usesResponses = isOpenCodeZenResponsesModel(body.model);
  const payload = usesResponses
    ? buildOpenCodeZenResponsesPayload(body)
    : buildOpenCodeZenPayload(body);
  const forwardHeaders = buildOpenCodeZenHeaders(originalHeaders, body, account);
  forwardHeaders["Content-Type"] = "application/json";
  forwardHeaders["Accept"] = payload.stream === true ? "text/event-stream" : "application/json";

  const endpoint = usesResponses ? OPENCODE_ZEN_RESPONSES_URL : OPENCODE_ZEN_CHAT_URL;
  const response = await fetchWithHeadersTimeout(endpoint, {
    method: "POST",
    headers: forwardHeaders,
    body: JSON.stringify(payload),
    signal,
    dispatcher: getAccountProxyDispatcher(account, OPENCODE_ZEN_PROVIDER_ID),
  } as RequestInitWithDispatcher);

  // The compatibility layer normalises all provider responses through the
  // Chat Completions shape before the local endpoint wraps them again. This
  // keeps Chat, Anthropic, and Responses callers on the same parser path.
  if (usesResponses && response.ok) {
    if (payload.stream === true && response.body) {
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.set("content-type", "text/event-stream");
      return {
        response: new Response(
          transformOpenCodeZenResponsesStream(response.body, body.model),
          { status: response.status, statusText: response.statusText, headers },
        ),
        endpoint,
      };
    }
    const raw = await response.text();
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.set("content-type", "application/json");
    return {
      response: new Response(
        JSON.stringify(openCodeZenResponsesToChatJson(raw, body.model)),
        { status: response.status, statusText: response.statusText, headers },
      ),
      endpoint,
    };
  }

  return { response, endpoint };
}

export type OpenCodeZenResponsesUpdate =
  | { kind: "text"; delta: string }
  | { kind: "reasoning"; delta: string }
  | { kind: "tool-start"; index: number; id: string; name: string }
  | { kind: "tool-delta"; index: number; delta: string }
  | { kind: "usage"; usage: TokenUsage }
  | { kind: "finish"; reason?: string }
  | { kind: "error"; message: string };

function responseErrorMessage(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (isRecord(value) && typeof value.message === "string" && value.message.trim()) {
    return value.message.trim();
  }
  return "OpenCode Zen Responses stream failed";
}

function responseFinishReason(value: Record<string, unknown>): string | undefined {
  if (value.status === "incomplete" && isRecord(value.incomplete_details)) {
    return typeof value.incomplete_details.reason === "string"
      ? value.incomplete_details.reason
      : undefined;
  }
  if (value.status === "failed") return "error";
  return undefined;
}

function responseCompletionFromRecord(
  value: Record<string, unknown>,
  rawResponse: unknown = value,
): CompatCompletion {
  let text = "";
  let thinkingText = "";
  const toolCalls: OpenAIToolCall[] = [];
  const output = Array.isArray(value.output) ? value.output : [];

  for (const rawItem of output) {
    if (!isRecord(rawItem)) continue;
    if (rawItem.type === "message" && Array.isArray(rawItem.content)) {
      for (const rawContent of rawItem.content) {
        if (!isRecord(rawContent)) continue;
        if (
          (rawContent.type === "output_text" || rawContent.type === "text") &&
          typeof rawContent.text === "string"
        ) {
          text += rawContent.text;
        } else if (rawContent.type === "refusal" && typeof rawContent.refusal === "string") {
          text += rawContent.refusal;
        }
      }
    }
    if (rawItem.type === "reasoning" && Array.isArray(rawItem.summary)) {
      for (const rawSummary of rawItem.summary) {
        if (isRecord(rawSummary) && typeof rawSummary.text === "string") {
          thinkingText += rawSummary.text;
        }
      }
    }
    if (rawItem.type === "function_call") {
      toolCalls.push({
        id: typeof rawItem.call_id === "string"
          ? rawItem.call_id
          : typeof rawItem.id === "string"
            ? rawItem.id
            : `call_${toolCalls.length}`,
        type: "function",
        function: {
          name: typeof rawItem.name === "string" ? rawItem.name : "unknown",
          arguments: typeof rawItem.arguments === "string"
            ? rawItem.arguments
            : JSON.stringify(rawItem.arguments ?? {}),
        },
      });
    }
  }

  if (!text && typeof value.output_text === "string") text = value.output_text;
  const usage = extractUsageFromRecord(value);
  const error = isRecord(value.error) ? responseErrorMessage(value.error) : undefined;
  return {
    text,
    thinkingText: thinkingText || undefined,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cachedTokens: usage?.cachedTokens,
    responseId: typeof value.id === "string" ? value.id : undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    rawResponse,
    streamError: error,
    finishReason: responseFinishReason(value),
  };
}

export function parseOpenCodeZenResponsesJson(raw: string): CompatCompletion {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return responseCompletionFromRecord(parsed, parsed);
  } catch {
    return {
      text: "",
      inputTokens: 0,
      outputTokens: 0,
      rawResponse: raw,
      streamError: "Invalid OpenCode Zen Responses JSON",
    };
  }
}

/** Parse native OpenAI Responses SSE events into provider-neutral updates. */
export class OpenCodeZenResponsesStreamParser {
  private buffer = "";
  private eventName = "";
  private text = "";
  private thinkingText = "";
  private responseId: string | undefined;
  private usage: TokenUsage | null = null;
  private finishReason: string | undefined;
  private streamError: string | undefined;
  private readonly toolCalls = new Map<number, OpenAIToolCall>();
  private readonly toolItemIndexes = new Map<string, number>();

  append(chunkText: string): OpenCodeZenResponsesUpdate[] {
    this.buffer += chunkText;
    const updates: OpenCodeZenResponsesUpdate[] = [];
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (line.startsWith("event:")) {
        this.eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        if (payload && payload !== "[DONE]") {
          updates.push(...this.processPayload(payload));
        }
      } else if (!line.trim()) {
        this.eventName = "";
      }
      newline = this.buffer.indexOf("\n");
    }
    return updates;
  }

  flush(): OpenCodeZenResponsesUpdate[] {
    if (!this.buffer.trim()) return [];
    return this.append("\n");
  }

  getText(): string {
    return this.text;
  }

  getUsage(): TokenUsage | null {
    return this.usage;
  }

  toCompletion(): CompatCompletion {
    return {
      text: this.text,
      thinkingText: this.thinkingText || undefined,
      inputTokens: this.usage?.inputTokens ?? 0,
      outputTokens: this.usage?.outputTokens ?? 0,
      cachedTokens: this.usage?.cachedTokens,
      responseId: this.responseId,
      toolCalls: this.toolCalls.size > 0 ? Array.from(this.toolCalls.values()) : undefined,
      streamError: this.streamError,
      finishReason: this.finishReason,
      rawResponse: {
        id: this.responseId,
        object: "response",
        output_text: this.text,
        usage: this.usage
          ? {
              input_tokens: this.usage.inputTokens,
              output_tokens: this.usage.outputTokens,
              total_tokens: this.usage.inputTokens + this.usage.outputTokens,
              ...(this.usage.cachedTokens !== undefined
                ? { input_tokens_details: { cached_tokens: this.usage.cachedTokens } }
                : {}),
            }
          : undefined,
      },
    };
  }

  private processPayload(payload: string): OpenCodeZenResponsesUpdate[] {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return [];
    }
    const type = this.eventName || (typeof parsed.type === "string" ? parsed.type : "");
    const response = isRecord(parsed.response) ? parsed.response : null;
    if (response && typeof response.id === "string") this.responseId = response.id;
    if (!this.responseId && typeof parsed.id === "string") this.responseId = parsed.id;

    if (type === "response.output_text.delta" && typeof parsed.delta === "string") {
      this.text += parsed.delta;
      return [{ kind: "text", delta: parsed.delta }];
    }
    if (
      type === "response.reasoning_summary_text.delta" &&
      typeof parsed.delta === "string"
    ) {
      this.thinkingText += parsed.delta;
      return [{ kind: "reasoning", delta: parsed.delta }];
    }
    if (type === "response.output_item.added" && isRecord(parsed.item)) {
      const item = parsed.item;
      if (item.type !== "function_call") return [];
      const index = typeof parsed.output_index === "number"
        ? parsed.output_index
        : this.toolCalls.size;
      const itemId = typeof item.id === "string" ? item.id : undefined;
      if (itemId) this.toolItemIndexes.set(itemId, index);
      if (this.toolCalls.has(index)) return [];
      const call: OpenAIToolCall = {
        id: typeof item.call_id === "string"
          ? item.call_id
          : itemId || `call_${index}`,
        type: "function",
        function: {
          name: typeof item.name === "string" ? item.name : "unknown",
          arguments: typeof item.arguments === "string" ? item.arguments : "",
        },
      };
      this.toolCalls.set(index, call);
      return [{
        kind: "tool-start",
        index,
        id: call.id,
        name: call.function.name,
      }];
    }
    if (
      type === "response.function_call_arguments.delta" &&
      typeof parsed.delta === "string"
    ) {
      const index = this.toolIndex(parsed);
      const call = this.ensureTool(index);
      call.function.arguments += parsed.delta;
      return [{ kind: "tool-delta", index, delta: parsed.delta }];
    }
    if (type === "response.output_item.done" && isRecord(parsed.item)) {
      const item = parsed.item;
      if (item.type !== "function_call") return [];
      const index = typeof parsed.output_index === "number"
        ? parsed.output_index
        : typeof item.id === "string" && this.toolItemIndexes.has(item.id)
          ? this.toolItemIndexes.get(item.id)!
          : this.toolCalls.size;
      const call = this.ensureTool(index, item);
      if (typeof item.arguments !== "string") return [];
      const current = typeof call.function.arguments === "string"
        ? call.function.arguments
        : "";
      const delta = item.arguments.startsWith(current)
        ? item.arguments.slice(current.length)
        : item.arguments;
      call.function.arguments = item.arguments;
      return delta ? [{ kind: "tool-delta", index, delta }] : [];
    }
    if (
      type === "response.completed" ||
      type === "response.incomplete" ||
      type === "response.failed"
    ) {
      const completed = response ?? parsed;
      const usage = extractUsageFromRecord(completed);
      const updates: OpenCodeZenResponsesUpdate[] = [];
      if (usage) {
        this.usage = usage;
        updates.push({ kind: "usage", usage });
      }
      this.finishReason = responseFinishReason(completed);
      if (type === "response.failed") {
        this.streamError = responseErrorMessage(parsed.error ?? completed.error);
        updates.push({ kind: "error", message: this.streamError });
      } else {
        updates.push({ kind: "finish", reason: this.finishReason });
      }
      return updates;
    }
    if (type === "error" || type === "response.error") {
      this.streamError = responseErrorMessage(parsed.error ?? parsed);
      return [{ kind: "error", message: this.streamError }];
    }
    return [];
  }

  private toolIndex(parsed: Record<string, unknown>): number {
    if (typeof parsed.output_index === "number") return parsed.output_index;
    if (typeof parsed.item_id === "string" && this.toolItemIndexes.has(parsed.item_id)) {
      return this.toolItemIndexes.get(parsed.item_id)!;
    }
    return Math.max(0, this.toolCalls.size - 1);
  }

  private ensureTool(index: number, item?: Record<string, unknown>): OpenAIToolCall {
    const existing = this.toolCalls.get(index);
    if (existing) return existing;
    const call: OpenAIToolCall = {
      id: typeof item?.call_id === "string"
        ? item.call_id
        : typeof item?.id === "string"
          ? item.id
          : `call_${index}`,
      type: "function",
      function: {
        name: typeof item?.name === "string" ? item.name : "unknown",
        arguments: "",
      },
    };
    this.toolCalls.set(index, call);
    if (typeof item?.id === "string") this.toolItemIndexes.set(item.id, index);
    return call;
  }
}

function openCodeZenChatChunk(
  id: string,
  model: string,
  delta: Record<string, unknown>,
  usage?: Record<string, unknown>,
): string {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: usage ? [] : [{ index: 0, delta, finish_reason: null }],
    ...(usage ? { usage } : {}),
  })}\n\n`;
}

function updateToOpenCodeZenChatSse(
  update: OpenCodeZenResponsesUpdate,
  id: string,
  model: string,
): string {
  switch (update.kind) {
    case "text":
      return openCodeZenChatChunk(id, model, { content: update.delta });
    case "reasoning":
      return openCodeZenChatChunk(id, model, { reasoning_content: update.delta });
    case "tool-start":
      return openCodeZenChatChunk(id, model, {
        tool_calls: [{
          index: update.index,
          id: update.id,
          type: "function",
          function: { name: update.name, arguments: "" },
        }],
      });
    case "tool-delta":
      return openCodeZenChatChunk(id, model, {
        tool_calls: [{ index: update.index, function: { arguments: update.delta } }],
      });
    case "usage":
      return openCodeZenChatChunk(id, model, {}, {
        prompt_tokens: update.usage.inputTokens,
        completion_tokens: update.usage.outputTokens,
        total_tokens: update.usage.inputTokens + update.usage.outputTokens,
        ...(update.usage.cachedTokens !== undefined
          ? { prompt_tokens_details: { cached_tokens: update.usage.cachedTokens } }
          : {}),
      });
    case "finish":
      return "";
    case "error":
      throw new Error(update.message);
  }
}

/** Convert native Responses SSE into OpenAI Chat Completions SSE. */
export function transformOpenCodeZenResponsesStream(
  body: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const parser = new OpenCodeZenResponsesStreamParser();
  const id = `chatcmpl-${randomUUID()}`;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      reader = body.getReader();
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          const updates = parser.append(decoder.decode(next.value, { stream: true }));
          for (const update of updates) {
            const rendered = updateToOpenCodeZenChatSse(update, id, model);
            if (rendered) controller.enqueue(encoder.encode(rendered));
          }
        }
        const tail = decoder.decode();
        for (const update of [...parser.append(tail), ...parser.flush()]) {
          const rendered = updateToOpenCodeZenChatSse(update, id, model);
          if (rendered) controller.enqueue(encoder.encode(rendered));
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader = null;
      }
    },
    async cancel(reason) {
      await reader?.cancel(reason);
    },
  });
}

function openCodeZenResponsesToChatJson(
  raw: string,
  model: string,
): Record<string, unknown> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {
      error: {
        message: "Invalid OpenCode Zen Responses JSON",
        type: "upstream_error",
      },
    };
  }
  const completion = responseCompletionFromRecord(parsed, parsed);
  const hasToolCalls = Boolean(completion.toolCalls?.length);
  const finishReason = hasToolCalls
    ? "tool_calls"
    : completion.finishReason === "max_output_tokens"
      ? "length"
      : "stop";
  const created = typeof parsed.created_at === "number"
    ? parsed.created_at
    : Math.floor(Date.now() / 1000);
  return {
    id: completion.responseId || `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created,
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: hasToolCalls ? null : completion.text,
        ...(hasToolCalls ? { tool_calls: completion.toolCalls } : {}),
        ...(completion.thinkingText ? { reasoning_content: completion.thinkingText } : {}),
      },
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens: completion.inputTokens,
      completion_tokens: completion.outputTokens,
      total_tokens: completion.inputTokens + completion.outputTokens,
      ...(completion.cachedTokens !== undefined
        ? { prompt_tokens_details: { cached_tokens: completion.cachedTokens } }
        : {}),
    },
  };
}

function extractUsageFromRecord(record: Record<string, unknown>): TokenUsage | null {
  const usage = isRecord(record.usage) ? record.usage : record;
  const inputTokens =
    typeof usage.prompt_tokens === "number"
      ? usage.prompt_tokens
      : typeof usage.input_tokens === "number"
        ? usage.input_tokens
        : 0;
  const outputTokens =
    typeof usage.completion_tokens === "number"
      ? usage.completion_tokens
      : typeof usage.output_tokens === "number"
        ? usage.output_tokens
        : 0;
  const inputTokenDetails = isRecord(usage.input_tokens_details)
    ? usage.input_tokens_details
    : null;
  const promptTokenDetails = isRecord(usage.prompt_tokens_details)
    ? usage.prompt_tokens_details
    : null;
  const cachedTokens =
    typeof inputTokenDetails?.cached_tokens === "number"
      ? inputTokenDetails.cached_tokens
      : typeof promptTokenDetails?.cached_tokens === "number"
        ? promptTokenDetails.cached_tokens
        : typeof usage.cached_tokens === "number"
          ? usage.cached_tokens
          : undefined;

  return inputTokens > 0 || outputTokens > 0
    ? {
        inputTokens,
        outputTokens,
        ...(cachedTokens !== undefined ? { cachedTokens } : {}),
      }
    : null;
}

export class OpenCodeZenSseAccumulator implements StreamAccumulator {
  private buffer = "";
  private accumulatedText = "";
  private usage: TokenUsage | null = null;

  append(chunkText: string): TokenUsage | null {
    this.buffer += chunkText;
    let newlyFound: TokenUsage | null = null;
    let newlineIdx = this.buffer.indexOf("\n");

    while (newlineIdx >= 0) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        if (payload && payload !== "[DONE]") {
          try {
            const parsed = JSON.parse(payload) as Record<string, unknown>;

            // Extract delta text if present
            if (Array.isArray(parsed.choices) && parsed.choices.length > 0) {
              const choice = parsed.choices[0];
              if (isRecord(choice) && isRecord(choice.delta)) {
                const content = choice.delta.content;
                if (typeof content === "string" && this.accumulatedText.length < 100000) {
                  this.accumulatedText += content;
                }
              }
            }

            const extractedUsage = extractUsageFromRecord(parsed);
            if (extractedUsage) {
              this.usage = extractedUsage;
              newlyFound = extractedUsage;
            }
          } catch {
            // Ignore malformed SSE lines
          }
        }
      }

      newlineIdx = this.buffer.indexOf("\n");
    }

    return newlyFound;
  }

  getText(): string {
    return this.accumulatedText;
  }

  final(): TokenUsage | null {
    if (this.buffer.trim()) {
      this.append(`${this.buffer}\n`);
    }
    return this.usage;
  }
}

const BENCHMARK_MODEL = "big-pickle";

export function getBenchmarkSpec(): {
  body: RequestBody;
  parseUsage(raw: string): { outputTokens: number } | null;
  parseText(raw: string): string;
} {
  return {
    body: {
      project: "",
      model: BENCHMARK_MODEL,
      request: {
        model: BENCHMARK_MODEL,
        messages: [{ role: "user", content: "Reply with: OK" }],
        stream: false,
        max_tokens: 16,
      },
    },
    parseUsage(raw: string) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const usage = extractUsageFromRecord(parsed);
        return usage ? { outputTokens: usage.outputTokens } : null;
      } catch {
        return null;
      }
    },
    parseText(raw: string) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (Array.isArray(parsed.choices) && parsed.choices.length > 0) {
          const choice = parsed.choices[0];
          if (isRecord(choice) && isRecord(choice.message)) {
            return typeof choice.message.content === "string"
              ? choice.message.content
              : "";
          }
        }
        return raw.slice(0, 1000);
      } catch {
        return raw.slice(0, 1000);
      }
    },
  };
}
