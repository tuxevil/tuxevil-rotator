// Google AICode (aicode.googleapis.com / v1alpha) request forwarding:
// eligibility gating, v1internal -> google.gca.aicode.v1main payload conversion,
// flat SSE -> { response } wrapper, and 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT fallback.

import { getCredentialGeneration } from "../../account-identity.js";
import {
  fetchWithHeadersTimeout,
  type RequestInitWithDispatcher,
} from "../../fetch-with-retry.js";
import type { ForwardedResponse, RequestBody } from "../../proxy.js";
import type { AccountRuntime } from "../../types.js";
import { DEFAULT_PROVIDER } from "../credential-helpers.js";
import { getAccountProxyDispatcher } from "../proxy-dispatcher.js";
import { hasAicodeScope } from "./aicode-eligibility.js";
import {
  buildAicodeWireHeaders,
  fetchAicodeConfig,
  fetchAicodeLicenses,
  isAicodeInsufficientScopeError,
  isInAicodeScopeCooldown,
  markAicodeScopeMissing,
  resolveAicodeEndpoint,
  resolveAicodeExperience,
} from "./aicode.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseUseAicodeEnvOverride(): boolean | null {
  const raw = process.env.USE_AICODE?.trim().toLowerCase();
  if (!raw) return null;
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;
  return null;
}

export function shouldAttemptAicodeRouting(
  account: AccountRuntime,
  now = Date.now(),
): boolean {
  const envOverride = parseUseAicodeEnvOverride();
  if (envOverride === false) return false;
  if (!account.accessToken) return false;
  if (!hasAicodeScope(account)) return false;
  if (isInAicodeScopeCooldown(account, now)) return false;

  const gen = getCredentialGeneration(account, DEFAULT_PROVIDER);
  const elig =
    account.aicodeEligibility?.credentialGeneration === gen
      ? account.aicodeEligibility
      : undefined;
  const cachedConfig =
    account.aicodeState?.credentialGeneration === gen
      ? account.aicodeState.config
      : undefined;

  if (elig?.personalConsumer !== true) {
    return false;
  }

  if (envOverride === true) {
    return true;
  }

  const mendelFlag =
    elig.useAicodeMendel === true ||
    (elig.useAicodeMendel !== false && cachedConfig?.useAicodeMendel === true);
  return mendelFlag;
}

export interface ResolvedAicodeTarget {
  endpoint: string;
  experience: string;
  userTier: string;
}

export async function resolveAicodeTarget(
  account: AccountRuntime,
  model: string,
  originalHeaders: Record<string, string>,
  signal?: AbortSignal,
): Promise<ResolvedAicodeTarget | null> {
  if (!shouldAttemptAicodeRouting(account)) return null;

  const [config, licenses] = await Promise.all([
    fetchAicodeConfig(account, originalHeaders, signal),
    fetchAicodeLicenses(account, originalHeaders, signal),
  ]);

  if (isInAicodeScopeCooldown(account)) return null;
  if (!config) return null;

  const envOverride = parseUseAicodeEnvOverride();
  if (envOverride !== true && config.useAicodeMendel === false) {
    return null;
  }

  const experience = resolveAicodeExperience(config, model);
  if (!experience) {
    return null;
  }

  const gen = getCredentialGeneration(account, DEFAULT_PROVIDER);
  const eligTier =
    account.aicodeEligibility?.credentialGeneration === gen
      ? account.aicodeEligibility.userTierId?.trim() || null
      : null;
  const userTier =
    licenses?.userTier ||
    (eligTier && eligTier.toLowerCase() !== "free-tier" ? eligTier : null);
  if (!userTier) {
    return null;
  }

  return {
    endpoint: resolveAicodeEndpoint(),
    experience,
    userTier,
  };
}

/**
 * Translate a twin-normalized `v1internal` request body into a flat
 * `google.gca.aicode.v1main.GenerateContentRequest` payload.
 */
