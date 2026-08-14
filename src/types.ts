// Account types and configuration

import { rotatorEnv } from "./env.js";
import type { ExhaustionPrediction } from "./providers/ollama/prediction.js";

export type AccountType = "pro" | "free";
export type AccountTier =
  | "ultra"
  | "pro"
  | "plus"
  | "free"
  | "unknown"
  | "max"
  | "team";
export type RoutingPolicy =
  | "timer-first"
  | "tier-first"
  | "quota-first"
  | "hybrid"
  | "sequential-quota"
  | "sticky-quota";

export type RoutingRejectionReason =
  | "disabled"
  | "flagged"
  | "provider-ineligible"
  | "account-concurrency"
  | "project-concurrency"
  | "cooldown"
  | "fresh-window-blocked"
  | "quota-zero"
  | "project-breaker"
  | "model-breaker"
  | "daily-account-stop"
  | "daily-project-stop"
  | "token-bucket-empty";

/**
 * One set of credentials for a single provider, owned by an account.
 * The account (email) is the parent entity; it may hold credentials for
 * multiple providers (e.g. the same human with a Google Antigravity token
 * and an Ollama Cloud API key).
 */
export interface ProviderCredential {
  /** Provider id: "google-antigravity", "ollama", or "openai-codex". */
  provider: string;
  /** Ollama Cloud: static API key (never expires). */
  apiKey?: string;
  /** Google Antigravity: OAuth refresh token. */
  refreshToken?: string;
  /** Google Antigravity: Cloud project id. */
  projectId?: string;
  /** Codex/ChatGPT workspace or account id from the OAuth identity claim. */
  providerAccountId?: string;
  // How the projectId was obtained.
  projectSource?: "google" | "manual";
  /** Optional HTTP(S) or SOCKS5 egress proxy for this provider credential. */
  proxyUrl?: string;
}

export interface AccountConfig {
  email: string;
  /**
   * Per-provider credentials. The account (email) is the parent entity and
   * may hold credentials for several providers.
   *
   * Legacy configs (pre-2.8) used flat fields instead: `provider`,
   * `apiKey` (Ollama) and `refreshToken`/`projectId` (Google). Those shapes
   * are still accepted on read and normalized into `credentials` by
   * normalizeAccountConfig().
   */
  credentials?: ProviderCredential[];
  /**
   * @deprecated legacy flat provider id ("google-antigravity" default).
   * Migrated into `credentials` on read; kept for back-compat.
   */
  provider?: string;
  /** @deprecated legacy Ollama Cloud API key, migrated into credentials. */
  apiKey?: string;
  /** @deprecated legacy Google Antigravity OAuth refresh token. */
  refreshToken?: string;
  /** @deprecated legacy Google Antigravity Cloud project id. */
  projectId?: string;
  /** @deprecated legacy Codex refresh token, migrated into credentials. */
  codexRefreshToken?: string;
  /** @deprecated legacy Codex account id, migrated into credentials. */
  codexAccountId?: string;
  /** @deprecated migrated into credentials. */
  projectSource?: "google" | "manual";
  /** @deprecated use credentials[].proxyUrl for provider-scoped routing. */
  proxyUrl?: string;
  label?: string;
  // Optional - pro/free is detected dynamically from quota API reset times
  type?: AccountType;
  tier?: AccountTier;
  familyManager?: boolean;
}

