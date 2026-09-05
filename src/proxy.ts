// HTTP reverse proxy - forwards requests to Antigravity with credential rotation

import {
  buildRotatorResponseHeaders,
  maskAccountLabel,
} from "./response-headers.js";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import {
  classifyEffortRoutingModel,
  getEffortRoutingRule,
  resolveQuotaModelKey,
  resolveDisplayModelKey,
} from "./types.js";
import type { AccountRuntime } from "./types.js";
import type { AccountRotator } from "./rotator.js";
import { DEFAULT_PROVIDER, getProviderAdapter, getProviderForAccount, findProviderForModel, isKnownProvider } from "./providers/registry.js";
import { isRecord } from "./compat/schema-sanitizer.js";
import type { ProviderAdapter, StreamAccumulator } from "./providers/adapter.js";
import {
  isCodeAssistAction,
  validateCodeAssistPayload,
  type CodeAssistAction,
} from "./providers/google-antigravity/code-assist.js";
import {
  forwardRequest,
  SseEventAccumulator,
  extractUsageFromSseEvent,
  GOOGLE_BENCHMARK_CONSTANTS,
} from "./providers/google-antigravity/forward.js";
export { forwardRequest, SseEventAccumulator, extractUsageFromSseEvent };
import {
  serveDashboard,
  serveStatusApi,
  serveConfigApi,
  serveConfigExportApi,
  serveConfigImportApi,
  serveEnableApi,
  serveDisableApi,
  serveQuarantineApi,
  serveRestoreApi,
  serveRemoveAccountApi,
  serveSetTierApi,
  serveFreshWindowStartsApi,
  serveAccountFreshWindowStartsApi,
  serveClearInFlightApi,
  serveClearBreakerApi,
  serveKickstartApi,
  serveAutoWarmupApi,
  serveGenerateVirtualKeyApi,
  serveListVirtualKeysApi,
  serveGetVirtualKeyApi,
  serveUpdateVirtualKeyApi,
  serveDeleteVirtualKeyApi,
  serveGetSpendLogsApi,
  serveGetSpendSummaryApi,
  serveGetSpendByKeyApi,
  serveModelsApi,
  serveDashboardKeys,
  serveDashboardLogs,
  serveStaticKeysJs,
  serveStaticLogsJs,
  serveStaticCss,
  serveStaticJs,
} from "./dashboard.js";
import {
  handleHostedCallback,
  serveLoginLanding,
  startHostedLogin,
  serveCliLogin,
  handleCliLoginApi,
} from "./onboarding.js";
import { requireAdmin } from "./admin-auth.js";
import { PayloadTooLargeError, readLimitedBody } from "./body-limit.js";
import { validateConfig, validateProxyRequestBody } from "./validators.js";
import { logger } from "./logger.js";
import {
  trackFeature,
  reportFlagEvent,
  FLAG_PATTERNS,
  type FlagPattern,
} from "./telemetry.js";
import type { FlagEventData } from "./telemetry.js";

/**
 * Provider adapter for a request on a (possibly multi-provider) account.
 * The destination model decides the adapter: if the model is in the
 * Ollama catalog (tracked on the rotator), it goes through the Ollama
 * adapter; otherwise the account's primary provider is used. This avoids
 * the broken heuristic of relying on `:` in the model name (some Ollama
 * models like `minimax-m3`, `kimi-k3`, `glm-5.1` have no tag, and some
 * Google model aliases do).
 *
 * The rotator is required only when it exposes `getOllamaModels()`; test
 * stubs that omit it fall back to the credentials-only dispatch.
 */
export function providerAdapterForModel(
  account: AccountRuntime,
  model: string | undefined,
  rotator?: { getOllamaModels?: () => string[]; getCodexModels?: () => string[] },
): ProviderAdapter {
  const creds = account.config.credentials ?? [];
  if (model) {
    const context = {
      ollamaModels: new Set(rotator?.getOllamaModels?.() ?? []),
      codexModels: new Set(rotator?.getCodexModels?.() ?? []),
    };
    const effortRoutingKind = classifyEffortRoutingModel(model);
    if (effortRoutingKind && context.ollamaModels.has(model)) {
      proxyLogger.warn(
        `Effort routing ${effortRoutingKind} "${model}" matches a live Ollama model; live provider dispatch wins`,
      );
    }
    const matched = findProviderForModel(model, context);
    if (matched) return matched;
  }
  if (creds.length > 0) {
    const providers = new Set(creds.map((c) => c.provider));
    if (providers.size === 1) {
      const soleProvider = Array.from(providers)[0];
      if (isKnownProvider(soleProvider)) {
        return getProviderAdapter(soleProvider);
      }
    }
  }
  const fallback = getProviderForAccount(account.config);
  return fallback.id === "openai-codex"
    ? getProviderAdapter(DEFAULT_PROVIDER)
    : fallback;
}

function routingModelKey(rotator: AccountRotator, model: string): string {
  const resolver = (rotator as unknown as {
    resolveQuotaModelKeyForDisplay?: (value: string) => string | null;
  }).resolveQuotaModelKeyForDisplay;
  return resolver?.call(rotator, model) ?? resolveQuotaModelKey(model) ?? model;
}

function observedModelKey(
  rotator: AccountRotator,
  displayModel: string,
  effectiveModel?: string,
): string {
  const rule = getEffortRoutingRule(displayModel);
  const observedModel = effectiveModel && rule ? effectiveModel : displayModel;
  const resolver = (rotator as unknown as {
    resolveObservedModelKey?: (value: string) => string;
  }).resolveObservedModelKey;
  return (
    resolver?.call(rotator, observedModel) ??
    resolveDisplayModelKey(displayModel, effectiveModel)
  );
}
import { startVersionChecker, performSelfUpdate } from "./version-check.js";
import { startNotificationPoller } from "./notification-poller.js";
import {
  handleAnthropicMessages,
  handleGeminiGenerateContent,
  handleOpenAIChatCompletions,
  handleOpenAIResponsesCancel,
  handleOpenAIResponsesCreate,
  handleOpenAIResponsesDelete,
  handleOpenAIResponsesInputItems,
  handleOpenAIResponsesRetrieve,
  serveGeminiModels,
  serveOpenAIModels,
} from "./compat.js";
import {
  handleOpenAIAudioTranscriptions,
  handleAudioWebSocket,
} from "./audio-transcription.js";
import { applyConfigDefaults } from "./account-store.js";
import {
  classifyRateLimitReason,
  parseRetryAfterMs,
  RESOURCE_EXHAUSTED_FALLBACK_MS,
} from "./rate-limit-parser.js";
import { authenticateVirtualKey, sendAuthErrorResponse } from "./key-auth.js";
import { logSpend } from "./spend-logger.js";
import { hashKey } from "./virtual-keys.js";

const proxyLogger = logger.child("proxy");
const GENERIC_UPSTREAM_ERROR = "Upstream request failed";

const DEFAULT_STREAM_RECOVERY_MAX_RETRIES = 2;
const MAX_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes max cooldown
const STREAM_IDLE_TIMEOUT_MS = 2 * 60 * 1000; // Release account if a stream goes silent.
const LARGE_CONTEXT_WARN_BYTES = 1 * 1024 * 1024;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Request aborted"));

  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Request aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class PreFlushStreamError extends Error {
  constructor(cause: unknown) {
    super(`Upstream stream failed before response flush: ${formatError(cause)}`, {
      cause,
    });
    this.name = "PreFlushStreamError";
  }
}

function getStreamRecoveryMaxRetries(rotator: AccountRotator): number {
  const configured = rotator.getConfig?.().streamRecoveryMaxRetries;
  if (configured === undefined || !Number.isInteger(configured) || configured < 0) {
    return DEFAULT_STREAM_RECOVERY_MAX_RETRIES;
  }
  return configured;
}

export interface RequestBody {
  project: string;
  model: string;
  request: unknown;
  requestType?: string;
  userAgent?: string;
  requestId?: string;
  displayModel?: string;
  [key: string]: unknown;
}

export interface ForwardedResponse {
  response: Response;
  endpoint: string;
}

export type BenchmarkResultStatus = "success" | "failed" | "skipped";

export interface BenchmarkResult {
  account: string;
  status: BenchmarkResultStatus;
  latencyMs: number | null;
  ttfbMs: number | null;
  outputTokens: number | null;
  tokensPerSecond: number | null;
  error?: string;
}

export interface BenchmarkSummary {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  successRate: number;
  averageLatencyMs: number | null;
  averageTtfbMs: number | null;
  averageTokensPerSecond: number | null;
}

export interface RotationAttemptContext {
  account: AccountRuntime;
  label: string;
  modelKey: string;
  displayModelKey: string;
  requestId: string;
  requestStartMs: number;
  endpoint: string;
  retries: number;
}

export type RotationOutcome<T> =
  | { ok: true; result: T; endpoint: string; context?: RotationAttemptContext }
  | {
      ok: false;
      status: number;
      errorText: string;
      retryAfterMs?: number;
      endpoint?: string;
      context?: RotationAttemptContext;
      totalMs?: number;
    };

/**
 * Discriminated union describing what should happen after inspecting an
 * upstream response. Used by both withRotation (which translates into a
 * RotationOutcome) and handleProxyRequest (which translates into HTTP) to
 * keep the status-code branching in one place.
 */
export type UpstreamAction =
  | {
      kind: "rate-limited";
      cooldownMs: number;
      providerResourceExhausted: boolean;
      errorText: string;
      endpoint: string;
    }
  | { kind: "flagged-401"; errorText: string; endpoint: string }
  | { kind: "flagged-403"; errorText: string; endpoint: string }
  | { kind: "forbidden"; errorText: string; endpoint: string }
  | { kind: "not-found"; errorText: string; endpoint: string }
  | { kind: "bad-request"; errorText: string; endpoint: string }
  | { kind: "server-error-503"; errorText: string; endpoint: string }
  | {
      kind: "rotate-on-5xx";
      httpStatus: number;
      errorText: string;
      endpoint: string;
    }
  | { kind: "success" };

