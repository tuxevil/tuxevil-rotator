import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
  type CompressionHeaderOptions,
  buildRotatorResponseHeaders,
} from "./response-headers.js";
import {
  applyPromptCompression,
  parseCompressionMode,
  type CompressionStats,
} from "./compression/index.js";
import { idempotencyManager } from "./idempotency.js";
import { authenticateVirtualKey, sendAuthErrorResponse } from "./key-auth.js";
import { logSpend } from "./spend-logger.js";
import { hashKey } from "./virtual-keys.js";
import { PayloadTooLargeError, readLimitedBody } from "./body-limit.js";
import { logger, redactSensitive } from "./logger.js";
import type { AccountRotator } from "./rotator.js";
import {
  withRotation,
  flattenHeaders,
  type RequestBody,
  type RotationAttemptContext,
  type RotationOutcome,
} from "./proxy.js";
import {
  isRecord,
  sanitizeGeminiSchema,
  sanitizeClaudeViaGeminiSchema,
} from "./compat/schema-sanitizer.js";
import {
  DEFAULT_MODEL_SPECS,
  setModelSpecsOverride,
  getActiveModelSpecs,
  getModelFamily,
  getModelSpec,
  isThinkingModel,
} from "./compat/model-specs.js";
import type { ModelSpec } from "./compat/model-specs.js";
import {
  responsesStore,
  makeCompatId,
  getStoredResponse,
  setStoredResponse,
  resetResponsesStoreForTests,
  loadResponsesStore,
  flushResponsesStore,
  cacheThoughtSignature,
} from "./compat/cache.js";
import {
  normalizeOpenAIChatCompletionRequest,
  normalizeOpenAIResponsesRequest,
  normalizeAnthropicMessagesRequest,
  convertResponsesToChatRequest,
  openAIToAntigravityBody,
  anthropicToAntigravityBody,
  convertAnthropicToolsToOpenAI,
  convertAnthropicToolChoice,
  convertAnthropicMessagesToOpenAI,
  extractText,
  validateOpenAIChatCompletionRequest,
  validateOpenAIResponsesRequest,
  validateAnthropicMessagesRequest,
  buildResponsesResponse,
  saveResponsesEntry,
  toolArgumentsToObject,
} from "./providers/google-antigravity/translators.js";
import {
  openAIToOllamaBody,
  anthropicToOllamaBody,
  parseOllamaNdjson,
} from "./providers/ollama/translators.js";
import { OPENCODE_ZEN_CATALOG, isOpenCodeZenModel } from "./providers/opencode-zen/catalog.js";
import { OPENCODE_ZEN_PROVIDER_ID } from "./providers/opencode-zen/index.js";
import type {
  ChatMessage,
  OpenAITool,
  OpenAIToolCall,
  OpenAIToolChoice,
  OpenAIChatCompletionRequest,
  OpenAIResponsesRequest,
  AnthropicMessagesRequest,
  CompatCompletion,
  ResponsesConversionResult,
} from "./providers/google-antigravity/translators.js";
import {
  isCodexRequestModel,
  isCodexProviderModelId,
  getCodexModels,
} from "./providers/openai-codex/catalog.js";
import { parseCodexResponseBody, serveCodexChat, serveCodexResponses } from "./providers/openai-codex/compat.js";
import { AutoRouter, AutoRouteError } from "./auto-routing/auto-router.js";
import type { AutoDecision } from "./auto-routing/types.js";

function isCodexModelForRotator(rotator: AccountRotator, model: string): boolean {
  if (isCodexRequestModel(model)) return true;
  if (!isCodexProviderModelId(model)) return false;
  try {
    return rotator.getCodexModels?.().includes(model) ?? false;
  } catch {
    return false;
  }
}

export {
  isRecord,
  sanitizeGeminiSchema,
  sanitizeClaudeViaGeminiSchema,
  DEFAULT_MODEL_SPECS,
  setModelSpecsOverride,
  getActiveModelSpecs,
  getModelFamily,
  getModelSpec,
  isThinkingModel,
  resetResponsesStoreForTests,
  loadResponsesStore,
  flushResponsesStore,
  normalizeOpenAIChatCompletionRequest,
  normalizeOpenAIResponsesRequest,
  normalizeAnthropicMessagesRequest,
  openAIToAntigravityBody,
  anthropicToAntigravityBody,
  validateOpenAIChatCompletionRequest,
  validateOpenAIResponsesRequest,
  validateAnthropicMessagesRequest,
  isCodexModelForRotator,
};
export type {
  ModelSpec,
  ChatMessage,
  OpenAITool,
  OpenAIToolCall,
  OpenAIToolChoice,
  OpenAIChatCompletionRequest,
  OpenAIResponsesRequest,
  AnthropicMessagesRequest,
  CompatCompletion,
};

const compatLogger = logger.child("compat");

const autoRouterCache = new WeakMap<AccountRotator, { signature: string; router: AutoRouter }>();

export function isAutoModel(model: string): boolean {
  return model.trim().toLowerCase() === "auto";
}

function getAutoRouter(rotator: AccountRotator): AutoRouter | null {
  if (typeof rotator.getAutoRouter === "function") return rotator.getAutoRouter();
  const auto = rotator.getConfig?.().auto;
  if (!auto) return null;
  const signature = JSON.stringify(auto);
  const cached = autoRouterCache.get(rotator);
  if (cached?.signature === signature) return cached.router;
  const router = new AutoRouter(auto);
  autoRouterCache.set(rotator, { signature, router });
  return router;
}

async function routeAutoRequest(
  req: IncomingMessage,
  rotator: AccountRotator,
  request: OpenAIChatCompletionRequest,
  authModels: readonly string[] | undefined,
  previousResponseId?: string | null,
  excludeModels?: readonly string[],
): Promise<AutoDecision> {
  const router = getAutoRouter(rotator);
  if (!router) throw new AutoRouteError("model=auto requires a valid config.auto section");
  const sessionHeader = req.headers["x-rotator-session-id"];
  const sessionId = typeof sessionHeader === "string" ? sessionHeader : null;
  const envelope = AutoRouter.envelopeFromChat(request, previousResponseId, sessionId);
  configureLocalAutoJudge(rotator, router);
  return router.route(envelope, { allowedModels: authModels, excludeModels });
}

function configureLocalAutoJudge(rotator: AccountRotator, router: AutoRouter): void {
  const auto = rotator.getConfig?.().auto;
  const judge = auto?.trajectory?.judge ?? auto?.judge;
  if (!judge?.model || judge.baseUrl) return;
  router.setJudgeExecutor(async (request, config, signal) => {
    const model = config.model;
    if (!model) throw new Error("local auto judge requires judge.model");
    const chatRequest = request as unknown as OpenAIChatCompletionRequest;
    const body: RequestBody = isOpenCodeZenModel(model)
      ? { project: "", model, request: { ...chatRequest, model } }
      : (rotator.getOllamaModels?.().includes(model)
        ? openAIToOllamaBody({ ...chatRequest, model })
        : openAIToAntigravityBody({ ...chatRequest, model }));
    const outcome = await withRotation(
      rotator,
      model,
      {},
      body,
      async (response, context) => {
        const raw = await response.text();
        const completion = isCodexModelForRotator(rotator, model)
          ? parseCodexResponseBody(raw)
          : isOpenCodeZenModel(model)
            ? parseOpenAiJson(raw)
            : rotator.getOllamaModels?.().includes(model)
              ? parseOllamaNdjson(raw)
              : parseAntigravitySse(raw);
        recordCompatOutcome(
          rotator,
          body,
          context,
          response.status,
          completion,
          undefined,
          { callType: "auto_judge", rawRequest: request, rawResponse: completion.rawResponse },
        );
        return { output_text: completion.text, usage: { output_tokens: completion.outputTokens } };
      },
      signal,
    );
    if (!outcome.ok) throw new Error(outcome.errorText);
    return outcome.result;
  });
}

function autoHeaders(decision: AutoDecision | undefined): Pick<import("./response-headers.js").RotatorResponseHeaderOptions, "selectedModel" | "routingRationale"> {
  return decision ? { selectedModel: decision.selectedModel, routingRationale: decision.rationale } : {};
}

function applyAutoSystemPrompt(
  request: OpenAIChatCompletionRequest,
  decision: AutoDecision | undefined,
): OpenAIChatCompletionRequest {
  if (!decision?.systemPrompt) return request;
  return {
    ...request,
    messages: [{ role: "system", content: decision.systemPrompt }, ...request.messages],
  };
}

function applyAnthropicSystemPrompt(
  request: AnthropicMessagesRequest,
  decision: AutoDecision | undefined,
): AnthropicMessagesRequest {
  if (!decision?.systemPrompt) return request;
  const existing = typeof request.system === "string"
    ? request.system
    : Array.isArray(request.system)
      ? extractText(request.system as ChatMessage["content"])
      : "";
  return {
    ...request,
    system: existing ? `${decision.systemPrompt}\n\n${existing}` : decision.systemPrompt,
  };
}

function isTrajectoryDecision(rotator: AccountRotator, decision: AutoDecision | undefined): boolean {
  return decision?.source === "trajectory-efficient" &&
    rotator.getConfig?.().auto?.escalationMode === "trajectory";
}

function autoSessionId(req: IncomingMessage): string | null {
  const value = req.headers["x-rotator-session-id"];
  return typeof value === "string" ? value : null;
}

async function evaluateTrajectory(
  req: IncomingMessage,
  rotator: AccountRotator,
  request: OpenAIChatCompletionRequest,
  completion: CompatCompletion,
  allowedModels: readonly string[] | undefined,
): Promise<AutoDecision | undefined> {
  const router = getAutoRouter(rotator);
  if (!router) return undefined;
  const envelope = AutoRouter.envelopeFromChat(request, null, autoSessionId(req));
  configureLocalAutoJudge(rotator, router);
  return router.evaluateTrajectory(envelope, completion.text, { allowedModels });
}

const VALIDATION_LOG_MAX_CHARS = 200;

export function logValidationFailure(scope: string, payload: unknown): void {
  const truncated = redactSensitive(JSON.stringify(payload));
  const clipped =
    truncated.length > VALIDATION_LOG_MAX_CHARS
      ? `${truncated.slice(0, VALIDATION_LOG_MAX_CHARS)}…[+${truncated.length - VALIDATION_LOG_MAX_CHARS} chars]`
      : truncated;
  compatLogger.warn(`${scope}: ${clipped}`);
}

// Interfaces and types have been moved to src/providers/google-antigravity/translators.ts

// Response Output types

// Cache and stores have been moved to src/compat/cache.ts

// Helper and translation functions have been moved to src/providers/google-antigravity/translators.ts

export function anthropicToOpenAIChatRequest(
  input: AnthropicMessagesRequest,
): OpenAIChatCompletionRequest {
  const systemText =
    typeof input.system === "string"
      ? input.system
      : Array.isArray(input.system)
        ? extractText(input.system as ChatMessage["content"])
        : "";
  const tools = convertAnthropicToolsToOpenAI(input.tools);
  const toolChoice = convertAnthropicToolChoice(input.tool_choice);
  const convertedMessages = convertAnthropicMessagesToOpenAI(input.messages);
  return {
    model: input.model,
    stream: input.stream,
    temperature: input.temperature,
    max_tokens: input.max_tokens,
    tools: tools as OpenAIChatCompletionRequest["tools"],
    tool_choice: toolChoice as OpenAIChatCompletionRequest["tool_choice"],
    messages: [
      ...(systemText ? [{ role: "system" as const, content: systemText }] : []),
      ...convertedMessages,
    ],
  };
}

