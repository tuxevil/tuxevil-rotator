import { logger, redactSensitive } from "../../logger.js";
import { applyModelAlias } from "../../types.js";
import type { RequestBody } from "../../proxy.js";
import {
  isRecord,
  sanitizeGeminiSchema,
  sanitizeClaudeViaGeminiSchema,
} from "../../compat/schema-sanitizer.js";
import {
  getModelFamily,
  getModelSpec,
  isThinkingModel,
} from "../../compat/model-specs.js";
import {
  thoughtSignatureCache,
  getStoredResponse,
  setStoredResponse,
  makeCompatId,
} from "../../compat/cache.js";

const compatLogger = logger.child("compat");

const VALIDATION_LOG_MAX_CHARS = 200;

export function logValidationFailure(scope: string, payload: unknown): void {
  const truncated = redactSensitive(JSON.stringify(payload));
  const clipped =
    truncated.length > VALIDATION_LOG_MAX_CHARS
      ? `${truncated.slice(0, VALIDATION_LOG_MAX_CHARS)}…[+${truncated.length - VALIDATION_LOG_MAX_CHARS} chars]`
      : truncated;
  compatLogger.warn(`${scope}: ${clipped}`);
}

export interface ResponseOutputText {
  type: "output_text";
  text: string;
  annotations: unknown[];
}

export interface ResponseMessageOutputItem {
  id: string;
  type: "message";
  status: "completed";
  role: "assistant";
  content: ResponseOutputText[];
}

export interface ResponseFunctionCallOutputItem {
  id: string;
  type: "function_call";
  call_id: string;
  name: string;
  /** JSON-encoded function arguments (OpenAI Responses API format). */
  arguments: unknown;
  status: "completed";
}

export type ResponseOutputItem =
  | ResponseMessageOutputItem
  | ResponseFunctionCallOutputItem;

export interface ChatMessage {
  role: "system" | "developer" | "user" | "assistant" | "model" | "tool";
  content?:
    | string
    | Array<{ type: string; text?: string; [key: string]: unknown }>
    | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /**
     * Function arguments: the OpenAI standard encodes this as a
     * JSON-stringified string, while Ollama expects an object. Callers
     * (rotator/forward) deal with the right shape for each provider.
     */
    arguments: unknown;
  };
}

export interface OpenAIToolChoice {
  type: "function";
  function: { name: string };
}

export interface OpenAIChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  prompt?: string | string[];
  input?: unknown;
  tools?: OpenAITool[];
  tool_choice?: unknown;
  /** OpenAI-style reasoning effort. Mapped to Gemini thinkingLevel. */
  reasoning_effort?: string;
  [key: string]: unknown;
}

export interface OpenAIResponsesRequest {
  model: string;
  input?: unknown;
  instructions?:
    | string
    | Array<{ type: string; text?: string; [key: string]: unknown }>
    | null;
  stream?: boolean;
  temperature?: number;
  max_output_tokens?: number;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: unknown;
  reasoning?: { effort?: string | null; [key: string]: unknown } | null;
  metadata?: Record<string, string>;
  store?: boolean;
  previous_response_id?: string | null;
  conversation?: unknown;
  parallel_tool_calls?: boolean;
  [key: string]: unknown;
}

export interface AnthropicMessagesRequest {
  model: string;
  messages: ChatMessage[];
  system?:
    | string
    | Array<{ type: string; text?: string; [key: string]: unknown }>;
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  [key: string]: unknown;
}

export interface CompatCompletion {
  text: string;
  thinkingText?: string; // Gemini thought blocks (thought: true), emitted as reasoning_content
  inputTokens: number;
  outputTokens: number;
  firstByteMs?: number;
  responseId?: string;
  toolCalls?: OpenAIToolCall[];
  rawResponse?: unknown;
  streamError?: string;
}

export type AntigravityPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };
export type GeminiContent = { role: "user" | "model"; parts: unknown[] };

interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

interface GeminiToolConfig {
  functionCallingConfig: {
    mode: "AUTO" | "NONE" | "ANY";
    allowedFunctionNames?: string[];
  };
}

export type ResponsesConversionResult = {
  chatRequest: OpenAIChatCompletionRequest;
  inputItems: Array<Record<string, unknown>>;
  conversationMessages: ChatMessage[];
  previousResponseId: string | null;
};

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Normalize a tool-call `arguments` field into the JSON-encoded string
 * shape that OpenAI-compat responses expect. The Ollama adapter feeds us
 * a parsed object, while OpenAI/Antigravity already gives us a string.
 */
export function toolArgumentsToString(args: unknown): string {
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return "{}";
  }
}

/**
 * Normalize a tool-call `arguments` field into a parsed object, falling
 * back to an empty object when the payload is malformed. Used when
 * forwarding an OpenAI-style request (where `arguments` is a string)
 * into Ollama (which expects an object).
 */
export function toolArgumentsToObject(args: unknown): Record<string, unknown> {
  if (args && typeof args === "object") return args as Record<string, unknown>;
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through
    }
  }
  return {};
}

function cleanCacheControl<T>(content: T): T {
  if (!Array.isArray(content)) return content;
  return content.map((block: Record<string, unknown>) => {
    if (!block || typeof block !== "object") return block;
    if ("cache_control" in block) {
      const { cache_control: _cc, ...rest } = block;
      return rest;
    }
    return block;
  }) as T;
}

export function extractText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return cleanCacheControl(content)
    .filter(
      (p: { type?: string; text?: string; thinking?: string }) =>
        (p.type === "text" && typeof p.text === "string") ||
        (p.type === "thinking" && typeof p.thinking === "string"),
    )
    .map((p: { type?: string; text?: string; thinking?: string }) =>
      p.type === "thinking"
        ? `[Thinking]\n${p.thinking}\n[/Thinking]`
        : (p.text as string),
    )
    .join("\n");
}

export function dataUrlToInlineData(url: string): AntigravityPart | null {
  const match = url.match(/^data:([^;,]+);base64,(.+)$/s);
  if (!match) return null;
  return { inlineData: { mimeType: match[1], data: match[2] } };
}