/**
 * Inspect an upstream response and return a tag describing what to do next.
 * Shared between withRotation and handleProxyRequest so the status-code
 * classification logic lives in one place.
 */
export async function classifyUpstreamResponse(
  response: Response,
  endpoint: string,
  account: AccountRuntime,
  model: string,
  modelKey: string,
  providerId = DEFAULT_PROVIDER,
): Promise<UpstreamAction> {
  if (response.status === 429) {
    const errorText = await response.text().catch(() => "");
    const rateLimitReason = classifyRateLimitReason(errorText, response.status);
    const providerResourceExhausted = rateLimitReason === "quota-exhausted";
    const cooldownMs = providerResourceExhausted
      ? providerId === DEFAULT_PROVIDER
        ? parseRetryAfterMs(
            errorText,
            response.headers,
            RESOURCE_EXHAUSTED_FALLBACK_MS,
          )
        : RESOURCE_EXHAUSTED_FALLBACK_MS
      : capCooldown(parseRetryAfterMs(errorText, response.headers));
    return {
      kind: "rate-limited",
      cooldownMs,
      providerResourceExhausted,
      errorText,
      endpoint,
    };
  }

  if (response.status === 401) {
    const errorText = await response.text().catch(() => "");
    return { kind: "flagged-401", errorText, endpoint };
  }

  if (response.status === 403) {
    const errorText = await response.text().catch(() => "");
    const lower = errorText.toLowerCase();
    const flagPatternsLocal = [
      "infring",
      "suspend",
      "abus",
      "terminat",
      "violat",
      "banned",
      "policy",
      "forbidden",
      "verif",
    ];
    const isFlagged = flagPatternsLocal.some((p) => lower.includes(p));
    if (isFlagged) {
      return { kind: "flagged-403", errorText, endpoint };
    }
    return { kind: "forbidden", errorText, endpoint };
  }

  if (response.status === 404) {
    const errorText = await response.text().catch(() => "");
    return { kind: "not-found", errorText, endpoint };
  }

  if (response.status === 400) {
    const errorText = await response.text().catch(() => "");
    return { kind: "bad-request", errorText, endpoint };
  }

  if (response.status === 503) {
    const errorText = await response.text().catch(() => "");
    return { kind: "server-error-503", errorText, endpoint };
  }

  if (response.status >= 500) {
    const errorText = await response.text().catch(() => "");
    return {
      kind: "rotate-on-5xx",
      httpStatus: response.status,
      errorText,
      endpoint,
    };
  }

  // Reference parameters to satisfy "all parameters are used" without changing behavior.
  void account;
  void model;
  void modelKey;
  return { kind: "success" };
}

function capCooldown(ms: number): number {
  return Math.min(ms, MAX_COOLDOWN_MS);
}

type UpstreamActionDecision =
  | { kind: "retry" }
  | {
      kind: "fail";
      status: number;
      errorText: string;
      retryAfterMs?: number;
      endpoint?: string;
      context: RotationAttemptContext;
      totalMs: number;
      actionKind: Exclude<UpstreamAction["kind"], "success">;
      providerResourceExhausted?: boolean;
      noReplacementReason?: string;
    };

type UpstreamFailureDecision = Extract<UpstreamActionDecision, { kind: "fail" }>;
type UpstreamFailureExtra = Partial<
  Pick<
    UpstreamFailureDecision,
    | "retryAfterMs"
    | "endpoint"
    | "providerResourceExhausted"
    | "noReplacementReason"
  >
>;

type UpstreamActionHandlerOptions = {
  action: Exclude<UpstreamAction, { kind: "success" }>;
  provider: ProviderAdapter;
  rotator: AccountRotator;
  account: AccountRuntime;
  model: string;
  modelKey: string;
  label: string;
  context: RotationAttemptContext;
  logRequestEnd: (status: string | number, extra?: string) => void;
  rotateAndRelease: () => Promise<AccountRuntime | null>;
  canRetry: boolean;
  writeLog: (message: string, level?: "info" | "warn" | "error") => void;
  recordFailureAttempt?: (statusCode: number) => void;
};

function buildFailureDecision(
  options: UpstreamActionHandlerOptions,
  status: number,
  errorText: string,
  extra: UpstreamFailureExtra = {},
): UpstreamFailureDecision {
  return {
    kind: "fail",
    status,
    errorText,
    context: options.context,
    totalMs: Date.now() - options.context.requestStartMs,
    actionKind: options.action.kind,
    endpoint: "endpoint" in options.action ? options.action.endpoint : undefined,
    ...extra,
  };
}

function buildNoReplacementDecision(
  options: UpstreamActionHandlerOptions,
  reason: string,
): UpstreamFailureDecision {
  const retryAfterMs = options.rotator.getRetryAfterMs(options.model);
  if (retryAfterMs > 0) {
    return buildFailureDecision(
      options,
      429,
      `All accounts cooling down or model circuit breaker active: ${reason}`,
      { retryAfterMs, noReplacementReason: reason },
    );
  }
  return buildFailureDecision(
    options,
    503,
    `All accounts exhausted or disabled: ${reason}`,
    { noReplacementReason: reason },
  );
}

async function handleUpstreamAccountAction(
  options: UpstreamActionHandlerOptions,
): Promise<UpstreamActionDecision> {
  const {
    action,
    provider,
    rotator,
    account,
    model,
    modelKey,
    label,
    logRequestEnd,
    rotateAndRelease,
    writeLog,
    recordFailureAttempt,
  } = options;

  if (
    provider.id === "openai-codex" &&
    (action.kind === "flagged-401" ||
      action.kind === "flagged-403" ||
      action.kind === "forbidden")
  ) {
    const status = action.kind === "flagged-401" ? 401 : 403;
    const message = `Codex credential rejected (${status}); re-authentication required`;
    writeLog(`[${label}] ${message}`, "warn");
    rotator.markProviderInvalid(account, "openai-codex", message);
    logRequestEnd(status, `endpoint=${action.endpoint}`);
    if (!options.canRetry) return buildFailureDecision(options, status, message);
    const nextAccount = await rotateAndRelease();
    if (nextAccount) return { kind: "retry" };
    return buildNoReplacementDecision(options, `no replacement Codex account remained after ${label} was rejected`);
  }

  if (action.kind === "rate-limited") {
    writeLog(
      `[${label}] 429 rate limited${action.providerResourceExhausted ? " (RESOURCE_EXHAUSTED)" : ""}, cooldown ${Math.ceil(action.cooldownMs / 1000)}s. Error text: ${action.errorText.slice(0, 300)}`,
      "warn",
    );
    recordFailureAttempt?.(429);
    rotator.markExhausted(
      account,
      model,
      action.cooldownMs,
      action.errorText.slice(0, 300),
    );
    rotator.recordProvider429(
      account,
      model,
      action.cooldownMs,
      action.providerResourceExhausted,
    );
    logRequestEnd(
      429,
      `cooldownMs=${action.cooldownMs}${action.providerResourceExhausted ? " resourceExhausted=true" : ""} endpoint=${action.endpoint}`,
    );

    const shouldRetryProviderRateLimit =
      provider.id === "openai-codex" ||
      provider.id === "opencode-zen" ||
      action.providerResourceExhausted;
    if (
      shouldRetryProviderRateLimit &&
      options.canRetry &&
      provider.shouldRetryOnQuotaExhaustion(account, model, action.errorText)
    ) {
      const nextAccount = await rotateAndRelease();
      if (nextAccount) {
        writeLog(
          `[${label}] RESOURCE_EXHAUSTED is account-scoped; retrying with the next eligible account`,
          "warn",
        );
        return { kind: "retry" };
      }
      writeLog(
        `[${label}] RESOURCE_EXHAUSTED has no eligible replacement account; returning the provider error`,
        "warn",
      );
    }

    return buildFailureDecision(options, 429, action.errorText, {
      retryAfterMs: action.cooldownMs,
      providerResourceExhausted: action.providerResourceExhausted,
    });
  }

  if (action.kind === "flagged-401") {
    writeLog(
      `[${label}] BLOCKED (401): ${action.errorText.slice(0, 200)}`,
      "error",
    );
    const lower401 = action.errorText.toLowerCase();
    const matched401 = FLAG_PATTERNS.filter((p) => lower401.includes(p));
    const ctx401 = rotator.getFlagContext(account, modelKey);
    reportFlagEvent({
      flagHttpStatus: 401,
      flagPatternsMatched:
        matched401.length > 0 ? matched401 : ["blocked_401" as FlagPattern],
      model: modelKey,
      timerType: ctx401.timerType as FlagEventData["timerType"],
      accountQuotaPercent: ctx401.accountQuotaPercent,
      wasProAccount: ctx401.wasProAccount,
      accountTotalRequests: account.totalRequests,
      accountRequestsLastHour: ctx401.accountRequestsLastHour,
      accountConcurrentAtFlag: account.inFlightRequests,
      poolSize: ctx401.poolSize,
      poolHealthyCount: ctx401.poolHealthyCount,
      protectivePauseTriggered: false,
      uptimeSeconds: ctx401.uptimeSeconds,
      timeSinceLastFlagSeconds: -1,
    });
    rotator.markFlagged(
      account,
      `Account blocked (401): ${action.errorText.slice(0, 300)}`,
    );
    logRequestEnd(401, `endpoint=${action.endpoint}`);
    if (!options.canRetry) {
      return buildFailureDecision(options, 401, action.errorText);
    }
    const nextAccount = await rotateAndRelease();
    if (!nextAccount) {
      return buildNoReplacementDecision(
        options,
        `no replacement account remained after ${label} was flagged with 401`,
      );
    }
    return { kind: "retry" };
  }

  if (action.kind === "flagged-403") {
    writeLog(`[${label}] FLAGGED: ${action.errorText.slice(0, 200)}`, "error");
    recordFailureAttempt?.(403);
    logRequestEnd(403, `endpoint=${action.endpoint}`);
    const lower = action.errorText.toLowerCase();
    const matchedPatterns = FLAG_PATTERNS.filter((p) => lower.includes(p));
    const ctx403 = rotator.getFlagContext(account, modelKey);
    reportFlagEvent({
      flagHttpStatus: 403,
      flagPatternsMatched: matchedPatterns,
      model: modelKey,
      timerType: ctx403.timerType as FlagEventData["timerType"],
      accountQuotaPercent: ctx403.accountQuotaPercent,
      wasProAccount: ctx403.wasProAccount,
      accountTotalRequests: account.totalRequests,
      accountRequestsLastHour: ctx403.accountRequestsLastHour,
      accountConcurrentAtFlag: account.inFlightRequests,
      poolSize: ctx403.poolSize,
      poolHealthyCount: ctx403.poolHealthyCount,
      protectivePauseTriggered: false,
      uptimeSeconds: ctx403.uptimeSeconds,
      timeSinceLastFlagSeconds: -1,
    });
    rotator.markFlagged(account, action.errorText.slice(0, 300));
    if (!options.canRetry) {
      return buildFailureDecision(options, 403, action.errorText);
    }
    const nextAccount = await rotateAndRelease();
    if (!nextAccount) {
      return buildNoReplacementDecision(
        options,
        `no replacement account remained after ${label} was flagged with 403`,
      );
    }
    return { kind: "retry" };
  }

  if (action.kind === "forbidden") {
    writeLog(`[${label}] 403: ${action.errorText.slice(0, 200)}`, "warn");
    logRequestEnd(403, `endpoint=${action.endpoint}`);
    return buildFailureDecision(options, 403, action.errorText);
  }

  if (action.kind === "not-found") {
    writeLog(
      `[${label}] 404 from ${action.endpoint}: ${action.errorText.slice(0, 200)}`,
      "warn",
    );
    logRequestEnd(404, `endpoint=${action.endpoint}`);
    return buildFailureDecision(options, 404, action.errorText);
  }

  if (action.kind === "bad-request") {
    writeLog(
      `[${label}] 400 Bad Request from ${action.endpoint}: ${action.errorText.slice(0, 500)}`,
      "warn",
    );
    logRequestEnd(400, `endpoint=${action.endpoint}`);
    return buildFailureDecision(options, 400, action.errorText);
  }

  if (action.kind === "server-error-503") {
    writeLog(
      `[${label}] Server error 503: ${action.errorText.slice(0, 200)}`,
      "warn",
    );
    recordFailureAttempt?.(503);
    logRequestEnd(503, `endpoint=${action.endpoint}`);
    rotator.markError(account, `503: ${action.errorText.slice(0, 200)}`);
    if (!options.canRetry) {
      return buildFailureDecision(options, 503, action.errorText);
    }
    const nextAccount = await rotateAndRelease();
    if (!nextAccount) {
      return buildNoReplacementDecision(
        options,
        `no replacement account remained after ${label} failed with 503`,
      );
    }
    return { kind: "retry" };
  }

  writeLog(
    `[${label}] Server error ${action.httpStatus}: ${action.errorText.slice(0, 200)}`,
    "warn",
  );
  recordFailureAttempt?.(action.httpStatus);
  logRequestEnd(action.httpStatus, `endpoint=${action.endpoint}`);
  rotator.markError(
    account,
    `${action.httpStatus}: ${action.errorText.slice(0, 200)}`,
  );
  if (!options.canRetry) {
    return buildFailureDecision(options, action.httpStatus, action.errorText);
  }
  const nextAccount = await rotateAndRelease();
  if (!nextAccount) {
    return buildNoReplacementDecision(
      options,
      `no replacement account remained after ${label} failed with ${action.httpStatus}`,
    );
  }
  return { kind: "retry" };
}