export function parseOpenAiJson(raw: string): CompatCompletion {
  let text = "";
  let thinkingText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let responseId: string | undefined;
  const toolCallsMap = new Map<string, OpenAIToolCall>();
  let toolCallIndex = 0;

  const trimmed = raw.trim();
  if (trimmed.startsWith("data:") || trimmed.includes("\ndata:")) {
    const lines = trimmed.split("\n");
    for (const line of lines) {
      const lineTrimmed = line.trim();
      if (!lineTrimmed.startsWith("data:")) continue;
      const payload = lineTrimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload) as Record<string, unknown>;
        if (isRecord(parsed.usage)) {
          if (typeof parsed.usage.prompt_tokens === "number") inputTokens = parsed.usage.prompt_tokens;
          if (typeof parsed.usage.completion_tokens === "number") outputTokens = parsed.usage.completion_tokens;
        }
        if (Array.isArray(parsed.choices) && parsed.choices.length > 0) {
          const choice = parsed.choices[0];
          if (isRecord(choice)) {
            const delta = isRecord(choice.delta) ? choice.delta : isRecord(choice.message) ? choice.message : {};
            if (typeof delta.reasoning_content === "string") {
              thinkingText += delta.reasoning_content;
            }
            if (typeof delta.content === "string") {
              text += delta.content;
            }
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                if (!isRecord(tc) || !isRecord(tc.function)) continue;
                const tcIndex = typeof tc.index === "number" ? tc.index : 0;
                const key = String(tcIndex);
                let existing = toolCallsMap.get(key);
                if (!existing) {
                  const callId = typeof tc.id === "string" && tc.id ? tc.id : `call_${Date.now().toString(36)}_${toolCallIndex++}`;
                  const name = typeof tc.function.name === "string" && tc.function.name ? tc.function.name : "unknown";
                  existing = {
                    id: callId,
                    type: "function",
                    function: { name, arguments: "" },
                  };
                  toolCallsMap.set(key, existing);
                } else {
                  if (typeof tc.id === "string" && tc.id) existing.id = tc.id;
                  if (typeof tc.function.name === "string" && tc.function.name && existing.function.name === "unknown") {
                    existing.function.name = tc.function.name;
                  }
                }
                const argsDelta = typeof tc.function.arguments === "string" ? tc.function.arguments : "";
                if (argsDelta) {
                  existing.function.arguments += argsDelta;
                }
              }
            }
          }
        }
      } catch {
        // Ignore bad SSE line
      }
    }
  } else {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.id === "string") responseId = parsed.id;
      if (isRecord(parsed.usage)) {
        if (typeof parsed.usage.prompt_tokens === "number") inputTokens = parsed.usage.prompt_tokens;
        if (typeof parsed.usage.completion_tokens === "number") outputTokens = parsed.usage.completion_tokens;
      }
      if (Array.isArray(parsed.choices) && parsed.choices.length > 0) {
        const choice = parsed.choices[0];
        if (isRecord(choice) && isRecord(choice.message)) {
          const msg = choice.message;
          if (typeof msg.content === "string") {
            text = msg.content;
          }
          if (typeof msg.reasoning_content === "string") {
            thinkingText = msg.reasoning_content;
          }
          if (Array.isArray(msg.tool_calls)) {
            for (const tc of msg.tool_calls) {
              if (!isRecord(tc) || !isRecord(tc.function)) continue;
              const name = typeof tc.function.name === "string" ? tc.function.name : "unknown";
              const args = typeof tc.function.arguments === "string"
                ? tc.function.arguments
                : JSON.stringify(tc.function.arguments ?? {});
              const callId = typeof tc.id === "string" ? tc.id : `call_${Date.now().toString(36)}_${toolCallIndex++}`;
              toolCallsMap.set(name + callId, {
                id: callId,
                type: "function",
                function: { name, arguments: args },
              });
            }
          }
        }
      }
    } catch {
      // Ignore invalid JSON
    }
  }

  return {
    text,
    thinkingText,
    inputTokens,
    outputTokens,
    responseId,
    toolCalls: Array.from(toolCallsMap.values()),
  };
}

export function parseAntigravitySse(raw: string): CompatCompletion {
  let text = "";
  let thinkingText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let responseId: string | undefined;
  const toolCallsMap = new Map<string, OpenAIToolCall>();
  let toolCallIndex = 0;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const response = isRecord(parsed.response) ? parsed.response : parsed;
      if (!responseId && typeof response.responseId === "string")
        responseId = response.responseId;
      const candidates = Array.isArray(response.candidates)
        ? response.candidates
        : [];
      for (const candidate of candidates) {
        if (
          !isRecord(candidate) ||
          !isRecord(candidate.content) ||
          !Array.isArray(candidate.content.parts)
        )
          continue;
        for (const part of candidate.content.parts) {
          if (!isRecord(part)) continue;
          if (typeof part.text === "string") {
            // Route thought blocks separately from normal text
            if (part.thought === true) {
              thinkingText += part.text;
            } else {
              text += part.text;
            }
          } else if (isRecord(part.functionCall)) {
            // Gemini functionCall → OpenAI tool_call
            const fc = part.functionCall;
            const name = typeof fc.name === "string" ? fc.name : "unknown";
            const args = fc.args !== undefined ? JSON.stringify(fc.args) : "{}";
            const callId = `call_${Date.now().toString(36)}_${toolCallIndex++}`;
            // Cache thought_signature so we can re-inject it on the next turn
            if (
              typeof part.thoughtSignature === "string" &&
              part.thoughtSignature
            ) {
              cacheThoughtSignature(callId, part.thoughtSignature);
            }
            toolCallsMap.set(name + callId, {
              id: callId,
              type: "function",
              function: { name, arguments: args },
            });
          }
        }
      }
      const usage = isRecord(response.usageMetadata)
        ? response.usageMetadata
        : isRecord(response.usage)
          ? response.usage
          : null;
      if (usage) {
        if (typeof usage.promptTokenCount === "number")
          inputTokens = usage.promptTokenCount;
        if (typeof usage.candidatesTokenCount === "number")
          outputTokens = usage.candidatesTokenCount;
        if (typeof usage.input_tokens === "number")
          inputTokens = usage.input_tokens;
        if (typeof usage.output_tokens === "number")
          outputTokens = usage.output_tokens;
      }
    } catch {
      // Ignore malformed SSE lines from upstream; other chunks may still be valid.
    }
  }

  let parsedText = text;

  // Intercept legacy hallucinated format: [Tool call: name(args)]
  const legacyRegex = /\[Tool call:\s*([a-zA-Z0-9_-]+)\(([\s\S]*?)\)\]/g;
  let match;
  while ((match = legacyRegex.exec(parsedText)) !== null) {
    const name = match[1];
    const args = match[2].trim();
    const callId = `call_${Date.now().toString(36)}_${toolCallIndex++}`;
    toolCallsMap.set(name + callId, {
      id: callId,
      type: "function",
      function: { name, arguments: args },
    });
  }
  parsedText = parsedText.replace(legacyRegex, "");

  // Intercept new hallucinated XML format: <tool_call name="name">args</tool_call>
  const xmlRegex = /<tool_call name="([^"]+)">([\s\S]*?)<\/tool_call>/g;
  while ((match = xmlRegex.exec(parsedText)) !== null) {
    const name = match[1];
    const args = match[2].trim();
    const callId = `call_${Date.now().toString(36)}_${toolCallIndex++}`;
    toolCallsMap.set(name + callId, {
      id: callId,
      type: "function",
      function: { name, arguments: args },
    });
  }
  parsedText = parsedText.replace(xmlRegex, "");

  parsedText = parsedText.trim();

  const toolCalls =
    toolCallsMap.size > 0 ? [...toolCallsMap.values()] : undefined;
  return {
    text: parsedText,
    thinkingText: thinkingText || undefined,
    inputTokens,
    outputTokens,
    responseId,
    toolCalls,
  };
}

function getCompressionHeaderOpts(
  stats?: CompressionStats | null,
): CompressionHeaderOptions | undefined {
  if (!stats) return undefined;
  return {
    mode: stats.mode,
    savedChars: stats.savedChars,
    savingsPercent: stats.savingsPercent,
  };
}

function writeJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(payload));
}

