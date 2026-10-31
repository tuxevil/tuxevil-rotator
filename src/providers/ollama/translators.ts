// Ollama Cloud compat translators: OpenAI/Anthropic bodies -> Ollama native.
//
// Ported from the ollama-rotator project (same author) into the
// tuxevil-rotator provider layer. Shared helpers (chat message shapes,
// Anthropic -> OpenAI conversion) come from the Google translator module,
// which both providers inherited from the same original compat layer.

import type { RequestBody } from "../../proxy.js";
import { isRecord } from "../../compat/schema-sanitizer.js";
import { getModelSpec } from "../../compat/model-specs.js";
import {
  type AnthropicMessagesRequest,
  type ChatMessage,
  type CompatCompletion,
  type OpenAIChatCompletionRequest,
  type OpenAIToolCall,
  extractText,
  convertAnthropicToolsToOpenAI,
  convertAnthropicToolChoice,
  convertAnthropicMessagesToOpenAI,
  toolArgumentsToObject,
  toolArgumentsToString,
} from "../google-antigravity/translators.js";

/**
 * Translate an OpenAI chat completion request into the body shape consumed
 * by the Ollama adapter (buildOllamaPayload: request.messages / stream /
 * tools / options). Mirrors the Ollama rotator's openAIToOllamaBody.
 */
export function openAIToOllamaBody(
  input: OpenAIChatCompletionRequest,
): RequestBody {
  const messages: ChatMessage[] = [];
  for (const msg of input.messages) {
    const rawRole = msg.role === "developer" ? "system" : msg.role;
    if (rawRole === "system") {
      const systemText =
        typeof msg.content === "string"
          ? msg.content
          : extractText(msg.content);
      if (systemText) messages.push({ role: "system", content: systemText });
      continue;
    }
    if (rawRole === "tool") {
      const toolText =
        typeof msg.content === "string"
          ? msg.content
          : extractText(msg.content);
      const entry: ChatMessage = {
        role: "tool",
        content: toolText || "",
        tool_call_id: msg.tool_call_id,
      };
      if (isRecord(msg) && typeof msg.name === "string") {
        entry.name = msg.name;
      }
      messages.push(entry);
      continue;
    }
    if (rawRole === "assistant" || rawRole === "model") {
      const text =
        typeof msg.content === "string" ? msg.content : extractText(msg.content);
      const entry: ChatMessage = { role: "assistant", content: text || null };
      const toolCalls = Array.isArray(msg.tool_calls)
        ? msg.tool_calls.filter(
            (tc) =>
              isRecord(tc) &&
              isRecord(tc.function) &&
              typeof tc.function.name === "string",
          )
        : [];
      if (toolCalls.length > 0) {
        entry.tool_calls = toolCalls.map((tc) => {
          // Ollama expects `function.arguments` as a parsed object, but
          // OpenAI sends it as a JSON-encoded string. Parse it back so
          // the Go upstream doesn't reject the body.
          const parsedArgs = toolArgumentsToObject(
            (tc.function as { arguments?: unknown }).arguments,
          );
          return {
            id:
              (tc.id as string) || `call_${Date.now().toString(36)}`,
            type: "function" as const,
            function: {
              name: (tc.function as { name: string }).name,
              arguments: parsedArgs,
            },
          };
        });
      }
      messages.push(entry);
      continue;
    }
    // user
    const content = msg.content;
    if (Array.isArray(content)) {
      const parts: Array<Record<string, unknown>> = [];
      for (const part of content) {
        if (!isRecord(part)) continue;
        if (part.type === "text" && typeof part.text === "string") {
          if (part.text) parts.push({ type: "text", text: part.text });
          continue;
        }
        if (
          part.type === "image_url" &&
          isRecord(part.image_url) &&
          typeof part.image_url.url === "string"
        ) {
          parts.push({
            type: "image_url",
            image_url: { url: part.image_url.url },
          });
          continue;
        }
        if (
          part.type === "image" &&
          isRecord(part.source) &&
          typeof part.source.data === "string"
        ) {
          const mediaType =
            typeof part.source.media_type === "string"
              ? part.source.media_type
              : "image/png";
          parts.push({
            type: "image_url",
            image_url: {
              url: `data:${mediaType};base64,${part.source.data}`,
            },
          });
        }
      }
      if (parts.length > 0) {
        messages.push({
          role: "user",
          content: parts as ChatMessage["content"],
        });
        continue;
      }
      const text = extractText(content);
      if (text) messages.push({ role: "user", content: text });
      continue;
    }
    const text = typeof content === "string" ? content : extractText(content);
    if (text) messages.push({ role: "user", content: text });
  }
  if (messages.length === 0) messages.push({ role: "user", content: "Hello" });

  const options: Record<string, unknown> = {};
  if (typeof input.temperature === "number" && input.temperature !== 1)
    options.temperature = input.temperature;
  const requestedMaxOutput =
    typeof input.max_tokens === "number"
      ? input.max_tokens
      : typeof input.max_completion_tokens === "number"
        ? input.max_completion_tokens
        : undefined;
  const maxOutputTokens =
    requestedMaxOutput ?? getModelSpec(input.model)?.maxOutputTokens ?? 8192;
  options.num_predict = maxOutputTokens;
  const tools = Array.isArray(input.tools) && input.tools.length > 0
    ? input.tools
    : undefined;
  return {
    project: "",
    model: input.model,
    request: {
      model: input.model,
      messages,
      stream: input.stream !== false,
      ...(tools ? { tools } : {}),
      ...(Object.keys(options).length > 0 ? { options } : {}),
    },
  };
}