function failureDecisionToOutcome<T>(
  decision: UpstreamFailureDecision,
): RotationOutcome<T> {
  return {
    ok: false,
    status: decision.status,
    errorText: decision.errorText,
    retryAfterMs: decision.retryAfterMs,
    endpoint: decision.endpoint,
    context: decision.context,
    totalMs: decision.totalMs,
  };
}

function formatError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause;
  if (cause && typeof cause === "object") {
    const code = "code" in cause ? String(cause.code) : null;
    const message = "message" in cause ? String(cause.message) : null;
    if (code || message) {
      return `${err.name}: ${err.message} (${[code, message].filter(Boolean).join(": ")})`;
    }
  }
  return `${err.name}: ${err.message}`;
}

function isFetchTransportError(err: unknown): boolean {
  if (err instanceof PreFlushStreamError) return true;
  if (err instanceof TypeError && /^(fetch failed|terminated)$/i.test(err.message)) {
    return true;
  }
  if (err && typeof err === "object" && "code" in err) {
    return ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"].includes(
      String(err.code),
    );
  }
  return false;
}

async function readJsonRequest(req: IncomingMessage): Promise<unknown> {
  const body = await readLimitedBody(req);
  return body.length === 0 ? {} : JSON.parse(body.toString("utf-8"));
}

async function streamResponseBody(
  body: Response["body"],
  req: IncomingMessage,
  res: ServerResponse,
  label: string,
  proxyLog: (msg: string, level?: "info" | "warn" | "error") => void,
  responseStatus: number,
  responseHeaders: Record<string, string>,
  accumulator: StreamAccumulator = new SseEventAccumulator(),
): Promise<{
  inputTokens: number;
  outputTokens: number;
  firstByteMs: number;
  responseText?: string;
  streamError?: string;
} | null> {
  if (!body) {
    if (!res.headersSent && !res.destroyed) {
      res.writeHead(responseStatus, responseHeaders);
    }
    return null;
  }

  const nodeStream = Readable.fromWeb(
    body as import("node:stream/web").ReadableStream,
  );
  const eventAccumulator = accumulator;
  let firstUsage: { inputTokens: number; outputTokens: number } | null = null;
  let streamError: string | undefined;
  const streamStartMs = Date.now();
  let firstByteMs = 0;
  let hasForwardedBytes = false;

  const usage = await new Promise<{
    inputTokens: number;
    outputTokens: number;
    firstByteMs: number;
    responseText?: string;
    streamError?: string;
  } | null>((resolve, reject) => {
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      nodeStream.off("data", onData);
      nodeStream.off("end", onEnd);
      nodeStream.off("error", onError);
      nodeStream.off("close", onClose);
      req.off("close", onClientClose);
      res.off("close", onResponseClose);
      res.off("error", onResponseError);
    };

    const finish = (reason?: string): void => {
      if (settled) return;
      settled = true;
      if (reason) proxyLog(`[${label}] Stream closed: ${reason}`, "warn");
      cleanup();
      // Drain any partial event that didn't end with \n\n
      if (!firstUsage) firstUsage = eventAccumulator.final();
      if (firstUsage || streamError) {
        resolve({
          ...(firstUsage || { inputTokens: 0, outputTokens: 0 }),
          firstByteMs,
          responseText: eventAccumulator.getText(),
          streamError,
        });
      } else {
        resolve(null);
      }
    };

    const failBeforeFlush = (err: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new PreFlushStreamError(err));
    };

    const emitStreamError = (err: unknown): void => {
      streamError = formatError(err).slice(0, 200);
      if (res.destroyed || res.writableEnded) return;
      res.write(
        `data: ${JSON.stringify({ error: { code: 502, status: "BAD_GATEWAY", message: streamError } })}\n\n`,
      );
    };

    const resetIdleTimer = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        const error = new Error(
          `idle timeout after ${Math.round(STREAM_IDLE_TIMEOUT_MS / 1000)}s`,
        );
        if (hasForwardedBytes) emitStreamError(error);
        finish(
          error.message,
        );
        if (!nodeStream.destroyed) nodeStream.destroy();
      }, STREAM_IDLE_TIMEOUT_MS);
    };

    const onData = (chunk: Buffer): void => {
      if (firstByteMs === 0) firstByteMs = Date.now() - streamStartMs;
      resetIdleTimer();
      // Forward to client immediately (real-time streaming preserved)
      if (!res.destroyed && !res.writableEnded) {
        if (!res.headersSent) res.writeHead(responseStatus, responseHeaders);
        hasForwardedBytes = true;
        res.write(chunk);
      }
      // Extract usage from any newly-completed SSE events
      if (!firstUsage) {
        const usage = eventAccumulator.append(chunk.toString());
        if (usage) firstUsage = usage;
      }
    };
    const onEnd = (): void => finish();
    const onError = (err: Error): void => {
      if (!hasForwardedBytes) {
        failBeforeFlush(err);
      } else {
        emitStreamError(err);
        finish(String(err));
      }
    };
    const onClose = (): void => {
      if (!hasForwardedBytes) {
        failBeforeFlush(new Error("upstream stream closed before response data"));
      } else {
        emitStreamError(new Error("upstream stream closed before response completion"));
        finish();
      }
    };
    // req.aborted is deprecated and unreliable since Node 18+.
    // req.on("close") is the correct signal for client disconnect in Node 22.
    const onClientClose = (): void => {
      // Always destroy when the client disconnects — regardless of writableEnded.
      // The upstream stream from Google may still be open even if res finished writing,
      // which would leave the account stuck in-flight until the idle timeout.
      if (!settled) {
        nodeStream.destroy();
        finish("client closed connection");
      }
    };
    const onResponseClose = (): void => {
      if (!settled) {
        nodeStream.destroy();
        finish("response closed before completion");
      }
    };
    const onResponseError = (err: Error): void => {
      nodeStream.destroy(err);
      finish(String(err));
    };

    nodeStream.on("data", onData);
    nodeStream.once("end", onEnd);
    nodeStream.once("error", onError);
    nodeStream.once("close", onClose);
    req.once("close", onClientClose);
    res.once("close", onResponseClose);
    res.once("error", onResponseError);
    resetIdleTimer();
  });

  if (!res.headersSent && !res.destroyed) {
    res.writeHead(responseStatus, responseHeaders);
  }

  return usage;
}function benchmarkFailure(
  account: AccountRuntime,
  startedAt: number,
  error: string,
  ttfbMs: number | null = null,
): BenchmarkResult {
  return {
    account: maskAccountLabel(account.config.label || account.config.email),
    status: "failed",
    latencyMs: Date.now() - startedAt,
    ttfbMs,
    outputTokens: null,
    tokensPerSecond: null,
    error: error.slice(0, 240),
  };
}