export function extractParts(
  content: ChatMessage["content"],
): AntigravityPart[] {
  if (content === null) return [];
  if (typeof content === "string") return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts: AntigravityPart[] = [];
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string" && part.text) {
      parts.push({ text: part.text });
      continue;
    }
    if (
      part.type === "thinking" &&
      typeof part.thinking === "string" &&
      part.thinking
    ) {
      parts.push({ text: `[Thinking]\n${part.thinking}\n[/Thinking]` });
      continue;
    }
    if (
      part.type === "image_url" &&
      isRecord(part.image_url) &&
      typeof part.image_url.url === "string"
    ) {
      const inline = dataUrlToInlineData(part.image_url.url);
      if (inline) parts.push(inline);
      continue;
    }
    if (
      part.type === "image" &&
      isRecord(part.source) &&
      part.source.type === "base64" &&
      typeof part.source.media_type === "string" &&
      typeof part.source.data === "string"
    ) {
      parts.push({
        inlineData: {
          mimeType: part.source.media_type,
          data: part.source.data,
        },
      });
    }
  }
  return parts;
}

export function convertOpenAIToolsToGemini(
  tools: OpenAITool[],
  isClaude: boolean = false,
): { functionDeclarations: GeminiFunctionDeclaration[] }[] {
  const decls: GeminiFunctionDeclaration[] = tools
    .filter((t) => t.type === "function" && isNonEmptyString(t.function?.name))
    .map((t) => {
      const sanitized = t.function.parameters
        ? ((isClaude
            ? sanitizeClaudeViaGeminiSchema(t.function.parameters)
            : sanitizeGeminiSchema(t.function.parameters)) as Record<
            string,
            unknown
          >)
        : undefined;
      return {
        name: t.function.name,
        ...(t.function.description
          ? { description: t.function.description }
          : {}),
        ...(sanitized ? { parameters: sanitized } : {}),
      };
    });
  return decls.length > 0 ? [{ functionDeclarations: decls }] : [];
}

export function convertToolChoiceToGemini(
  toolChoice: unknown,
): GeminiToolConfig | undefined {
  if (!toolChoice || toolChoice === "none")
    return { functionCallingConfig: { mode: "NONE" } };
  if (toolChoice === "auto" || toolChoice === "required")
    return { functionCallingConfig: { mode: "AUTO" } };
  if (
    isRecord(toolChoice) &&
    toolChoice.type === "function" &&
    isRecord(toolChoice.function) &&
    isNonEmptyString(toolChoice.function.name)
  ) {
    return {
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: [toolChoice.function.name],
      },
    };
  }
  return { functionCallingConfig: { mode: "AUTO" } };
}

function forcesToolUse(toolChoice: unknown): boolean {
  if (toolChoice === "required") return true;
  return isRecord(toolChoice) &&
    toolChoice.type === "function" &&
    ((isRecord(toolChoice.function) && isNonEmptyString(toolChoice.function.name)) ||
      isNonEmptyString(toolChoice.name));
}

export function validateMessages(value: unknown): value is ChatMessage[] {
  return (
    Array.isArray(value) &&
    value.every((msg) => {
      if (!isRecord(msg)) return false;
      if (
        !["system", "developer", "user", "assistant", "model", "tool"].includes(
          String(msg.role),
        )
      )
        return false;
      // OpenAI clients may omit assistant content when the turn consists
      // solely of valid tool calls. Other roles still require content.
      if (msg.content === undefined) {
        return msg.role === "assistant" && hasValidToolCalls(msg.tool_calls);
      }
      return (
        typeof msg.content === "string" ||
        msg.content === null ||
        Array.isArray(msg.content)
      );
    })
  );
}

function hasValidToolCalls(value: unknown): value is OpenAIToolCall[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (toolCall) =>
        isRecord(toolCall) &&
        isNonEmptyString(toolCall.id) &&
        toolCall.type === "function" &&
        isRecord(toolCall.function) &&
        isNonEmptyString(toolCall.function.name) &&
        "arguments" in toolCall.function,
    )
  );
}

export function extractTextFromUnknownContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!isRecord(part)) return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.input_text === "string") return part.input_text;
      if (typeof part.output_text === "string") return part.output_text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function normalizeContentBlocks(
  content: unknown,
): ChatMessage["content"] {
  if (typeof content === "string" || content === null) return content;
  if (!Array.isArray(content)) return extractTextFromUnknownContent(content);
  const blocks = content.flatMap((part) => {
    if (typeof part === "string") return [{ type: "text", text: part }];
    if (!isRecord(part)) return [];
    if (part.type === "input_text" && typeof part.text === "string")
      return [{ type: "text", text: part.text }];
    if (part.type === "output_text" && typeof part.text === "string")
      return [{ type: "text", text: part.text }];
    if (typeof part.text === "string")
      return [
        {
          ...part,
          type: typeof part.type === "string" ? part.type : "text",
          text: part.text,
        },
      ];
    if (typeof part.input_text === "string")
      return [{ type: "text", text: part.input_text }];
    if (typeof part.output_text === "string")
      return [{ type: "text", text: part.output_text }];
    if (part.type === "input_image" && typeof part.image_url === "string") {
      return [{ type: "image_url", image_url: { url: part.image_url } }];
    }
    return [part as { type: string; text?: string; [key: string]: unknown }];
  });
  return blocks.length > 0 ? blocks : "";
}

export function normalizeInstructionsContent(
  content: OpenAIResponsesRequest["instructions"],
): ChatMessage["content"] {
  if (typeof content === "string" || content === null || content === undefined)
    return content ?? "";
  return normalizeContentBlocks(content);
}

export function contentToResponseInputBlocks(
  content: ChatMessage["content"],
  role: string,
): Array<Record<string, unknown>> {
  if (typeof content === "string") {
    if (!content) return [];
    return [
      {
        type:
          role === "assistant" || role === "model"
            ? "output_text"
            : "input_text",
        text: content,
      },
    ];
  }
  if (!Array.isArray(content)) return [];
  return cleanCacheControl(content).flatMap((part) => {
    if (!isRecord(part)) return [];
    if (typeof part.text === "string") {
      return [
        {
          type:
            role === "assistant" || role === "model"
              ? "output_text"
              : "input_text",
          text: part.text,
        },
      ];
    }
    if (
      part.type === "image_url" &&
      isRecord(part.image_url) &&
      typeof part.image_url.url === "string"
    ) {
      return [{ type: "input_image", image_url: part.image_url.url }];
    }
    return [part];
  });
}

