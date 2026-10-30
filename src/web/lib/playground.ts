// Shared, browser-independent playground contracts and compatibility evaluators.
export type PlaygroundTab = "chat" | "compare" | "compliance" | "transcription";
export interface ImageAttachment {
  name: string;
  url: string;
}
export type MessageContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    >;
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface PlaygroundMessage {
  role: "system" | "user" | "assistant";
  content: MessageContent | null;
  tool_calls?: ToolCall[];
}
export interface Parameters {
  system: string;
  temperature: string;
  maxTokens: string;
  effort: string;
  stream: boolean;
  tools: string;
}
export const DEFAULT_PARAMETERS: Parameters = {
  system: "",
  temperature: "",
  maxTokens: "512",
  effort: "",
  stream: true,
  tools: "",
};
export interface ChatRequest {
  model: string;
  messages: PlaygroundMessage[];
  stream: boolean;
  temperature?: number;
  max_tokens?: number;
  reasoning_effort?: string;
  tools?: unknown[];
  tool_choice?: unknown;
  response_format?: { type: "json_object" };
}
export interface ChatResult {
  content: string;
  reasoning: string;
  tools: ToolCall[];
  durationMs: number;
  firstContentMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  finishReason: string | null;
  metadata: Record<string, string>;
  raw: unknown[];
  done: boolean;
  status: number;
}
export interface Turn {
  request: ChatRequest;
  result: ChatResult | null;
  error?: string;
}
export interface PlaygroundPanel {
  id: string;
  model: string;
  params: Parameters;
  turns: Turn[];
}
export type CaseId = "basic" | "stream" | "system" | "json" | "tools";
export type Verdict =
  "passed" | "failed" | "unsupported" | "error" | "cancelled";
export interface ComplianceResult {
  model: string;
  caseId: CaseId;
  verdict: Verdict;
  explanation: string;
  turn: Turn;
}
export interface TranscriptionResult {
  id: string;
  filename: string;
  model: string;
  language: string;
  prompt: string;
  text: string;
  elapsedMs: number;
  createdAt: number;
}
export interface TranscriptionState {
  model: string;
  language: string;
  prompt: string;
  results: TranscriptionResult[];
}
export function newTranscription(): TranscriptionState {
  return { model: "", language: "", prompt: "", results: [] };
}
export interface PlaygroundDocument {
  version: 1;
  id: string;
  title: string;
  updatedAt: number;
  chat: PlaygroundPanel;
  compare: PlaygroundPanel[];
  sync: boolean;
  draft: string;
  images: ImageAttachment[];
  complianceModels: string[];
  cases: CaseId[];
  results: ComplianceResult[];
  transcription?: TranscriptionState;
}
export const CASES: Array<{ id: CaseId; label: string }> = [
  { id: "basic", label: "Basic chat" },
  { id: "stream", label: "Streaming" },
  { id: "system", label: "System prompt" },
  { id: "json", label: "JSON mode" },
  { id: "tools", label: "Tool calling" },
];
export const VERDICT_LABELS: Record<Verdict, string> = {
  passed: "Passed",
  failed: "Failed",
  unsupported: "Not supported",
  error: "Error",
  cancelled: "Cancelled",
};
/**
 * Transcription-only compatibility names (whisper-1). They are listed by
 * /api/models but cannot serve Chat Completions; Gemini models, which the
 * Transcription tab also offers, handle both.
 */
export function isAudioOnlyModel(id: string): boolean {
  return /^whisper(?:-1)?$/i.test(id.trim());
}
// randomUUID requires a secure context; getRandomValues also works on LAN HTTP dashboards.
export const newId = (): string =>
  typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