export async function benchmarkAccount(
  rotator: AccountRotator,
  account: AccountRuntime,
  sharedSignal?: AbortSignal,
): Promise<BenchmarkResult> {
  const label = maskAccountLabel(account.config.label || account.config.email);
  const startedAt = Date.now();
  const maxConcurrent = Math.max(
    1,
    rotator.getConfig().maxConcurrentRequestsPerAccount ?? 5,
  );
  if (account.inFlightRequests >= maxConcurrent) {
    return {
      account: label,
      status: "skipped",
      latencyMs: null,
      ttfbMs: null,
      outputTokens: null,
      tokensPerSecond: null,
      error: "Account already has the maximum number of in-flight requests",
    };
  }

  const benchmarkSpec = getProviderForAccount(account.config).getBenchmark(account);
  rotator.startRequest(account, benchmarkSpec.body.model);
  const timeoutController = new AbortController();
  const timeout = setTimeout(
    () => timeoutController.abort(new Error("Benchmark timeout")),
    GOOGLE_BENCHMARK_CONSTANTS.timeoutMs,
  );
  const signal = sharedSignal
    ? AbortSignal.any([timeoutController.signal, sharedSignal])
    : timeoutController.signal;
  let ttfbMs: number | null = null;

  try {
    await rotator.ensureValidToken(account);
    const forwarded = await providerAdapterForModel(
      account,
      benchmarkSpec.body.model,
      rotator,
    ).forwardRequest(account, benchmarkSpec.body, {}, signal);
    ttfbMs = Date.now() - startedAt;
    const raw = await forwarded.response.text();
    const latencyMs = Date.now() - startedAt;
    if (!forwarded.response.ok) {
      return benchmarkFailure(
        account,
        startedAt,
        `HTTP ${forwarded.response.status}: ${raw || forwarded.response.statusText}`,
        ttfbMs,
      );
    }

    const usage = benchmarkSpec.parseUsage(raw);
    const outputTokens = usage?.outputTokens ?? Math.max(1, Math.ceil(raw.length / 4));
    return {
      account: label,
      status: "success",
      latencyMs,
      ttfbMs,
      outputTokens,
      tokensPerSecond: outputTokens / Math.max(latencyMs / 1000, 0.001),
    };
  } catch (err) {
    return benchmarkFailure(account, startedAt, formatError(err), ttfbMs);
  } finally {
    clearTimeout(timeout);
    rotator.finishRequest(account, benchmarkSpec.body.model);
  }
}

function averageBenchmarkMetric(
  results: BenchmarkResult[],
  metric: "latencyMs" | "ttfbMs" | "tokensPerSecond",
): number | null {
  const values = results
    .filter((result) => result.status === "success")
    .map((result) => result[metric])
    .filter((value): value is number => value !== null);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function summarizeBenchmarkResults(
  results: BenchmarkResult[],
): BenchmarkSummary {
  const succeeded = results.filter((result) => result.status === "success").length;
  const failed = results.filter((result) => result.status === "failed").length;
  const skipped = results.filter((result) => result.status === "skipped").length;
  return {
    total: results.length,
    succeeded,
    failed,
    skipped,
    successRate: results.length > 0 ? (succeeded / results.length) * 100 : 0,
    averageLatencyMs: averageBenchmarkMetric(results, "latencyMs"),
    averageTtfbMs: averageBenchmarkMetric(results, "ttfbMs"),
    averageTokensPerSecond: averageBenchmarkMetric(results, "tokensPerSecond"),
  };
}

function sortBenchmarkResults(results: BenchmarkResult[]): BenchmarkResult[] {
  const rank: Record<BenchmarkResultStatus, number> = {
    success: 0,
    failed: 1,
    skipped: 2,
  };
  return results.sort((a, b) => {
    if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
    if (a.status === "success" && b.status === "success") {
      return (b.tokensPerSecond ?? 0) - (a.tokensPerSecond ?? 0);
    }
    return a.account.localeCompare(b.account);
  });
}

function writeBenchmarkEvent(
  res: ServerResponse,
  payload: Record<string, unknown>,
): boolean {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

export async function serveBenchmarkApi(
  res: ServerResponse,
  rotator: AccountRotator,
): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": benchmark\n\n");

  const accounts = rotator.getBenchmarkAccounts();
  const clientController = new AbortController();
  const onClose = (): void => clientController.abort();
  res.once("close", onClose);
  const results: BenchmarkResult[] = [];

  try {
    writeBenchmarkEvent(res, {
      type: "start",
      total: accounts.length,
      model: GOOGLE_BENCHMARK_CONSTANTS.model,
    });
    await Promise.all(
      accounts.map(async (account) => {
        const result = await benchmarkAccount(
          rotator,
          account,
          clientController.signal,
        );
        results.push(result);
        writeBenchmarkEvent(res, {
          type: "progress",
          completed: results.length,
          total: accounts.length,
          result,
        });
      }),
    );
    const sortedResults = sortBenchmarkResults(results);
    writeBenchmarkEvent(res, {
      type: "complete",
      summary: summarizeBenchmarkResults(sortedResults),
      results: sortedResults,
    });
  } catch (err) {
    const details = formatError(err);
    proxyLogger.error(`Benchmark failed: ${details}`);
    writeBenchmarkEvent(res, {
      type: "error",
      error: "Benchmark failed",
    });
  } finally {
    res.off("close", onClose);
    if (!res.writableEnded) res.end();
  }
}