export function buildAicodeGenerateContentRequest(
  twinBody: RequestBody,
  experience: string,
  userTier: string,
): Record<string, unknown> {
  const inner = isRecord(twinBody.request) ? twinBody.request : {};
  const out: Record<string, unknown> = {
    aicode: { experience },
  };

  if (Array.isArray(inner.contents)) {
    out.contents = inner.contents;
  }
  if (isRecord(inner.systemInstruction) || typeof inner.systemInstruction === "string") {
    out.systemInstruction = inner.systemInstruction;
  }
  if (Array.isArray(inner.tools)) {
    out.tools = inner.tools;
  }
  if (isRecord(inner.toolConfig)) {
    out.toolConfig = inner.toolConfig;
  }
  if (isRecord(inner.labels)) {
    out.labels = inner.labels;
  }
  if (Array.isArray(inner.safetySettings)) {
    out.safetySettings = inner.safetySettings;
  }
  if (isRecord(inner.generationConfig)) {
    out.generationConfig = inner.generationConfig;
  }
  if (typeof inner.sessionId === "string" && inner.sessionId.trim()) {
    out.sessionId = inner.sessionId;
  }
  if (userTier.trim()) {
    out.entitlement = { userTier: userTier.trim() };
  }

  return out;
}

function transformSseBlock(block: string): string {
  const normalized = block.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const otherLines: string[] = [];
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    } else {
      otherLines.push(line);
    }
  }

  if (dataLines.length === 0) {
    return `${normalized}\n\n`;
  }

  const payload = dataLines.join("\n").trim();
  if (!payload || payload === "[DONE]") {
    return `${normalized}\n\n`;
  }

  try {
    const parsed: unknown = JSON.parse(payload);
    if (isRecord(parsed) && !("response" in parsed)) {
      const wrapped = `data: ${JSON.stringify({ response: parsed })}`;
      const prefix = otherLines.length > 0 ? `${otherLines.join("\n")}\n` : "";
      return `${prefix}${wrapped}\n\n`;
    }
  } catch {
    // Pass unparseable/partial payloads through unchanged.
  }

  return `${normalized}\n\n`;
}

/**
 * Wrap flat AICode SSE `GenerateContentResponse` events into `{ response: ... }`
 * frames matching `v1internal:streamGenerateContent?alt=sse`.
 */
export function wrapAicodeSseResponse(response: Response): Response {
  if (!response.ok || !response.body) {
    return response;
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (block.length > 0) {
          controller.enqueue(encoder.encode(transformSseBlock(block)));
        } else {
          controller.enqueue(encoder.encode("\n\n"));
        }
        boundary = buffer.indexOf("\n\n");
      }
    },
    flush(controller) {
      buffer += decoder.decode().replace(/\r\n/g, "\n");
      if (buffer.trim().length > 0) {
        controller.enqueue(encoder.encode(transformSseBlock(buffer)));
      }
      buffer = "";
    },
  });

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");

  return new Response(response.body.pipeThrough(transform), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function forwardAicodeRequestOnce(
  account: AccountRuntime,
  target: ResolvedAicodeTarget,
  twinBody: RequestBody,
  originalHeaders: Record<string, string>,
  signal: AbortSignal | undefined,
  readErrorBody: (
    response: Response,
    signal?: AbortSignal,
  ) => Promise<{ text: string; truncatedOrTimedOut: boolean }>,
): Promise<{ result: ForwardedResponse; scopeInsufficientFallback: boolean }> {
  const url = `${target.endpoint}/v1alpha:streamGenerateContent?alt=sse`;
  const payload = buildAicodeGenerateContentRequest(
    twinBody,
    target.experience,
    target.userTier,
  );
  const response = await fetchWithHeadersTimeout(url, {
    method: "POST",
    headers: buildAicodeWireHeaders(account, originalHeaders),
    body: JSON.stringify(payload),
    signal,
    dispatcher: getAccountProxyDispatcher(account, DEFAULT_PROVIDER),
  } as RequestInitWithDispatcher);

  if (response.status === 403) {
    const { text: errorText } = await readErrorBody(response, signal);
    await response.body?.cancel().catch(() => undefined);
    if (isAicodeInsufficientScopeError(403, errorText)) {
      markAicodeScopeMissing(account);
      return {
        result: {
          endpoint: target.endpoint,
          response: new Response(errorText, {
            status: 403,
            statusText: response.statusText,
            headers: response.headers,
          }),
        },
        scopeInsufficientFallback: true,
      };
    }
    return {
      result: {
        endpoint: target.endpoint,
        response: new Response(errorText, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        }),
      },
      scopeInsufficientFallback: false,
    };
  }

  return {
    result: {
      endpoint: target.endpoint,
      response: wrapAicodeSseResponse(response),
    },
    scopeInsufficientFallback: false,
  };
}