export interface Config {
  accounts: AccountConfig[];
  requestsPerRotation: number;
  proxyPort: number;
  bindHost?: string;
  routingPolicy?: RoutingPolicy;
  // Rotate when a model's quota drops by this many percentage points (0 = disabled, use request count)
  rotateOnQuotaDrop: number;
  // How often to poll quota (ms). Default: 5min
  quotaPollIntervalMs: number;
  // Hard cap on parallel requests per account. Conservative default is 1.
  maxConcurrentRequestsPerAccount?: number;
  // Hard cap on parallel requests per projectId/model. Conservative default is 1.
  maxConcurrentRequestsPerProjectModel?: number;
  // Global delay in ms added to every request to slow down traffic and avoid rate limits.
  globalRequestDelayMs?: number;
  // Pause projectId/model when several accounts hit provider 429 in a short window. Defaults: 3 hits / 10min / 60min pause.
  projectCircuitBreaker429Threshold?: number;
  projectCircuitBreakerWindowMs?: number;
  projectCircuitBreakerCooldownMs?: number;
  // Pause a model globally when several unique accounts hit provider 429 in a short window. Defaults: 3 hits / same window / 6h pause.
  modelCircuitBreaker429Threshold?: number;
  modelCircuitBreakerCooldownMs?: number;
  // Daily safety budgets. Defaults: account slow 250, account stop 350, project slow 900, project stop 1200.
  dailyAccountSlowRequests?: number;
  dailyAccountStopRequests?: number;
  dailyProjectSlowRequests?: number;
  dailyProjectStopRequests?: number;
  // Add small delay before upstream call when an account/project is in slow mode. Default: 8-25s.
  slowModeJitterMinMs?: number;
  slowModeJitterMaxMs?: number;
  // Pause all routing after a serious provider flag. Default: 6h.
  protectivePauseMs?: number;
  // Use request-count rotation only before quota data is available. Default: true.
  useRequestCountRotationWhenQuotaUnknownOnly?: boolean;
  tokenBucketEnabled?: boolean;
  tokenBucketMaxTokens?: number;
  tokenBucketRefillPerMinute?: number;
  tokenBucketInitialTokens?: number;
  // Deduplicate in-flight / short-window identical requests to prevent duplicate upstream calls.
  idempotencyEnabled?: boolean;
  idempotencyWindowMs?: number;
  // Retry upstream failures before any response bytes reach the client. Default: 2.
  streamRecoveryMaxRetries?: number;
  // Prompt compression mode ("off" | "lite" | "rtk" | "rtk+lite").
  compressionMode?: "off" | "lite" | "rtk" | "rtk+lite";
  // Override per-model specs used by the compat layer. Keys are model id substrings
  // matched case-insensitively. When set, replaces the bundled defaults entirely.
  modelSpecs?: Record<string, ModelSpecConfig>;
  // Override model-id aliases used to translate the operator-facing name
  // (e.g. "gemini-3.5-flash-high") to the upstream Antigravity name
  // (e.g. "gemini-3-flash-agent"). When set, replaces the bundled defaults.
  modelAliases?: Record<string, string>;
}

export const DEFAULT_QUOTA_POLL_INTERVAL_MS = 300_000;
export const MIN_QUOTA_POLL_INTERVAL_MS = 60_000;
export const MAX_QUOTA_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;

// ── Default model-id aliases ─────────────────────────────────────────
// Translates operator-facing model names to Antigravity upstream names.
// When the provider adds a new model, this is the only place that needs
// updating. Operators can override via Config.modelAliases in accounts.json.
const DEFAULT_MODEL_ALIASES: Record<string, string> = {
  "gemini-3.1-pro-high": "gemini-pro-agent",
  "gemini-3.5-flash": "gemini-3-flash-agent",
  "gemini-3.5-flash-high": "gemini-3-flash-agent",
  "gemini-3.5-flash-medium": "gemini-3-flash-agent",
  "gpt-oss-120b": "gpt-oss-120b-medium",
};
let modelAliasesOverride: Record<string, string> | null = null;

/**
 * Replace the bundled model-alias table with operator-provided overrides.
 * Pass `null` to restore the defaults. Called once at startup from
 * index.ts via `setModelAliasesOverride(config.modelAliases ?? null)`.
 *
 * @param aliases Map of operator-facing model name to upstream model name,
 *                or null to restore defaults.
 */
export function setModelAliasesOverride(
  aliases: Record<string, string> | null,
): void {
  modelAliasesOverride =
    aliases && Object.keys(aliases).length > 0 ? aliases : null;
}

function getActiveModelAliases(): Record<string, string> {
  return modelAliasesOverride ?? DEFAULT_MODEL_ALIASES;
}

/**
 * Translate a model name to its upstream equivalent. Exact-match lookup
 * (case-insensitive). Returns the original model if no alias is configured.
 */
export function applyModelAlias(model: string): string {
  const aliases = getActiveModelAliases();
  if (model in aliases) return aliases[model];
  const lower = model.toLowerCase();
  for (const [from, to] of Object.entries(aliases)) {
    if (from.toLowerCase() === lower) return to;
  }
  return model;
}

// Quota API response from Google
export interface GoogleQuotaResponse {
  models: Record<
    string,
    {
      quotaInfo?: {
        remainingFraction?: number;
        resetTime?: string;
      };
    }
  >;
}

// Per-model thinking/output spec used by the compat layer.
// Operators can override defaults via the `modelSpecs` field in accounts.json.
export interface ModelSpecConfig {
  maxOutputTokens: number;
  thinkingBudget: number; // -1 = adaptive (model decides), >=0 = fixed
  isThinking: boolean;
}