export async function withRotation<T>(
  rotator: AccountRotator,
  model: string,
  originalHeaders: Record<string, string>,
  body: RequestBody,
  onSuccess: (
    response: Response,
    context: RotationAttemptContext,
  ) => Promise<T>,
  signal?: AbortSignal,
): Promise<RotationOutcome<T>> {
  const sendNoAccountsAvailable = (
    reason: string,
    context?: RotationAttemptContext,
  ): RotationOutcome<T> => {
    log(`[${model}] No healthy account available: ${reason}`, rotator, "warn");
    const retryAfterMs = rotator.getRetryAfterMs(model);
    const contextFields = context
      ? { context, totalMs: Date.now() - context.requestStartMs }
      : {};
    if (retryAfterMs > 0) {
      return {
        ok: false,
        status: 429,
        errorText: `All accounts cooling down or model circuit breaker active: ${reason}`,
        retryAfterMs,
        ...contextFields,
      };
    }
    return {
      ok: false,
      status: 503,
      errorText: `All accounts exhausted or disabled: ${reason}`,
      ...contextFields,
    };
  };

  const maxRetries = getStreamRecoveryMaxRetries(rotator);
  const maxAttempts = maxRetries + 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const account = await rotator.getActiveAccount(model, signal);
    if (!account) {
      if (signal?.aborted) {
        return { ok: false, status: 499, errorText: "Client closed request" };
      }
      return sendNoAccountsAvailable("rotation returned no available account");
    }

    const label = account.config.label || account.config.email;
    const modelKey = routingModelKey(rotator, model);
    const displayModelKey = observedModelKey(
      rotator,
      body.displayModel || model,
      body.model,
    );
    const requestId = `${modelKey}-${Date.now().toString(36)}-${attempt + 1}`;
    const requestStartMs = Date.now();
    let accountReleased = false;
    const releaseCurrentAccount = (): void => {
      if (accountReleased) return;
      accountReleased = true;
      rotator.finishRequest(account, modelKey);
    };
    const rotateAndRelease = async (): Promise<AccountRuntime | null> => {
      releaseCurrentAccount();
      const nextAccount = await rotator.rotateToNext(model, account);
      return nextAccount;
    };
    const logRequestEnd = (status: string | number, extra = ""): void => {
      log(
        `[${requestId}] END account=${label} model=${model} status=${status}${extra ? ` ${extra}` : ""} totalMs=${Date.now() - requestStartMs}`,
        rotator,
        status === 200 || status === 0 ? "info" : "warn",
      );
    };

    log(
      `[${requestId}] START account=${label} model=${model} attempt=${attempt + 1}`,
      rotator,
    );

    try {
      const skipJitter = Boolean(
        originalHeaders &&
          (originalHeaders["x-skip-safety-jitter"] === "true" ||
            originalHeaders["x-live-request"] === "true"),
      );
      const jitterMs = skipJitter ? 0 : rotator.getSafetyJitterMs(account);
      const globalDelayMs = skipJitter ? 0 : rotator.getGlobalDelayMs();
      const totalDelayMs = jitterMs + globalDelayMs;
      if (totalDelayMs > 0) {
        if (jitterMs > 0) {
          log(
            `[${requestId}] Safety slow-mode jitter ${jitterMs}ms for account/project daily budget pressure`,
            rotator,
            "warn",
          );
        }
        if (globalDelayMs > 0) {
          log(
            `[${requestId}] Global request delay ${globalDelayMs}ms applied to slow down requests`,
            rotator,
            "info",
          );
        }
        await sleep(totalDelayMs, signal);
      }

      rotator.recordUpstreamAttempt(account);
      const provider = providerAdapterForModel(
        account,
        model,
        rotator,
      );
      // A parent account may carry Google + Codex credentials; refresh the
      // selected provider, never merely the account's primary provider.
      await provider.ensureValidToken(account);
      const forwarded = await provider.forwardRequest(
        account,
        { ...body },
        originalHeaders,
        signal,
      );
      const { response, endpoint } = forwarded;
      const context: RotationAttemptContext = {
        account,
        label,
        modelKey,
        displayModelKey,
        requestId,
        requestStartMs,
        endpoint,
        retries: attempt,
      };

      const action = await classifyUpstreamResponse(
        response,
        endpoint,
        account,
        model,
        modelKey,
        provider.id,
      );

      if (action.kind !== "success") {
        const decision = await handleUpstreamAccountAction({
          action,
          provider,
          rotator,
          account,
          model,
          modelKey,
          label,
          context,
          logRequestEnd,
          rotateAndRelease,
          canRetry: attempt < maxRetries,
          writeLog: (message, level = "info") => log(message, rotator, level),
        });
        if (decision.kind === "retry") continue;
        return failureDecisionToOutcome(decision);
      }

      // success
      const result = await onSuccess(response, context);
      const shouldRotate = rotator.recordRequest(account, model);
      const inTokens =
        result && typeof result === "object" && "inputTokens" in result
          ? (result as Record<string, unknown>).inputTokens
          : 0;
      const outTokens =
        result && typeof result === "object" && "outputTokens" in result
          ? (result as Record<string, unknown>).outputTokens
          : 0;
      const ttfbMs =
        result && typeof result === "object" && "firstByteMs" in result
          ? (result as Record<string, unknown>).firstByteMs
          : undefined;
      const ttfbInfo = ttfbMs !== undefined ? ` ttfbMs=${ttfbMs}` : "";
      const tokensInfo =
        inTokens || outTokens ? ` inTokens=${inTokens} outTokens=${outTokens}` : "";
      logRequestEnd(response.status, `endpoint=${endpoint}${ttfbInfo}${tokensInfo}`);
      if (shouldRotate) {
        await rotator.rotateToNext(model, account);
      }
      return { ok: true, result, endpoint, context };
    } catch (err) {
      if (signal?.aborted) {
        return { ok: false, status: 499, errorText: "Client closed request" };
      }
      const formattedError = formatError(err);
      log(
        `[${label}] Request failed: ${formattedError}`,
        rotator,
        isFetchTransportError(err) ? "warn" : "error",
      );
      logRequestEnd(
        isFetchTransportError(err) ? "fetch-error" : 500,
        `error=${formattedError.slice(0, 120)}`,
      );
      if (!isFetchTransportError(err)) {
        rotator.markError(account, formattedError);
        return {
          ok: false,
          status: 502,
          errorText: GENERIC_UPSTREAM_ERROR,
          context: {
            account,
            label,
            modelKey,
            displayModelKey,
            requestId,
            requestStartMs,
            endpoint: "unknown",
            retries: attempt,
          },
          totalMs: Date.now() - requestStartMs,
        };
      }
      if (attempt >= maxRetries) {
        return {
          ok: false,
          status: 502,
          errorText: "All retry attempts failed",
          context: {
            account,
            label,
            modelKey,
            displayModelKey,
            requestId,
            requestStartMs,
            endpoint: "unknown",
            retries: attempt,
          },
          totalMs: Date.now() - requestStartMs,
        };
      }
      const nextAccount = await rotateAndRelease();
      if (!nextAccount) {
        return sendNoAccountsAvailable(
          `no replacement account remained after ${label} request error`,
        );
      }
      continue;
    } finally {
      releaseCurrentAccount();
    }
  }

  return { ok: false, status: 502, errorText: "All retry attempts failed" };
}

function log(
  msg: string,
  rotator?: AccountRotator,
  level: "info" | "warn" | "error" = "info",
): void {
  proxyLogger.log(level, msg);
  rotator?.recordProxyEvent(msg, level);
}

function isGeminiGenerateContentPath(pathname: string): boolean {
  const prefix = "/v1beta/models/";
  if (!pathname.startsWith(prefix)) return false;

  const separator = pathname.lastIndexOf(":");
  if (separator <= prefix.length || separator === pathname.length - 1) {
    return false;
  }

  const operation = pathname.slice(separator + 1);
  return operation === "generateContent" || operation === "streamGenerateContent";
}

/**
 * Handle a proxied API request.
 */