export function parseResponsesInput(
  input: unknown,
  callIdToName: Map<string, string> = new Map(),
): ParsedResponsesInput {
  if (typeof input === "string") {
    return {
      inputItems: [
        {
          id: makeCompatId("in"),
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: input }],
        },
      ],
      messages: [{ role: "user", content: input }],
    };
  }
  if (!Array.isArray(input)) return { inputItems: [], messages: [] };

  const inputItems: Array<Record<string, unknown>> = [];
  const messages: ChatMessage[] = [];

  for (const rawItem of input) {
    if (typeof rawItem === "string") {
      inputItems.push({
        id: makeCompatId("in"),
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: rawItem }],
      });
      messages.push({ role: "user", content: rawItem });
      continue;
    }
    if (!isRecord(rawItem)) continue;

    if (
      rawItem.type === "function_call_output" &&
      typeof rawItem.call_id === "string"
    ) {
      const outputText =
        typeof rawItem.output === "string"
          ? rawItem.output
          : JSON.stringify(rawItem.output ?? "");
      const toolName =
        typeof rawItem.name === "string"
          ? rawItem.name
          : callIdToName.get(rawItem.call_id) || "unknown";
      inputItems.push({
        id: makeCompatId("in"),
        type: "function_call_output",
        call_id: rawItem.call_id,
        output: outputText,
      });
      messages.push({
        role: "tool",
        content: outputText,
        name: toolName,
        tool_call_id: rawItem.call_id,
      });
      continue;
    }

    if (rawItem.type === "function_call" && typeof rawItem.name === "string") {
      const callId =
        typeof rawItem.call_id === "string"
          ? rawItem.call_id
          : makeCompatId("call");
      const args =
        typeof rawItem.arguments === "string"
          ? rawItem.arguments
          : JSON.stringify(rawItem.arguments ?? {});
      inputItems.push({
        id: makeCompatId("in"),
        type: "function_call",
        call_id: callId,
        name: rawItem.name,
        arguments: args,
      });
      const lastMsg = messages[messages.length - 1];
      if (
        lastMsg &&
        lastMsg.role === "assistant" &&
        Array.isArray(lastMsg.tool_calls)
      ) {
        lastMsg.tool_calls.push({
          id: callId,
          type: "function",
          function: { name: rawItem.name, arguments: args },
        });
      } else {
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: callId,
              type: "function",
              function: { name: rawItem.name, arguments: args },
            },
          ],
        });
      }
      continue;
    }

    const isMessage =
      rawItem.type === "message" ||
      typeof rawItem.role === "string" ||
      "content" in rawItem;
    if (!isMessage) continue;
    const rawRole = typeof rawItem.role === "string" ? rawItem.role : "user";
    const role = rawRole === "developer" ? "system" : rawRole;
    if (!["system", "user", "assistant", "model", "tool"].includes(role))
      continue;
    const content =
      "content" in rawItem
        ? normalizeContentBlocks(rawItem.content)
        : extractTextFromUnknownContent(rawItem);
    inputItems.push({
      id: makeCompatId("in"),
      type: "message",
      role: rawRole,
      content: contentToResponseInputBlocks(content, role),
    });
    messages.push({ role: role as ChatMessage["role"], content });
  }

  return { inputItems, messages };
}

type ParsedResponsesInput = {
  inputItems: Array<Record<string, unknown>>;
  messages: ChatMessage[];
};

export function messagesFromResponsesInput(
  input: unknown,
): ChatMessage[] | null {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return null;

  const messages: ChatMessage[] = [];
  for (const item of input) {
    if (typeof item === "string") {
      messages.push({ role: "user", content: item });
      continue;
    }
    if (!isRecord(item)) continue;
    const role = typeof item.role === "string" ? item.role : "user";
    if (!["system", "user", "assistant", "model", "tool"].includes(role))
      continue;
    const content =
      "content" in item
        ? normalizeContentBlocks(item.content)
        : extractTextFromUnknownContent(item);
    messages.push({ role: role as ChatMessage["role"], content });
  }
  return messages.length > 0 ? messages : null;
}

export function messagesFromLooseMessages(
  value: unknown,
): ChatMessage[] | null {
  if (typeof value === "string") return [{ role: "user", content: value }];
  if (isRecord(value)) return messagesFromResponsesInput([value]);
  return null;
}

export function messagesFromAntigravityRequest(
  value: Record<string, unknown>,
): ChatMessage[] | null {
  const request = isRecord(value.request) ? value.request : null;
  if (!request || !Array.isArray(request.contents)) return null;
  const messages: ChatMessage[] = [];
  if (
    isRecord(request.systemInstruction) &&
    Array.isArray(request.systemInstruction.parts)
  ) {
    const systemText = request.systemInstruction.parts
      .map((part) =>
        isRecord(part) && typeof part.text === "string" ? part.text : "",
      )
      .filter(Boolean)
      .join("\n");
    if (systemText) messages.push({ role: "system", content: systemText });
  }
  for (const turn of request.contents) {
    if (!isRecord(turn) || !Array.isArray(turn.parts)) continue;
    const role =
      turn.role === "model" || turn.role === "assistant" ? "assistant" : "user";
    const content = turn.parts
      .map((part) =>
        isRecord(part) && typeof part.text === "string" ? part.text : "",
      )
      .filter(Boolean)
      .join("\n");
    messages.push({ role, content });
  }
  return messages.length > 0 ? messages : null;
}

export function normalizeOpenAIChatCompletionRequest(value: unknown): unknown {
  if (!isRecord(value) || Array.isArray(value.messages)) return value;
  const messages = (() => {
    if ("messages" in value) return messagesFromLooseMessages(value.messages);
    if (typeof value.prompt === "string")
      return [{ role: "user", content: value.prompt }];
    if (Array.isArray(value.prompt))
      return (
        messagesFromResponsesInput(value.prompt) ??
        value.prompt.map((prompt) => ({
          role: "user",
          content: String(prompt),
        }))
      );
    if ("input" in value) return messagesFromResponsesInput(value.input);
    return messagesFromAntigravityRequest(value);
  })();
  return messages ? { ...value, messages } : value;
}