function writeResponsesEvent(
  res: ServerResponse,
  payload: Record<string, unknown>,
): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeCompatStreamError(
  res: ServerResponse,
  format: "openai" | "anthropic",
  message: string,
): void {
  if (format === "openai") {
    res.write(
      `data: ${JSON.stringify({ error: { message, type: "server_error" } })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
    return;
  }
  res.write(
    `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message } })}\n\n`,
  );
}

function summarizeCompatRequest(body: RequestBody): string {
  const request = isRecord(body.request) ? body.request : {};
  const contents = Array.isArray(request.contents) ? request.contents : [];
  const tools = Array.isArray(request.tools) ? request.tools.length : 0;
  const systemInstruction = isRecord(request.systemInstruction) ? "yes" : "no";
  return `model=${body.model} userAgent=${body.userAgent || "none"} turns=${contents.length} tools=${tools} systemInstruction=${systemInstruction}`;
}

function recordCompatOutcome(
  rotator: AccountRotator,
  body: RequestBody,
  context: RotationAttemptContext,
  statusCode: number,
  completion?: CompatCompletion,
  totalMs = Date.now() - context.requestStartMs,
  options?: {
    callType?: string;
    apiKeyHash?: string | null;
    requesterIp?: string | null;
    rawRequest?: unknown;
    rawResponse?: unknown;
  },
): void {
  const ttfbMs = completion?.firstByteMs ?? totalMs;
  rotator.recordLatency(body.displayModel || body.model, ttfbMs, totalMs);
  rotator.recordRequestLog({
    model: context.displayModelKey,
    account: context.label,
    statusCode,
    ttfbMs,
    totalMs,
    inputTokens: completion?.inputTokens ?? 0,
    outputTokens: completion?.outputTokens ?? 0,
  });
  logSpend({
    requestId: context.requestId,
    apiKeyHash: options?.apiKeyHash || null,
    model: context.displayModelKey,
    accountEmail: context.label,
    callType: options?.callType || "compat",
    status: statusCode >= 200 && statusCode < 300 ? "success" : "failure",
    promptTokens: completion?.inputTokens ?? 0,
    completionTokens: completion?.outputTokens ?? 0,
    totalTokens: (completion?.inputTokens ?? 0) + (completion?.outputTokens ?? 0),
    startTime: new Date(context.requestStartMs).toISOString(),
    endTime: new Date().toISOString(),
    ttfbMs,
    durationMs: totalMs,
    requestMessages: options?.rawRequest || body.request || body,
    responseContent:
      options?.rawResponse ||
      completion?.rawResponse ||
      (completion?.text ? { text: completion.text } : null),
    requesterIp: options?.requesterIp || null,
  });
}

function recordCompatFailure(
  rotator: AccountRotator,
  body: RequestBody,
  outcome: RotationOutcome<unknown>,
  options?: {
    callType?: string;
    apiKeyHash?: string | null;
    requesterIp?: string | null;
    rawRequest?: unknown;
    rawResponse?: unknown;
  },
): void {
  if (outcome.ok || !outcome.context) return;
  recordCompatOutcome(
    rotator,
    body,
    outcome.context,
    outcome.status,
    undefined,
    outcome.totalMs,
    options,
  );
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  try {
    const body = await readLimitedBody(req);
    return JSON.parse(body.toString("utf-8"));
  } catch (err) {
    if (err instanceof PayloadTooLargeError) throw err;
    throw new Error("Invalid JSON body", { cause: err });
  }
}

async function streamCompatSse(
  body: unknown,
  req: IncomingMessage,
  res: ServerResponse,
  model: string,
  format: "openai" | "anthropic",
  context?: RotationAttemptContext,
  rotator?: AccountRotator,
  compressionStats?: CompressionStats | null,
  upstream: "google" | "ollama" | "opencode-zen" = "google",
  routing?: AutoDecision,
): Promise<CompatCompletion> {
  const nodeStream = Readable.fromWeb(
    body as import("node:stream/web").ReadableStream,
  );
  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  const streamStartMs = Date.now();
  let firstByteMs: number | undefined;
  let responseId: string | undefined;
  let toolCallIndex = 0;

  const created = Math.floor(Date.now() / 1000);
  const id =
    format === "openai"
      ? `chatcmpl-${Date.now().toString(36)}`
      : `msg_${Date.now().toString(36)}`;

  const openaiToolCalls: OpenAIToolCall[] = [];
  let anthropicActiveBlockIndex = -1;
  let anthropicActiveBlockType: "thinking" | "text" | null = null;
  let anthropicHasToolUse = false;
  const anthropicToolCalls: OpenAIToolCall[] = [];

  const rotatorHeaders = buildRotatorResponseHeaders({
    accountLabel: context?.label,
    model,
    ttfbMs: Date.now() - (context?.requestStartMs ?? streamStartMs),
    healthScore: context?.account?.healthScore,
    routingPolicy: rotator?.getConfig?.()?.routingPolicy || "timer-first",
    retries: context?.retries,
    compression: getCompressionHeaderOpts(compressionStats),
    ...autoHeaders(routing),
  });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...rotatorHeaders,
  });

  if (format === "openai") {
    res.write(
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`,
    );
  } else if (format === "anthropic") {
    res.write(
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`,
    );
  }

  let tailBuffer = "";
  let reqClosed = false;
  let streamError: string | undefined;
  interface OpenAiStreamingToolState {
    id: string;
    name: string;
    arguments: string;
    anthropicBlockIndex?: number;
    anthropicStarted?: boolean;
    openaiToolCallIndex: number;
  }
  const openAiStreamingTools = new Map<number, OpenAiStreamingToolState>();
  const emitOllamaLine = (line: string): void => {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.done === true) {
        if (typeof parsed.prompt_eval_count === "number")
          inputTokens = parsed.prompt_eval_count;
        if (typeof parsed.eval_count === "number")
          outputTokens = parsed.eval_count;
      }
      const message = isRecord(parsed.message) ? parsed.message : null;
      if (!message) return;
      const deltaText =
        typeof message.content === "string" ? message.content : "";
      if (deltaText) {
        text += deltaText;
        if (format === "openai") {
          res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: deltaText }, finish_reason: null }] })}\n\n`);
        } else {
          if (anthropicActiveBlockType !== "text") {
            if (anthropicActiveBlockType === "thinking") {
              res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: anthropicActiveBlockIndex })}\n\n`);
              anthropicActiveBlockIndex = 1;
            } else {
              anthropicActiveBlockIndex = 0;
            }
            anthropicActiveBlockType = "text";
            res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: anthropicActiveBlockIndex, content_block: { type: "text", text: "" } })}\n\n`);
          }
          res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: anthropicActiveBlockIndex, delta: { type: "text_delta", text: deltaText } })}\n\n`);
        }
      }
      if (Array.isArray(message.tool_calls)) {
        for (const tc of message.tool_calls) {
          if (!isRecord(tc) || !isRecord(tc.function)) continue;
          const name =
            typeof tc.function.name === "string" ? tc.function.name : "unknown";
          const args =
            typeof tc.function.arguments === "string"
              ? tc.function.arguments
              : JSON.stringify(tc.function.arguments ?? {});
          const callId = `call_${Date.now().toString(36)}_${toolCallIndex++}`;
          if (format === "openai") {
            openaiToolCalls.push({
              id: callId,
              type: "function",
              function: { name, arguments: args },
            });
            res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: toolCallIndex - 1, id: callId, type: "function", function: { name, arguments: args } }] }, finish_reason: null }] })}\n\n`);
          } else {
            if (anthropicActiveBlockType !== null) {
              res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: anthropicActiveBlockIndex })}\n\n`);
              anthropicActiveBlockType = null;
            }
            anthropicActiveBlockIndex++;
            anthropicHasToolUse = true;
            anthropicToolCalls.push({
              id: callId,
              type: "function",
              function: { name, arguments: args },
            });
            let parsedInput: unknown;
            try {
              parsedInput = JSON.parse(args);
            } catch {
              parsedInput = {};
            }
            res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: anthropicActiveBlockIndex, content_block: { type: "tool_use", id: callId, name, input: {} } })}\n\n`);
            res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: anthropicActiveBlockIndex, delta: { type: "input_json_delta", partial_json: JSON.stringify(parsedInput) } })}\n\n`);
            res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: anthropicActiveBlockIndex })}\n\n`);
          }
        }
      }
    } catch {
      // Ignore malformed NDJSON lines
    }
  };
  const emitOpenAiSseLine = (line: string): void => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      if (!isRecord(parsed)) return;

      if (isRecord(parsed.usage)) {
        if (typeof parsed.usage.prompt_tokens === "number") inputTokens = parsed.usage.prompt_tokens;
        if (typeof parsed.usage.completion_tokens === "number") outputTokens = parsed.usage.completion_tokens;
      }

      if (!Array.isArray(parsed.choices) || parsed.choices.length === 0) return;
      const choice = parsed.choices[0];
      if (!isRecord(choice)) return;

      const delta = isRecord(choice.delta) ? choice.delta : {};
      const reasoningText = typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
      const deltaText = typeof delta.content === "string" ? delta.content : "";

      if (reasoningText) {
        if (format === "openai") {
          res.write(
            `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { reasoning_content: reasoningText }, finish_reason: null }] })}\n\n`,
          );
        } else {
          if (anthropicActiveBlockType !== "thinking") {
            if (anthropicActiveBlockType === "text") {
              res.write(
                `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: anthropicActiveBlockIndex })}\n\n`,
              );
            }
            anthropicActiveBlockIndex = 0;
            anthropicActiveBlockType = "thinking";
            res.write(
              `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: anthropicActiveBlockIndex, content_block: { type: "thinking", thinking: "" } })}\n\n`,
            );
          }
          res.write(
            `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: anthropicActiveBlockIndex, delta: { type: "thinking_delta", thinking: reasoningText } })}\n\n`,
          );
        }
      }

      if (deltaText) {
        text += deltaText;
        if (format === "openai") {
          res.write(
            `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: deltaText }, finish_reason: null }] })}\n\n`,
          );
        } else {
          if (anthropicActiveBlockType !== "text") {
            if (anthropicActiveBlockType === "thinking") {
              res.write(
                `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: anthropicActiveBlockIndex })}\n\n`,
              );
              anthropicActiveBlockIndex = 1;
            } else {
              anthropicActiveBlockIndex = 0;
            }
            anthropicActiveBlockType = "text";
            res.write(
              `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: anthropicActiveBlockIndex, content_block: { type: "text", text: "" } })}\n\n`,
            );
          }
          res.write(
            `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: anthropicActiveBlockIndex, delta: { type: "text_delta", text: deltaText } })}\n\n`,
          );
        }
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          if (!isRecord(tc) || !isRecord(tc.function)) continue;
          const tcIndex = typeof tc.index === "number" ? tc.index : 0;
          let state = openAiStreamingTools.get(tcIndex);
          if (!state) {
            const callId = typeof tc.id === "string" && tc.id ? tc.id : `call_${Date.now().toString(36)}_${toolCallIndex++}`;
            const name = typeof tc.function.name === "string" && tc.function.name ? tc.function.name : "unknown";
            state = {
              id: callId,
              name,
              arguments: "",
              openaiToolCallIndex: toolCallIndex - 1,
            };
            openAiStreamingTools.set(tcIndex, state);
          } else {
            if (typeof tc.id === "string" && tc.id) state.id = tc.id;
            if (typeof tc.function.name === "string" && tc.function.name && state.name === "unknown") {
              state.name = tc.function.name;
            }
          }

          const argsDelta = typeof tc.function.arguments === "string" ? tc.function.arguments : "";
          if (argsDelta) {
            state.arguments += argsDelta;
          }

          if (format === "openai") {
            const existingRecord = openaiToolCalls.find((c) => c.id === state!.id);
            if (existingRecord) {
              existingRecord.function.name = state.name;
              existingRecord.function.arguments = state.arguments;
            } else {
              openaiToolCalls.push({
                id: state.id,
                type: "function",
                function: { name: state.name, arguments: state.arguments },
              });
            }

            res.write(
              `data: ${JSON.stringify({
                id,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{
                  index: 0,
                  delta: {
                    tool_calls: [{
                      index: tcIndex,
                      ...(tc.id ? { id: state.id } : {}),
                      ...(tc.type ? { type: "function" } : {}),
                      function: {
                        ...(tc.function.name ? { name: state.name } : {}),
                        arguments: argsDelta,
                      },
                    }],
                  },
                  finish_reason: null,
                }],
              })}\n\n`,
            );
          } else {
            if (!state.anthropicStarted) {
              if (anthropicActiveBlockType !== null) {
                res.write(
                  `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: anthropicActiveBlockIndex })}\n\n`,
                );
                anthropicActiveBlockType = null;
              }
              anthropicActiveBlockIndex++;
              state.anthropicBlockIndex = anthropicActiveBlockIndex;
              state.anthropicStarted = true;
              anthropicHasToolUse = true;

              anthropicToolCalls.push({
                id: state.id,
                type: "function",
                function: { name: state.name, arguments: state.arguments },
              });

              res.write(
                `event: content_block_start\ndata: ${JSON.stringify({
                  type: "content_block_start",
                  index: state.anthropicBlockIndex,
                  content_block: { type: "tool_use", id: state.id, name: state.name, input: {} },
                })}\n\n`,
              );
            } else {
              const rec = anthropicToolCalls.find((c) => c.id === state!.id);
              if (rec) {
                rec.function.name = state.name;
                rec.function.arguments = state.arguments;
              }
            }

            if (argsDelta) {
              res.write(
                `event: content_block_delta\ndata: ${JSON.stringify({
                  type: "content_block_delta",
                  index: state.anthropicBlockIndex,
                  delta: { type: "input_json_delta", partial_json: argsDelta },
                })}\n\n`,
              );
            }
          }
        }
      }
    } catch {
      // Ignore malformed SSE lines
    }
  };
  const closeUpstreamForClient = (): void => {
    reqClosed = true;
    if (!nodeStream.destroyed) nodeStream.destroy();
  };
  const responseEvents = res as {
    once?: (event: "close", listener: () => void) => unknown;
    off?: (event: "close", listener: () => void) => unknown;
  };
  req.once("close", closeUpstreamForClient);
  responseEvents.once?.("close", closeUpstreamForClient);

  try {
    for await (const chunk of nodeStream) {
      if (reqClosed) {
        break;
      }
      if (firstByteMs === undefined) firstByteMs = Date.now() - streamStartMs;
      const str = chunk.toString();
      tailBuffer += str;
      let newlineIdx;
      while ((newlineIdx = tailBuffer.indexOf("\n")) >= 0) {
        const line = tailBuffer.slice(0, newlineIdx).trim();
        tailBuffer = tailBuffer.slice(newlineIdx + 1);

        if (upstream === "ollama") {
          if (line) emitOllamaLine(line);
          continue;
        }
        if (upstream === "opencode-zen") {
          if (line) emitOpenAiSseLine(line);
          continue;
        }
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;

        try {
          const parsed = JSON.parse(payload) as Record<string, unknown>;
          const response = isRecord(parsed.response) ? parsed.response : parsed;
          if (!responseId && typeof response.responseId === "string")
            responseId = response.responseId;

            const candidates = Array.isArray(response.candidates)
              ? response.candidates
              : [];
            for (const candidate of candidates) {
            if (
              !isRecord(candidate) ||
              !isRecord(candidate.content) ||
              !Array.isArray(candidate.content.parts)
            )
              continue;
            for (const part of candidate.content.parts) {
              if (!isRecord(part)) continue;
              if (typeof part.text === "string" && part.text) {
                if (part.thought === true) {
                  // Thought block → reasoning_content (OpenAI) or thinking_delta (Anthropic)
                  if (format === "openai") {
                    res.write(
                      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { reasoning_content: part.text }, finish_reason: null }] })}\n\n`,
                    );
                  } else {
                    if (anthropicActiveBlockType !== "thinking") {
                      if (anthropicActiveBlockType === "text") {
                        res.write(
                          `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: anthropicActiveBlockIndex })}\n\n`,
                        );
                      }
                      anthropicActiveBlockIndex = 0;
                      anthropicActiveBlockType = "thinking";
                      res.write(
                        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: anthropicActiveBlockIndex, content_block: { type: "thinking", thinking: "" } })}\n\n`,
                      );
                    }
                    res.write(
                      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: anthropicActiveBlockIndex, delta: { type: "thinking_delta", thinking: part.text } })}\n\n`,
                    );
                  }
                } else {
                  text += part.text;
                  if (format === "openai") {
                    res.write(
                      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: part.text }, finish_reason: null }] })}\n\n`,
                    );
                  } else {
                    if (anthropicActiveBlockType !== "text") {
                      if (anthropicActiveBlockType === "thinking") {
                        res.write(
                          `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: anthropicActiveBlockIndex })}\n\n`,
                        );
                        anthropicActiveBlockIndex = 1;
                      } else {
                        anthropicActiveBlockIndex = 0;
                      }
                      anthropicActiveBlockType = "text";
                      res.write(
                        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: anthropicActiveBlockIndex, content_block: { type: "text", text: "" } })}\n\n`,
                      );
                    }
                    res.write(
                      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: anthropicActiveBlockIndex, delta: { type: "text_delta", text: part.text } })}\n\n`,
                    );
                  }
                }
              } else if (isRecord(part.functionCall)) {
                const fc = part.functionCall;
                const name = typeof fc.name === "string" ? fc.name : "unknown";
                const args =
                  fc.args !== undefined ? JSON.stringify(fc.args) : "{}";
                const callId = `call_${Date.now().toString(36)}_${toolCallIndex++}`;
                // Cache thought_signature so we can re-inject it on the next turn
                if (
                  typeof part.thoughtSignature === "string" &&
                  part.thoughtSignature
                ) {
                  cacheThoughtSignature(callId, part.thoughtSignature);
                }
                if (format === "openai") {
                  openaiToolCalls.push({
                    id: callId,
                    type: "function",
                    function: { name, arguments: args },
                  });
                  res.write(
                    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: toolCallIndex - 1, id: callId, type: "function", function: { name, arguments: args } }] }, finish_reason: null }] })}\n\n`,
                  );
                } else {
                  // Close any active text/thinking block before emitting tool_use
                  if (anthropicActiveBlockType !== null) {
                    res.write(
                      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: anthropicActiveBlockIndex })}\n\n`,
                    );
                    anthropicActiveBlockType = null;
                  }
                  anthropicActiveBlockIndex++;
                  anthropicHasToolUse = true;
                  anthropicToolCalls.push({
                    id: callId,
                    type: "function",
                    function: { name, arguments: args },
                  });
                  let parsedInput: unknown;
                  try {
                    parsedInput = JSON.parse(args);
                  } catch {
                    parsedInput = {};
                  }
                  res.write(
                    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: anthropicActiveBlockIndex, content_block: { type: "tool_use", id: callId, name, input: {} } })}\n\n`,
                  );
                  res.write(
                    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: anthropicActiveBlockIndex, delta: { type: "input_json_delta", partial_json: JSON.stringify(parsedInput) } })}\n\n`,
                  );
                  res.write(
                    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: anthropicActiveBlockIndex })}\n\n`,
                  );
                }
              }
            }
          }
          const usage = isRecord(response.usageMetadata)
            ? response.usageMetadata
            : isRecord(response.usage)
              ? response.usage
              : null;
          if (usage) {
            if (typeof usage.promptTokenCount === "number")
              inputTokens = usage.promptTokenCount;
            if (typeof usage.candidatesTokenCount === "number")
              outputTokens = usage.candidatesTokenCount;
            if (typeof usage.input_tokens === "number")
              inputTokens = usage.input_tokens;
            if (typeof usage.output_tokens === "number")
              outputTokens = usage.output_tokens;
          }
        } catch {
          // Ignore malformed JSON chunks
        }
      }
    }
  } catch (err) {
    if (!reqClosed) {
      streamError = redactSensitive(String(err)).slice(0, 200);
      compatLogger.warn(
        `Stream read error: ${streamError}`,
      );
    }
  } finally {
    req.off("close", closeUpstreamForClient);
    responseEvents.off?.("close", closeUpstreamForClient);
  }

  if (!reqClosed && !res.writableEnded) {
    if (streamError) {
      writeCompatStreamError(res, format, streamError);
    } else if (format === "openai") {
      const openaiFinishReason = toolCallIndex > 0 ? "tool_calls" : "stop";
      res.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: openaiFinishReason }] })}\n\n`,
      );
      // Emit a usage chunk so agents (hermes, openwebui, etc.) can display token statistics
      if (inputTokens > 0 || outputTokens > 0) {
        res.write(
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens } })}\n\n`,
        );
      }
      res.write("data: [DONE]\n\n");
    } else {
      if (anthropicActiveBlockType !== null) {
        res.write(
          `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: anthropicActiveBlockIndex })}\n\n`,
        );
      }
      for (const toolState of openAiStreamingTools.values()) {
        if (toolState.anthropicStarted) {
          res.write(
            `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: toolState.anthropicBlockIndex })}\n\n`,
          );
        }
      }
      const anthropicStopReason = anthropicHasToolUse ? "tool_use" : "end_turn";
      // message_delta carries output_tokens; also include input_tokens so Hermes shows full context count
      res.write(
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: anthropicStopReason, stop_sequence: null }, usage: { input_tokens: inputTokens, output_tokens: outputTokens } })}\n\n`,
      );
      res.write(
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
      );
    }
    res.end();
  }

  const collectedToolCalls =
    openaiToolCalls.length > 0
      ? openaiToolCalls
      : anthropicToolCalls.length > 0
        ? anthropicToolCalls
        : undefined;

  const rawResponse =
    format === "openai"
      ? {
          id,
          object: "chat.completion",
          created,
          model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: text || null,
                ...(collectedToolCalls ? { tool_calls: collectedToolCalls } : {}),
              },
              finish_reason: collectedToolCalls ? "tool_calls" : "stop",
            },
          ],
          usage: {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
          },
        }
      : {
          id,
          type: "message",
          role: "assistant",
          model,
          content: [
            ...(text ? [{ type: "text", text }] : []),
            ...(collectedToolCalls
              ? collectedToolCalls.map((tc) => ({
                  type: "tool_use",
                  id: tc.id,
                  name: tc.function.name,
                  input: toolArgumentsToObject(tc.function.arguments),
                }))
              : []),
          ],
          stop_reason: anthropicHasToolUse ? "tool_use" : "end_turn",
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        };

  return {
    text,
    inputTokens,
    outputTokens,
    firstByteMs,
    responseId,
    toolCalls: collectedToolCalls,
    rawResponse,
    streamError,
  };
}