async function handleProxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  rotator: AccountRotator,
  onComplete?: () => void,
  nativeOllamaChat = false,
): Promise<void> {
  let bodyBuffer: Buffer;
  try {
    bodyBuffer = await readLimitedBody(req);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Payload too large",
          limitBytes: err.limitBytes,
        }),
      );
      return;
    }
    throw err;
  }
  let body: RequestBody;
  if (nativeOllamaChat) {
    // Native /api/chat payload ({model, messages, stream, options}) is
    // translated to the internal body shape; the internal validator expects
    // the wrapped format, so parse the native shape first.
    let raw: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(bodyBuffer.toString("utf-8"));
      raw = isRecord(parsed) ? parsed : {};
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }
    if (typeof raw.model !== "string" || raw.model === "") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid request body: model required" }));
      return;
    }
    if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: "Invalid request body: messages required" }),
      );
      return;
    }
    body = {
      project: "",
      model: raw.model,
      request: raw,
      displayModel: raw.model,
      requestType: "ollama-chat",
    };
  } else {
    try {
      const parsed: unknown = JSON.parse(bodyBuffer.toString("utf-8"));
      const validation = validateProxyRequestBody(parsed);
      if (!validation.ok || !validation.value) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Invalid request body",
            details: validation.errors,
          }),
        );
        return;
      }
      body = validation.value as RequestBody;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }
  }

  const auth = await authenticateVirtualKey(req, body.model);
  if (!auth.authenticated) {
    sendAuthErrorResponse(res, auth);
    return;
  }
  const apiKeyHash = auth.key?.tokenHash || (auth.rawKey ? hashKey(auth.rawKey) : null);
  const clientController = new AbortController();
  const abortClient = (): void => clientController.abort();
  const removeAbortListeners = (): void => {
    req.off("aborted", abortClient);
    res.off("close", abortClient);
  };
  req.once("aborted", abortClient);
  res.once("close", abortClient);
  res.once("finish", removeAbortListeners);

  const proxyLog = (
    msg: string,
    level: "info" | "warn" | "error" = "info",
  ): void => {
    log(msg, rotator, level);
  };
  if (bodyBuffer.length > LARGE_CONTEXT_WARN_BYTES) {
    proxyLog(
      `[${body.model}] Large request body ${bodyBuffer.length} bytes; high context pressure increases rate-limit/flag risk`,
      "warn",
    );
  }

  const sendNoAccountsAvailable = (reason: string): void => {
    if (clientController.signal.aborted || res.destroyed) return;
    proxyLog(`[${body.model}] No healthy account available: ${reason}`, "warn");
    const retryAfterMs = rotator.getRetryAfterMs(body.model);
    if (retryAfterMs > 0) {
      const retrySec = Math.ceil(retryAfterMs / 1000);
      res.writeHead(429, {
        "Content-Type": "application/json",
        "Retry-After": String(retrySec),
      });
      res.end(
        JSON.stringify({
          error: `Rate limit exceeded. All accounts cooling down. Please wait ${retrySec} seconds before retrying.`,
          reason,
          model: body.model,
          retryAfterMs,
          retryAfterSeconds: retrySec,
        }),
      );
      return;
    }
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "All accounts exhausted or disabled",
        reason,
        model: body.model,
        retryable: false,
      }),
    );
  };
  const sendFailureDecision = (decision: UpstreamFailureDecision): void => {
    if (clientController.signal.aborted || res.destroyed) return;
    if (decision.noReplacementReason) {
      sendNoAccountsAvailable(decision.noReplacementReason);
      return;
    }

    const label = decision.context.label;
    if (decision.actionKind === "rate-limited") {
      const retryAfterMs = decision.retryAfterMs ?? 0;
      res.writeHead(429, {
        "Content-Type": "application/json",
        "Retry-After": String(Math.ceil(retryAfterMs / 1000)),
      });
      res.end(
        JSON.stringify({
          error: decision.providerResourceExhausted
            ? "Resource exhausted"
            : "Rate limited",
          reason: decision.providerResourceExhausted
            ? `${label} hit provider RESOURCE_EXHAUSTED; not retrying another account to avoid pool-wide hammering`
            : `${label} was rate limited; not retrying another account for account-safety`,
          model: body.model,
          account: label,
          retryAfterMs,
        }),
      );
      return;
    }

    if (decision.actionKind === "forbidden") {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(decision.errorText || JSON.stringify({ error: "Forbidden" }));
      return;
    }

    if (decision.actionKind === "not-found") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(decision.errorText || JSON.stringify({ error: "Not found" }));
      return;
    }

    if (decision.actionKind === "bad-request") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(decision.errorText || JSON.stringify({ error: "Bad request" }));
      return;
    }

    if (decision.actionKind === "server-error-503") {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        decision.errorText ||
          JSON.stringify({
            error: "Server unavailable",
            account: label,
            model: body.model,
          }),
      );
      return;
    }

    res.writeHead(decision.status, { "Content-Type": "application/json" });
    res.end(decision.errorText || JSON.stringify({ error: "Upstream error" }));
  };

  const maxRetries = getStreamRecoveryMaxRetries(rotator);
  const maxAttempts = maxRetries + 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const account = await rotator.getActiveAccount(
      body.model,
      clientController.signal,
    );
    if (!account) {
      if (clientController.signal.aborted || res.destroyed) return;
      sendNoAccountsAvailable("rotation returned no available account");
      return;
    }

    const label = account.config.label || account.config.email;
    const modelKey = rotator.resolveQuotaModelKeyForDisplay(body.model) ?? body.model; // quota routing
    const displayModelKey = observedModelKey(rotator, body.model); // metrics/logs
    const requestId = `${modelKey}-${Date.now().toString(36)}-${attempt + 1}`;
    let accountReleased = false;
    const releaseCurrentAccount = (): void => {
      if (accountReleased) return;
      accountReleased = true;
      rotator.finishRequest(
        account,
        routingModelKey(rotator, body.model),
      );
    };
    const rotateAndRelease = async (): Promise<AccountRuntime | null> => {
      releaseCurrentAccount();
      const nextAccount = await rotator.rotateToNext(body.model, account);
      return nextAccount;
    };
    proxyLog(
      `[${requestId}] START account=${label} model=${body.model} attempt=${attempt + 1}`,
    );
    const requestStartMs = Date.now();
    const logRequestEnd = (status: string | number, extra = ""): void => {
      proxyLog(
        `[${requestId}] END account=${label} model=${body.model} status=${status}${extra ? ` ${extra}` : ""} totalMs=${Date.now() - requestStartMs}`,
        status === 200 || status === 0 ? "info" : "warn",
      );
    };
    const recordOutcome = (
      statusCode: number,
      ttfbMs = 0,
      totalMs = Date.now() - requestStartMs,
      inputTokens = 0,
      outputTokens = 0,
    ): void => {
      rotator.recordRequestLog({
        model: modelKey,
        account: label,
        statusCode,
        ttfbMs,
        totalMs,
        inputTokens,
        outputTokens,
      });
    };

    try {
      const skipJitter = req.headers["x-skip-safety-jitter"] === "true" || req.headers["x-live-request"] === "true";
      const jitterMs = skipJitter ? 0 : rotator.getSafetyJitterMs(account);
      const globalDelayMs = skipJitter ? 0 : rotator.getGlobalDelayMs();
      const totalDelayMs = jitterMs + globalDelayMs;
      if (totalDelayMs > 0) {
        if (jitterMs > 0) {
          proxyLog(
            `[${requestId}] Safety slow-mode jitter ${jitterMs}ms for account/project daily budget pressure`,
            "warn",
          );
        }
        if (globalDelayMs > 0) {
          proxyLog(
            `[${requestId}] Global request delay ${globalDelayMs}ms applied to slow down requests`,
            "info",
          );
        }
        await sleep(totalDelayMs, clientController.signal);
      }
      rotator.recordUpstreamAttempt(account);
      const provider = providerAdapterForModel(
        account,
        body.model,
        rotator,
      );
      await provider.ensureValidToken(account);
      const forwarded = await provider.forwardRequest(
        account,
        { ...body },
        flattenHeaders(req.headers),
        clientController.signal,
      );
      const { response, endpoint } = forwarded;
      const context: RotationAttemptContext = {
        account,
        label,
        modelKey,
        displayModelKey,
        requestId,
        requestStartMs,
        endpoint,
        retries: attempt,
      };

      const action = await classifyUpstreamResponse(
        response,
        endpoint,
        account,
        body.model,
        modelKey,
        provider.id,
      );

      if (action.kind !== "success") {
        const decision = await handleUpstreamAccountAction({
          action,
          provider,
          rotator,
          account,
          model: body.model,
          modelKey,
          label,
          context,
          logRequestEnd,
          rotateAndRelease,
          canRetry: attempt < maxRetries,
          writeLog: proxyLog,
          recordFailureAttempt: recordOutcome,
        });
        if (decision.kind === "retry") continue;
        sendFailureDecision(decision);
        return;
      }

      // Success or non-error client response
      const shouldRotate = rotator.recordRequest(account, body.model);

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        if (
          key.toLowerCase() !== "transfer-encoding" &&
          key.toLowerCase() !== "connection"
        ) {
          responseHeaders[key] = value;
        }
      });

      const rotatorHeaders = buildRotatorResponseHeaders({
        accountLabel: label,
        model: displayModelKey || body.displayModel || body.model,
        ttfbMs: Date.now() - requestStartMs,
        healthScore: account.healthScore,
        routingPolicy: rotator?.getConfig?.()?.routingPolicy || "timer-first",
        retries: attempt,
      });
      Object.assign(responseHeaders, rotatorHeaders);

      try {
        const usage = await streamResponseBody(
          response.body,
          req,
          res,
          label,
          proxyLog,
          response.status,
          responseHeaders,
          provider.createStreamAccumulator(),
        );
        const totalMs = Date.now() - requestStartMs;
        const ttfbMs = usage?.firstByteMs ?? totalMs;
        const outcomeStatus = usage?.streamError ? 502 : response.status;
        rotator.recordLatency(body.displayModel || body.model, ttfbMs, totalMs);
        logRequestEnd(outcomeStatus, `ttfbMs=${ttfbMs} inTokens=${usage?.inputTokens ?? 0} outTokens=${usage?.outputTokens ?? 0} endpoint=${endpoint}`);
        rotator.recordRequestLog({
          model: displayModelKey,
          account: label,
          statusCode: outcomeStatus,
          ttfbMs,
          totalMs,
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
        });
        logSpend({
          requestId,
          apiKeyHash,
          model: displayModelKey,
          accountEmail: label,
          callType: "native",
          status: outcomeStatus >= 200 && outcomeStatus < 300 ? "success" : "failure",
          promptTokens: usage?.inputTokens ?? 0,
          completionTokens: usage?.outputTokens ?? 0,
          totalTokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
          startTime: new Date(requestStartMs).toISOString(),
          endTime: new Date().toISOString(),
          ttfbMs,
          durationMs: totalMs,
          requestMessages: body.request || body,
          responseContent: usage?.responseText
            ? { candidates: [{ content: { parts: [{ text: usage.responseText }] }, finishReason: "STOP" }] }
            : null,
          requesterIp: req.socket?.remoteAddress || null,
        });
        if (usage && (usage.inputTokens > 0 || usage.outputTokens > 0)) {
          rotator.recordTokenUsage(
            body.displayModel || body.model,
            usage.inputTokens,
            usage.outputTokens,
          );
        }
      } catch (err) {
        proxyLog(`[${label}] Stream setup error: ${err}`, "warn");
        if (err instanceof PreFlushStreamError) throw err;
      }
      res.end();

      if (shouldRotate) {
        await rotator.rotateToNext(body.model, account);
      }
      return;
    } catch (err) {
      if (clientController.signal.aborted || res.destroyed) return;
      const formattedError = formatError(err);
      proxyLog(
        `[${label}] Request failed: ${formattedError}`,
        isFetchTransportError(err) ? "warn" : "error",
      );
      recordOutcome(isFetchTransportError(err) ? 0 : 500);
      logRequestEnd(
        isFetchTransportError(err) ? "fetch-error" : 500,
        `error=${formattedError.slice(0, 120)}`,
      );
      if (!isFetchTransportError(err)) {
        rotator.markError(account, formattedError);
      }
      if (res.headersSent || res.destroyed) {
        res.end();
        return;
      }
      if (!isFetchTransportError(err) || attempt >= maxRetries) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: GENERIC_UPSTREAM_ERROR }));
        return;
      }
      const nextAccount = await rotateAndRelease();
      if (!nextAccount) {
        sendNoAccountsAvailable(
          `no replacement account remained after ${label} request error`,
        );
        return;
      }
      continue;
    } finally {
      releaseCurrentAccount();
      if (onComplete) onComplete();
    }
  }

  if (clientController.signal.aborted || res.destroyed) return;
  if (!res.headersSent) {
    res.writeHead(502, { "Content-Type": "application/json" });
  }
  res.end(JSON.stringify({ error: "All retry attempts failed" }));
}

const CODE_ASSIST_ROUTING_MODEL = "gemini-3-flash";