/**
 * Translate an Anthropic messages request into an Ollama native body by
 * first converting to the OpenAI chat shape (shared with the Google path).
 */
export function anthropicToOllamaBody(
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
  return openAIToOllamaBody({
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

/**
 * Parse a complete NDJSON response body into a CompatCompletion
 * (text, token usage from the terminal `done` record, tool calls).
 */
export function parseOllamaNdjson(raw: string): CompatCompletion {
  let inputTokens = 0;
  let outputTokens = 0;
  let text = "";
  let thinkingText = "";
  let streamError: string | undefined;
  let finishReason: string | undefined;
  let terminal = false;
  const toolCalls: OpenAIToolCall[] = [];
  let chunks = raw.split(/\r?\n/);
  // Nonstreaming Ollama may return one pretty-printed JSON object.
  try { const single: unknown = JSON.parse(raw); if (isRecord(single)) chunks = [JSON.stringify(single)]; } catch { /* NDJSON */ }
  for (const chunk of chunks) {
    const line = chunk.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (!isRecord(parsed)) { streamError = "Invalid Ollama response"; continue; }
      if (parsed.error !== undefined) { streamError = "Ollama returned an upstream error"; continue; }
      if (parsed.done === true) {
        terminal = true;
        if (parsed.done_reason === "length") finishReason = "MAX_TOKENS";
        inputTokens = (parsed.prompt_eval_count as number) ?? 0;
        outputTokens = (parsed.eval_count as number) ?? 0;
      }
      const msg = isRecord(parsed.message) ? parsed.message : null;
      if (msg) {
        if (typeof msg.thinking === "string") thinkingText += msg.thinking;
        if (typeof msg.content === "string" && msg.content) {
          text += msg.content;
        }
        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
          for (const tc of msg.tool_calls) {
            if (!isRecord(tc) || !isRecord(tc.function)) continue;
            toolCalls.push({
              id: (tc.id as string) || `call_${Date.now().toString(36)}`,
              type: "function",
              function: {
                name:
                  typeof tc.function.name === "string"
                    ? tc.function.name
                    : "unknown",
                arguments: toolArgumentsToString(tc.function.arguments),
              },
            });
          }
        }
      }
    } catch {
      streamError = "Malformed Ollama response";
    }
  }
  if (!terminal) streamError ??= "Ollama response ended without a completion record";
  if (!text.trim() && toolCalls.length === 0) streamError ??= "Ollama returned no completion content";
  return {
    ...(thinkingText ? { thinkingText } : {}),
    ...(streamError ? { streamError } : {}),
    ...(finishReason ? { finishReason } : {}),
    text,
    inputTokens,
    outputTokens,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}