export function normalizeOpenAIResponsesRequest(value: unknown): unknown {
  if (!isRecord(value)) return value;

  let normalized: Record<string, unknown> = { ...value };
  if (Array.isArray(value.tools)) {
    const before = value.tools.length;
    const filtered: unknown[] = [];
    for (const t of value.tools) {
      if (!isRecord(t) || typeof t.type !== "string") continue;
      if (t.type !== "function") continue;

      if (isNonEmptyString(t.name) && !isRecord(t.function)) {
        filtered.push({
          type: "function",
          function: {
            name: t.name,
            ...(typeof t.description === "string"
              ? { description: t.description }
              : {}),
            ...(isRecord(t.parameters) ? { parameters: t.parameters } : {}),
          },
        });
        continue;
      }

      if (isRecord(t.function) && isNonEmptyString(t.function.name)) {
        filtered.push(t);
      }
    }
    const dropped = before - filtered.length;
    if (dropped > 0) {
      compatLogger.warn(
        `Filtered ${dropped} unsupported/unnamed tool(s) from Responses request (kept ${filtered.length} function tools)`,
      );
    }
    normalized = {
      ...normalized,
      tools: filtered.length > 0 ? filtered : undefined,
    };
  }

  if ("input" in normalized) return normalized;
  if ("messages" in normalized)
    return { ...normalized, input: normalized.messages };
  if ("prompt" in normalized)
    return { ...normalized, input: normalized.prompt };
  return normalized;
}

export function normalizeAnthropicMessagesRequest(value: unknown): unknown {
  if (!isRecord(value) || Array.isArray(value.messages)) return value;
  const messages =
    "messages" in value
      ? messagesFromLooseMessages(value.messages)
      : "input" in value
        ? messagesFromResponsesInput(value.input)
        : messagesFromAntigravityRequest(value);
  return messages ? { ...value, messages } : value;
}

export function convertResponsesToChatRequest(
  input: OpenAIResponsesRequest,
): ResponsesConversionResult {
  const previousResponseId = input.previous_response_id ?? null;
  const previous = previousResponseId
    ? getStoredResponse(previousResponseId)
    : null;
  if (previousResponseId && !previous) {
    throw new Error(`previous_response_id not found: ${previousResponseId}`);
  }

  const previousCallIdToName = previous
    ? new Map(Object.entries(previous.callIdToName))
    : new Map<string, string>();
  const previousConversationMessages: ChatMessage[] = previous
    ? (previous.conversationMessages as unknown as ChatMessage[])
    : [];

  const parsed = parseResponsesInput(input.input, previousCallIdToName);
  const conversationMessages = [
    ...previousConversationMessages,
    ...parsed.messages,
  ];
  const chatMessages = [
    ...(input.instructions
      ? [
          {
            role: "system" as const,
            content: normalizeInstructionsContent(input.instructions),
          },
        ]
      : []),
    ...conversationMessages,
  ];

  return {
    chatRequest: {
      model: input.model,
      messages: chatMessages,
      stream: input.stream,
      temperature: input.temperature,
      max_tokens: input.max_output_tokens,
      tools: input.tools as OpenAITool[] | undefined,
      tool_choice: input.tool_choice,
      reasoning_effort:
        typeof input.reasoning?.effort === "string"
          ? input.reasoning.effort
          : undefined,
      parallel_tool_calls: input.parallel_tool_calls,
    },
    inputItems: parsed.inputItems,
    conversationMessages,
    previousResponseId,
  };
}

/**
 * Canonical model ID whose thinking level follows an OpenAI-style
 * reasoning_effort. Matched case-insensitively against the exact ID only;
 * virtual siblings (e.g. `gemini-3.7-flash-tiered-high`) are excluded.
 */
export const TIERED_EFFORT_MODEL_ID = "gemini-3.7-flash-tiered";

/**
 * Map an OpenAI Chat `reasoning_effort` to a Gemini `thinkingLevel` for
 * `gemini-3.7-flash-tiered` only. Accepts exactly low/medium/high
 * (case-insensitive); anything else returns undefined so the caller falls
 * back to the existing adaptive/fixed-budget semantics and never emits an
 * invalid upstream enum.
 */
export function mapTieredReasoningEffortToThinkingLevel(
  effort: string | undefined,
  modelId: string,
): "LOW" | "MEDIUM" | "HIGH" | undefined {
  if (modelId.toLowerCase() !== TIERED_EFFORT_MODEL_ID) return undefined;
  if (!isNonEmptyString(effort)) return undefined;
  switch (effort.toLowerCase()) {
    case "low":
      return "LOW";
    case "medium":
      return "MEDIUM";
    case "high":
      return "HIGH";
    default:
      return undefined;
  }
}