async function handleCodeAssistPassthrough(
  req: IncomingMessage,
  res: ServerResponse,
  rotator: AccountRotator,
  action: CodeAssistAction,
): Promise<void> {
  let bodyBuffer: Buffer;
  try {
    bodyBuffer = await readLimitedBody(req);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Payload too large", limitBytes: err.limitBytes }));
      return;
    }
    throw err;
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyBuffer.toString("utf-8")) as unknown;
    validateCodeAssistPayload(action, body);
  } catch (err) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: err instanceof Error ? err.message : "Invalid Code Assist request",
    }));
    return;
  }

  const provider = getProviderAdapter(DEFAULT_PROVIDER);
  if (!provider.forwardCodeAssistRequest) {
    res.writeHead(501, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Code Assist passthrough is unavailable" }));
    return;
  }

  const clientController = new AbortController();
  const abortClient = (): void => clientController.abort();
  const removeAbortListeners = (): void => {
    req.off("aborted", abortClient);
    res.off("close", abortClient);
  };
  req.once("aborted", abortClient);
  res.once("close", abortClient);
  res.once("finish", removeAbortListeners);

  const maxRetries = getStreamRecoveryMaxRetries(rotator);
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let account: AccountRuntime | null;
    try {
      account = await rotator.getActiveAccount(
        CODE_ASSIST_ROUTING_MODEL,
        clientController.signal,
      );
    } catch {
      if (clientController.signal.aborted || res.destroyed) return;
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Account token refresh failed" }));
      return;
    }
    if (!account) {
      if (clientController.signal.aborted || res.destroyed) return;
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "All Google accounts exhausted or disabled" }));
      return;
    }

    let accountReleased = false;
    const releaseCurrentAccount = (): void => {
      if (accountReleased) return;
      accountReleased = true;
      rotator.finishRequest(
        account,
        resolveQuotaModelKey(CODE_ASSIST_ROUTING_MODEL) ?? undefined,
      );
    };

    try {
      // getActiveAccount performs the normal account lifecycle check, but the
      // explicit provider call is required for dual Google+Ollama accounts.
      await provider.ensureValidToken(account);
      rotator.recordUpstreamAttempt(account);
      const forwarded = await provider.forwardCodeAssistRequest(
        account,
        action,
        body,
        flattenHeaders(req.headers),
        clientController.signal,
      );
      const responseBody = await forwarded.response.text();
      if (clientController.signal.aborted || res.destroyed) return;
      res.writeHead(forwarded.response.status, {
        "Content-Type": forwarded.response.headers.get("content-type") || "application/json",
      });
      res.end(responseBody);
      return;
    } catch (err) {
      if (clientController.signal.aborted || res.destroyed) return;
      if (!isFetchTransportError(err) || attempt >= maxRetries) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Code Assist upstream request failed" }));
        return;
      }
      releaseCurrentAccount();
      const nextAccount = await rotator.rotateToNext(CODE_ASSIST_ROUTING_MODEL, account);
      if (nextAccount) {
        continue;
      }
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No replacement Google account available" }));
      return;
    } finally {
      releaseCurrentAccount();
    }
  }
}

export function flattenHeaders(
  headers: IncomingMessage["headers"],
): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value) {
      flat[key] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  return flat;
}

