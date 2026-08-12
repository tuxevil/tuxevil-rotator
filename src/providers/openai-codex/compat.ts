import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { RequestBody } from "../../proxy.js";
import {
  flattenHeaders,
  type RotationAttemptContext,
  type RotationOutcome,
  withRotation,
} from "../../proxy.js";
import type { AccountRotator } from "../../rotator.js";
import type { OpenAIChatCompletionRequest, OpenAIResponsesRequest, CompatCompletion, OpenAIToolCall } from "../google-antigravity/translators.js";
import { buildRotatorResponseHeaders } from "../../response-headers.js";
import { logSpend } from "../../spend-logger.js";
import {
  buildCodexPayload,
  createCodexStreamAccumulator,
  extractCodexUsage,
} from "./forward.js";
import { sanitizeCodexResponsesRequest } from "./forward.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(value));
}

export interface CodexCompatOptions {
  callType?: string;
  apiKeyHash?: string | null;
  requesterIp?: string | null;
  rawRequest?: unknown;
  selectedModel?: string;
  routingRationale?: string;
  responseModel?: string;
}

function recordCodexTokenUsage(
  rotator: AccountRotator,
  model: string,
  completion: CompatCompletion,
): void {
  if (completion.inputTokens > 0 || completion.outputTokens > 0) {
    rotator.recordTokenUsage(model, completion.inputTokens, completion.outputTokens);
  }
}

function recordCodexOutcome(
  rotator: AccountRotator,
  body: RequestBody,
  context: RotationAttemptContext,
  statusCode: number,
  completion: CompatCompletion,
  options?: CodexCompatOptions,
  totalMs = Date.now() - context.requestStartMs,
): void {
  const ttfbMs = completion.firstByteMs ?? totalMs;
  rotator.recordLatency(body.displayModel || body.model, ttfbMs, totalMs);
  rotator.recordRequestLog({
    model: context.displayModelKey,
    account: context.label,
    statusCode,
    ttfbMs,
    totalMs,
    inputTokens: completion.inputTokens,
    outputTokens: completion.outputTokens,
  });
  logSpend({
    requestId: context.requestId,
    apiKeyHash: options?.apiKeyHash || null,
    model: context.displayModelKey,
    accountEmail: context.label,
    callType: options?.callType || "compat",
    status: statusCode >= 200 && statusCode < 300 ? "success" : "failure",
    promptTokens: completion.inputTokens,
    completionTokens: completion.outputTokens,
    totalTokens: completion.inputTokens + completion.outputTokens,
    startTime: new Date(context.requestStartMs).toISOString(),
    endTime: new Date().toISOString(),
    ttfbMs,
    durationMs: totalMs,
    requestMessages: options?.rawRequest || body.request || body,
    responseContent: completion.rawResponse || (completion.text ? { text: completion.text } : null),
    requesterIp: options?.requesterIp || null,
  });
}

function recordCodexFailure(
  rotator: AccountRotator,
  body: RequestBody,
  outcome: RotationOutcome<CompatCompletion>,
  options?: CodexCompatOptions,
): void {
  if (outcome.ok || !outcome.context) return;
  recordCodexOutcome(
    rotator,
    body,
    outcome.context,
    outcome.status,
    { text: "", inputTokens: 0, outputTokens: 0 },
    options,
    outcome.totalMs,
  );
}

function messageContent(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return value ?? "";
  return value.map((part) => {
    if (!isRecord(part)) return part;
    if (part.type === "text" || part.type === "input_text") return { type: "input_text", text: part.text ?? "" };
    if (part.type === "image_url" && isRecord(part.image_url)) return { type: "input_image", image_url: part.image_url.url };
    return part;
  });
}

function instructionText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (typeof part === "string") return part;
      return isRecord(part) && typeof part.text === "string" ? part.text : "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