// Per-model quota info for an account
export interface ModelQuota {
  modelKey: string;
  displayName: string;
  /** Owner of this quota pool when the account has several providers. */
  providerId?: string;
  percentRemaining: number;
  /** Raw usage fraction (0..1) when the provider reports one (Ollama). */
  usageRaw?: number;
  resetTime: string | null;
  // Timer classification based on resetTime duration
  // "fresh" = no active timer, "5h" = short timer, "7d" = long timer
  timerType: "fresh" | "5h" | "7d";
}

// Model key mapping for the quota API. One entry per family: all Claude
// variants (and gpt-oss) share one bucket, all Gemini variants share one.
export const QUOTA_MODEL_KEYS: Record<
  string,
  { key: string; altKeys: string[]; display: string }
> = {
  claude: {
    key: "claude",
    altKeys: [
      "claude-opus-4-6-thinking",
      "claude-opus-4-5-thinking",
      "claude-opus-4-5",
      "claude-sonnet-4-6-thinking",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5-thinking",
      "claude-sonnet-4-5",
      "gpt-oss-120b-medium",
      "gpt-oss-120b",
    ],
    display: "Claude",
  },
  gemini: {
    key: "gemini",
    altKeys: [
      "gemini-3.1-pro",
      "gemini-3.1-pro-low",
      "gemini-3.1-pro-high",
      "gemini-3-pro-high",
      "gemini-3-pro-low",
      "gemini-3.5-flash",
      "gemini-3.5-flash-low",
      "gemini-3.5-flash-medium",
      "gemini-3.5-flash-high",
      "gemini-3-flash-agent",
      "gemini-3-flash",
      "gemini-3.6-flash",
      "gemini-3.6-flash-high",
      "gemini-3.6-flash-medium",
      "gemini-3.6-flash-low",
      "gemini-3.6-flash-tiered",
      "gemini-3.7-flash-tiered",
    ],
    display: "Gemini",
  },
};

// Map request model names to quota model keys (family buckets).
export function resolveQuotaModelKey(requestModel: string): string | null {
  const lower = requestModel.toLowerCase();
  if (
    lower === "deepseek-v4-flash-free" ||
    lower === "nemotron-3.5-lightning-free" ||
    lower === "nemotron-3-ultra-free" ||
    lower === "mimo-v2.5-free" ||
    lower === "hy3-free" ||
    lower.endsWith("-free")
  ) {
    return "opencode-zen";
  }
  // Claude family: every Claude variant and gpt-oss share one bucket.
  if (
    lower.includes("claude") ||
    lower.includes("gpt-oss")
  ) {
    return "claude";
  }
  // Gemini family: every Gemini variant shares one bucket.
  if (lower.includes("gemini")) {
    return "gemini";
  }
  return null;
}

/**
 * Resolves the precise model name for metrics/savings/latency/logs.
 * Unlike resolveQuotaModelKey, this preserves the distinction between:
 * - gemini-3.1-pro-low vs gemini-3.1-pro-high (same quota pool, different display)
 * - claude-sonnet-4-6 vs claude-opus-4-6-thinking (different pricing)
 */
export function resolveDisplayModelKey(requestModel: string): string {
  const lower = requestModel.toLowerCase();
  // Explicit agent and gpt-oss overrides
  if (lower.includes("gemini-3-flash-agent")) return "gemini-3.5-flash-high";
  if (lower.includes("gpt-oss-120b")) return "gpt-oss-120b-medium";

  // Claude — distinguish sonnet vs opus
  if (lower.includes("claude")) {
    if (lower.includes("sonnet")) return "claude-sonnet-4-6";
    if (lower.includes("opus")) return "claude-opus-4-6-thinking";
    return "claude-opus-4-6-thinking"; // fallback
  }
  // Gemini Pro — distinguish low vs high
  if (lower.includes("gemini") && lower.includes("pro")) {
    if (lower.includes("-low")) return "gemini-3.1-pro-low";
    if (lower.includes("-high")) return "gemini-3.1-pro-high";
    return "gemini-3.1-pro"; // unspecified variant
  }
  // Gemini 3.6 Flash — distinguish variants
  if (
    lower.includes("gemini") &&
    lower.includes("3.6") &&
    lower.includes("flash")
  ) {
    if (lower.includes("-low")) return "gemini-3.6-flash-low";
    if (lower.includes("-medium")) return "gemini-3.6-flash-medium";
    if (lower.includes("-tiered")) return "gemini-3.6-flash-tiered";
    if (lower.includes("-high")) return "gemini-3.6-flash-high";
    return "gemini-3.6-flash-high"; // unspecified variant
  }
  // Gemini 3.7 Flash — only the tiered variant exists. Unsupported
  // virtual variants (low/medium/high) intentionally fall through to the
  // generic Flash fallback below instead of resolving as supported models.
  if (
    lower.includes("gemini") &&
    lower.includes("3.7") &&
    lower.includes("flash") &&
    lower.includes("-tiered")
  ) {
    return "gemini-3.7-flash-tiered";
  }
  // Gemini 3.5 Flash — distinguish medium vs high
  if (
    lower.includes("gemini") &&
    lower.includes("3.5") &&
    lower.includes("flash")
  ) {
    if (lower.includes("-low") || lower.includes("-medium"))
      return "gemini-3.5-flash-medium";
    if (lower.includes("-high")) return "gemini-3.5-flash-high";
    return "gemini-3.5-flash"; // unspecified variant
  }
  // Flash
  if (lower.includes("gemini") && lower.includes("flash"))
    return "gemini-3-flash";
  // Fallback: return as-is cleaned up
  return requestModel;
}