export function openAIToAntigravityBody(
  input: OpenAIChatCompletionRequest,
): RequestBody {
  const systemParts: string[] = [];
  const conversationMessages = input.messages.filter((msg) => {
    if (msg.role === "system" || msg.role === "developer") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : extractText(msg.content);
      if (text) systemParts.push(text);
      return false;
    }
    return true;
  });

  const isClaude = /^claude-/i.test(input.model);
  const isThinking = isThinkingModel(input.model);
  const isGeminiThinking = !isClaude && isThinking;

  const contents: GeminiContent[] = [];
  // Claude requires every tool_result to immediately follow its tool_use turn.
  let pendingClaudeToolCallIds = new Set<string>();
  // OpenAI tool messages often omit `name`; resolve the function name from the
  // preceding assistant tool_call (matched by tool_call_id) so the upstream
  // functionResponse never carries the placeholder "unknown".
  const toolCallIdToFunctionName = new Map<string, string>();
  for (let i = 0; i < conversationMessages.length; i++) {
    const msg = conversationMessages[i];
    if (msg.role === "assistant" || msg.role === "model") {
      let msgToolCalls = msg.tool_calls;
      if (Array.isArray(msgToolCalls) && msgToolCalls.length > 0) {
        const completedToolCallIds = new Set<string>();
        let j = i + 1;
        while (
          j < conversationMessages.length &&
          conversationMessages[j].role === "tool"
        ) {
          const toolCallId = conversationMessages[j].tool_call_id;
          if (typeof toolCallId === "string") {
            completedToolCallIds.add(toolCallId);
          }
          j++;
        }
        msgToolCalls = msgToolCalls.filter(
          (tc) => tc.id && completedToolCallIds.has(tc.id),
        );
        if (msgToolCalls.length === 0) {
          msgToolCalls = undefined;
        }
      }

      const hasMissingSig =
        isGeminiThinking &&
        Array.isArray(msgToolCalls) &&
        msgToolCalls.length > 0 &&
        !thoughtSignatureCache.has(msgToolCalls[0].id);

      if (hasMissingSig) {
        const toolNames = msgToolCalls!
          .map((tc) => tc.function.name)
          .join(", ");
        const resultParts: string[] = [];
        while (
          i + 1 < conversationMessages.length &&
          conversationMessages[i + 1].role === "tool"
        ) {
          i++;
          const toolMsg = conversationMessages[i];
          const toolText =
            typeof toolMsg.content === "string"
              ? toolMsg.content
              : extractText(toolMsg.content);
          resultParts.push(
            `${toolMsg.name || "tool"}: ${toolText.slice(0, 500)}`,
          );
        }
        const summaryText = `[Context: The assistant used tools (${toolNames}) and received results:\n${resultParts.join("\n")}]`;
        contents.push({ role: "user", parts: [{ text: summaryText }] });
        contents.push({
          role: "model",
          parts: [{ text: "Understood, I have the tool results." }],
        });
        continue;
      }

      const parts: unknown[] = [];
      if (msg.content) {
        const textContent =
          typeof msg.content === "string"
            ? msg.content
            : extractText(msg.content);
        if (textContent) parts.push({ text: textContent });
      }
      if (Array.isArray(msgToolCalls) && msgToolCalls.length > 0) {
        let isFirstInMessage = true;
        for (const tc of msgToolCalls) {
          if (typeof tc.id === "string" && typeof tc.function?.name === "string") {
            toolCallIdToFunctionName.set(tc.id, tc.function.name);
          }
          let args: unknown;
          try {
            args =
              typeof tc.function.arguments === "string"
                ? JSON.parse(tc.function.arguments)
                : tc.function.arguments;
          } catch {
            args = {};
          }
          const cachedSig = isFirstInMessage
            ? thoughtSignatureCache.get(tc.id)
            : undefined;
          parts.push({
            ...(cachedSig ? { thoughtSignature: cachedSig } : {}),
            functionCall: {
              ...(isClaude ? { id: tc.id } : {}),
              name: tc.function.name,
              args,
            },
          });
          isFirstInMessage = false;
        }
      }
      if (parts.length === 0) {
        parts.push({ text: "..." });
      }
      if (parts.length > 0) {
        const functionCallIds = new Set<string>();
        for (const part of parts) {
          if (!isRecord(part)) continue;
          const functionCall = part.functionCall;
          if (
            isRecord(functionCall) &&
            typeof functionCall.id === "string" &&
            functionCall.id
          ) {
            functionCallIds.add(functionCall.id);
          }
        }
        const hasFunctionCall = parts.some((p: any) => p.functionCall);
        if (isClaude) {
          const lastContent = contents[contents.length - 1];
          const prevHasFunctionCall =
            lastContent &&
            lastContent.role === "model" &&
            lastContent.parts.some((p: any) => p.functionCall);
          if (prevHasFunctionCall && !hasFunctionCall) {
            // Skip
          } else if (hasFunctionCall) {
            const fcOnly = parts.filter((p: any) => p.functionCall);
            if (prevHasFunctionCall) {
              lastContent.parts.push(...fcOnly);
              for (const id of functionCallIds) pendingClaudeToolCallIds.add(id);
            } else {
              contents.push({ role: "model", parts: fcOnly });
              pendingClaudeToolCallIds = new Set(functionCallIds);
            }
          } else {
            contents.push({ role: "model", parts });
            pendingClaudeToolCallIds.clear();
          }
        } else {
          contents.push({ role: "model", parts });
        }
      }
    } else if (msg.role === "tool") {
      const responseText =
        typeof msg.content === "string"
          ? msg.content
          : extractText(msg.content);
      const toolCallId = msg.tool_call_id;
      const fnName =
        msg.name ||
        (typeof toolCallId === "string"
          ? toolCallIdToFunctionName.get(toolCallId)
          : undefined) ||
        "unknown";
      if (
        isClaude &&
        (!toolCallId || !pendingClaudeToolCallIds.has(toolCallId))
      ) {
        continue;
      }
      let responseData: unknown;
      try {
        const parsed = JSON.parse(responseText);
        responseData =
          parsed !== null &&
          typeof parsed === "object" &&
          !Array.isArray(parsed)
            ? parsed
            : { output: parsed };
      } catch {
        responseData = { output: responseText };
      }
      const toolImages: AntigravityPart[] = [];
      if (msg.content && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (
            part.type === "image_url" &&
            isRecord(part.image_url) &&
            typeof part.image_url.url === "string"
          ) {
            const inlineData = dataUrlToInlineData(part.image_url.url);
            if (inlineData) toolImages.push(inlineData);
          } else if (
            part.type === "image" &&
            isRecord(part.source) &&
            typeof part.source.data === "string"
          ) {
            const mediaType =
              typeof part.source.media_type === "string"
                ? part.source.media_type
                : "image/png";
            toolImages.push({
              inlineData: { mimeType: mediaType, data: part.source.data },
            });
          }
        }
      }

      const fnResponsePart = {
        functionResponse: {
          ...(isClaude && toolCallId ? { id: toolCallId } : {}),
          name: fnName,
          response: responseData,
        },
      };
      const lastContent = contents[contents.length - 1];
      if (
        lastContent &&
        lastContent.role === "user" &&
        Array.isArray(lastContent.parts) &&
        lastContent.parts.length > 0 &&
        isRecord(lastContent.parts[0] as any) &&
        (lastContent.parts[0] as any).functionResponse !== undefined
      ) {
        const firstNonFnIdx = lastContent.parts.findIndex(
          (p: any) => !isRecord(p) || p.functionResponse === undefined,
        );
        if (firstNonFnIdx === -1) {
          lastContent.parts.push(fnResponsePart);
        } else {
          lastContent.parts.splice(firstNonFnIdx, 0, fnResponsePart);
        }
        if (toolImages.length > 0) {
          lastContent.parts.push(...toolImages);
        }
      } else {
        contents.push({ role: "user", parts: [fnResponsePart, ...toolImages] });
      }
      if (isClaude && toolCallId) pendingClaudeToolCallIds.delete(toolCallId);
    } else {
      const msgParts = extractParts(msg.content);
      if (msgParts.length > 0) {
        if (isClaude) pendingClaudeToolCallIds.clear();
        contents.push({ role: "user", parts: msgParts });
      }
    }
  }

  // Google rejects compatibility requests whose final contents turn is a
  // model turn. Claude additionally needs dangling tool-call turns removed;
  // other models keep the call history but still need a user turn to resume.
  while (contents.at(-1)?.role === "model") {
    const lastContent = contents.at(-1);
    const hasFunctionCall =
      lastContent?.parts.some((p: any) => isRecord(p) && p.functionCall) ??
      false;
    if (isClaude && hasFunctionCall) {
      contents.pop();
      continue;
    }
    contents.push({
      role: "user",
      parts: [
        {
          text: "Continue from the previous assistant message. Do not repeat completed tool calls unless new user input asks for them.",
        },
      ],
    });
    break;
  }

  if (contents.length === 0)
    contents.push({ role: "user", parts: [{ text: "Hello" }] });

  const inputTools = Array.isArray(input.tools)
    ? (input.tools as OpenAITool[])
    : [];
  const geminiTools = convertOpenAIToolsToGemini(inputTools, isClaude);
  const geminiToolConfig =
    input.tool_choice !== undefined
      ? convertToolChoiceToGemini(input.tool_choice)
      : undefined;

  const modelSpec = getModelSpec(input.model);
  const modelFamily = getModelFamily(input.model);
  let maxOutputTokens =
    typeof input.max_tokens === "number" ? input.max_tokens : undefined;
  if (maxOutputTokens && maxOutputTokens > modelSpec.maxOutputTokens) {
    compatLogger.debug(
      `Capping ${input.model} maxOutputTokens ${maxOutputTokens} → ${modelSpec.maxOutputTokens}`,
    );
    maxOutputTokens = modelSpec.maxOutputTokens;
  }

  let thinkingConfigObj: Record<string, unknown> | undefined;
  if (modelFamily === "claude" && isThinking && !forcesToolUse(input.tool_choice)) {
    const tb = modelSpec.thinkingBudget;
    thinkingConfigObj = { include_thoughts: true, thinking_budget: tb };
    if (!maxOutputTokens || maxOutputTokens <= tb) {
      maxOutputTokens = Math.min(tb + 8192, modelSpec.maxOutputTokens);
      compatLogger.debug(
        `Adjusted Claude maxOutputTokens → ${maxOutputTokens}`,
      );
    }
  } else if (isThinking && modelFamily !== "claude") {
    const tb = modelSpec.thinkingBudget;
    // Only the exact tiered model selects its thinking level from an
    // OpenAI-style reasoning_effort, and only while its spec stays adaptive
    // (thinkingBudget === -1). A fixed budget — bundled or set by an operator
    // modelSpecs override — deterministically wins and is never combined
    // with thinkingLevel.
    const tieredThinkingLevel =
      tb === -1
        ? mapTieredReasoningEffortToThinkingLevel(
            input.reasoning_effort,
            input.model,
          )
        : undefined;
    if (tieredThinkingLevel) {
      thinkingConfigObj = {
        includeThoughts: true,
        thinkingLevel: tieredThinkingLevel,
      };
    } else if (tb === -1) {
      thinkingConfigObj = { includeThoughts: true };
    } else {
      thinkingConfigObj = { includeThoughts: true, thinkingBudget: tb };
    }
    if (tb !== -1 && (!maxOutputTokens || maxOutputTokens <= tb)) {
      maxOutputTokens = Math.min(tb + 8192, modelSpec.maxOutputTokens);
      compatLogger.debug(
        `Adjusted Gemini maxOutputTokens → ${maxOutputTokens}`,
      );
    }
  } else if (input.reasoning_effort) {
    const budgets: Record<string, number> = {
      low: Math.round(modelSpec.thinkingBudget / 4),
      medium: Math.round(modelSpec.thinkingBudget / 2),
      high: modelSpec.thinkingBudget,
    };
    const b = budgets[input.reasoning_effort.toLowerCase()];
    if (b) thinkingConfigObj = { includeThoughts: true, thinkingBudget: b };
  }

  const generationConfig: Record<string, unknown> = {
    ...(typeof input.temperature === "number"
      ? { temperature: input.temperature }
      : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(thinkingConfigObj ? { thinkingConfig: thinkingConfigObj } : {}),
  };

  const request: Record<string, unknown> = {
    contents,
    generationConfig,
  };

  if (systemParts.length > 0) {
    if (!isClaude && isThinking) {
      const firstTurn = contents[0];
      if (
        firstTurn &&
        firstTurn.role === "user" &&
        (firstTurn.parts[0] as any)?.text !== undefined
      ) {
        (firstTurn.parts[0] as any).text =
          systemParts.join("\n\n") + "\n\n" + (firstTurn.parts[0] as any).text;
      } else if (firstTurn && firstTurn.role === "user") {
        firstTurn.parts.unshift({ text: systemParts.join("\n\n") + "\n\n" });
      } else {
        contents.unshift({
          role: "user",
          parts: [{ text: systemParts.join("\n\n") }],
        });
      }
    } else {
      request.systemInstruction = {
        role: "system",
        parts: [{ text: systemParts.join("\n\n") }],
      };
    }
  }

  if (geminiTools.length > 0) request.tools = geminiTools;
  if (geminiToolConfig) request.toolConfig = geminiToolConfig;

  const mappedModel = applyModelAlias(input.model);

  return {
    project: "compat-placeholder",
    model: mappedModel,
    displayModel: input.model,
    userAgent: "antigravity",
    requestType: "agent",
    request,
  };
}