/** Convert Chat Completions function tools to the Responses tool shape. */
function chatToolToResponsesTool(value: unknown): unknown {
  if (!isRecord(value) || value.type !== "function" || !isRecord(value.function)) return value;
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

function chatToolChoiceToResponsesChoice(value: unknown): unknown {
  if (!isRecord(value) || value.type !== "function" || !isRecord(value.function)) return value;
  return { type: "function", name: value.function.name };
}

/** Convert OpenAI Chat Completions messages into native Responses input items. */
export function chatToCodexResponsesRequest(request: OpenAIChatCompletionRequest): Record<string, unknown> {
  const input: unknown[] = [];
  const instructions: string[] = [];
  for (const message of request.messages) {
    const item = message as unknown as Record<string, unknown>;
    const role = typeof item.role === "string" ? item.role : "user";
    if (role === "system" || role === "developer") {
      const text = instructionText(item.content);
      if (text) instructions.push(text);
      continue;
    }
    if (role === "tool") {
      input.push({ type: "function_call_output", call_id: item.tool_call_id, output: String(item.content ?? "") });
      continue;
    }
    if (Array.isArray(item.tool_calls)) {
      for (const call of item.tool_calls) {
        if (!isRecord(call) || !isRecord(call.function)) continue;
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.function.name,
          arguments: typeof call.function.arguments === "string" ? call.function.arguments : JSON.stringify(call.function.arguments ?? {}),
        });
      }
      if (!item.content) continue;
    }
    input.push({ role: role === "system" ? "developer" : role, content: messageContent(item.content) });
  }
  const result: Record<string, unknown> = {
    model: request.model,
    instructions: instructions.join("\n\n"),
    input,
    stream: true,
    store: false,
  };
  if (Array.isArray(request.tools) && request.tools.length > 0) {
    result.tools = request.tools.map(chatToolToResponsesTool);
  }
  if (request.tool_choice !== undefined) {
    result.tool_choice = chatToolChoiceToResponsesChoice(request.tool_choice);
  }
  // The ChatGPT Codex OAuth endpoint rejects Responses' max_output_tokens
  // field, so keep the request compatible with its native contract. The
  // public Chat Completions limit cannot be represented on this endpoint.
  const raw = request as unknown as Record<string, unknown>;
  if (isRecord(raw.reasoning)) result.reasoning = raw.reasoning;
  else if (typeof raw.reasoning_effort === "string") result.reasoning = { effort: raw.reasoning_effort };
  return sanitizeCodexResponsesRequest(result, request.model);
}

export function parseCodexResponse(raw: string): CompatCompletion {
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { /* stream-like response */ }
  const output = Array.isArray(parsed.output) ? parsed.output : [];
  let text = "";
  let thinkingText = "";
  const toolCalls: OpenAIToolCall[] = [];
  for (const item of output) {
    if (!isRecord(item)) continue;
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const content of item.content) {
        if (!isRecord(content)) continue;
        if ((content.type === "output_text" || content.type === "text") && typeof content.text === "string") text += content.text;
        if (content.type === "refusal" && typeof content.refusal === "string") text += content.refusal;
      }
    }
    if (item.type === "reasoning" && Array.isArray(item.summary)) {
      for (const summary of item.summary) if (isRecord(summary) && typeof summary.text === "string") thinkingText += summary.text;
    }
    if (item.type === "function_call") {
      toolCalls.push({
        id: typeof item.call_id === "string" ? item.call_id : `call_${toolCalls.length}`,
        type: "function",
        function: { name: typeof item.name === "string" ? item.name : "unknown", arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}) },
      });
    }
  }
  if (!text && typeof parsed.output_text === "string") text = parsed.output_text;
  const usage = extractCodexUsage(raw);
  return {
    text,
    thinkingText: thinkingText || undefined,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    rawResponse: parsed,
  };
}