// Runtime state for a single account
export interface AccountRuntime {
  config: AccountConfig;
  accessToken: string | null;
  tokenExpires: number;
  /** Provider-scoped access tokens. Legacy Google/Ollama state still uses the fields above. */
  providerTokens?: Record<
    string,
    { accessToken: string | null; tokenExpires: number }
  >;
  /** Provider-local auth failures/cooldowns; Google/Ollama remain routable. */
  invalidProviders?: Record<string, string>;
  providerCooldowns?: Record<string, number>;
  // Rotation tracking (per-model via rotator)
  requestsSinceRotation: number;
  totalRequests: number;
  // Cooldown / exhaustion per-model
  cooldownsByModel: Record<string, number>;
  quotaExhaustedAt: number;
  // Quota tracking (from API) - per-model data
  quota: ModelQuota[];
  lastQuotaPoll: number;
  // Per-provider RAW POLL strings, accumulated by each adapter during a
  // quota cycle. The rotator emits one consolidated log per account/cycle
  // and resets the map.
  lastPollByProvider?: Record<string, string>;
  // Status
  lastUsed: number;
  lastError: string | null;
  consecutiveErrors: number;
  disabled: boolean; // permanently disabled (revoked token, etc.)
  flagged: boolean; // flagged for infringement/abuse by Google
  inFlightRequests: number;
  inFlightByModel: Record<string, number>;
  allowFreshWindowStartsOverride: boolean;
  dailyRequestCount: number;
  dailyRequestDay: string;
  healthScore: number;
  tokenBucket: {
    tokens: number;
    lastRefillAt: number;
  };
}

// Per-model rotation state tracked by the rotator
export interface ModelRotationState {
  activeAccountIndex: number;
  /** Preferred account for quota-aware policies while a temporary fallback is active. */
  stickyAccountIndex?: number;
  quotaAtRotationStart: number; // quota % when this account became active for this model
  requestsOnActiveAccount: number;
}

export interface PersistedSafetyState {
  day: string;
  projectRequests: Record<string, number>;
  projectModelBreakers: Record<string, number>;
  modelBreakers?: Record<string, number>;
  provider429Events: Array<{
    ts: number;
    projectId: string;
    modelKey: string;
    account: string;
  }>;
}

export interface PersistedState {
  // Per-model active account index
  modelAccounts: Record<string, number>;
  // Per-model request count on the active account
  modelRequestCounts?: Record<string, number>;
  // Per-model preferred account for quota-aware sticky/sequential fallback
  modelStickyAccounts?: Record<string, number>;
  // Legacy fallback
  currentIndex?: number;
  protectivePauseUntil?: number;
  protectivePauseReason?: string | null;
  allowFreshWindowStarts?: boolean;
  autoWarmupEnabled?: boolean;
  safety?: PersistedSafetyState;
  accounts: Record<
    string,
    {
      totalRequests: number;
      dailyRequestCount?: number;
      dailyRequestDay?: string;
      cooldownUntil?: number; // legacy fallback
      cooldownsByModel?: Record<string, number>;
      quotaExhaustedAt: number;
      disabled: boolean;
      flagged: boolean;
      allowFreshWindowStartsOverride?: boolean;
    }
  >;
}

// Version check info for dashboard
export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  checkedAt: number;
}

// Admin broadcast notification
export interface AdminNotification {
  id: string;
  type: "info" | "warning" | "critical";
  title: string;
  message: string;
  createdAt: string;
  actionUrl?: string | null;
  actionLabel?: string | null;
}

