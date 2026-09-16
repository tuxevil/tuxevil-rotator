// Provider adapter contract.
//
// Every upstream provider (Google Antigravity, Ollama Cloud, ...) plugs into
// the rotator core through this interface. The core talks to providers ONLY
// through a ProviderAdapter; adding a new provider means implementing this
// interface and registering it in ./registry.ts — nothing in the core needs
// to change.

import type { RequestBody, ForwardedResponse } from "../proxy.js";
import type { AccountRuntime } from "../types.js";
import type { AccountConfig } from "../types.js";

/** Fractional token usage extracted from an upstream stream. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
}

/**
 * Streaming accumulator for a provider's upstream response format
 * (Google: SSE events; Ollama Cloud: NDJSON lines).
 */
export interface StreamAccumulator {
  /** Append a raw chunk; returns usage from any newly completed events. */
  append(chunkText: string): TokenUsage | null;
  /** Accumulated visible text (used for diagnostics / raw error bodies). */
  getText(): string;
  /** Flush any partial event at end-of-stream. */
  final(): TokenUsage | null;
}

/** Callbacks the core hands to provider code when polling quota. */
export interface QuotaFetchContext {
  log(message: string): void;
  markFlagged(
    account: AccountRuntime,
    reason: string,
    options?: { triggerProtectivePause?: boolean },
  ): void;
  reportQuotaPollFlag(
    account: AccountRuntime,
    statusCode: number,
    errorText: string,
  ): void;
  /** Provider-scoped invalidation/cooldown hooks; never affect sibling providers. */
  markProviderInvalid?(
    account: AccountRuntime,
    providerId: string,
    reason: string,
  ): void;
  setProviderCooldown?(
    account: AccountRuntime,
    providerId: string,
    durationMs: number,
  ): void;
}

export type CredentialValidationResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

/** Provider-reported account tier names, ranked best → worst. */
export interface TierRanking {
  [tier: string]: number;
}

export interface ProviderFeatures {
  /** Project/model circuit breakers on repeated 429s (opt-in via config). */
  circuitBreakers: boolean;
  /** Per-account / per-project concurrency caps. */
  concurrencyLimits: boolean;
  /** Calibrated exhaustion prediction + proactive rotation. */
  proactiveRotation: boolean;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly credentialKind: "oauth" | "api-key";
  readonly tierRanking: TierRanking;
  readonly features: ProviderFeatures;

  // --- Credentials / login ---
  /** Interactive CLI flow that returns a ready-to-store AccountConfig. */
  runLogin(): Promise<AccountConfig>;
  /** Validate credentials before persisting an account. */
  validateCredentials(config: AccountConfig): Promise<CredentialValidationResult>;
  /** True when the account has valid, usable credentials right now. */
  hasValidCredentials(account: AccountRuntime): boolean;

  // --- Auth lifecycle ---
  /**
   * Ensure the account has a usable access token (OAuth refresh for Google,
   * no-op for static API keys). Throws on unrecoverable failures.
   */
  ensureValidToken(account: AccountRuntime): Promise<void>;
  /** Auth header value for outgoing upstream requests. */
  getAuthHeader(account: AccountRuntime): string;

  /**
   * Whether a provider's RESOURCE_EXHAUSTED response is scoped to this
   * account and can safely be retried with another credential.
   */
  shouldRetryOnQuotaExhaustion(
    account: AccountRuntime,
    model: string,
    errorText: string,
  ): boolean;

  // --- Quota / usage telemetry ---
  /** Poll current quota/usage and write it into account.quota. */
  fetchQuota(account: AccountRuntime, ctx: QuotaFetchContext): Promise<void>;

  // --- Request forwarding ---
  /** Build + send the upstream request, swapping in provider credentials. */
  forwardRequest(
    account: AccountRuntime,
    body: RequestBody,
    originalHeaders: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<ForwardedResponse>;
  /** Forward one allowlisted non-generation Code Assist operation. */
  forwardCodeAssistRequest?(
    account: AccountRuntime,
    action: string,
    body: unknown,
    originalHeaders: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<ForwardedResponse>;
  /** Accumulator matching this provider's stream format. */
  createStreamAccumulator(): StreamAccumulator;

  /** Provider-native minimal request used to start an idle quota timer. */
  forwardKickstartRequest?(
    account: AccountRuntime,
    model: string,
    signal?: AbortSignal,
  ): Promise<ForwardedResponse>;
  /** Drop provider-local quota cache after a state-changing kickstart. */
  clearQuotaCache?(account: AccountRuntime): void;

  // --- Catalog / helpers ---
  /** Whether a model belongs to this provider. */
  ownsModel?(
    model: string,
    context?: { ollamaModels?: Set<string>; codexModels?: Set<string> },
  ): boolean;
  /** Returns the pool key for a model served by this provider. */
  getPoolKey?(model: string): string;
  /** Cheap upstream model that warms a quota pool during kickstart. */
  getKickstartModelForPool(quotaModelKey: string): string | undefined;
  /** Benchmark request used to measure account latency/health. */
  getBenchmark(account: AccountRuntime): {
    body: RequestBody;
    parseUsage(raw: string): { outputTokens: number } | null;
    parseText(raw: string): string;
  };
}