export function startProxy(
  rotator: AccountRotator,
  port: number,
  bindHost = "0.0.0.0",
): Server {
  startVersionChecker();
  startNotificationPoller();
  const sseClients = new Set<ServerResponse>();
  let sseBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
  let benchmarkRunning = false;
  const SSE_THROTTLE_MS = 1000; // max 1 push/second

  const scheduleSseBroadcast = (): void => {
    if (sseBroadcastTimer) return; // already scheduled
    sseBroadcastTimer = setTimeout(() => {
      sseBroadcastTimer = null;
      if (sseClients.size === 0) return;
      const data = JSON.stringify(rotator.getStatus());
      for (const client of sseClients) {
        try {
          client.write(`data: ${data}\n\n`);
        } catch {
          sseClients.delete(client);
        }
      }
    }, SSE_THROTTLE_MS);
  };

  // Hook into rotator state changes to trigger SSE
  const origSaveState = rotator.saveState.bind(rotator);
  rotator.saveState = (): Promise<void> => {
    const write = origSaveState();
    scheduleSseBroadcast();
    return write;
  };

  const server = createServer((req, res) => {
    const method = req.method?.toUpperCase();
    const url = req.url || "";
    const pathname = url.split("?")[0];

    // CORS headers for API consumers (e.g. MindWhisperAI, local frontends)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (method === "GET" && (pathname === "/" || pathname === "/dashboard")) {
      if (!requireAdmin(req, res)) return;
      trackFeature("dashboard");
      serveDashboard(res);
      return;
    }

    if (method === "GET" && pathname === "/dashboard/keys") {
      if (!requireAdmin(req, res)) return;
      serveDashboardKeys(res);
      return;
    }

    if (method === "GET" && pathname === "/dashboard/logs") {
      if (!requireAdmin(req, res)) return;
      serveDashboardLogs(res);
      return;
    }

    if (method === "GET" && pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (method === "GET" && pathname === "/static/dashboard.css") {
      serveStaticCss(res);
      return;
    }

    if (method === "GET" && pathname === "/static/dashboard.js") {
      serveStaticJs(res);
      return;
    }

    if (method === "GET" && pathname === "/static/dashboard-keys.js") {
      serveStaticKeysJs(res);
      return;
    }

    if (method === "GET" && pathname === "/static/dashboard-logs.js") {
      serveStaticLogsJs(res);
      return;
    }

    if (method === "GET" && pathname === "/login") {
      if (!requireAdmin(req, res)) return;
      trackFeature("hostedLogin");
      serveLoginLanding(res);
      return;
    }

    if (method === "GET" && pathname === "/login-cli") {
      if (!requireAdmin(req, res)) return;
      trackFeature("cliLogin");
      serveCliLogin(res);
      return;
    }

    if (method === "POST" && pathname === "/api/cli-login") {
      if (!requireAdmin(req, res)) return;
      handleCliLoginApi(req, res, rotator).catch((err) => {
        log(`CLI login error: ${err}`, rotator, "error");
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
        }
        res.end(JSON.stringify({ ok: false, error: "Internal login error" }));
      });
      return;
    }

    if (method === "GET" && pathname === "/auth/antigravity/start") {
      if (!requireAdmin(req, res)) return;
      startHostedLogin(req, res);
      return;
    }

    if (method === "GET" && pathname === "/auth/antigravity/callback") {
      handleHostedCallback(req, res, rotator).catch((err) => {
        log(`Hosted callback error: ${err}`, rotator, "error");
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        }
        res.end("<h1>Internal login error</h1>");
      });
      return;
    }

    if (method === "GET" && pathname === "/api/status") {
      if (!requireAdmin(req, res)) return;
      serveStatusApi(res, rotator);
      return;
    }

    if (method === "GET" && pathname === "/api/config") {
      if (!requireAdmin(req, res)) return;
      serveConfigApi(res, rotator);
      return;
    }

    if (method === "GET" && pathname === "/api/config/export") {
      if (!requireAdmin(req, res)) return;
      serveConfigExportApi(res, rotator);
      return;
    }

    if (method === "POST" && pathname === "/api/benchmark") {
      if (!requireAdmin(req, res)) return;
      if (benchmarkRunning) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Benchmark already running" }));
        return;
      }
      benchmarkRunning = true;
      void serveBenchmarkApi(res, rotator).finally(() => {
        benchmarkRunning = false;
      });
      return;
    }

    if (
      (method === "PUT" && pathname === "/api/config") ||
      (method === "POST" && pathname === "/api/config/import")
    ) {
      if (!requireAdmin(req, res)) return;
      readJsonRequest(req)
        .then((parsed) => {
          const candidate =
            parsed &&
            typeof parsed === "object" &&
            "config" in (parsed as Record<string, unknown>)
              ? (parsed as { config: unknown }).config
              : parsed;
          const validation = validateConfig(candidate);
          if (!validation.ok || !validation.value) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, errors: validation.errors }));
            return;
          }
           return serveConfigImportApi(
             res,
             rotator,
             applyConfigDefaults(validation.value),
          );
        })
        .catch((err) => {
          const isPayloadTooLarge = err instanceof PayloadTooLargeError;
          proxyLogger.warn(`Config import request failed: ${formatError(err)}`);
          res.writeHead(isPayloadTooLarge ? 413 : 400, {
            "Content-Type": "application/json",
          });
          res.end(
            JSON.stringify({
              ok: false,
              error: isPayloadTooLarge
                ? "Payload too large"
                : "Invalid config request",
            }),
          );
        });
      return;
    }

    if (method === "GET" && pathname === "/api/events") {
      if (!requireAdmin(req, res)) return;
      // Server-Sent Events for live dashboard
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(":\n\n"); // keepalive comment
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    if (method === "POST" && pathname.startsWith("/api/enable/")) {
      if (!requireAdmin(req, res)) return;
      const email = decodeURIComponent(pathname.slice("/api/enable/".length));
      void serveEnableApi(res, rotator, email);
      return;
    }

    if (method === "POST" && pathname.startsWith("/api/disable/")) {
      if (!requireAdmin(req, res)) return;
      const email = decodeURIComponent(pathname.slice("/api/disable/".length));
      void serveDisableApi(res, rotator, email);
      return;
    }

    if (method === "POST" && pathname.startsWith("/api/quarantine/")) {
      if (!requireAdmin(req, res)) return;
      const email = decodeURIComponent(pathname.slice("/api/quarantine/".length));
      void serveQuarantineApi(res, rotator, email);
      return;
    }

    if (method === "POST" && pathname.startsWith("/api/restore/")) {
      if (!requireAdmin(req, res)) return;
      const email = decodeURIComponent(pathname.slice("/api/restore/".length));
      void serveRestoreApi(res, rotator, email);
      return;
    }

    if (method === "POST" && pathname.startsWith("/api/remove-account/")) {
      if (!requireAdmin(req, res)) return;
      const email = decodeURIComponent(
        pathname.slice("/api/remove-account/".length),
      );
      void serveRemoveAccountApi(res, rotator, email);
      return;
    }

    if (method === "POST" && pathname.startsWith("/api/set-tier/")) {
      if (!requireAdmin(req, res)) return;
      const rest = pathname.slice("/api/set-tier/".length);
      const lastSlash = rest.lastIndexOf("/");
      if (lastSlash < 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: "Missing tier. Use /api/set-tier/:email/:tier",
          }),
        );
        return;
      }
      const email = decodeURIComponent(rest.slice(0, lastSlash));
      const tier = decodeURIComponent(rest.slice(lastSlash + 1));
      void serveSetTierApi(res, rotator, email, tier);
      return;
    }

    if (method === "POST" && pathname.startsWith("/api/clear-inflight/")) {
      if (!requireAdmin(req, res)) return;
      const rest = pathname.slice("/api/clear-inflight/".length);
      const firstSlash = rest.indexOf("/");
      const email = decodeURIComponent(
        firstSlash >= 0 ? rest.slice(0, firstSlash) : rest,
      );
      const modelKey =
        firstSlash >= 0
          ? decodeURIComponent(rest.slice(firstSlash + 1))
          : undefined;
      serveClearInFlightApi(res, rotator, email, modelKey);
      return;
    }

    if (method === "POST" && pathname.startsWith("/api/clear-breaker/")) {
      if (!requireAdmin(req, res)) return;
      const rest = pathname.slice("/api/clear-breaker/".length);
      const modelKey =
        rest && rest !== "all" ? decodeURIComponent(rest) : undefined;
      void serveClearBreakerApi(res, rotator, modelKey);
      return;
    }

    if (
      method === "POST" &&
      (pathname === "/api/settings/fresh-window-starts/on" ||
        pathname === "/api/settings/fresh-window-starts/off")
    ) {
      if (!requireAdmin(req, res)) return;
      trackFeature("freshWindowToggle");
      void serveFreshWindowStartsApi(res, rotator, pathname.endsWith("/on"));
      return;
    }

    if (
      method === "POST" &&
      pathname.startsWith("/api/account-fresh-window-starts/") &&
      (pathname.endsWith("/on") || pathname.endsWith("/off"))
    ) {
      if (!requireAdmin(req, res)) return;
      const rest = pathname.slice("/api/account-fresh-window-starts/".length);
      const lastSlash = rest.lastIndexOf("/");
      const email = decodeURIComponent(rest.slice(0, lastSlash));
      const enabled = rest.slice(lastSlash + 1) === "on";
      void serveAccountFreshWindowStartsApi(res, rotator, email, enabled);
      return;
    }

    if (method === "POST" && pathname.startsWith("/api/kickstart/")) {
      if (!requireAdmin(req, res)) return;
      const rest = pathname.slice("/api/kickstart/".length);
      const firstSlash = rest.indexOf("/");
      if (firstSlash >= 0) {
        // /api/kickstart/:email/:modelKey
        const email = decodeURIComponent(rest.slice(0, firstSlash));
        const modelKey = decodeURIComponent(rest.slice(firstSlash + 1));
        serveKickstartApi(res, rotator, email, modelKey);
      } else {
        // /api/kickstart/:email — kickstart all fresh timers
        const email = decodeURIComponent(rest);
        serveKickstartApi(res, rotator, email);
      }
      return;
    }

    if (
      method === "POST" &&
      (pathname === "/api/settings/auto-warmup/on" ||
        pathname === "/api/settings/auto-warmup/off")
    ) {
      if (!requireAdmin(req, res)) return;
      void serveAutoWarmupApi(res, rotator, pathname.endsWith("/on"));
      return;
    }

    if (method === "POST" && pathname === "/api/self-update") {
      if (!requireAdmin(req, res)) return;
      trackFeature("selfUpdate");
      try {
        const result = performSelfUpdate();
        res.writeHead(result.ok ? 200 : 500, {
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify(result));
      } catch {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            message: "Self-update failed. Check the server logs and try again.",
          }),
        );
      }
      return;
    }

    // ── Virtual Keys & Spend Logs API routes ──
    if (method === "POST" && pathname === "/api/keys/generate") {
      if (!requireAdmin(req, res)) return;
      void serveGenerateVirtualKeyApi(req, res);
      return;
    }

    if (method === "GET" && pathname === "/api/keys") {
      if (!requireAdmin(req, res)) return;
      void serveListVirtualKeysApi(res);
      return;
    }

    // Admin-only model catalog used by the dashboard's Generate/Edit
    // Virtual Key modal so every active provider's models (Ollama, OpenCode
    // Zen, OpenAI Codex, Google Antigravity) can be selected.
    if (method === "GET" && pathname === "/api/models") {
      if (!requireAdmin(req, res)) return;
      serveModelsApi(res, rotator);
      return;
    }

    if (pathname.startsWith("/api/keys/")) {
      if (!requireAdmin(req, res)) return;
      const hash = decodeURIComponent(pathname.slice("/api/keys/".length));
      if (method === "GET") {
        void serveGetVirtualKeyApi(res, hash);
        return;
      }
      if (method === "PUT") {
        void serveUpdateVirtualKeyApi(req, res, hash);
        return;
      }
      if (method === "DELETE") {
        void serveDeleteVirtualKeyApi(res, hash);
        return;
      }
    }

    if (method === "GET" && pathname === "/api/spend/logs") {
      if (!requireAdmin(req, res)) return;
      void serveGetSpendLogsApi(req, res);
      return;
    }

    if (method === "GET" && pathname === "/api/spend/summary") {
      if (!requireAdmin(req, res)) return;
      void serveGetSpendSummaryApi(req, res);
      return;
    }

    if (method === "GET" && pathname === "/api/spend/by-key") {
      if (!requireAdmin(req, res)) return;
      void serveGetSpendByKeyApi(req, res);
      return;
    }

    // OpenAI-compatible adapter route (additive; does not affect native v1internal route)
    if (method === "GET" && pathname === "/v1/models") {
      serveOpenAIModels(res, rotator);
      return;
    }

    if (method === "GET" && pathname === "/v1beta/models") {
      serveGeminiModels(res);
      return;
    }

    if (method === "POST" && pathname === "/v1/chat/completions") {
      handleOpenAIChatCompletions(req, res, rotator).catch((err) => {
        log(`OpenAI compat error: ${err}`, rotator, "error");
        if (!res.headersSent)
          res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: "Internal OpenAI compat error",
              type: "server_error",
            },
          }),
        );
      });
      return;
    }

    if (method === "POST" && pathname === "/v1/audio/transcriptions") {
      handleOpenAIAudioTranscriptions(req, res).catch((err) => {
        log(`Audio transcription error: ${err}`, rotator, "error");
        if (!res.headersSent)
          res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: "Internal audio transcription error",
              type: "server_error",
            },
          }),
        );
      });
      return;
    }

    if (method === "POST" && pathname === "/v1/responses") {
      handleOpenAIResponsesCreate(req, res, rotator).catch((err) => {
        log(`OpenAI responses compat error: ${err}`, rotator, "error");
        if (!res.headersSent)
          res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: "Internal OpenAI responses compat error",
              type: "server_error",
            },
          }),
        );
      });
      return;
    }

    const responseMatch = pathname.match(
      /^\/v1\/responses\/([^/]+)(?:\/(cancel|input_items))?$/,
    );
    if (responseMatch) {
      const responseId = decodeURIComponent(responseMatch[1]);
      const action = responseMatch[2] || "";
      if (method === "GET" && !action)
        return handleOpenAIResponsesRetrieve(req, res, responseId);
      if (method === "DELETE" && !action)
        return handleOpenAIResponsesDelete(req, res, responseId);
      if (method === "POST" && action === "cancel")
        return handleOpenAIResponsesCancel(req, res, responseId);
      if (method === "GET" && action === "input_items")
        return handleOpenAIResponsesInputItems(req, res, responseId);
    }

    // Anthropic-compatible adapter route (additive; does not affect native v1internal route)
    if (method === "POST" && pathname === "/v1/messages") {
      handleAnthropicMessages(req, res, rotator).catch((err) => {
        log(`Anthropic compat error: ${err}`, rotator, "error");
        if (!res.headersSent)
          res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            type: "error",
            error: {
              type: "server_error",
              message: "Internal Anthropic compat error",
            },
          }),
        );
      });
      return;
    }

    if (method === "POST" && isGeminiGenerateContentPath(pathname)) {
      handleGeminiGenerateContent(req, res, rotator).catch((err) => {
        log(`Gemini compat error: ${err}`, rotator, "error");
        if (!res.headersSent)
          res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: "Internal Gemini compat error",
              status: "INTERNAL",
            },
          }),
        );
      });
      return;
    }

    // Native Ollama chat route (additive; /api/chat payload shape)
    if (method === "POST" && pathname === "/api/chat") {
      handleProxyRequest(req, res, rotator, scheduleSseBroadcast, true).catch(
        (err) => {
          log(`Unhandled error: ${err}`, rotator, "error");
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
          }
          res.end(JSON.stringify({ error: "Internal proxy error" }));
        },
      );
      return;
    }

    // Proxy route (native Antigravity v1internal)
    if (method === "POST" && url.includes("v1internal")) {
      const operation = pathname.split(":").pop() || "";
      if (isCodeAssistAction(operation)) {
        handleCodeAssistPassthrough(req, res, rotator, operation).catch(
          (err) => {
            log(`Unhandled Code Assist passthrough error: ${err}`, rotator, "error");
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "application/json" });
            }
            res.end(JSON.stringify({ error: "Internal Code Assist proxy error" }));
          },
        );
        return;
      }
      if (
        operation !== "streamGenerateContent" &&
        operation !== "generateContent"
      ) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unsupported v1internal operation" }));
        return;
      }
      handleProxyRequest(req, res, rotator, scheduleSseBroadcast).catch(
        (err) => {
          log(`Unhandled error: ${err}`, rotator, "error");
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
          }
          res.end(JSON.stringify({ error: "Internal proxy error" }));
        },
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.on("upgrade", (req, socket) => {
    const url = req.url || "";
    const pathname = url.split("?")[0];
    if (
      pathname === "/ws" ||
      pathname === "/ws/audio" ||
      pathname === "/v1/audio/transcriptions/stream" ||
      pathname === "/v1/listen" ||
      pathname.startsWith("/ws/")
    ) {
      handleAudioWebSocket(req, socket).catch(() => socket.destroy());
      return;
    }
    socket.destroy();
  });

  server.listen(port, bindHost, () => {
    log(`Listening on ${bindHost}:${port}`, rotator);
    log(`Dashboard: http://localhost:${port}/dashboard`, rotator);
    log(`Audio Stream WS: ws://localhost:${port}/ws`, rotator);
    log(`Hosted login: http://localhost:${port}/login`, rotator);
  });
  return server;
}