export function convertAnthropicToolsToOpenAI(
  tools: unknown,
): OpenAITool[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const result: OpenAITool[] = [];
  for (const t of tools) {
    if (!isRecord(t) || !isNonEmptyString(t.name)) continue;
    result.push({
      type: "function",
      function: {
        name: t.name as string,
        ...(typeof t.description === "string"
          ? { description: t.description }
          : {}),
        ...(isRecord(t.input_schema)
          ? { parameters: t.input_schema as Record<string, unknown> }
          : {}),
      },
    });
  }
  return result.length > 0 ? result : undefined;
}

export function convertAnthropicToolChoice(toolChoice: unknown): unknown {
  if (!isRecord(toolChoice)) return toolChoice;
  if (toolChoice.type === "auto") return "auto";
  if (toolChoice.type === "any") return "required";
  if (toolChoice.type === "tool" && isNonEmptyString(toolChoice.name)) {
    return { type: "function", function: { name: toolChoice.name } };
  }
  return "auto";
}

export function convertAnthropicMessagesToOpenAI(
  messages: ChatMessage[],
): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const blocks = msg.content as Array<Record<string, unknown>>;
      const toolUseBlocks = blocks.filter(
        (b) => isRecord(b) && b.type === "tool_use" && isNonEmptyString(b.name),
      );
      if (toolUseBlocks.length > 0) {
        const textParts = blocks
          .filter(
            (b) =>
              isRecord(b) && b.type === "text" && typeof b.text === "string",
          )
          .map((b) => b.text as string)
          .join("");
        const toolCalls: OpenAIToolCall[] = toolUseBlocks.map((b) => ({
          id: (b.id as string) || `call_${Date.now().toString(36)}`,
          type: "function" as const,
          function: {
            name: b.name as string,
            arguments:
              typeof b.input === "string"
                ? b.input
                : JSON.stringify(b.input ?? {}),
          },
        }));
        result.push({
          role: "assistant",
          content: textParts || null,
          tool_calls: toolCalls,
        });
        continue;
      }
    }
    if (msg.role === "user" && Array.isArray(msg.content)) {
      const blocks = msg.content as Array<Record<string, unknown>>;
      const toolResults = blocks.filter(
        (b) => isRecord(b) && b.type === "tool_result",
      );
      if (toolResults.length > 0) {
        const otherBlocks = blocks.filter(
          (b) => !isRecord(b) || b.type !== "tool_result",
        );
        for (const tr of toolResults) {
          const content =
            typeof tr.content === "string"
              ? tr.content
              : Array.isArray(tr.content)
                ? extractTextFromUnknownContent(tr.content)
                : JSON.stringify(tr.content ?? "");
          result.push({
            role: "tool",
            content,
            tool_call_id: tr.tool_use_id as string,
          });
        }
        if (otherBlocks.length > 0) {
          result.push({
            role: "user",
            content: otherBlocks as ChatMessage["content"],
          });
        }
        continue;
      }
    }
    result.push(msg);
  }
  return result;
}