async function streamResponsesSse(
  body: unknown,
  req: IncomingMessage,
  res: ServerResponse,
  request: OpenAIResponsesRequest,
  responseId: string,
  previousResponseId: string | null,
  createdAt: number,
  context?: RotationAttemptContext,
  rotator?: AccountRotator,
  compressionStats?: CompressionStats | null,
  upstream: "google" | "ollama" = "google",
  routing?: AutoDecision,
): Promise<CompatCompletion> {
  const nodeStream = Readable.fromWeb(
    body as import("node:stream/web").ReadableStream,
  );
  const responseRequest = routing ? { ...request, model: "auto" } : request;
  let text = "";
  let thinkingText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  const streamStartMs = Date.now();
  let firstByteMs: number | undefined;
  const toolCalls: OpenAIToolCall[] = [];
  let toolCallIndex = 0;
  let nextOutputIndex = 0;
  let messageOutputIndex = -1;
  let messageItemId = "";
  let reasoningOutputIndex = -1;
  let reasoningItemId = "";
  let reasoningDone = false;
  let reqClosed = false;
  let streamError: string | undefined;
  const closeUpstreamForClient = (): void => {
    reqClosed = true;
    if (!nodeStream.destroyed) nodeStream.destroy();
  };
  const responseEvents = res as {
    once?: (event: "close", listener: () => void) => unknown;
    off?: (event: "close", listener: () => void) => unknown;
  };
  req.once("close", closeUpstreamForClient);
  responseEvents.once?.("close", closeUpstreamForClient);

  const rotatorHeaders = buildRotatorResponseHeaders({
    accountLabel: context?.label,
    model: routing ? "auto" : request.model,
    ttfbMs: Date.now() - (context?.requestStartMs ?? streamStartMs),
    healthScore: context?.account?.healthScore,
    routingPolicy: rotator?.getConfig?.()?.routingPolicy || "timer-first",
    retries: context?.retries,
    compression: getCompressionHeaderOpts(compressionStats),
    ...autoHeaders(routing),
  });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...rotatorHeaders,
  });
  const emptyCompletion: CompatCompletion = {
    text: "",
    thinkingText: undefined,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: [],
  };
  writeResponsesEvent(res, {
    type: "response.created",
    response: buildResponsesResponse(
      responseRequest,
      responseId,
      createdAt,
      emptyCompletion,
      "in_progress",
      previousResponseId,
    ),
  });
  writeResponsesEvent(res, {
    type: "response.in_progress",
    response: buildResponsesResponse(
      responseRequest,
      responseId,
      createdAt,
      emptyCompletion,
      "in_progress",
      previousResponseId,
    ),
  });

  let tailBuffer = "";
  const emitOllamaLine = (line: string): void => {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.done === true) {
        if (typeof parsed.prompt_eval_count === "number")
          inputTokens = parsed.prompt_eval_count;
        if (typeof parsed.eval_count === "number")
          outputTokens = parsed.eval_count;
      }
      const message = isRecord(parsed.message) ? parsed.message : null;
      if (!message) return;
      const deltaText =
        typeof message.content === "string" ? message.content : "";
      const closeReasoningIfOpen = (): void => {
        if (reasoningOutputIndex !== -1 && !reasoningDone) {
          reasoningDone = true;
          writeResponsesEvent(res, {
            type: "response.reasoning_summary_text.done",
            item_id: reasoningItemId,
            output_index: reasoningOutputIndex,
            summary_index: 0,
            text: thinkingText,
          });
          writeResponsesEvent(res, {
            type: "response.output_item.done",
            output_index: reasoningOutputIndex,
            item: {
              id: reasoningItemId,
              type: "reasoning",
              status: "completed",
              summary: [{ type: "summary_text", text: thinkingText }],
            },
          });
        }
      };
      if (deltaText) {
        closeReasoningIfOpen();
        if (messageOutputIndex === -1) {
          messageOutputIndex = nextOutputIndex++;
          messageItemId = makeCompatId("msg");
          writeResponsesEvent(res, {
            type: "response.output_item.added",
            output_index: messageOutputIndex,
            item: {
              id: messageItemId,
              type: "message",
              status: "completed",
              role: "assistant",
              content: [
                { type: "output_text", text: "", annotations: [] },
              ],
            },
          });
        }
        text += deltaText;
        writeResponsesEvent(res, {
          type: "response.output_text.delta",
          item_id: messageItemId,
          output_index: messageOutputIndex,
          content_index: 0,
          delta: deltaText,
        });
      }
      if (Array.isArray(message.tool_calls)) {
        for (const tc of message.tool_calls) {
          if (!isRecord(tc) || !isRecord(tc.function)) continue;
          const name =
            typeof tc.function.name === "string" ? tc.function.name : "unknown";
          const args =
            typeof tc.function.arguments === "string"
              ? tc.function.arguments
              : JSON.stringify(tc.function.arguments ?? {});
          const callId = `call_${Date.now().toString(36)}_${toolCallIndex++}`;
          closeReasoningIfOpen();
          toolCalls.push({
            id: callId,
            type: "function",
            function: { name, arguments: args },
          });
          const item = {
            id: makeCompatId("fc"),
            type: "function_call",
            call_id: callId,
            name,
            arguments: args,
            status: "completed",
          };
          const outputIndex = nextOutputIndex++;
          writeResponsesEvent(res, {
            type: "response.output_item.added",
            output_index: outputIndex,
            item,
          });
          writeResponsesEvent(res, {
            type: "response.function_call_arguments.delta",
            item_id: item.id,
            output_index: outputIndex,
            delta: args,
          });
          writeResponsesEvent(res, {
            type: "response.function_call_arguments.done",
            item_id: item.id,
            output_index: outputIndex,
            arguments: args,
          });
          writeResponsesEvent(res, {
            type: "response.output_item.done",
            output_index: outputIndex,
            item,
          });
        }
      }
    } catch {
      // Ignore malformed NDJSON lines
    }
  };
  try {
    for await (const chunk of nodeStream) {
      if (reqClosed) {
        break;
      }
      if (firstByteMs === undefined) firstByteMs = Date.now() - streamStartMs;
      tailBuffer += chunk.toString();
      let newlineIdx;
      while ((newlineIdx = tailBuffer.indexOf("\n")) >= 0) {
        const line = tailBuffer.slice(0, newlineIdx).trim();
        tailBuffer = tailBuffer.slice(newlineIdx + 1);
        if (upstream === "ollama") {
          if (line) emitOllamaLine(line);
          continue;
        }
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const parsed = JSON.parse(payload) as Record<string, unknown>;
          const response = isRecord(parsed.response) ? parsed.response : parsed;
          const candidates = Array.isArray(response.candidates)
            ? response.candidates
            : [];
          for (const candidate of candidates) {
            if (
              !isRecord(candidate) ||
              !isRecord(candidate.content) ||
              !Array.isArray(candidate.content.parts)
            )
              continue;
            for (const part of candidate.content.parts) {
              if (!isRecord(part)) continue;
              if (typeof part.text === "string" && part.text) {
                if (part.thought === true) {
                  // Stream reasoning content via Responses API reasoning events.
                  // First thought chunk: open the reasoning output item.
                  if (reasoningOutputIndex === -1) {
                    reasoningOutputIndex = nextOutputIndex++;
                    reasoningItemId = makeCompatId("rs");
                    writeResponsesEvent(res, {
                      type: "response.output_item.added",
                      output_index: reasoningOutputIndex,
                      item: {
                        id: reasoningItemId,
                        type: "reasoning",
                        status: "in_progress",
                        summary: [],
                      },
                    });
                  }
                  writeResponsesEvent(res, {
                    type: "response.reasoning_summary_text.delta",
                    item_id: reasoningItemId,
                    output_index: reasoningOutputIndex,
                    summary_index: 0,
                    delta: part.text,
                  });
                  thinkingText += part.text;
                  continue;
                }
                // Non-thought text arriving: close reasoning item immediately so Codex
                // sees a completed reasoning block before any content/tool items.
                if (reasoningOutputIndex !== -1 && !reasoningDone) {
                  reasoningDone = true;
                  writeResponsesEvent(res, {
                    type: "response.reasoning_summary_text.done",
                    item_id: reasoningItemId,
                    output_index: reasoningOutputIndex,
                    summary_index: 0,
                    text: thinkingText,
                  });
                  writeResponsesEvent(res, {
                    type: "response.output_item.done",
                    output_index: reasoningOutputIndex,
                    item: {
                      id: reasoningItemId,
                      type: "reasoning",
                      status: "completed",
                      summary: [{ type: "summary_text", text: thinkingText }],
                    },
                  });
                }
                if (messageOutputIndex === -1) {
                  messageOutputIndex = nextOutputIndex++;
                  messageItemId = makeCompatId("msg");
                  writeResponsesEvent(res, {
                    type: "response.output_item.added",
                    output_index: messageOutputIndex,
                    item: {
                      id: messageItemId,
                      type: "message",
                      status: "completed",
                      role: "assistant",
                      content: [
                        { type: "output_text", text: "", annotations: [] },
                      ],
                    },
                  });
                }
                text += part.text;
                writeResponsesEvent(res, {
                  type: "response.output_text.delta",
                  item_id: messageItemId,
                  output_index: messageOutputIndex,
                  content_index: 0,
                  delta: part.text,
                });
              } else if (isRecord(part.functionCall)) {
                // functionCall arriving: close reasoning item immediately if still open
                if (reasoningOutputIndex !== -1 && !reasoningDone) {
                  reasoningDone = true;
                  writeResponsesEvent(res, {
                    type: "response.reasoning_summary_text.done",
                    item_id: reasoningItemId,
                    output_index: reasoningOutputIndex,
                    summary_index: 0,
                    text: thinkingText,
                  });
                  writeResponsesEvent(res, {
                    type: "response.output_item.done",
                    output_index: reasoningOutputIndex,
                    item: {
                      id: reasoningItemId,
                      type: "reasoning",
                      status: "completed",
                      summary: [{ type: "summary_text", text: thinkingText }],
                    },
                  });
                }
                const fc = part.functionCall;
                const name = typeof fc.name === "string" ? fc.name : "unknown";
                const args =
                  fc.args !== undefined ? JSON.stringify(fc.args) : "{}";
                const callId = `call_${Date.now().toString(36)}_${toolCallIndex++}`;
                if (
                  typeof part.thoughtSignature === "string" &&
                  part.thoughtSignature
                ) {
                  cacheThoughtSignature(callId, part.thoughtSignature);
                }
                toolCalls.push({
                  id: callId,
                  type: "function",
                  function: { name, arguments: args },
                });
                const item = {
                  id: makeCompatId("fc"),
                  type: "function_call",
                  call_id: callId,
                  name,
                  arguments: args,
                  status: "completed",
                };
                const outputIndex = nextOutputIndex++;
                writeResponsesEvent(res, {
                  type: "response.output_item.added",
                  output_index: outputIndex,
                  item,
                });
                writeResponsesEvent(res, {
                  type: "response.function_call_arguments.delta",
                  item_id: item.id,
                  output_index: outputIndex,
                  delta: args,
                });
                writeResponsesEvent(res, {
                  type: "response.function_call_arguments.done",
                  item_id: item.id,
                  output_index: outputIndex,
                  arguments: args,
                });
                writeResponsesEvent(res, {
                  type: "response.output_item.done",
                  output_index: outputIndex,
                  item,
                });
              }
            }
          }
          const usage = isRecord(response.usageMetadata)
            ? response.usageMetadata
            : isRecord(response.usage)
              ? response.usage
              : null;
          if (usage) {
            if (typeof usage.promptTokenCount === "number")
              inputTokens = usage.promptTokenCount;
            if (typeof usage.candidatesTokenCount === "number")
              outputTokens = usage.candidatesTokenCount;
            if (typeof usage.input_tokens === "number")
              inputTokens = usage.input_tokens;
            if (typeof usage.output_tokens === "number")
              outputTokens = usage.output_tokens;
          }
        } catch {
          // Ignore malformed JSON chunks
        }
      }
    }
  } catch (err) {
    if (!reqClosed) {
      streamError = redactSensitive(String(err)).slice(0, 200);
      compatLogger.warn(
        `Responses stream read error: ${streamError}`,
      );
    }
  } finally {
    req.off("close", closeUpstreamForClient);
    responseEvents.off?.("close", closeUpstreamForClient);
  }

  const completion: CompatCompletion = {
    text,
    thinkingText: thinkingText || undefined,
    inputTokens,
    outputTokens,
    firstByteMs,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    streamError,
    rawResponse: {
      id: responseId,
      object: "response",
      created: createdAt,
      output_text: text,
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    },
  };
  if (!reqClosed && !res.writableEnded && streamError) {
    writeResponsesEvent(res, {
      type: "error",
      error: { code: "stream_error", message: streamError },
    });
    res.end();
  } else if (!reqClosed && !res.writableEnded) {
    // Close reasoning item if it was never closed mid-stream
    if (reasoningOutputIndex !== -1 && !reasoningDone) {
      writeResponsesEvent(res, {
        type: "response.reasoning_summary_text.done",
        item_id: reasoningItemId,
        output_index: reasoningOutputIndex,
        summary_index: 0,
        text: thinkingText,
      });
      writeResponsesEvent(res, {
        type: "response.output_item.done",
        output_index: reasoningOutputIndex,
        item: {
          id: reasoningItemId,
          type: "reasoning",
          status: "completed",
          summary: [{ type: "summary_text", text: thinkingText }],
        },
      });
    }
    if (messageOutputIndex !== -1) {
      writeResponsesEvent(res, {
        type: "response.output_text.done",
        item_id: messageItemId,
        output_index: messageOutputIndex,
        content_index: 0,
        text,
      });
      writeResponsesEvent(res, {
        type: "response.output_item.done",
        output_index: messageOutputIndex,
        item: {
          id: messageItemId,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      });
    }
    writeResponsesEvent(res, {
      type: "response.completed",
      response: buildResponsesResponse(
        request,
        responseId,
        createdAt,
        completion,
        "completed",
        previousResponseId,
      ),
    });
    res.end();
  }
  return completion;
}