export function newPanel(): PlaygroundPanel {
  return {
    id: newId(),
    model: "",
    params: { ...DEFAULT_PARAMETERS },
    turns: [],
  };
}
export function newDocument(): PlaygroundDocument {
  return {
    version: 1,
    id: newId(),
    title: "Untitled playground",
    updatedAt: Date.now(),
    chat: newPanel(),
    compare: [newPanel(), newPanel()],
    sync: true,
    draft: "",
    images: [],
    complianceModels: [],
    cases: CASES.map((c) => c.id),
    results: [],
    transcription: newTranscription(),
  };
}
export function userMessage(
  text: string,
  images: ImageAttachment[],
): PlaygroundMessage {
  return {
    role: "user",
    content: images.length
      ? [
          ...(text ? [{ type: "text" as const, text }] : []),
          ...images.map((image) => ({
            type: "image_url" as const,
            image_url: { url: image.url },
          })),
        ]
      : text,
  };
}
export function buildChatRequest(
  panel: PlaygroundPanel,
  next: PlaygroundMessage,
  retry = false,
): ChatRequest {
  if (!panel.model) throw new Error("Choose a model first.");
  const params = panel.params;
  const messages: PlaygroundMessage[] = params.system
    ? [{ role: "system", content: params.system }]
    : [];
  // Tool calls are inspected only; without tool results they cannot be replayed.
  const turns = retry ? panel.turns.slice(0, -1) : panel.turns;
  for (const turn of turns) {
    if (
      turn.error ||
      !turn.result?.done ||
      !turn.result.content ||
      turn.result.tools.length
    )
      continue;
    messages.push(turn.request.messages[turn.request.messages.length - 1], {
      role: "assistant",
      content: turn.result.content,
    });
  }
  messages.push(next);
  const request: ChatRequest = {
    model: panel.model,
    messages,
    stream: params.stream,
  };
  if (params.temperature !== "") {
    const value = Number(params.temperature);
    if (!Number.isFinite(value) || value < 0 || value > 2)
      throw new Error("Temperature must be between 0 and 2.");
    request.temperature = value;
  }
  if (params.maxTokens !== "") {
    const value = Number(params.maxTokens);
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error("Max tokens must be a positive integer.");
    request.max_tokens = value;
  }
  if (params.effort) request.reasoning_effort = params.effort;
  if (params.tools.trim()) {
    const tools: unknown = JSON.parse(params.tools);
    if (
      !Array.isArray(tools) ||
      tools.some(
        (t) =>
          !record(t) ||
          t.type !== "function" ||
          !record(t.function) ||
          typeof t.function.name !== "string" ||
          !record(t.function.parameters),
      )
    ) {
      throw new Error(
        "Tools must be a JSON array of function definitions with name and parameters.",
      );
    }
    request.tools = tools;
  }
  return request;
}
export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function emptyResult(): ChatResult {
  return {
    content: "",
    reasoning: "",
    tools: [],
    durationMs: 0,
    firstContentMs: null,
    inputTokens: null,
    outputTokens: null,
    finishReason: null,
    metadata: {},
    raw: [],
    done: false,
    status: 0,
  };
}
export function apiErrorMessage(value: unknown): string | null {
  if (!record(value)) return null;
  if (typeof value.error === "string") return value.error;
  if (record(value.error) && typeof value.error.message === "string")
    return value.error.message;
  return null;
}
/** Parses SSE across arbitrary UTF-8/text boundaries, including CRLF and comments. */
export class SseDecoder {
  private buffer = "";
  constructor(private readonly onData: (data: string) => void) {}
  push(text: string): void {
    this.buffer += text;
    for (;;) {
      const separator = /\r?\n\r?\n/.exec(this.buffer);
      if (!separator) return;
      const frame = this.buffer.slice(0, separator.index);
      this.buffer = this.buffer.slice(separator.index + separator[0].length);
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) this.onData(data);
    }
  }
  finish(): void {
    if (this.buffer.trim()) throw new Error("Incomplete SSE frame.");
  }
}
export function applyCompletion(
  result: ChatResult,
  value: unknown,
  streaming: boolean,
  elapsedMs: number,
): void {
  const error = apiErrorMessage(value);
  if (error) throw new Error(error);
  if (!record(value)) throw new Error("Invalid completion response.");
  result.raw.push(value);
  if (record(value.usage)) {
    if (typeof value.usage.prompt_tokens === "number")
      result.inputTokens = value.usage.prompt_tokens;
    if (typeof value.usage.completion_tokens === "number")
      result.outputTokens = value.usage.completion_tokens;
  }
  if (!Array.isArray(value.choices))
    throw new Error("Response is missing choices.");
  const choice = value.choices[0];
  if (!record(choice)) return; // usage-only streaming chunk
  if (typeof choice.finish_reason === "string")
    result.finishReason = choice.finish_reason;
  const message = streaming ? choice.delta : choice.message;
  if (!record(message))
    throw new Error("Response is missing its message or delta.");
  if (typeof message.content === "string") result.content += message.content;
  if (typeof message.reasoning_content === "string")
    result.reasoning += message.reasoning_content;
  if (Array.isArray(message.tool_calls)) {
    for (const [position, tool] of message.tool_calls.entries()) {
      if (!record(tool)) throw new Error("Invalid tool call.");
      const index = streaming ? tool.index : position;
      if (!Number.isInteger(index) || Number(index) < 0 || Number(index) > 100)
        throw new Error("Invalid tool call index.");
      const current = result.tools[Number(index)] ?? {
        id: "",
        type: "function",
        function: { name: "", arguments: "" },
      };
      if (typeof tool.id === "string") current.id = tool.id;
      if (record(tool.function)) {
        if (typeof tool.function.name === "string")
          current.function.name += tool.function.name;
        if (typeof tool.function.arguments === "string")
          current.function.arguments += tool.function.arguments;
      }
      result.tools[Number(index)] = current;
    }
  }
  if (
    result.firstContentMs === null &&
    (result.content || result.reasoning || result.tools.length)
  )
    result.firstContentMs = elapsedMs;
}
export function complianceRequest(model: string, caseId: CaseId): ChatRequest {
  const request: ChatRequest = {
    model,
    messages: [{ role: "user", content: "Reply with the single word hello." }],
    stream: caseId === "stream",
    max_tokens: 256,
  };
  if (caseId === "system")
    request.messages = [
      {
        role: "system",
        content:
          "For every user message respond with exactly ROTATOR_OK and nothing else.",
      },
      { role: "user", content: "What is two plus two?" },
    ];
  if (caseId === "json") {
    request.response_format = { type: "json_object" };
    request.messages = [
      {
        role: "user",
        content:
          'Return a JSON object with exactly this property: "rotator_ok": true. No markdown.',
      },
    ];
  }
  if (caseId === "tools") {
    request.tools = [
      {
        type: "function",
        function: {
          name: "rotator_echo",
          description: "Echo the provided text.",
          parameters: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false,
          },
        },
      },
    ];
    request.tool_choice = {
      type: "function",
      function: { name: "rotator_echo" },
    };
    request.messages = [
      { role: "user", content: 'Call rotator_echo with text "ROTATOR_OK".' },
    ];
  }
  return request;
}
export function evaluateCompliance(
  caseId: CaseId,
  result: ChatResult,
): { verdict: Verdict; explanation: string } {
  let passed =
    result.done &&
    result.raw.length > 0 &&
    result.finishReason !== null &&
    Boolean(result.content || result.tools.length);
  if (caseId === "system") passed &&= result.content.trim() === "ROTATOR_OK";
  if (caseId === "json") {
    try {
      const value: unknown = JSON.parse(result.content);
      passed &&=
        record(value) &&
        value.rotator_ok === true &&
        Object.keys(value).length === 1;
    } catch {
      passed = false;
    }
  }
  if (caseId === "tools") {
    try {
      passed &&=
        result.tools.length === 1 &&
        result.tools[0].function.name === "rotator_echo" &&
        JSON.parse(result.tools[0].function.arguments).text === "ROTATOR_OK";
    } catch {
      passed = false;
    }
  }
  return {
    verdict: passed ? "passed" : "failed",
    explanation: passed
      ? "Observed response meets this case's checks through the rotator."
      : "Response did not meet this case's checks. Inspect the request and response.",
  };
}
export function errorVerdict(status: number, message: string): Verdict {
  return [400, 422, 501].includes(status) &&
    /(?:not supported|unsupported|does not support|not implemented)/i.test(
      message,
    )
    ? "unsupported"
    : "error";
}