export function anthropicToAntigravityBody(
  input: AnthropicMessagesRequest,
): RequestBody {
  const systemText =
    typeof input.system === "string"
      ? input.system
      : Array.isArray(input.system)
        ? extractText(input.system as ChatMessage["content"])
        : "";
  const tools = convertAnthropicToolsToOpenAI(input.tools);
  const toolChoice = convertAnthropicToolChoice(input.tool_choice);
  const convertedMessages = convertAnthropicMessagesToOpenAI(input.messages);
  return openAIToAntigravityBody({
    model: input.model,
    stream: input.stream,
    temperature: input.temperature,
    max_tokens: input.max_tokens,
    tools,
    tool_choice: toolChoice,
    messages: [
      ...(systemText ? [{ role: "system" as const, content: systemText }] : []),
      ...convertedMessages,
    ],
  });
}

export function mapReasoningEffortToThinkingLevel(
  effort: string | undefined,
  modelId: string,
): number | undefined {
  const lowerModel = modelId.toLowerCase();
  const isGemini31Pro = /gemini-3\.1-pro/i.test(modelId);
  const isGemini3Flash =
    lowerModel.includes("gemini-3-flash") ||
    lowerModel.includes("gemini-3.5-flash");

  let effectiveEffort = effort;
  if (!effectiveEffort) {
    if (lowerModel.endsWith("-high") || lowerModel.includes("gemini-pro-agent"))
      effectiveEffort = "high";
    else if (lowerModel.endsWith("-low")) effectiveEffort = "low";
    else if (isGemini3Flash) effectiveEffort = "high";
  }

  if (!effectiveEffort) return undefined;

  if (isGemini31Pro) {
    switch (effectiveEffort.toLowerCase()) {
      case "high":
        return 10001;
      case "medium":
        return 5000;
      case "low":
        return 1001;
      default:
        return undefined;
    }
  }

  if (isGemini3Flash) {
    switch (effectiveEffort.toLowerCase()) {
      case "high":
        return -1;
      case "medium":
        return 4096;
      case "low":
        return 1024;
      default:
        return undefined;
    }
  }

  return undefined;
}

export function validateOpenAIChatCompletionRequest(
  value: unknown,
):
  | { ok: true; value: OpenAIChatCompletionRequest }
  | { ok: false; errors: string[] } {
  if (!isRecord(value))
    return { ok: false, errors: ["body must be a JSON object"] };
  const errors: string[] = [];
  if (!isNonEmptyString(value.model))
    errors.push("body.model must be a non-empty string");
  if (!validateMessages(value.messages)) {
    logValidationFailure("OpenAI messages validation failed", value.messages);
    errors.push("body.messages must be an array of chat messages");
  }
  if (value.stream !== undefined && typeof value.stream !== "boolean")
    errors.push("body.stream must be boolean when provided");
  if (value.temperature !== undefined && typeof value.temperature !== "number")
    errors.push("body.temperature must be number when provided");
  if (value.max_tokens !== undefined && typeof value.max_tokens !== "number")
    errors.push("body.max_tokens must be number when provided");
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: value as unknown as OpenAIChatCompletionRequest };
}

function validateResponsesTools(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    return ["body.tools must be an array when provided"];
  const errors: string[] = [];
  for (const tool of value) {
    if (!isRecord(tool)) {
      errors.push("each tool must be an object");
      continue;
    }
    if (tool.type !== "function") {
      errors.push(`only function tools are supported (got: ${tool.type})`);
    }
  }
  return errors;
}