async function completeResponsesViaRotator(
  req: IncomingMessage,
  res: ServerResponse,
  rotator: AccountRotator,
  request: OpenAIResponsesRequest,
  body: RequestBody,
  responseId: string,
  previousResponseId: string | null,
  options?: {
    callType?: string;
    apiKeyHash?: string | null;
    requesterIp?: string | null;
    rawRequest?: unknown;
    rawResponse?: unknown;
    compressionStats?: CompressionStats | null;
    autoDecision?: AutoDecision;
  },
): Promise<{
  completion: CompatCompletion;
  status: number;
  errorText?: string;
  streamed: boolean;
  context?: RotationAttemptContext;
  compressionStats?: CompressionStats | null;
}> {
  const createdAt = Math.floor(Date.now() / 1000);
  const outcome = await withRotation(
    rotator,
    body.model,
    flattenHeaders(req.headers),
    body,
    async (response, context) => {
      const completion = await streamResponsesSse(
        response.body,
        req,
        res,
        request,
        responseId,
        previousResponseId,
        createdAt,
        context,
        rotator,
        options?.compressionStats,
        (rotator?.getOllamaModels?.() ?? []).includes(body.model)
          ? "ollama"
          : "google",
        options?.autoDecision,
      );
      if (completion.inputTokens > 0 || completion.outputTokens > 0) {
        rotator.recordTokenUsage(
          body.displayModel || body.model,
          completion.inputTokens,
          completion.outputTokens,
        );
        if (options?.autoDecision) {
          getAutoRouter(rotator)?.recordModelTokens(
            completion.inputTokens + completion.outputTokens,
          );
        }
      }
      recordCompatOutcome(
        rotator,
        body,
        context,
        completion.streamError ? 502 : response.status,
        completion,
        undefined,
        options,
      );
      return completion;
    },
  );
  if (!outcome.ok) {
    recordCompatFailure(rotator, body, outcome, options);
    return {
      completion: { text: "", inputTokens: 0, outputTokens: 0 },
      status: outcome.status,
      errorText: outcome.retryAfterMs
        ? `${outcome.errorText}; retryAfterMs=${outcome.retryAfterMs}`
        : outcome.errorText,
      streamed: false,
      context: outcome.context,
    };
  }
  return {
    completion: outcome.result,
    status: 200,
    streamed: true,
    context: outcome.context,
    compressionStats: options?.compressionStats,
  };
}

class NonOkOutcomeError extends Error {
  constructor(public outcome: RotationOutcome<CompatCompletion>) {
    super("Non-ok rotation outcome");
  }
}

async function completeViaRotator(
  req: IncomingMessage,
  res: ServerResponse,
  rotator: AccountRotator,
  body: RequestBody,
  streamMode: "none" | "openai" | "anthropic",
  options?: {
    callType?: string;
    apiKeyHash?: string | null;
    requesterIp?: string | null;
    rawRequest?: unknown;
    rawResponse?: unknown;
    compressionStats?: CompressionStats | null;
    autoDecision?: AutoDecision;
  },
): Promise<{
  completion: CompatCompletion;
  status: number;
  errorText?: string;
  streamed: boolean;
  context?: RotationAttemptContext;
  isDeduplicated?: boolean;
  compressionStats?: CompressionStats | null;
}> {
  const ollamaModels = rotator?.getOllamaModels?.() ?? [];
  const isOllamaUpstream = (model: string): boolean => ollamaModels.includes(model);
  const cfg = typeof rotator?.getConfig === "function" ? rotator.getConfig() : undefined;
  const enabled = cfg?.idempotencyEnabled === true;
  const windowMs = cfg?.idempotencyWindowMs ?? 2000;
  const shouldDedup = enabled && streamMode === "none" && !idempotencyManager.isOptedOut(req);

  const runWithRotation = () =>
    withRotation(
      rotator,
      body.model,
      flattenHeaders(req.headers),
      body,
      async (response, context) => {
        if (streamMode === "none") {
          const raw = await response.text();
          const completion = isOpenCodeZenModel(body.model)
            ? parseOpenAiJson(raw)
            : isOllamaUpstream(body.model)
              ? parseOllamaNdjson(raw)
              : parseAntigravitySse(raw);
          if (completion.inputTokens > 0 || completion.outputTokens > 0) {
            rotator.recordTokenUsage(
              body.displayModel || body.model,
              completion.inputTokens,
              completion.outputTokens,
            );
            if (options?.autoDecision) {
              getAutoRouter(rotator)?.recordModelTokens(
                completion.inputTokens + completion.outputTokens,
              );
            }
          }
          recordCompatOutcome(
            rotator,
            body,
            context,
            completion.streamError ? 502 : response.status,
            completion,
            undefined,
            options,
          );
          return completion;
        } else {
          const completion = await streamCompatSse(
            response.body,
            req,
            res,
            options?.autoDecision ? "auto" : body.displayModel || body.model,
            streamMode,
            context,
            rotator,
            options?.compressionStats,
            isOpenCodeZenModel(body.model)
              ? "opencode-zen"
              : isOllamaUpstream(body.model)
                ? "ollama"
                : "google",
            options?.autoDecision,
          );
          if (completion.inputTokens > 0 || completion.outputTokens > 0) {
            rotator.recordTokenUsage(
              body.displayModel || body.model,
              completion.inputTokens,
              completion.outputTokens,
            );
            if (options?.autoDecision) {
              getAutoRouter(rotator)?.recordModelTokens(
                completion.inputTokens + completion.outputTokens,
              );
            }
          }
          recordCompatOutcome(
            rotator,
            body,
            context,
            completion.streamError ? 502 : response.status,
            completion,
            undefined,
            options,
          );
          return completion;
        }
      },
    );

  let outcome: RotationOutcome<CompatCompletion>;
  let isDeduplicated = false;

  if (shouldDedup) {
    const clientKey = idempotencyManager.extractClientKey(req);
    const key = idempotencyManager.computeKey(
      body.model,
      options?.rawRequest || body,
      clientKey,
    );
    const dedupRes = await idempotencyManager
      .execute(key, windowMs, async () => {
        const res = await runWithRotation();
        if (!res.ok) {
          throw new NonOkOutcomeError(res);
        }
        return res;
      })
      .catch((err) => {
        if (err instanceof NonOkOutcomeError) {
          return { result: err.outcome, isDeduplicated: false };
        }
        throw err;
      });
    outcome = dedupRes.result;
    isDeduplicated = dedupRes.isDeduplicated;
  } else {
    outcome = await runWithRotation();
  }

  if (!outcome.ok) {
    recordCompatFailure(rotator, body, outcome, options);
    if (outcome.status === 404) {
      compatLogger.warn(
        `Compat upstream 404 endpoint=${outcome.endpoint || "unknown"} ${summarizeCompatRequest(body)} error=${(outcome.errorText || "").slice(0, 300)}`,
      );
    }
    return {
      completion: { text: "", inputTokens: 0, outputTokens: 0 },
      status: outcome.status,
      errorText: outcome.retryAfterMs
        ? `${outcome.errorText}; retryAfterMs=${outcome.retryAfterMs}`
        : outcome.errorText,
      streamed: false,
      context: outcome.context,
      isDeduplicated,
      compressionStats: options?.compressionStats,
    };
  }
  return {
    completion: outcome.result,
    status: 200,
    streamed: streamMode !== "none",
    context: outcome.context,
    isDeduplicated,
    compressionStats: options?.compressionStats,
  };
}