export function parseCodexResponseBody(raw: string): CompatCompletion {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("event:") && !trimmed.startsWith("data:")) {
    return parseCodexResponse(raw);
  }
  const accumulator = createCodexStreamAccumulator();
  let eventName = "";
  const toolCalls: OpenAIToolCall[] = [];
  let completed: CompatCompletion | null = null;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
      continue;
    }
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(payload) as Record<string, unknown>; } catch { continue; }
    const type = eventName || (typeof parsed.type === "string" ? parsed.type : "");
    if (type === "response.completed" && isRecord(parsed.response)) {
      completed = parseCodexResponse(JSON.stringify(parsed.response));
      continue;
    }
    if (type === "response.output_item.added" && isRecord(parsed.item) && parsed.item.type === "function_call") {
      const item = parsed.item;
      toolCalls.push({
        id: typeof item.call_id === "string" ? item.call_id : `call_${toolCalls.length}`,
        type: "function",
        function: {
          name: typeof item.name === "string" ? item.name : "unknown",
          arguments: "",
        },
      });
      continue;
    }
    if (type === "response.output_item.done" && isRecord(parsed.item) && parsed.item.type === "function_call") {
      const item = parsed.item;
      const call = toolCalls.find((candidate) => candidate.id === item.call_id);
      if (call) {
        if (typeof item.name === "string") call.function.name = item.name;
        if (typeof item.arguments === "string") call.function.arguments = item.arguments;
      }
      continue;
    }
    if (type === "response.function_call_arguments.delta" && typeof parsed.delta === "string") {
      const call = toolCalls.at(-1);
      if (call) call.function.arguments += parsed.delta;
      continue;
    }
    if (type === "response.output_text.delta" && typeof parsed.delta === "string") {
      accumulator.append(`data: ${JSON.stringify({ delta: parsed.delta })}\n`);
    }
  }
  if (completed) {
    if (toolCalls.length > 0 && !completed.toolCalls) completed.toolCalls = toolCalls;
    if (!completed.text) completed.text = accumulator.getText();
    return completed;
  }
  const usage = extractCodexUsage(raw);
  return {
    text: accumulator.getText(),
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    rawResponse: {},
  };
}

function codexResponseJson(
  completion: CompatCompletion,
  model: string,
): Record<string, unknown> {
  const id = `resp-${Date.now().toString(36)}`;
  const output: unknown[] = [];
  if (completion.text || !completion.toolCalls?.length) {
    output.push({
      id: `${id}-msg`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: completion.text,
          annotations: [],
        },
      ],
    });
  }
  for (const call of completion.toolCalls ?? []) {
    output.push({
      id: call.id,
      type: "function_call",
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
      status: "completed",
    });
  }
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output,
    output_text: completion.text,
    usage: {
      input_tokens: completion.inputTokens,
      output_tokens: completion.outputTokens,
      total_tokens: completion.inputTokens + completion.outputTokens,
    },
  };
}

function upstreamHeaders(
  response: Response,
  context: { account?: { healthScore: number }; requestStartMs: number; label: string; retries: number },
  model: string,
  options?: CodexCompatOptions,
): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    if (key !== "connection" && key !== "transfer-encoding" && key !== "content-length") headers[key] = value;
  });
  Object.assign(headers, buildRotatorResponseHeaders({
    accountLabel: context.label,
    model: options?.selectedModel ?? model,
    ttfbMs: Date.now() - context.requestStartMs,
    healthScore: context.account?.healthScore,
    retries: context.retries,
    routingPolicy: "timer-first",
    selectedModel: options?.selectedModel,
    routingRationale: options?.routingRationale,
  }));
  return headers;
}