export function validateOpenAIResponsesRequest(
  value: unknown,
):
  | { ok: true; value: OpenAIResponsesRequest }
  | { ok: false; errors: string[] } {
  if (!isRecord(value))
    return { ok: false, errors: ["body must be a JSON object"] };
  const errors: string[] = [];
  if (!isNonEmptyString(value.model))
    errors.push("body.model must be a non-empty string");
  if (value.stream !== undefined && typeof value.stream !== "boolean")
    errors.push("body.stream must be boolean when provided");
  if (value.temperature !== undefined && typeof value.temperature !== "number")
    errors.push("body.temperature must be number when provided");
  if (
    value.max_output_tokens !== undefined &&
    typeof value.max_output_tokens !== "number"
  )
    errors.push("body.max_output_tokens must be number when provided");
  if (value.store !== undefined && typeof value.store !== "boolean")
    errors.push("body.store must be boolean when provided");
  if (
    value.previous_response_id !== undefined &&
    value.previous_response_id !== null &&
    !isNonEmptyString(value.previous_response_id)
  ) {
    errors.push("body.previous_response_id must be a non-empty string or null");
  }
  if (value.conversation !== undefined && value.conversation !== null) {
    errors.push(
      "body.conversation is not supported; use previous_response_id instead",
    );
  }
  if (value.metadata !== undefined && !isRecord(value.metadata))
    errors.push("body.metadata must be an object when provided");
  if (
    value.reasoning !== undefined &&
    value.reasoning !== null &&
    !isRecord(value.reasoning)
  ) {
    errors.push("body.reasoning must be an object when provided");
  } else if (
    isRecord(value.reasoning) &&
    value.reasoning.effort !== undefined &&
    value.reasoning.effort !== null &&
    typeof value.reasoning.effort !== "string"
  ) {
    errors.push("body.reasoning.effort must be a string when provided");
  }
  if (
    value.instructions !== undefined &&
    value.instructions !== null &&
    typeof value.instructions !== "string" &&
    !Array.isArray(value.instructions)
  ) {
    errors.push(
      "body.instructions must be a string or content array when provided",
    );
  }
  errors.push(...validateResponsesTools(value.tools));
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: value as unknown as OpenAIResponsesRequest };
}

export function validateAnthropicMessagesRequest(
  value: unknown,
):
  | { ok: true; value: AnthropicMessagesRequest }
  | { ok: false; errors: string[] } {
  if (!isRecord(value))
    return { ok: false, errors: ["body must be a JSON object"] };
  const errors: string[] = [];
  if (!isNonEmptyString(value.model))
    errors.push("body.model must be a non-empty string");
  if (!validateMessages(value.messages))
    errors.push("body.messages must be an array of chat messages");
  if (
    value.system !== undefined &&
    typeof value.system !== "string" &&
    !Array.isArray(value.system)
  )
    errors.push("body.system must be string or content array when provided");
  if (value.stream !== undefined && typeof value.stream !== "boolean")
    errors.push("body.stream must be boolean when provided");
  if (value.temperature !== undefined && typeof value.temperature !== "number")
    errors.push("body.temperature must be number when provided");
  if (value.max_tokens !== undefined && typeof value.max_tokens !== "number")
    errors.push("body.max_tokens must be number when provided");
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: value as unknown as AnthropicMessagesRequest };
}

export function responseUsageFromCompletion(
  completion: CompatCompletion,
): Record<string, unknown> {
  return {
    input_tokens: completion.inputTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: completion.outputTokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: completion.inputTokens + completion.outputTokens,
  };
}

export function buildResponsesOutput(completion: CompatCompletion): {
  output: ResponseOutputItem[];
  outputText: string;
  callIdToName: Map<string, string>;
} {
  const output: ResponseOutputItem[] = [];
  const callIdToName = new Map<string, string>();
  if (completion.thinkingText) {
    output.push({
      id: makeCompatId("rs"),
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: completion.thinkingText }],
    } as unknown as ResponseOutputItem);
  }
  if (completion.text) {
    output.push({
      id: makeCompatId("msg"),
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        { type: "output_text", text: completion.text, annotations: [] },
      ],
    });
  }
  for (const toolCall of completion.toolCalls ?? []) {
    callIdToName.set(toolCall.id, toolCall.function.name);
    output.push({
      id: makeCompatId("fc"),
      type: "function_call",
      call_id: toolCall.id,
      name: toolCall.function.name,
      arguments: toolArgumentsToString(toolCall.function.arguments),
      status: "completed",
    });
  }
  return { output, outputText: completion.text, callIdToName };
}

export function buildAssistantMessageFromCompletion(
  completion: CompatCompletion,
): ChatMessage {
  return completion.toolCalls && completion.toolCalls.length > 0
    ? {
        role: "assistant",
        content: completion.text || null,
        tool_calls: completion.toolCalls,
      }
    : { role: "assistant", content: completion.text };
}

export function buildResponsesResponse(
  request: OpenAIResponsesRequest,
  responseId: string,
  createdAt: number,
  completion: CompatCompletion,
  status: "in_progress" | "completed" | "cancelled",
  previousResponseId: string | null,
): Record<string, unknown> {
  const { output, outputText } = buildResponsesOutput(completion);
  return {
    id: responseId,
    object: "response",
    created_at: createdAt,
    status,
    error: null,
    incomplete_details: null,
    instructions: request.instructions ?? null,
    max_output_tokens: request.max_output_tokens ?? null,
    model: request.model,
    output,
    output_text: outputText,
    parallel_tool_calls: request.parallel_tool_calls ?? true,
    previous_response_id: previousResponseId,
    reasoning: { effort: request.reasoning?.effort ?? null },
    store: request.store !== false,
    temperature: request.temperature ?? null,
    text: { format: { type: "text" } },
    tool_choice: request.tool_choice ?? "auto",
    tools: Array.isArray(request.tools) ? request.tools : [],
    top_p: null,
    truncation: "disabled",
    usage: responseUsageFromCompletion(completion),
    metadata: isRecord(request.metadata) ? request.metadata : {},
  };
}

export function saveResponsesEntry(
  response: Record<string, unknown>,
  inputItems: Array<Record<string, unknown>>,
  conversationMessages: ChatMessage[],
  completion: CompatCompletion,
): void {
  const responseId = typeof response.id === "string" ? response.id : null;
  if (!responseId) return;
  const { callIdToName } = buildResponsesOutput(completion);
  const mergedConversation = [
    ...conversationMessages,
    buildAssistantMessageFromCompletion(completion),
  ];
  const expiresAt = Date.now() + 6 * 60 * 60 * 1000;
  setStoredResponse(responseId, {
    response,
    inputItems,
    conversationMessages: mergedConversation as unknown as Array<
      Record<string, unknown>
    >,
    callIdToName: Object.fromEntries(callIdToName),
    expiresAt,
  });
}