const MODEL_CATALOG = [
  {
    id: "gemini-3.5-flash-medium",
    family: "gemini-3.5-flash",
    ctx: 1048576,
    quotaPool: "gemini",
    multimodal: true,
    tools: true,
  },
  {
    id: "gemini-3.5-flash-high",
    family: "gemini-3.5-flash",
    ctx: 1048576,
    quotaPool: "gemini",
    multimodal: true,
    tools: true,
  },
  {
    id: "gemini-3-flash",
    family: "gemini-3.5-flash",
    ctx: 1048576,
    quotaPool: "gemini",
    multimodal: true,
    tools: true,
  },
  {
    id: "gemini-3.6-flash-high",
    family: "gemini-3.6-flash",
    ctx: 1048576,
    quotaPool: "gemini",
    multimodal: true,
    tools: true,
  },
  {
    id: "gemini-3.6-flash-medium",
    family: "gemini-3.6-flash",
    ctx: 1048576,
    quotaPool: "gemini",
    multimodal: true,
    tools: true,
  },
  {
    id: "gemini-3.6-flash-low",
    family: "gemini-3.6-flash",
    ctx: 1048576,
    quotaPool: "gemini",
    multimodal: true,
    tools: true,
  },
  {
    id: "gemini-3.6-flash-tiered",
    family: "gemini-3.6-flash",
    ctx: 1048576,
    quotaPool: "gemini",
    multimodal: true,
    tools: true,
  },
  {
    id: "gemini-3.1-pro-low",
    family: "gemini-3.1-pro",
    ctx: 1048576,
    quotaPool: "gemini",
    multimodal: true,
    tools: true,
  },
  {
    id: "gemini-3.1-pro-high",
    family: "gemini-3.1-pro",
    ctx: 1048576,
    quotaPool: "gemini",
    multimodal: true,
    tools: true,
  },
  {
    id: "claude-sonnet-4-6",
    family: "claude",
    ctx: 500000,
    quotaPool: "claude",
    multimodal: true,
    tools: true,
  },
  {
    id: "claude-opus-4-6-thinking",
    family: "claude",
    ctx: 500000,
    quotaPool: "claude",
    multimodal: true,
    tools: true,
  },
  {
    id: "gpt-oss-120b-medium",
    family: "gpt-oss",
    ctx: 131072,
    quotaPool: "claude",
    multimodal: false,
    tools: true,
  },
] as const;

export function serveOpenAIModels(
  res: ServerResponse,
  rotator?: AccountRotator,
): void {
  const catalog: Array<Record<string, unknown>> = MODEL_CATALOG.map(
    ({ id, ctx, family, quotaPool, multimodal, tools }) => ({
      id,
      object: "model",
      created: 0,
      owned_by: "tuxevil-rotator",
      context_window: ctx,
      max_model_len: ctx,
      meta: {
        context_length: ctx,
        family,
        quota_pool: quotaPool,
        multimodal,
        tool_calling: tools,
      },
    }),
  );
  const hasActiveProvider = (providerId: string): boolean =>
    rotator?.hasActiveProvider(providerId) ?? false;
  const autoConfig = rotator?.getConfig?.().auto;
  if (autoConfig) {
    catalog.unshift({
      id: "auto",
      object: "model",
      created: 0,
      owned_by: "tuxevil-rotator",
      context_window: 0,
      max_model_len: 0,
      meta: {
        family: "automatic-router",
        candidates: autoConfig.candidates.map((candidate) => candidate.model),
        selection_policy: autoConfig.selectionPolicy ?? "highest_score",
      },
    });
  }
  const ollamaModels = hasActiveProvider("ollama")
    ? rotator?.getOllamaModels?.() ?? []
    : [];
  if (hasActiveProvider("openai-codex")) {
    for (const model of getCodexModels()) {
      catalog.push({
        id: model.id,
        object: "model",
        created: 0,
        owned_by: "openai-codex",
        context_window: model.contextWindow,
        max_model_len: model.contextWindow,
        meta: {
          context_length: model.contextWindow,
          family: "openai-codex",
          provider: "openai-codex",
          reasoning: model.reasoning,
          multimodal: model.multimodal,
          tool_calling: model.tools,
        },
      });
    }
  }
  for (const id of ollamaModels) {
    catalog.push({
      id,
      object: "model",
      created: 0,
      owned_by: "ollama",
      context_window: 128000,
      max_model_len: 128000,
      meta: {
        context_length: 128000,
        family: "ollama-cloud",
        quota_pool: "ollama-cloud",
        multimodal: false,
        tool_calling: true,
      },
    });
  }
  if (hasActiveProvider(OPENCODE_ZEN_PROVIDER_ID)) {
    for (const spec of OPENCODE_ZEN_CATALOG) {
      catalog.push({
        id: spec.id,
        object: "model",
        created: 0,
        owned_by: OPENCODE_ZEN_PROVIDER_ID,
        context_window: spec.contextWindow,
        max_model_len: spec.contextWindow,
        meta: {
          context_length: spec.contextWindow,
          family: "opencode-zen",
          provider: OPENCODE_ZEN_PROVIDER_ID,
          multimodal: false,
          tool_calling: true,
        },
      });
    }
  }
  writeJson(res, 200, { object: "list", data: catalog });
}

export function serveGeminiModels(res: ServerResponse): void {
  writeJson(res, 200, {
    models: MODEL_CATALOG.map(
      ({ id, ctx, family, quotaPool, multimodal, tools }) => ({
        name: `models/${id}`,
        baseModelId: family,
        version: "v2.0",
        displayName: id,
        description: `Tuxevil Rotator Gemini-compatible model entry for ${id}`,
        inputTokenLimit: ctx,
        outputTokenLimit: ctx,
        supportedGenerationMethods: [
          "generateContent",
          "streamGenerateContent",
        ],
        capabilities: {
          tools,
          multimodal,
          quotaPool,
        },
      }),
    ),
  });
}

export async function handleGeminiGenerateContent(
  req: IncomingMessage,
  res: ServerResponse,
  rotator: AccountRotator,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = await readJsonBody(req);
  } catch (err) {
    if (err instanceof PayloadTooLargeError)
      return writeJson(res, 413, {
        error: { message: "Payload too large", status: "INVALID_ARGUMENT" },
      });
    return writeJson(res, 400, {
      error: { message: "Invalid JSON body", status: "INVALID_ARGUMENT" },
    });
  }
  if (!isRecord(parsed))
    return writeJson(res, 400, {
      error: { message: "Body must be an object", status: "INVALID_ARGUMENT" },
    });

  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  const modelToken = pathname.match(
    /\/v1beta\/models\/(.+):(generateContent|streamGenerateContent)$/,
  )?.[1];
  const model = modelToken
    ? decodeURIComponent(modelToken).replace(/^models\//, "")
    : null;
  if (!model)
    return writeJson(res, 400, {
      error: { message: "Model path is required", status: "INVALID_ARGUMENT" },
    });

  const auth = await authenticateVirtualKey(req, model);
  if (!auth.authenticated) {
    sendAuthErrorResponse(res, auth);
    return;
  }
  const apiKeyHash = auth.key?.tokenHash || (auth.rawKey ? hashKey(auth.rawKey) : null);

  const body: RequestBody = {
    model,
    project: "",
    request: {
      contents: Array.isArray(parsed.contents) ? parsed.contents : [],
      systemInstruction: parsed.systemInstruction,
      generationConfig: parsed.generationConfig,
      tools: parsed.tools,
    },
  };
  const started = Date.now();
  const result = await completeViaRotator(req, res, rotator, body, "none", {
    callType: "gemini",
    apiKeyHash,
    requesterIp: req.socket?.remoteAddress || null,
    rawRequest: parsed,
  });
  if (result.status !== 200) {
    return writeJson(res, result.status, {
      error: {
        message: result.errorText || "Upstream error",
        status: "UPSTREAM_ERROR",
      },
    });
  }
  if (result.streamed) return;
  const totalMs = Date.now() - started;
  const ttfbMs = result.completion.firstByteMs ?? totalMs;
  const rotatorHeaders = buildRotatorResponseHeaders({
    accountLabel: result.context?.label,
    model: model,
    latencyMs: totalMs,
    ttfbMs,
    inputTokens: result.completion.inputTokens,
    outputTokens: result.completion.outputTokens,
    healthScore: result.context?.account?.healthScore,
    routingPolicy: rotator?.getConfig?.()?.routingPolicy || "timer-first",
    idempotencyHit: result.isDeduplicated,
    retries: result.context?.retries,
    compression: getCompressionHeaderOpts(result.compressionStats),
  });
  writeJson(res, 200, {
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ text: result.completion.text }],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: result.completion.inputTokens,
      candidatesTokenCount: result.completion.outputTokens,
      totalTokenCount:
        result.completion.inputTokens + result.completion.outputTokens,
    },
  }, rotatorHeaders);
}