async function pipeNativeResponses(
  response: Response,
  req: IncomingMessage,
  res: ServerResponse,
  context: { account?: { healthScore: number }; requestStartMs: number; label: string; retries: number },
  model: string,
  options?: CodexCompatOptions,
): Promise<CompatCompletion> {
  res.writeHead(response.status, upstreamHeaders(response, context, model, options));
  if (!response.body) {
    res.end();
    return { text: "", inputTokens: 0, outputTokens: 0 };
  }
  const stream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  const accumulator = createCodexStreamAccumulator();
  const streamStartMs = Date.now();
  let firstByteMs: number | undefined;
  const close = (): void => { if (!stream.destroyed) stream.destroy(); };
  req.once("close", close);
  try {
    for await (const chunk of stream) {
      if (firstByteMs === undefined) firstByteMs = Date.now() - streamStartMs;
      accumulator.append(chunk.toString());
      if (!res.writableEnded) res.write(chunk);
    }
  } finally {
    req.off("close", close);
    if (!res.writableEnded) res.end();
  }
  const usage = accumulator.final();
  return {
    text: accumulator.getText(),
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    firstByteMs,
  };
}

function emitChatChunk(res: ServerResponse, model: string, id: string, delta: Record<string, unknown>, finishReason: string | null = null, usage?: Record<string, number>): void {
  res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finishReason }], ...(usage ? { usage } : {}) })}\n\n`);
}

async function pipeCodexAsChat(
  response: Response,
  req: IncomingMessage,
  res: ServerResponse,
  model: string,
  context: { account?: { healthScore: number }; requestStartMs: number; label: string; retries: number },
  options?: CodexCompatOptions,
): Promise<CompatCompletion> {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", ...upstreamHeaders(response, context, model, options) });
  const id = `chatcmpl-${Date.now().toString(36)}`;
  emitChatChunk(res, model, id, { role: "assistant" });
  if (!response.body) {
    emitChatChunk(res, model, id, {}, "stop");
    res.end("data: [DONE]\n\n");
    return { text: "", inputTokens: 0, outputTokens: 0 };
  }
  const stream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  let buffer = "";
  let eventName = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let toolIndex = 0;
  const streamStartMs = Date.now();
  let firstByteMs: number | undefined;
  const close = (): void => { if (!stream.destroyed) stream.destroy(); };
  req.once("close", close);
  const handle = (payload: string, event: string): void => {
    let data: Record<string, unknown>;
    try { data = JSON.parse(payload) as Record<string, unknown>; } catch { return; }
    const delta = typeof data.delta === "string" ? data.delta : "";
    if (event === "response.output_text.delta" && delta) emitChatChunk(res, model, id, { content: delta });
    if (event === "response.reasoning_summary_text.delta" && delta) emitChatChunk(res, model, id, { reasoning_content: delta });
    if (event === "response.output_item.added" && isRecord(data.item) && data.item.type === "function_call") {
      const item = data.item;
      emitChatChunk(res, model, id, { tool_calls: [{ index: toolIndex, id: item.call_id, type: "function", function: { name: item.name, arguments: "" } }] });
      toolIndex++;
    }
    if (event === "response.function_call_arguments.delta" && delta) emitChatChunk(res, model, id, { tool_calls: [{ index: Math.max(0, toolIndex - 1), function: { arguments: delta } }] });
    if (event === "response.completed" && isRecord(data.response)) {
      const usage = extractCodexUsage(JSON.stringify(data.response));
      inputTokens = usage?.inputTokens ?? inputTokens;
      outputTokens = usage?.outputTokens ?? outputTokens;
    }
  };
  try {
    for await (const chunk of stream) {
      if (firstByteMs === undefined) firstByteMs = Date.now() - streamStartMs;
      buffer += chunk.toString();
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) handle(line.slice(5).trim(), eventName);
        newline = buffer.indexOf("\n");
      }
    }
  } finally { req.off("close", close); }
  emitChatChunk(res, model, id, {}, toolIndex > 0 ? "tool_calls" : "stop");
  if (inputTokens > 0 || outputTokens > 0) emitChatChunk(res, model, id, {}, null, { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens });
  res.end("data: [DONE]\n\n");
  return { text: "", inputTokens, outputTokens, firstByteMs };
}

export async function serveCodexResponses(
  req: IncomingMessage,
  res: ServerResponse,
  rotator: AccountRotator,
  request: OpenAIResponsesRequest,
  options?: CodexCompatOptions,
): Promise<void> {
  const body: RequestBody = { project: "", model: request.model, request: buildCodexPayload({ project: "", model: request.model, request }) };
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  req.once("aborted", abort);
  res.once("close", abort);
  try {
    const outcome = await withRotation(rotator, request.model, flattenHeaders(req.headers), body, async (response, context) => {
      const responseModel = options?.responseModel ?? request.model;
      if (request.stream) {
        const completion = await pipeNativeResponses(response, req, res, context, responseModel, options);
        recordCodexTokenUsage(rotator, request.model, completion);
        recordCodexOutcome(rotator, body, context, response.status, completion, options);
        return completion;
      }
      const raw = await response.text();
      const headers = upstreamHeaders(response, context, request.model, options);
      const completion = parseCodexResponseBody(raw);
      const parsedBody = raw.trim().startsWith("{")
        ? JSON.parse(raw) as unknown
        : codexResponseJson(completion, request.model);
      const responseBody = options?.responseModel && isRecord(parsedBody)
        ? { ...parsedBody, model: responseModel }
        : parsedBody;
      writeJson(res, response.status, responseBody, headers);
      recordCodexTokenUsage(rotator, request.model, completion);
      recordCodexOutcome(rotator, body, context, response.status, completion, options);
      return completion;
    }, controller.signal);
    recordCodexFailure(rotator, body, outcome, options);
    if (!outcome.ok && !res.headersSent) writeJson(res, outcome.status, { error: { message: outcome.errorText, type: "upstream_error" } });
  } finally {
    req.off("aborted", abort);
    res.off("close", abort);
  }
}

export async function serveCodexChat(
  req: IncomingMessage,
  res: ServerResponse,
  rotator: AccountRotator,
  request: OpenAIChatCompletionRequest,
  options?: CodexCompatOptions,
): Promise<void> {
  const codexRequest = chatToCodexResponsesRequest(request);
  const body: RequestBody = { project: "", model: request.model, request: codexRequest };
  const responseModel = options?.responseModel ?? request.model;
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  req.once("aborted", abort);
  res.once("close", abort);
  try {
    const outcome = await withRotation(rotator, request.model, flattenHeaders(req.headers), body, async (response, context) => {
      if (request.stream) {
        const completion = await pipeCodexAsChat(response, req, res, responseModel, context, options);
        recordCodexTokenUsage(rotator, request.model, completion);
        recordCodexOutcome(rotator, body, context, response.status, completion, options);
        return completion;
      }
      const raw = await response.text();
      const completion = parseCodexResponseBody(raw);
      const hasTools = Boolean(completion.toolCalls?.length);
      writeJson(res, response.status, {
        id: `chatcmpl-${Date.now().toString(36)}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: options?.responseModel ?? request.model,
        choices: [{ index: 0, message: { role: "assistant", content: hasTools ? null : completion.text, ...(hasTools ? { tool_calls: completion.toolCalls } : {}), ...(completion.thinkingText ? { reasoning_content: completion.thinkingText } : {}) }, finish_reason: hasTools ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: completion.inputTokens, completion_tokens: completion.outputTokens, total_tokens: completion.inputTokens + completion.outputTokens },
      }, upstreamHeaders(response, context, request.model, options));
      recordCodexTokenUsage(rotator, request.model, completion);
      recordCodexOutcome(rotator, body, context, response.status, completion, options);
      return completion;
    }, controller.signal);
    recordCodexFailure(rotator, body, outcome, options);
    if (!outcome.ok && !res.headersSent) writeJson(res, outcome.status, { error: { message: outcome.errorText, type: "upstream_error" } });
  } finally {
    req.off("aborted", abort);
    res.off("close", abort);
  }
}