// Dashboard API response
export interface StatusResponse {
  version: string;
  proxyPort: number;
  requestsPerRotation: number;
  totalRequestsAllAccounts: number;
  uptime: number;
  // Per-model active account
  activeAccounts: Record<string, string>;
  accounts: AccountStatus[];
  protectivePauseUntil: number;
  protectivePauseRemaining: number;
  protectivePauseReason: string | null;
  operatorControls: {
    allowFreshWindowStarts: boolean;
    autoWarmupEnabled: boolean;
  };
  security: {
    adminTokenConfigured: boolean;
    warning: string | null;
    bindHost: string;
  };
  routingDiagnostics: Record<string, RoutingModelDiagnostics>;
  ollamaModels: string[];
  codexModels?: string[];
  // Present only when at least one account carries an ollama credential.
  modelTierAccess?: Record<string, ModelTierAccess>;
  predictions: Record<string, ExhaustionPrediction>;
  circuitBreakers: {
    model: Record<string, { until: number; remainingMs: number }>;
    project: Record<string, { until: number; remainingMs: number }>;
  };
  routingHealth: {
    state: "healthy" | "paused" | "cooldown_wait" | "busy" | "stopped";
    reason: string;
    nextRetryIn: number;
    availableCount: number;
    readyCount: number;
    activeCount: number;
    cooldownCount: number;
    busyCount: number;
    flaggedCount: number;
    disabledCount: number;
    errorCount: number;
  };
  recentEvents: RecentEvent[];
  requestLog: RequestLogEntry[];
  tokenUsage: TokenUsageData;
  latencyStats: Record<
    string,
    {
      ttfb: { p50: number; p95: number };
      total: { p50: number; p95: number };
      count: number;
    }
  >;
  updateInfo?: UpdateInfo;
  notifications?: AdminNotification[];
  hostedOAuthConfigured?: boolean;
}

export interface AccountStatus {
  email: string;
  label: string;
  /** Provider id, e.g. "google-antigravity" | "ollama". */
  provider: string;
  status:
    | "active"
    | "ready"
    | "cooldown"
    | "exhausted"
    | "disabled"
    | "flagged"
    | "error";
  // Which models this account is currently active for
  activeForModels: string[];
  requestsSinceRotation: number;
  totalRequests: number;
  dailyRequestCount: number;
  dailyAccountStopRequests: number;
  dailyProjectRequestCount: number;
  dailyProjectStopRequests: number;
  cooldownsByModel: Record<string, number>;
  lastUsed: number;
  lastError: string | null;
  consecutiveErrors: number;
  hasValidToken: boolean;
  /** Provider-scoped authentication failures; sibling providers may remain usable. */
  invalidProviders?: Record<string, string>;
  /** Provider-scoped cooldown deadlines, kept separate from account breakers. */
  providerCooldowns?: Record<string, number>;
  quota: ModelQuota[];
  inFlightRequests: number;
  inFlightByModel: Record<string, number>;
  // Pro family sharing
  proDetected: boolean;
  tier: AccountTier;
  healthScore: number;
  tokenBucket: {
    enabled: boolean;
    tokens: number;
    capacity: number;
    nextRefillInMs: number;
  };
  allowFreshWindowStartsOverride: boolean;
  effectiveFreshWindowStartsAllowed: boolean;
}

export interface HealthScoreBreakdown {
  quotaComponent: number;
  errorPenalty: number;
  cooldownPenalty: number;
  availabilityPenalty: number;
  score: number;
}

export interface RoutingAccountDiagnostic {
  email: string;
  label: string;
  status: AccountStatus["status"];
  score: number | null;
  timerPriority: number | null;
  quota: number | null;
  tier: AccountTier;
  healthScore: number;
  healthBreakdown: HealthScoreBreakdown;
  distance: number | null;
  tokenBucket: {
    enabled: boolean;
    tokens: number;
    capacity: number;
    nextRefillInMs: number;
  };
  rejectedReason: RoutingRejectionReason | null;
  rejectedDetail: string | null;
}

export interface RoutingModelDiagnostics {
  modelKey: string;
  policy: RoutingPolicy;
  selectedEmail: string | null;
  reason: string;
  availableCandidates: number;
  rejectedCandidates: number;
  accounts: RoutingAccountDiagnostic[];
}

export interface RecentEvent {
  timestamp: number;
  source: "rotator" | "proxy";
  level: "info" | "warn" | "error";
  message: string;
}

export interface RequestLogEntry {
  timestamp: number;
  model: string;
  account: string;
  statusCode: number;
  ttfbMs: number;
  totalMs: number;
  inputTokens: number;
  outputTokens: number;
}