export async function handleOpenAIChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  rotator: AccountRotator,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = await readJsonBody(req);
  } catch (err) {
    if (err instanceof PayloadTooLargeError)
      return writeJson(res, 413, {
        error: { message: "Payload too large", type: "invalid_request_error" },
      });
    return writeJson(res, 400, {
      error: { message: "Invalid JSON body", type: "invalid_request_error" },
    });
  }
  const validation = validateOpenAIChatCompletionRequest(
    normalizeOpenAIChatCompletionRequest(parsed),
  );
  if (!validation.ok)
    return writeJson(res, 400, {
      error: {
        message: validation.errors.join("; "),
        type: "invalid_request_error",
      },
    });

  const requestedModel = validation.value.model;
  const auth = await authenticateVirtualKey(req, isAutoModel(requestedModel) ? undefined : requestedModel);
  if (!auth.authenticated) {
    sendAuthErrorResponse(res, auth);
    return;
  }
  const apiKeyHash = auth.key?.tokenHash || (auth.rawKey ? hashKey(auth.rawKey) : null);

  if (isCodexModelForRotator(rotator, requestedModel)) {
    await serveCodexChat(req, res, rotator, validation.value, {
      callType: "chat_completion",
      apiKeyHash,
      requesterIp: req.socket?.remoteAddress || null,
      rawRequest: validation.value,
    });
    return;
  }

  let autoDecision: AutoDecision | undefined;
  let effectiveRequest = validation.value;
  if (isAutoModel(requestedModel)) {
    try {
      autoDecision = await routeAutoRequest(req, rotator, validation.value, auth.key?.models);
      effectiveRequest = applyAutoSystemPrompt(
        { ...validation.value, model: autoDecision.selectedModel },
        autoDecision,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "auto routing failed";
      return writeJson(res, 503, { error: { message, type: "routing_error" } });
    }
  }

  if (isCodexModelForRotator(rotator, effectiveRequest.model)) {
    await serveCodexChat(req, res, rotator, effectiveRequest, {
      callType: "chat_completion",
      apiKeyHash,
      requesterIp: req.socket?.remoteAddress || null,
      rawRequest: validation.value,
      selectedModel: autoDecision?.selectedModel,
      routingRationale: autoDecision?.rationale,
      responseModel: autoDecision ? requestedModel : undefined,
    });
    return;
  }

  const compMode = parseCompressionMode(
    req.headers["x-rotator-compression"],
    rotator?.getConfig?.()?.compressionMode,
  );
  const compRes = applyPromptCompression(
    effectiveRequest.messages,
    compMode,
    { model: effectiveRequest.model },
  );
  const chatReq = compRes.stats
    ? { ...effectiveRequest, messages: compRes.messages }
    : effectiveRequest;

  const started = Date.now();
  const streamMode = validation.value.stream ? "openai" : "none";
  const bodyToForward: RequestBody = isOpenCodeZenModel(chatReq.model)
    ? { project: "", model: chatReq.model, request: chatReq }
    : (rotator?.getOllamaModels?.().includes(chatReq.model) ? openAIToOllamaBody(chatReq) : openAIToAntigravityBody(chatReq));
  let result = await completeViaRotator(
    req,
    res,
    rotator,
    bodyToForward,
    streamMode,
    {
    callType: "chat_completion",
      apiKeyHash,
      requesterIp: req.socket?.remoteAddress || null,
      rawRequest: validation.value,
      compressionStats: compRes.stats,
      autoDecision,
    },
  );
  if (
    result.status === 200 &&
    !validation.value.stream &&
    isTrajectoryDecision(rotator, autoDecision)
  ) {
    const trajectoryDecision = await evaluateTrajectory(
      req,
      rotator,
      validation.value,
      result.completion,
      auth.key?.models,
    );
    if (trajectoryDecision) {
      autoDecision = trajectoryDecision;
      if (trajectoryDecision.selectedModel !== chatReq.model) {
        const capableRequest = { ...chatReq, model: trajectoryDecision.selectedModel };
        const capableBody: RequestBody = isOpenCodeZenModel(capableRequest.model)
          ? { project: "", model: capableRequest.model, request: capableRequest }
          : (rotator?.getOllamaModels?.().includes(capableRequest.model)
            ? openAIToOllamaBody(capableRequest)
            : openAIToAntigravityBody(capableRequest));
        result = await completeViaRotator(
          req,
          res,
          rotator,
          capableBody,
          "none",
          {
            callType: "chat_completion",
            apiKeyHash,
            requesterIp: req.socket?.remoteAddress || null,
            rawRequest: validation.value,
            compressionStats: compRes.stats,
            autoDecision,
          },
        );
      }
    }
  }
  if (result.status !== 200 && autoDecision && !validation.value.stream) {
    try {
      const reroutedDecision = await routeAutoRequest(
        req,
        rotator,
        validation.value,
        auth.key?.models,
        undefined,
        [autoDecision.selectedModel],
      );
      const reroutedRequest = applyAutoSystemPrompt(
        { ...validation.value, model: reroutedDecision.selectedModel },
        reroutedDecision,
      );
      const reroutedCompression = applyPromptCompression(
        reroutedRequest.messages,
        compMode,
        { model: reroutedRequest.model },
      );
      const reroutedChatRequest = reroutedCompression.stats
        ? { ...reroutedRequest, messages: reroutedCompression.messages }
        : reroutedRequest;
      const reroutedBody: RequestBody = isOpenCodeZenModel(reroutedChatRequest.model)
        ? { project: "", model: reroutedChatRequest.model, request: reroutedChatRequest }
        : (rotator?.getOllamaModels?.().includes(reroutedChatRequest.model)
          ? openAIToOllamaBody(reroutedChatRequest)
          : openAIToAntigravityBody(reroutedChatRequest));
      autoDecision = reroutedDecision;
      result = await completeViaRotator(
        req,
        res,
        rotator,
        reroutedBody,
        "none",
        {
          callType: "chat_completion",
          apiKeyHash,
          requesterIp: req.socket?.remoteAddress || null,
          rawRequest: validation.value,
          compressionStats: reroutedCompression.stats,
          autoDecision,
        },
      );
    } catch (error) {
      compatLogger.warn(`OpenAI auto re-evaluation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (result.status !== 200) {
    compatLogger.warn(
      `OpenAI compat upstream failed status=${result.status} model=${validation.value.model}`,
    );
    if (!res.headersSent) {
      return writeJson(res, result.status, {
        error: {
          message: result.errorText || "Upstream error",
          type: "upstream_error",
        },
      });
    }
    return;
  }
  if (result.streamed) {
    return;
  }
  const hasToolCalls =
    result.completion.toolCalls && result.completion.toolCalls.length > 0;
  const totalMs = Date.now() - started;
  const ttfbMs = result.completion.firstByteMs ?? totalMs;
  const rotatorHeaders = buildRotatorResponseHeaders({
    accountLabel: result.context?.label,
    model: requestedModel,
    latencyMs: totalMs,
    ttfbMs,
    inputTokens: result.completion.inputTokens,
    outputTokens: result.completion.outputTokens,
    healthScore: result.context?.account?.healthScore,
    routingPolicy: rotator?.getConfig?.()?.routingPolicy || "timer-first",
    idempotencyHit: result.isDeduplicated,
    retries: result.context?.retries,
    ...autoHeaders(autoDecision),
  });
  writeJson(res, 200, {
    id: `chatcmpl-${started.toString(36)}`,
    object: "chat.completion",
    created: Math.floor(started / 1000),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          ...(hasToolCalls
            ? { content: null, tool_calls: result.completion.toolCalls }
            : { content: result.completion.text }),
          ...(result.completion.thinkingText
            ? { reasoning_content: result.completion.thinkingText }
            : {}),
        },
        finish_reason: hasToolCalls ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: result.completion.inputTokens,
      completion_tokens: result.completion.outputTokens,
      total_tokens:
        result.completion.inputTokens + result.completion.outputTokens,
    },
  }, rotatorHeaders);
}

export async function handleOpenAIResponsesCreate(
  req: IncomingMessage,
  res: ServerResponse,
  rotator: AccountRotator,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = await readJsonBody(req);
  } catch (err) {
    if (err instanceof PayloadTooLargeError)
      return writeJson(res, 413, {
        error: { message: "Payload too large", type: "invalid_request_error" },
      });
    return writeJson(res, 400, {
      error: { message: "Invalid JSON body", type: "invalid_request_error" },
    });
  }

  const normalized = normalizeOpenAIResponsesRequest(parsed);
  const validation = validateOpenAIResponsesRequest(normalized);
  if (!validation.ok)
    return writeJson(res, 400, {
      error: {
        message: validation.errors.join("; "),
        type: "invalid_request_error",
      },
    });

  const requestedModel = validation.value.model;
  const auth = await authenticateVirtualKey(req, isAutoModel(requestedModel) ? undefined : requestedModel);
  if (!auth.authenticated) {
    sendAuthErrorResponse(res, auth);
    return;
  }
  const apiKeyHash = auth.key?.tokenHash || (auth.rawKey ? hashKey(auth.rawKey) : null);

  if (isCodexModelForRotator(rotator, requestedModel)) {
    await serveCodexResponses(req, res, rotator, validation.value, {
      callType: "responses",
      apiKeyHash,
      requesterIp: req.socket?.remoteAddress || null,
      rawRequest: validation.value,
    });
    return;
  }

  let converted: ResponsesConversionResult;
  try {
    converted = convertResponsesToChatRequest(validation.value);
  } catch {
    return writeJson(res, 400, {
      error: {
        message: "Invalid responses request",
        type: "invalid_request_error",
      },
    });
  }

  let autoDecision: AutoDecision | undefined;
  let effectiveChatRequest = converted.chatRequest;
  if (isAutoModel(requestedModel)) {
    try {
      autoDecision = await routeAutoRequest(
        req,
        rotator,
        converted.chatRequest,
        auth.key?.models,
        converted.previousResponseId,
      );
      effectiveChatRequest = applyAutoSystemPrompt(
        { ...converted.chatRequest, model: autoDecision.selectedModel },
        autoDecision,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "auto routing failed";
      return writeJson(res, 503, { error: { message, type: "routing_error" } });
    }
  }

  if (isCodexModelForRotator(rotator, effectiveChatRequest.model)) {
    await serveCodexResponses(req, res, rotator, { ...validation.value, model: effectiveChatRequest.model }, {
      callType: "responses",
      apiKeyHash,
      requesterIp: req.socket?.remoteAddress || null,
      rawRequest: validation.value,
      selectedModel: autoDecision?.selectedModel,
      routingRationale: autoDecision?.rationale,
      responseModel: autoDecision ? requestedModel : undefined,
    });
    return;
  }

  const responseId = makeCompatId("resp");
  if (autoDecision) getAutoRouter(rotator)?.linkResponseId(responseId, autoDecision);
  const createdAt = Math.floor(Date.now() / 1000);
  const compMode = parseCompressionMode(
    req.headers["x-rotator-compression"],
    rotator?.getConfig?.()?.compressionMode,
  );
  const compRes = applyPromptCompression(
    effectiveChatRequest.messages,
    compMode,
    { model: effectiveChatRequest.model },
  );
  const chatRequest = compRes.stats
    ? { ...effectiveChatRequest, messages: compRes.messages }
    : effectiveChatRequest;

  const requestBody: RequestBody = isOpenCodeZenModel(chatRequest.model)
    ? { project: "", model: chatRequest.model, request: chatRequest }
    : (rotator?.getOllamaModels?.().includes(chatRequest.model) ? openAIToOllamaBody(chatRequest) : openAIToAntigravityBody(chatRequest));
  requestBody.requestId = responseId;

  if (validation.value.store !== false) {
    const expiresAt = Date.now() + 6 * 60 * 60 * 1000;
    setStoredResponse(responseId, {
      response: buildResponsesResponse(
        validation.value,
        responseId,
        createdAt,
        { text: "", inputTokens: 0, outputTokens: 0, toolCalls: [] },
        "in_progress",
        converted.previousResponseId,
      ),
      inputItems: converted.inputItems,
      conversationMessages: converted.conversationMessages as unknown as Array<
        Record<string, unknown>
      >,
      callIdToName: {},
      expiresAt,
    });
  }

  if (validation.value.stream) {
    const result = await completeResponsesViaRotator(
      req,
      res,
      rotator,
      validation.value,
      requestBody,
      responseId,
      converted.previousResponseId,
      {
        callType: "responses",
        apiKeyHash,
        requesterIp: req.socket?.remoteAddress || null,
        compressionStats: compRes.stats,
        autoDecision,
      },
    );
    if (result.status !== 200) {
      responsesStore.delete(responseId);
      if (!res.headersSent)
        return writeJson(res, result.status, {
          error: {
            message: result.errorText || "Upstream error",
            type: "upstream_error",
          },
        });
      return;
    }
    if (validation.value.store !== false) {
      const responseObject = buildResponsesResponse(
        validation.value,
        responseId,
        createdAt,
        result.completion,
        "completed",
        converted.previousResponseId,
      );
      saveResponsesEntry(
        responseObject,
        converted.inputItems,
        converted.conversationMessages,
        result.completion,
      );
    }
    return;
  }

  let result = await completeViaRotator(
    req,
    res,
    rotator,
    requestBody,
    "none",
    {
      callType: "responses",
      apiKeyHash,
      requesterIp: req.socket?.remoteAddress || null,
      rawRequest: validation.value,
      compressionStats: compRes.stats,
      autoDecision,
    },
  );
  if (
    result.status === 200 &&
    isTrajectoryDecision(rotator, autoDecision)
  ) {
    const trajectoryDecision = await evaluateTrajectory(
      req,
      rotator,
      converted.chatRequest,
      result.completion,
      auth.key?.models,
    );
    if (trajectoryDecision) {
      autoDecision = trajectoryDecision;
      if (trajectoryDecision.selectedModel !== chatRequest.model) {
        const capableRequest = { ...chatRequest, model: trajectoryDecision.selectedModel };
        const capableBody: RequestBody = isOpenCodeZenModel(capableRequest.model)
          ? { project: "", model: capableRequest.model, request: capableRequest }
          : (rotator?.getOllamaModels?.().includes(capableRequest.model)
            ? openAIToOllamaBody(capableRequest)
            : openAIToAntigravityBody(capableRequest));
        capableBody.requestId = responseId;
        result = await completeViaRotator(
          req,
          res,
          rotator,
          capableBody,
          "none",
          {
            callType: "responses",
            apiKeyHash,
            requesterIp: req.socket?.remoteAddress || null,
            rawRequest: validation.value,
            compressionStats: compRes.stats,
            autoDecision,
          },
        );
      }
    }
  }
  if (result.status !== 200 && autoDecision && !validation.value.stream) {
    try {
      const reroutedDecision = await routeAutoRequest(
        req,
        rotator,
        converted.chatRequest,
        auth.key?.models,
        converted.previousResponseId,
        [autoDecision.selectedModel],
      );
      const reroutedRequest = applyAutoSystemPrompt(
        { ...converted.chatRequest, model: reroutedDecision.selectedModel },
        reroutedDecision,
      );
      const reroutedCompression = applyPromptCompression(
        reroutedRequest.messages,
        compMode,
        { model: reroutedRequest.model },
      );
      const reroutedChatRequest = reroutedCompression.stats
        ? { ...reroutedRequest, messages: reroutedCompression.messages }
        : reroutedRequest;
      const reroutedBody: RequestBody = isOpenCodeZenModel(reroutedChatRequest.model)
        ? { project: "", model: reroutedChatRequest.model, request: reroutedChatRequest }
        : (rotator?.getOllamaModels?.().includes(reroutedChatRequest.model)
          ? openAIToOllamaBody(reroutedChatRequest)
          : openAIToAntigravityBody(reroutedChatRequest));
      reroutedBody.requestId = responseId;
      autoDecision = reroutedDecision;
      result = await completeViaRotator(
        req,
        res,
        rotator,
        reroutedBody,
        "none",
        {
          callType: "responses",
          apiKeyHash,
          requesterIp: req.socket?.remoteAddress || null,
          rawRequest: validation.value,
          compressionStats: reroutedCompression.stats,
          autoDecision,
        },
      );
    } catch (error) {
      compatLogger.warn(`Responses auto re-evaluation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (result.status !== 200) {
    responsesStore.delete(responseId);
    return writeJson(res, result.status, {
      error: {
        message: result.errorText || "Upstream error",
        type: "upstream_error",
      },
    });
  }

  const responseObject = buildResponsesResponse(
    validation.value,
    responseId,
    createdAt,
    result.completion,
    "completed",
    converted.previousResponseId,
  );
  if (validation.value.store !== false) {
    saveResponsesEntry(
      responseObject,
      converted.inputItems,
      converted.conversationMessages,
      result.completion,
    );
  } else {
    responsesStore.delete(responseId);
  }
  const totalMs = Date.now() - (createdAt * 1000);
  const ttfbMs = result.completion.firstByteMs ?? totalMs;
  const rotatorHeaders = buildRotatorResponseHeaders({
    accountLabel: result.context?.label,
    model: validation.value.model,
    latencyMs: totalMs,
    ttfbMs,
    inputTokens: result.completion.inputTokens,
    outputTokens: result.completion.outputTokens,
    healthScore: result.context?.account?.healthScore,
    routingPolicy: rotator?.getConfig?.()?.routingPolicy || "timer-first",
    idempotencyHit: result.isDeduplicated,
    retries: result.context?.retries,
    ...autoHeaders(autoDecision),
  });
  writeJson(res, 200, responseObject, rotatorHeaders);
}

export function handleOpenAIResponsesRetrieve(
  _req: IncomingMessage,
  res: ServerResponse,
  responseId: string,
): void {
  const entry = getStoredResponse(responseId);
  if (!entry)
    return writeJson(res, 404, {
      error: {
        message: `Response not found: ${responseId}`,
        type: "invalid_request_error",
      },
    });
  writeJson(res, 200, entry.response);
}

export function handleOpenAIResponsesDelete(
  _req: IncomingMessage,
  res: ServerResponse,
  responseId: string,
): void {
  writeJson(res, 200, {
    id: responseId,
    object: "response.deleted",
    deleted: responsesStore.delete(responseId),
  });
}

export function handleOpenAIResponsesCancel(
  _req: IncomingMessage,
  res: ServerResponse,
  responseId: string,
): void {
  const entry = getStoredResponse(responseId);
  if (!entry)
    return writeJson(res, 404, {
      error: {
        message: `Response not found: ${responseId}`,
        type: "invalid_request_error",
      },
    });
  if (entry.response.status === "in_progress")
    entry.response.status = "cancelled";
  writeJson(res, 200, entry.response);
}

export function handleOpenAIResponsesInputItems(
  _req: IncomingMessage,
  res: ServerResponse,
  responseId: string,
): void {
  const entry = getStoredResponse(responseId);
  if (!entry)
    return writeJson(res, 404, {
      error: {
        message: `Response not found: ${responseId}`,
        type: "invalid_request_error",
      },
    });
  writeJson(res, 200, {
    object: "list",
    data: entry.inputItems,
    has_more: false,
    first_id: entry.inputItems[0]?.id ?? null,
    last_id: entry.inputItems.at(-1)?.id ?? null,
  });
}

export async function handleAnthropicMessages(
  req: IncomingMessage,
  res: ServerResponse,
  rotator: AccountRotator,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = await readJsonBody(req);
  } catch (err) {
    if (err instanceof PayloadTooLargeError)
      return writeJson(res, 413, {
        type: "error",
        error: { type: "invalid_request_error", message: "Payload too large" },
      });
    return writeJson(res, 400, {
      type: "error",
      error: { type: "invalid_request_error", message: "Invalid JSON body" },
    });
  }
  const validation = validateAnthropicMessagesRequest(
    normalizeAnthropicMessagesRequest(parsed),
  );
  if (!validation.ok)
    return writeJson(res, 400, {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: validation.errors.join("; "),
      },
    });

  const requestedModel = validation.value.model;
  const auth = await authenticateVirtualKey(req, isAutoModel(requestedModel) ? undefined : requestedModel);
  if (!auth.authenticated) {
    sendAuthErrorResponse(res, auth);
    return;
  }
  const apiKeyHash = auth.key?.tokenHash || (auth.rawKey ? hashKey(auth.rawKey) : null);

  let autoDecision: AutoDecision | undefined;
  let effectiveAnthropicRequest = validation.value;
  if (isAutoModel(requestedModel)) {
    try {
      autoDecision = await routeAutoRequest(
        req,
        rotator,
        anthropicToOpenAIChatRequest(validation.value),
        auth.key?.models,
      );
      effectiveAnthropicRequest = applyAnthropicSystemPrompt(
        { ...validation.value, model: autoDecision.selectedModel },
        autoDecision,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "auto routing failed";
      return writeJson(res, 503, { type: "error", error: { type: "routing_error", message } });
    }
  }

  const compMode = parseCompressionMode(
    req.headers["x-rotator-compression"],
    rotator?.getConfig?.()?.compressionMode,
  );
  const compRes = applyPromptCompression(
    effectiveAnthropicRequest.messages as ChatMessage[],
    compMode,
    { model: effectiveAnthropicRequest.model },
  );
  const anthropicReq = compRes.stats
    ? {
        ...effectiveAnthropicRequest,
        messages: compRes.messages as typeof validation.value.messages,
      }
    : effectiveAnthropicRequest;

  const started = Date.now();
  const streamMode = validation.value.stream ? "anthropic" : "none";
  const bodyToForward: RequestBody = isOpenCodeZenModel(anthropicReq.model)
    ? { project: "", model: anthropicReq.model, request: anthropicToOpenAIChatRequest(anthropicReq) }
    : (rotator?.getOllamaModels?.().includes(anthropicReq.model) ? anthropicToOllamaBody(anthropicReq) : anthropicToAntigravityBody(anthropicReq));
  let result = await completeViaRotator(
    req,
    res,
    rotator,
    bodyToForward,
    streamMode,
    {
      callType: "anthropic",
      apiKeyHash,
      requesterIp: req.socket?.remoteAddress || null,
      rawRequest: validation.value,
      compressionStats: compRes.stats,
      autoDecision,
    },
  );
  if (
    result.status === 200 &&
    !validation.value.stream &&
    isTrajectoryDecision(rotator, autoDecision)
  ) {
    const trajectoryDecision = await evaluateTrajectory(
      req,
      rotator,
      anthropicToOpenAIChatRequest(validation.value),
      result.completion,
      auth.key?.models,
    );
    if (trajectoryDecision) {
      autoDecision = trajectoryDecision;
      if (trajectoryDecision.selectedModel !== anthropicReq.model) {
        const capableRequest = { ...anthropicReq, model: trajectoryDecision.selectedModel };
        const capableBody: RequestBody = isOpenCodeZenModel(capableRequest.model)
          ? { project: "", model: capableRequest.model, request: anthropicToOpenAIChatRequest(capableRequest) }
          : (rotator?.getOllamaModels?.().includes(capableRequest.model)
            ? anthropicToOllamaBody(capableRequest)
            : anthropicToAntigravityBody(capableRequest));
        result = await completeViaRotator(
          req,
          res,
          rotator,
          capableBody,
          "none",
          {
            callType: "anthropic",
            apiKeyHash,
            requesterIp: req.socket?.remoteAddress || null,
            rawRequest: validation.value,
            compressionStats: compRes.stats,
            autoDecision,
          },
        );
      }
    }
  }
  if (result.status !== 200 && autoDecision && !validation.value.stream) {
    try {
      const reroutedDecision = await routeAutoRequest(
        req,
        rotator,
        anthropicToOpenAIChatRequest(validation.value),
        auth.key?.models,
        undefined,
        [autoDecision.selectedModel],
      );
      const reroutedRequest = {
        ...applyAnthropicSystemPrompt(
          { ...validation.value, model: reroutedDecision.selectedModel },
          reroutedDecision,
        ),
      };
      const reroutedCompression = applyPromptCompression(
        reroutedRequest.messages as ChatMessage[],
        compMode,
        { model: reroutedRequest.model },
      );
      const reroutedAnthropicRequest = reroutedCompression.stats
        ? { ...reroutedRequest, messages: reroutedCompression.messages as typeof validation.value.messages }
        : reroutedRequest;
      const reroutedBody: RequestBody = isOpenCodeZenModel(reroutedAnthropicRequest.model)
        ? { project: "", model: reroutedAnthropicRequest.model, request: anthropicToOpenAIChatRequest(reroutedAnthropicRequest) }
        : (rotator?.getOllamaModels?.().includes(reroutedAnthropicRequest.model)
          ? anthropicToOllamaBody(reroutedAnthropicRequest)
          : anthropicToAntigravityBody(reroutedAnthropicRequest));
      autoDecision = reroutedDecision;
      result = await completeViaRotator(
        req,
        res,
        rotator,
        reroutedBody,
        "none",
        {
          callType: "anthropic",
          apiKeyHash,
          requesterIp: req.socket?.remoteAddress || null,
          rawRequest: validation.value,
          compressionStats: reroutedCompression.stats,
          autoDecision,
        },
      );
    } catch (error) {
      compatLogger.warn(`Anthropic auto re-evaluation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (result.status !== 200) {
    compatLogger.warn(
      `Anthropic compat upstream failed status=${result.status} model=${validation.value.model}`,
    );
    if (!res.headersSent) {
      return writeJson(res, result.status, {
        type: "error",
        error: {
          type: "upstream_error",
          message: result.errorText || "Upstream error",
        },
      });
    }
    return;
  }
  if (result.streamed) {
    return;
  }
  const contentBlocks: Array<Record<string, unknown>> = [];
  if (result.completion.thinkingText) {
    contentBlocks.push({
      type: "thinking",
      thinking: result.completion.thinkingText,
    });
  }
  if (result.completion.text) {
    contentBlocks.push({ type: "text", text: result.completion.text });
  }
  if (result.completion.toolCalls && result.completion.toolCalls.length > 0) {
    for (const tc of result.completion.toolCalls) {
      const parsedInput = toolArgumentsToObject(tc.function.arguments);
      contentBlocks.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: parsedInput,
      });
    }
  }
  const stopReason =
    result.completion.toolCalls && result.completion.toolCalls.length > 0
      ? "tool_use"
      : "end_turn";
  const totalMs = Date.now() - started;
  const ttfbMs = result.completion.firstByteMs ?? totalMs;
  const rotatorHeaders = buildRotatorResponseHeaders({
    accountLabel: result.context?.label,
    model: requestedModel,
    latencyMs: totalMs,
    ttfbMs,
    inputTokens: result.completion.inputTokens,
    outputTokens: result.completion.outputTokens,
    healthScore: result.context?.account?.healthScore,
    routingPolicy: rotator?.getConfig?.()?.routingPolicy || "timer-first",
    idempotencyHit: result.isDeduplicated,
    retries: result.context?.retries,
    ...autoHeaders(autoDecision),
  });
  writeJson(res, 200, {
    id: `msg_${started.toString(36)}`,
    type: "message",
    role: "assistant",
    model: validation.value.model,
    content: contentBlocks,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: result.completion.inputTokens,
      output_tokens: result.completion.outputTokens,
    },
  }, rotatorHeaders);
}
