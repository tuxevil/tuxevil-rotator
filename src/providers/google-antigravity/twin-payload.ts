import { randomUUID } from "node:crypto";
import { rotatorEnv } from "../../env.js";
import { ANTIGRAVITY_IDENTITY_PROMPT } from "../../types.js";

export type AntigravitySystemPromptMode =
  | "default-identity"
  | "prepend"
  | "twin"
  | "passthrough";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getAntigravitySystemPromptMode(): AntigravitySystemPromptMode {
  const raw = (rotatorEnv("ANTIGRAVITY_SYSTEM_PROMPT_MODE") || "")
    .trim()
    .toLowerCase();
  if (
    raw === "default-identity" ||
    raw === "prepend" ||
    raw === "passthrough" ||
    raw === "twin"
  ) {
    return raw;
  }
  return "twin";
}

/**
 * Matches Antigravity ccpa.HashSessionID (64-bit FNV-1a signed decimal string).
 */
export function computeAntigravitySessionId(seed: string): string {
  const FNV_OFFSET = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  const MASK_64 = 0xffffffffffffffffn;
  let hash = FNV_OFFSET;
  const bytes = Buffer.from(seed, "utf8");
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return BigInt.asIntN(64, hash).toString(10);
}

/**
 * Matches Antigravity ccpa.ComputeRequestID (`prefix/uuid`).
 */
export function computeAntigravityRequestId(prefix = "agent"): string {
  const cleanPrefix = prefix.trim() || "unknown";
  return `${cleanPrefix}/${randomUUID()}`;
}

/**
 * Wraps a user prompt with Antigravity's <USER_REQUEST> tag convention.
 */
export function wrapAntigravityUserRequest(text: string): string {
  if (!text || text.includes("<USER_REQUEST>")) return text;
  return `<USER_REQUEST>\n${text}\n</USER_REQUEST>`;
}

export function composeAntigravitySystemInstruction(
  callerSystemText: string,
  mode: AntigravitySystemPromptMode = getAntigravitySystemPromptMode(),
): string | null {
  const trimmed = callerSystemText.trim();
  if (mode === "passthrough") {
    return trimmed || null;
  }
  if (!trimmed) {
    return ANTIGRAVITY_IDENTITY_PROMPT;
  }
  if (mode === "prepend" || mode === "twin") {
    return trimmed.includes(ANTIGRAVITY_IDENTITY_PROMPT)
      ? trimmed
      : `${ANTIGRAVITY_IDENTITY_PROMPT}\n\n${trimmed}`;
  }
  return trimmed;
}

function extractSystemInstructionText(systemInstruction: unknown): string {
  if (typeof systemInstruction === "string") return systemInstruction;
  if (!isRecord(systemInstruction) || !Array.isArray(systemInstruction.parts)) {
    return "";
  }
  return systemInstruction.parts
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n\n");
}

function buildTwinSystemInstruction(
  composedText: string,
  original: unknown,
): Record<string, unknown> {
  const extraParts =
    isRecord(original) && Array.isArray(original.parts)
      ? original.parts.filter(
          (part) => !isRecord(part) || typeof part.text !== "string",
        )
      : [];
  // Antigravity's Go codeassistclient builds SystemInstruction as Content{Parts}
  // with empty Role (omitted by protojson in proto3).
  return {
    parts: [{ text: composedText }, ...extraParts],
  };
}

/**
 * Ensures an Antigravity `v1internal` payload carries IDE/CLI twin envelope
 * fields (`requestId`, `userPromptId`, `userAgent`, `requestType`), signed
 * FNV-1a `request.sessionId`, `request.systemInstruction`, and `<USER_REQUEST>`
 * wrapping without mutating caller-owned nested request objects.
 */
export function applyAntigravityTwinPayload<T extends Record<string, unknown>>(
  payload: T,
  options?: {
    skipTrailingContinueWrap?: boolean;
    skipPromptInjection?: boolean;
  },
): T {
  const out: Record<string, unknown> = { ...payload };
  if (typeof out.requestId !== "string" || !out.requestId) {
    out.requestId = computeAntigravityRequestId("agent");
  }
  if (typeof out.userPromptId !== "string" || !out.userPromptId) {
    out.userPromptId = randomUUID();
  }
  if (typeof out.userAgent !== "string" || !out.userAgent) {
    out.userAgent = "antigravity";
  }
  if (typeof out.requestType !== "string" || !out.requestType) {
    out.requestType = "agent";
  }

  if (!isRecord(out.request)) return out as T;

  const reqClone: Record<string, unknown> = { ...out.request };
  const promptMode = getAntigravitySystemPromptMode();
  const rawContents = Array.isArray(reqClone.contents) ? reqClone.contents : null;

  if (rawContents) {
    const clonedContents = rawContents.map((turn) =>
      isRecord(turn)
        ? {
            ...turn,
            ...(Array.isArray(turn.parts)
              ? {
                  parts: turn.parts.map((part) =>
                    isRecord(part) ? { ...part } : part,
                  ),
                }
              : {}),
          }
        : turn,
    );

    if (promptMode === "twin" && !options?.skipPromptInjection) {
      const lastTurn = clonedContents[clonedContents.length - 1];
      const endsWithSyntheticContinue =
        options?.skipTrailingContinueWrap &&
        clonedContents.length > 1 &&
        isRecord(lastTurn) &&
        lastTurn.role === "user";
      const searchEnd = endsWithSyntheticContinue
        ? clonedContents.length - 2
        : clonedContents.length - 1;
      for (let idx = searchEnd; idx >= 0; idx--) {
        const turn = clonedContents[idx];
        if (isRecord(turn) && turn.role === "user" && Array.isArray(turn.parts)) {
          for (const part of turn.parts) {
            if (isRecord(part) && typeof part.text === "string" && part.text.trim()) {
              part.text = wrapAntigravityUserRequest(part.text);
              idx = -1;
              break;
            }
          }
        }
      }
    }

    reqClone.contents = clonedContents;
    if (typeof reqClone.sessionId !== "string" || !reqClone.sessionId.trim()) {
      const firstTurn = clonedContents[0];
      const seed =
        isRecord(firstTurn) && "parts" in firstTurn
          ? JSON.stringify(firstTurn.parts ?? "antigravity")
          : JSON.stringify("antigravity");
      reqClone.sessionId = computeAntigravitySessionId(seed);
    }
  } else if (typeof reqClone.sessionId !== "string" || !reqClone.sessionId.trim()) {
    reqClone.sessionId = computeAntigravitySessionId("antigravity");
  }

  if (!options?.skipPromptInjection) {
    const existingSystemText = extractSystemInstructionText(reqClone.systemInstruction);
    const systemText = composeAntigravitySystemInstruction(
      existingSystemText,
      promptMode,
    );
    if (systemText) {
      reqClone.systemInstruction = buildTwinSystemInstruction(
        systemText,
        reqClone.systemInstruction,
      );
    } else if (
      promptMode === "passthrough" &&
      isRecord(reqClone.systemInstruction) &&
      "role" in reqClone.systemInstruction
    ) {
      const { role: _role, ...rest } = reqClone.systemInstruction;
      reqClone.systemInstruction = rest;
    }
  }

  out.request = reqClone;
  return out as T;
}