// Token usage tracking — tiered time-series
export interface TokenBucket {
  period: string; // key: "2026-04-28T12:05" (min), "2026-04-28T12" (hour), "2026-04-28" (day), "2026-04" (month)
  inputTokens: number;
  outputTokens: number;
  requests: number;
  byModel: Record<
    string,
    { inputTokens: number; outputTokens: number; requests: number }
  >;
}

export interface TokenUsageTiered {
  minutes: TokenBucket[]; // current hour, max 60
  hours: TokenBucket[]; // last 7 days, max 168
  days: TokenBucket[]; // last year, max 365
  months: TokenBucket[]; // historical, unlimited
}

export interface TokenUsageData {
  minutes: TokenBucket[];
  hours: TokenBucket[];
  days: TokenBucket[];
  months: TokenBucket[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalRequests: number;
  tokensByModel: Record<
    string,
    { input: number; output: number; requests: number }
  >;
  savings: {
    totalUsd: number;
    byModel: Record<
      string,
      { inputUsd: number; outputUsd: number; totalUsd: number }
    >;
  };
}

// Pricing per 1M tokens (USD) — what these would cost on paid APIs
export const MODEL_PRICING: Record<
  string,
  {
    inputPer1M: number;
    outputPer1M: number;
    cachingPer1M?: number;
    cachingStoragePer1MPerHour?: number;
  }
> = {
  "claude-opus-4-6-thinking": { inputPer1M: 5.0, outputPer1M: 25.0 },
  "claude-sonnet-4-6": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "gemini-3.1-pro": { inputPer1M: 2.0, outputPer1M: 12.0 },
  "gemini-3.1-pro-low": { inputPer1M: 2.0, outputPer1M: 12.0 },
  "gemini-3.1-pro-high": { inputPer1M: 2.0, outputPer1M: 12.0 },
  "gemini-3-flash": { inputPer1M: 0.5, outputPer1M: 3.0 },
  "gemini-3.5-flash": {
    inputPer1M: 1.5,
    outputPer1M: 9.0,
    cachingPer1M: 0.15,
    cachingStoragePer1MPerHour: 1.0,
  },
  "gemini-3.5-flash-low": {
    inputPer1M: 1.5,
    outputPer1M: 9.0,
    cachingPer1M: 0.15,
    cachingStoragePer1MPerHour: 1.0,
  },
  "gemini-3.5-flash-medium": {
    inputPer1M: 1.5,
    outputPer1M: 9.0,
    cachingPer1M: 0.15,
    cachingStoragePer1MPerHour: 1.0,
  },
  "gemini-3.5-flash-high": {
    inputPer1M: 1.5,
    outputPer1M: 9.0,
    cachingPer1M: 0.15,
    cachingStoragePer1MPerHour: 1.0,
  },
  "gemini-3.6-flash": {
    inputPer1M: 1.5,
    outputPer1M: 7.5,
    cachingPer1M: 0.15,
    cachingStoragePer1MPerHour: 1.0,
  },
  "gemini-3.6-flash-high": {
    inputPer1M: 1.5,
    outputPer1M: 7.5,
    cachingPer1M: 0.15,
    cachingStoragePer1MPerHour: 1.0,
  },
  "gemini-3.6-flash-medium": {
    inputPer1M: 1.5,
    outputPer1M: 7.5,
    cachingPer1M: 0.15,
    cachingStoragePer1MPerHour: 1.0,
  },
  "gemini-3.6-flash-low": {
    inputPer1M: 1.5,
    outputPer1M: 7.5,
    cachingPer1M: 0.15,
    cachingStoragePer1MPerHour: 1.0,
  },
  "gemini-3.6-flash-tiered": {
    inputPer1M: 1.5,
    outputPer1M: 7.5,
    cachingPer1M: 0.15,
    cachingStoragePer1MPerHour: 1.0,
  },
  // Gemini 3.7 Flash tiered — public Gemini API equivalent-value pricing,
  // verified on the official Gemini API / Google Cloud pricing pages
  // 2026-08-13. Introductory rates through 2026-12-31. From 2027-01-01
  // these double to: input 1.50, output 7.50, cached input 0.15, cache
  // storage 1.00 (USD per 1M tokens / per 1M tokens/hour) — update this
  // static entry when the introductory period ends.
  "gemini-3.7-flash-tiered": {
    inputPer1M: 0.75,
    outputPer1M: 3.75,
    cachingPer1M: 0.075,
    cachingStoragePer1MPerHour: 0.5,
  },
  "gpt-oss-120b-medium": { inputPer1M: 2.0, outputPer1M: 10.0 },

  // OpenAI Codex GPT-5.6 models — official OpenAI API pricing checked
  // 2026-08-11. Token usage currently records aggregate input/output tokens;
  // cache rates are retained for spend metadata but are not applied separately.
  "gpt-5.6-sol": {
    inputPer1M: 5.0,
    outputPer1M: 30.0,
    cachingPer1M: 0.50,
  },
  "gpt-5.6-terra": {
    inputPer1M: 2.0,
    outputPer1M: 12.0,
    cachingPer1M: 0.20,
  },
  "gpt-5.6-luna": {
    inputPer1M: 0.20,
    outputPer1M: 1.20,
    cachingPer1M: 0.02,
  },

  // Ollama Cloud model pricing (USD per 1M tokens). Sourced from the
  // ~/ollama-rotator project (verified 2026-08-09).
  "gpt-oss:20b":                 { inputPer1M: 0.075,  outputPer1M: 0.30 },
  "gpt-oss:120b":                { inputPer1M: 0.15,   outputPer1M: 0.60 },
  "deepseek-v4-flash:preview":   { inputPer1M: 0.14,   outputPer1M: 0.28,  cachingPer1M: 0.0028 },
  "deepseek-v4-flash:0731":      { inputPer1M: 0.14,   outputPer1M: 0.28,  cachingPer1M: 0.0028 },
  "deepseek-v4-pro":             { inputPer1M: 0.435,  outputPer1M: 0.87,  cachingPer1M: 0.0036 },
  "qwen3.5:397b":                { inputPer1M: 0.60,   outputPer1M: 3.60 },
  "glm-5.1":                     { inputPer1M: 0.80,   outputPer1M: 2.56 },
  "glm-5.2":                     { inputPer1M: 0.80,   outputPer1M: 2.56 },
  "gemma4:31b":                  { inputPer1M: 0.38,   outputPer1M: 1.15 },
  "kimi-k2.6":                   { inputPer1M: 0.95,   outputPer1M: 4.00 },
  "kimi-k2.7-code":              { inputPer1M: 0.95,   outputPer1M: 4.00 },
  "kimi-k3":                     { inputPer1M: 0.95,   outputPer1M: 4.00 },
  "minimax-m2.7":                { inputPer1M: 0.30,   outputPer1M: 1.20 },
  "minimax-m3":                  { inputPer1M: 0.30,   outputPer1M: 1.20 },
  "mistral-large-3:675b":        { inputPer1M: 0.50,   outputPer1M: 1.50 },
  "nemotron-3-nano:30b":         { inputPer1M: 0.50,   outputPer1M: 1.50 },
  "nemotron-3-super":            { inputPer1M: 0.60,   outputPer1M: 1.80 },
  "nemotron-3-ultra":            { inputPer1M: 0.60,   outputPer1M: 1.80 },

  // OpenCode Zen free models — equivalent market rates (USD per 1M tokens) for savings tracking
  "deepseek-v4-flash-free":      { inputPer1M: 0.14,   outputPer1M: 0.28,  cachingPer1M: 0.0028 },
  "nemotron-3.5-lightning-free": { inputPer1M: 0.35,   outputPer1M: 1.05 },
  "nemotron-3-ultra-free":       { inputPer1M: 0.60,   outputPer1M: 1.80 },
  "mimo-v2.5-free":              { inputPer1M: 0.15,   outputPer1M: 0.60 },
  "hy3-free":                    { inputPer1M: 0.25,   outputPer1M: 1.00 },

};

// Which Ollama Cloud models respond on which subscription tiers, verified
// 2026-08-09 with minimal /api/chat probes against free-tier accounts
// (HTTP 200 vs 403). "free" = served on the free tier; "subscription" =
// the API returns "this model requires a subscription" until the account
// is upgraded. Sourced from ~/ollama-rotator.
export type ModelTierAccess = "free" | "subscription";
export const MODEL_TIER_ACCESS: Record<string, ModelTierAccess> = {
  "gpt-oss:20b":                  "free",
  "gpt-oss:120b":                 "free",
  "gemma4:31b":                   "free",
  "minimax-m3":                   "free",
  "nemotron-3-nano:30b":          "free",
  "nemotron-3-super":             "free",
  "nemotron-3-ultra":             "free",
  "deepseek-v4-flash:0731":       "subscription",
  "deepseek-v4-flash:preview":    "subscription",
  "deepseek-v4-pro":              "subscription",
  "glm-5.1":                      "subscription",
  "glm-5.2":                      "subscription",
  "kimi-k2.6":                    "subscription",
  "kimi-k2.7-code":               "subscription",
  "kimi-k3":                      "subscription",
  "minimax-m2.7":                 "subscription",
  "mistral-large-3:675b":         "subscription",
  "qwen3.5:397b":                 "subscription",
};

export const TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * Legacy compatibility client used by existing installations.
 *
 * Operator-provided ANTIGRAVITY_CLIENT_ID and ANTIGRAVITY_CLIENT_SECRET
 * take precedence in src/oauth.ts. Keep this fallback only so upgrades do
 * not break existing account refresh and login flows.
 */
export const CLIENT_ID = atob(
  "MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
);
export const CLIENT_SECRET = atob(
  "R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=",
);

// Production default: use the daily Cloud Code Assist endpoint. The proxy
// forwarder supports cascading if additional verified endpoints are added here.
export const ANTIGRAVITY_ENDPOINTS = [
  "https://daily-cloudcode-pa.googleapis.com",
] as const;

// Maps each quota pool key (Google quota API) to the cheapest upstream model
// used for kickstart warmup requests. Gemini 3.6/3.5 Flash and Gemini 3.1 Pro
// share the same upstream pool, so all map to gemini-3-flash.
export const KICKSTART_MODEL_FOR_QUOTA_POOL: Record<string, string> = {
  "claude-opus-4-6-thinking": "gpt-oss-120b-medium",
  "gemini-3.5-flash": "gemini-3-flash",
  "gemini-3.6-flash": "gemini-3-flash",
  "gemini-3.1-pro": "gemini-3-flash",
};

export const QUOTA_API_URL =
  "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";

// ── Ollama Cloud endpoints ──────────────────────────────────────────
export const OLLAMA_API_BASE = "https://ollama.com/api";
export const OLLAMA_OPENAI_BASE = "https://ollama.com/v1";
export const OLLAMA_USAGE_URL = "https://ollama.com/api/usage";
export const OLLAMA_TAGS_URL = "https://ollama.com/api/tags";
// Mutable so tests can redirect to a local stub (same pattern as ANTIGRAVITY_ENDPOINTS).
export const OLLAMA_CHAT_ENDPOINTS = ["https://ollama.com/api/chat"];
export const OLLAMA_CHAT_URL = OLLAMA_CHAT_ENDPOINTS[0];

// User-Agent sent to ollama.com (defaults are spoofed per docs examples).
export const OLLAMA_USER_AGENT =
  process.env.TUXEVIL_ROTATOR_OLLAMA_USER_AGENT ||
  process.env.OLLAMA_ROTATOR_USER_AGENT ||
  "ollama-rotator/1.0";

// TTL for the cached /api/tags listing (model catalog refresh).
export const TAGS_CACHE_TTL_MS = 5 * 60 * 1000;
export const ANTIGRAVITY_VERSION =
	rotatorEnv("ANTIGRAVITY_VERSION") ||
	process.env.PI_AI_ANTIGRAVITY_VERSION ||
	"1.107.0";
export const QUOTA_USER_AGENT =
	rotatorEnv("QUOTA_USER_AGENT") ||
	`antigravity/${ANTIGRAVITY_VERSION} darwin/arm64`;
export const REQUEST_USER_AGENT =
  rotatorEnv("REQUEST_USER_AGENT") || QUOTA_USER_AGENT;
export const REQUEST_GOOG_API_CLIENT =
  rotatorEnv("X_GOOG_API_CLIENT") ||
  "google-cloud-sdk vscode_cloudshelleditor/0.1";
export const REQUEST_CLIENT_METADATA =
  rotatorEnv("CLIENT_METADATA") ||
  JSON.stringify({
    ideType: "ANTIGRAVITY",
    platform: "MACOS",
    pluginType: "GEMINI",
  });

// ── Virtual Keys & Spend Logging ─────────────────────────────────────

export interface VirtualKey {
  tokenHash: string;
  keyName: string;
  keyAlias: string;
  userId?: string | null;
  models?: string[];
  metadata?: Record<string, unknown>;
  blocked: boolean;
  lastActive?: string | null;
  createdAt: string;
  createdBy?: string | null;
}

export interface SpendLog {
  requestId: string;
  apiKeyHash?: string | null;
  keyAlias?: string | null;
  keyName?: string | null;
  model: string;
  accountEmail?: string | null;
  callType: string;
  status: "success" | "failure";
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost?: number;
  startTime: string;
  endTime: string;
  ttfbMs?: number | null;
  durationMs: number;
  requestMessages?: unknown;
  responseContent?: unknown;
  metadata?: Record<string, unknown>;
  requesterIp?: string | null;
  createdAt?: string;
}

export interface DailySpend {
  apiKeyHash?: string | null;
  model: string;
  date: string;
  promptTokens: number;
  completionTokens: number;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  totalDurationMs: number;
}
