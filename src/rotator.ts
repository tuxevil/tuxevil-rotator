// Account rotation and token management with per-model routing

import {
  type AccountConfig,
  type AccountRuntime,
  type AccountStatus,
  type AccountTier,
  type Config,
  type HealthScoreBreakdown,
  type ModelQuota,
  type ModelRotationState,
  type PersistedState,
  type RoutingAccountDiagnostic,
  type RoutingModelDiagnostics,
  type RoutingRejectionReason,
  type StatusResponse,
  type TokenBucket,
  type TokenUsageData,
  type TokenUsageTiered,
  MODEL_PRICING,
  MODEL_TIER_ACCESS,
  QUOTA_USER_AGENT,
  REQUEST_GOOG_API_CLIENT,
  REQUEST_CLIENT_METADATA,
  ANTIGRAVITY_ENDPOINTS,
  OLLAMA_TAGS_URL,
  OLLAMA_USER_AGENT,
  TAGS_CACHE_TTL_MS,
  DEFAULT_QUOTA_POLL_INTERVAL_MS,
  MAX_QUOTA_POLL_INTERVAL_MS,
  MIN_QUOTA_POLL_INTERVAL_MS,
  resolveQuotaModelKey,
  resolveDisplayModelKey,
} from "./types.js";
import {
  reportFlagEvent,
  FLAG_PATTERNS,
  type FlagEventData,
} from "./telemetry.js";
import {
  applyConfigDefaults,
  saveAccountsConfig,
  removeAccountFromConfig,
} from "./account-store.js";
import { isHostedOAuthConfigured } from "./providers/google-antigravity/oauth.js";
import type { RequestBody } from "./proxy.js";
import { UsagePredictor, type ExhaustionPrediction } from "./providers/ollama/prediction.js";
import { fetchWithRetry } from "./fetch-with-retry.js";
import type { RequestInitWithDispatcher } from "./fetch-with-retry.js";
import { getOllamaApiKey } from "./providers/ollama/credentials.js";
import {
  DEFAULT_PROVIDER,
  getProviderAdapter,
  getProviderForAccount,
  hasCredential,
  primaryProviderId,
  findProviderForModel,
  getProviderIdForPoolKey,
  PROVIDER_ORDER,
} from "./providers/registry.js";
import type { QuotaFetchContext } from "./providers/adapter.js";
import { logger } from "./logger.js";
import { getAccountProxyDispatcher } from "./providers/proxy-dispatcher.js";
import {
  fetchCodexCatalog,
  getCodexModels,
  isCodexRequestModel,
  isCodexProviderModelId,
} from "./providers/openai-codex/catalog.js";
import { CodexOAuthError } from "./providers/openai-codex/oauth.js";
import { CODEX_QUOTA_MODEL_KEY } from "./providers/openai-codex/quota.js";
import { OPENCODE_ZEN_PROVIDER_ID } from "./providers/opencode-zen/credentials.js";
import { getUpdateInfo } from "./version-check.js";
import { getNotifications } from "./notification-poller.js";
import { getConfiguredAdminToken } from "./admin-auth.js";
import { getProxyExposureWarning } from "./exposure.js";
import {
  getCachedState,
  setCachedState,
  getCachedTokenUsage,
  setCachedTokenUsage,
} from "./db-store.js";

const rotatorLogger = logger.child("rotator");

function currentUtcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function nextUtcDayStartMs(now = Date.now()): number {
  const date = new Date(now);
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 1,
  );
}

function projectModelKey(projectId: string, modelKey: string): string {
  return `${projectId}::${modelKey}`;
}

// Reverse map: upstream model → the quota pool key it primarily represents (for deduplication).
const QUOTA_POOL_FOR_KICKSTART_MODEL: Record<string, string> = {
  "gpt-oss-120b-medium": "claude-opus-4-6-thinking",
  "gemini-3-flash": "gemini-3.5-flash",
};

export class AccountRotator {
  private accounts: AccountRuntime[] = [];
  // Per-model active account tracking
  private modelState = new Map<string, ModelRotationState>();
  // Fallback for requests where model can't be resolved
  private defaultIndex = 0;
  private startTime = Date.now();
  private quotaPollTimer: ReturnType<typeof setInterval> | null = null;
  private protectivePauseUntil = 0;
  private protectivePauseReason: string | null = null;
  private allowFreshWindowStarts = true;
  private recentEvents: StatusResponse["recentEvents"] = [];
  private static readonly RECENT_EVENT_LIMIT = 40;
  private tokenBuckets: TokenUsageTiered = {
    minutes: [],
    hours: [],
    days: [],
    months: [],
  };
  private latencyRecords: Map<string, { ttfbMs: number; totalMs: number }[]> =
    new Map();
  private static readonly MAX_LATENCY_RECORDS = 200;
  private requestLog: StatusResponse["requestLog"] = [];
  private ollamaModels = new Set<string>();
  private codexModels = new Set<string>(getCodexModels().map((model) => model.id));
  private readonly usagePredictor = new UsagePredictor();
  private lastOllamaCatalogFetch = 0;

  setOllamaModels(models: string[]): void {
    this.ollamaModels = new Set(models.map((m) => m.trim()).filter(Boolean));
  }

  getOllamaModels(): string[] {
    return [...this.ollamaModels];
  }

  hasActiveProvider(providerId: string): boolean {
    return this.accounts.some(
      (account) =>
        !account.disabled &&
        !account.flagged &&
        hasCredential(account.config, providerId),
    );
  }

  setCodexModels(models: string[]): void {
    this.codexModels = new Set(
      models
        .map((model) => model.trim())
        .filter((model): model is string => isCodexProviderModelId(model)),
    );
  }

  getCodexModels(): string[] {
    return [...this.codexModels];
  }

  async primeCodexCatalog(): Promise<void> {
    const account = this.accounts.find(
      (candidate) => hasCredential(candidate.config, "openai-codex") && !candidate.disabled && !candidate.flagged,
    );
    if (!account) return;
    try {
      await this.ensureValidTokenForProvider(account, "openai-codex");
      const models = await fetchCodexCatalog(account);
      this.setCodexModels(models.map((model) => model.id));
    } catch {
      // The verified base allowlist stays active when discovery is unavailable.
    }
  }

  /** Fetch the Ollama Cloud catalog once at startup so provider-aware routing and /v1/models work before the first quota poll. */
  primeOllamaCatalog(): Promise<void> {
    return this.refreshOllamaCatalogOnce();
  }

    private async refreshOllamaCatalogOnce(): Promise<void> {
    const now = Date.now();
    if (now - this.lastOllamaCatalogFetch < TAGS_CACHE_TTL_MS) return;
    const ollamaAccount = this.accounts.find(
      (a) =>
        hasCredential(a.config, "ollama") &&
        !a.disabled &&
        !a.flagged,
    );
    if (!ollamaAccount || typeof getOllamaApiKey(ollamaAccount.config) !== "string") {
      return;
    }
    this.lastOllamaCatalogFetch = now;
    try {
      const response = await fetchWithRetry(OLLAMA_TAGS_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${getOllamaApiKey(ollamaAccount.config) ?? ""}`,
          "User-Agent": OLLAMA_USER_AGENT,
        },
        timeoutMs: 8000,
      });
      if (!response.ok) return;
      const data = (await response.json()) as {
        models?: Array<{ name?: string; model?: string }>;
      };
      const names = (data.models ?? [])
        .map((m) => m.name ?? m.model ?? "")
        .filter(Boolean);
      if (names.length > 0) this.setOllamaModels(names);
    } catch {
      // Catalog refresh is non-fatal
    }
  }

  private static readonly MAX_REQUEST_LOG = 200;
  private safetyDay = currentUtcDay();
  private projectRequests: Record<string, number> = {};
  private projectModelBreakers: Record<string, number> = {};
  private modelBreakers: Record<string, number> = {};
  private provider429Events: Array<{
    ts: number;
    projectId: string;
    modelKey: string;
    account: string;
  }> = [];
  private routingDiagnostics: Record<string, RoutingModelDiagnostics> = {};
  private autoWarmupEnabled = false;
  // Tracks upstream models already warmed-up this poll cycle per account (email → Set<upstreamModel>).
  // Cleared at the start of each pollAllQuotas() to enforce the one-per-cycle guarantee.
  private warmupSentThisCycle = new Map<string, Set<string>>();
  // Debounced state writer: batches multiple saveState() calls within a 1s window
  // to a single disk write. Hot paths (markError, recordRequest, etc.) call
  // scheduleStateSave() instead of saveState() to avoid blocking the event loop.
  private stateSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly STATE_SAVE_DEBOUNCE_MS = 1_000;
  private stateSaveInflight: Promise<void> | null = null;
  private stateSavePending = false;
  // Debounced token-usage writer: same pattern as state. Debounce window is
  // longer (2s) because token-usage writes include the minute/hour/day
  // consolidation pass and the JSON can be tens of KB.
  private tokenUsageSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly TOKEN_USAGE_SAVE_DEBOUNCE_MS = 2_000;
  private tokenUsageSaveInflight = false;
  private tokenUsageSavePending = false;

  constructor(private config: Config) {
    this.config = applyConfigDefaults(config);
    this.initAccounts();
    this.loadState();
    this.startQuotaPolling();
  }

  private initAccounts(): void {
    this.accounts = this.config.accounts.map((config) => ({
      config,
      accessToken: null,
      tokenExpires: 0,
      requestsSinceRotation: 0,
      totalRequests: 0,
      cooldownsByModel: {},
      quotaExhaustedAt: 0,
      quota: [],
      lastQuotaPoll: 0,
      lastUsed: 0,
      lastError: null,
      consecutiveErrors: 0,
      disabled: false,
      flagged: false,
      inFlightRequests: 0,
      inFlightByModel: {},
      allowFreshWindowStartsOverride: false,
      dailyRequestCount: 0,
      dailyRequestDay: currentUtcDay(),
      healthScore: 1,
      tokenBucket: {
        tokens: Math.max(
          0,
          Math.min(
            this.config.tokenBucketInitialTokens ?? 50,
            this.config.tokenBucketMaxTokens ?? 50,
          ),
        ),
        lastRefillAt: Date.now(),
      },
    }));
    this.refreshHealthScores();
  }

  private isTokenBucketEnabled(): boolean {
    return !!this.config.tokenBucketEnabled;
  }

  private getTokenBucketCapacity(): number {
    return Math.max(1, this.config.tokenBucketMaxTokens ?? 50);
  }

  private getTokenBucketRefillPerMinute(): number {
    return Math.max(0.0001, this.config.tokenBucketRefillPerMinute ?? 6);
  }

  private refillTokenBucket(account: AccountRuntime, now: number): void {
    const capacity = this.getTokenBucketCapacity();
    if (!this.isTokenBucketEnabled()) {
      account.tokenBucket.tokens = capacity;
      account.tokenBucket.lastRefillAt = now;
      return;
    }
    const elapsedMinutes =
      Math.max(0, now - account.tokenBucket.lastRefillAt) / 60_000;
    if (elapsedMinutes <= 0) return;
    account.tokenBucket.tokens = Math.min(
      capacity,
      account.tokenBucket.tokens +
        elapsedMinutes * this.getTokenBucketRefillPerMinute(),
    );
    account.tokenBucket.lastRefillAt = now;
  }

  private getTokenBucketSnapshot(
    account: AccountRuntime,
    now: number,
  ): {
    enabled: boolean;
    tokens: number;
    capacity: number;
    nextRefillInMs: number;
  } {
    const capacity = this.getTokenBucketCapacity();
    if (!this.isTokenBucketEnabled()) {
      return { enabled: false, tokens: capacity, capacity, nextRefillInMs: 0 };
    }
    this.refillTokenBucket(account, now);
    const tokens = Math.max(0, Math.min(capacity, account.tokenBucket.tokens));
    if (tokens >= 1) {
      return { enabled: true, tokens, capacity, nextRefillInMs: 0 };
    }
    const tokensNeeded = 1 - tokens;
    const nextRefillInMs = Math.ceil(
      (tokensNeeded / this.getTokenBucketRefillPerMinute()) * 60_000,
    );
    return {
      enabled: true,
      tokens,
      capacity,
      nextRefillInMs: Math.max(0, nextRefillInMs),
    };
  }

  private consumeTokenBucket(account: AccountRuntime, now: number): boolean {
    if (!this.isTokenBucketEnabled()) return true;
    this.refillTokenBucket(account, now);
    if (account.tokenBucket.tokens < 1) return false;
    account.tokenBucket.tokens = Math.max(0, account.tokenBucket.tokens - 1);
    account.tokenBucket.lastRefillAt = now;
    return true;
  }

  private refundTokenBucket(account: AccountRuntime, now: number): void {
    if (!this.isTokenBucketEnabled()) return;
    this.refillTokenBucket(account, now);
    account.tokenBucket.tokens = Math.min(
      this.getTokenBucketCapacity(),
      account.tokenBucket.tokens + 1,
    );
    account.tokenBucket.lastRefillAt = now;
  }

  private loadState(): void {
    const state = getCachedState();
    if (!state) {
      this.loadTokenUsage();
      return;
    }

    try {
      // Load per-model account assignments
      if (state.modelAccounts) {
        for (const [model, idx] of Object.entries(state.modelAccounts)) {
          this.modelState.set(model, {
            activeAccountIndex: Math.min(idx, this.accounts.length - 1),
            stickyAccountIndex:
              state.modelStickyAccounts?.[model] !== undefined
                ? Math.min(
                    state.modelStickyAccounts[model],
                    this.accounts.length - 1,
                  )
                : undefined,
            quotaAtRotationStart: -1,
            requestsOnActiveAccount: state.modelRequestCounts?.[model] ?? 0,
          });
        }
      }
      // Legacy fallback
      if (state.currentIndex !== undefined) {
        this.defaultIndex = Math.min(
          state.currentIndex,
          this.accounts.length - 1,
        );
      }
      this.protectivePauseUntil = state.protectivePauseUntil ?? 0;
      this.protectivePauseReason = state.protectivePauseReason ?? null;
      this.allowFreshWindowStarts = state.allowFreshWindowStarts ?? true;
      this.autoWarmupEnabled = state.autoWarmupEnabled ?? false;
      this.safetyDay = state.safety?.day ?? currentUtcDay();
      this.projectRequests = state.safety?.projectRequests ?? {};
      this.projectModelBreakers = state.safety?.projectModelBreakers ?? {};
      this.modelBreakers = state.safety?.modelBreakers ?? {};
      this.provider429Events = state.safety?.provider429Events ?? [];
      this.rollDailySafetyIfNeeded(Date.now());

      for (const account of this.accounts) {
        const saved = state.accounts[account.config.email];
        if (saved) {
          account.totalRequests = saved.totalRequests;
          account.dailyRequestCount = saved.dailyRequestCount ?? 0;
          account.dailyRequestDay = saved.dailyRequestDay ?? currentUtcDay();
          account.cooldownsByModel = saved.cooldownsByModel ?? {};
          if (
            saved.cooldownUntil !== undefined &&
            Object.keys(account.cooldownsByModel).length === 0
          ) {
            // legacy migration: apply global cooldown to default
            account.cooldownsByModel["__default__"] = saved.cooldownUntil;
          }
          account.quotaExhaustedAt = saved.quotaExhaustedAt;
          account.disabled = saved.disabled;
          account.flagged = saved.flagged ?? false;
          account.allowFreshWindowStartsOverride =
            saved.allowFreshWindowStartsOverride ?? false;
        }
      }
      // Cap any stale cooldowns to 30 min max from now
      const maxCooldown = 30 * 60 * 1000;
      const now = Date.now();
      for (const account of this.accounts) {
        for (const [model, cooldown] of Object.entries(
          account.cooldownsByModel,
        )) {
          if (cooldown > now + maxCooldown) {
            account.cooldownsByModel[model] = now + maxCooldown;
          }
        }
      }
      this.log("Loaded persisted state");
    } catch {
      this.log("Could not load state, starting fresh");
    }
    this.loadTokenUsage();
  }

  private loadTokenUsage(): void {
    try {
      const parsed = getCachedTokenUsage() as any;

      if (!parsed) return;

      const normalize = (arr: any[]): TokenBucket[] =>
        (arr || [])
          .map((b: any) => ({
            period: b.period ?? b.hour ?? "unknown",
            inputTokens: Number(b.inputTokens || 0),
            outputTokens: Number(b.outputTokens || 0),
            requests: Number(b.requests || 0),
            byModel: b.byModel || {},
          }))
          .filter((b: TokenBucket) => b.period && b.period !== "unknown");
      if (Array.isArray(parsed)) {
        // Migrate from flat array (old format)
        this.tokenBuckets = {
          minutes: normalize(parsed),
          hours: [],
          days: [],
          months: [],
        };
      } else {
        this.tokenBuckets = {
          minutes: normalize(parsed.minutes || []),
          hours: normalize(parsed.hours || []),
          days: normalize(parsed.days || []),
          months: normalize(parsed.months || []),
        };
      }
      const total =
        this.tokenBuckets.minutes.length +
        this.tokenBuckets.hours.length +
        this.tokenBuckets.days.length +
        this.tokenBuckets.months.length;
      this.log(`Loaded ${total} token usage buckets`);
    } catch {
      this.log("Could not load token usage, starting fresh");
    }
  }

  async saveState(): Promise<void> {
    const modelAccounts: Record<string, number> = {};
    const modelRequestCounts: Record<string, number> = {};
    const modelStickyAccounts: Record<string, number> = {};
    for (const [model, state] of this.modelState.entries()) {
      modelAccounts[model] = state.activeAccountIndex;
      modelRequestCounts[model] = state.requestsOnActiveAccount;
      if (state.stickyAccountIndex !== undefined) {
        modelStickyAccounts[model] = state.stickyAccountIndex;
      }
    }

    const state: PersistedState = {
      modelAccounts,
      modelRequestCounts,
      modelStickyAccounts,
      currentIndex: this.defaultIndex,
      protectivePauseUntil: this.protectivePauseUntil,
      protectivePauseReason: this.protectivePauseReason,
      allowFreshWindowStarts: this.allowFreshWindowStarts,
      autoWarmupEnabled: this.autoWarmupEnabled,
      safety: {
        day: this.safetyDay,
        projectRequests: { ...this.projectRequests },
        projectModelBreakers: { ...this.projectModelBreakers },
        modelBreakers: { ...this.modelBreakers },
        provider429Events: [...this.provider429Events],
      },
      accounts: {},
    };
    for (const account of this.accounts) {
      state.accounts[account.config.email] = {
        totalRequests: account.totalRequests,
        dailyRequestCount: account.dailyRequestCount,
        dailyRequestDay: account.dailyRequestDay,
        cooldownsByModel: { ...account.cooldownsByModel },
        quotaExhaustedAt: account.quotaExhaustedAt,
        disabled: account.disabled,
        flagged: account.flagged,
        allowFreshWindowStartsOverride: account.allowFreshWindowStartsOverride,
      };
    }
    try {
      await setCachedState(state);
    } catch (err) {
      this.log(`Failed to save state: ${err}`, "error");
    }
  }

  /**
   * Schedule a debounced state save. Multiple calls within STATE_SAVE_DEBOUNCE_MS
   * are coalesced into a single saveState() invocation. Hot paths (recordRequest,
   * markError, etc.) should use this instead of saveState() to avoid blocking
   * the event loop on every request.
   *
   * If a write is already in-flight when the timer fires, the next write is
   * scheduled for after it completes.
   */
  scheduleStateSave(): void {
    if (this.stateSaveTimer) return;
    this.stateSaveTimer = setTimeout(() => {
      this.stateSaveTimer = null;
      void this.runScheduledStateSave();
    }, AccountRotator.STATE_SAVE_DEBOUNCE_MS);
    if (this.stateSaveTimer.unref) this.stateSaveTimer.unref();
  }

  private async runScheduledStateSave(): Promise<void> {
    if (this.stateSaveInflight) {
      // A write is already running. Re-schedule ourselves to run after it.
      this.stateSavePending = true;
      await this.stateSaveInflight;
      return;
    }
    const write = this.saveState();
    this.stateSaveInflight = write;
    try {
      await write;
    } finally {
      this.stateSaveInflight = null;
      if (this.stateSavePending) {
        this.stateSavePending = false;
        this.scheduleStateSave();
      }
    }
  }

  /**
   * Force-flush any pending state writes. Called by SIGTERM/SIGINT handlers
   * in index.ts to minimise data loss on shutdown.
   */
  async flushPendingStateSave(): Promise<void> {
    if (this.stateSaveTimer) {
      clearTimeout(this.stateSaveTimer);
      this.stateSaveTimer = null;
    }
    if (this.stateSaveInflight) await this.stateSaveInflight;
    this.stateSavePending = false;
    await this.saveState();
  }

  // =========================================================================
  // Quota Polling
  // =========================================================================

  private startQuotaPolling(): void {
    const configuredIntervalMs = this.config.quotaPollIntervalMs;
    const intervalMs =
      Number.isFinite(configuredIntervalMs) &&
      configuredIntervalMs >= MIN_QUOTA_POLL_INTERVAL_MS &&
      configuredIntervalMs <= MAX_QUOTA_POLL_INTERVAL_MS
        ? Math.floor(configuredIntervalMs)
        : DEFAULT_QUOTA_POLL_INTERVAL_MS;
    this.log(`Quota polling every ${Math.round(intervalMs / 1000)}s`);

    // Initial poll (delayed 2s to allow token refresh first)
    setTimeout(() => this.pollAllQuotas(), 2000);

    this.quotaPollTimer = setInterval(() => this.pollAllQuotas(), intervalMs);
  }

  stopQuotaPolling(): void {
    if (this.quotaPollTimer) {
      clearInterval(this.quotaPollTimer);
      this.quotaPollTimer = null;
    }
  }

  /**
   * Emit one consolidated RAW POLL line per quota cycle, with Antigravity
   * pools first and Ollama (usage) pools last. Per-provider strings are
   * collected into `account.lastPollByProvider` by each adapter.
   */
  private logConsolidatedPoll(account: AccountRuntime): void {
    const stash = account.lastPollByProvider;
    if (!stash) return;
    const ordered = PROVIDER_ORDER
      .filter((pid) => stash[pid])
      .map((pid) => `${pid}: ${stash[pid]}`);
    if (ordered.length > 0) {
      this.log(`RAW POLL ${account.config.email} -> ${ordered.join(" | ")}`);
    }
    account.lastPollByProvider = {};
  }

  private async pollAllQuotas(): Promise<void> {
    // Reset per-cycle warmup tracking so each poll cycle allows at most one warmup per upstream model per account.
    this.warmupSentThisCycle.clear();
    void this.refreshOllamaCatalogOnce().catch(() => {});

    const available = this.accounts.filter((a) => !a.disabled && !a.flagged);
    for (const account of available) {
      try {
        const quotaCtx: QuotaFetchContext = {
          log: (message) => this.log(message),
          markFlagged: (acc, reason, options) =>
            this.markFlagged(acc, reason, options),
          reportQuotaPollFlag: (acc, statusCode, errorText) =>
            this.reportQuotaPollFlag(acc, statusCode, errorText),
          markProviderInvalid: (acc, providerId, reason) =>
            this.markProviderInvalid(acc, providerId, reason),
          setProviderCooldown: (acc, providerId, durationMs) =>
            this.setProviderCooldown(acc, providerId, durationMs),
        };
        // Parent-account model: poll quota for every provider credential
        // the account holds (Google OAuth pools + Ollama usage pools).
        const providerIds = new Set<string>(
          (account.config.credentials ?? []).map((c) => c.provider),
        );
        if (providerIds.size === 0) providerIds.add(primaryProviderId(account.config));
        for (const pid of providerIds) {
          try {
            await this.ensureValidTokenForProvider(account, pid);
            await getProviderAdapter(pid).fetchQuota(account, quotaCtx);
          } catch {
            // One invalid provider credential must not suppress sibling pools.
          }
        }
      } catch {
        // Token refresh or quota fetch failed, skip this account
      }

      // Consolidated RAW POLL across all providers on this account:
      // google first (Antigravity OAuth pools), then ollama (usage pools).
      this.logConsolidatedPoll(account);

      // Auto-warmup: send minimal kickstart requests for idle pools on accounts that have opted
      // in via allowFreshWindowStartsOverride, but only if the operator has enabled the global
      // auto-warmup toggle. "Idle" includes both fresh pools (no active timer) and rolling idle
      // pools (100% quota with resetTime very close to a full 5h or 7d window — timer exists but
      // untouched). Deduplicates by upstream model within this cycle.
      if (this.autoWarmupEnabled && account.allowFreshWindowStartsOverride) {
        const idlePools = account.quota.filter(
          (q) =>
            this.isQuotaIdleForKickstart(q) &&
            this.getKickstartTarget(account, q.modelKey) !== null,
        );
        if (idlePools.length > 0) {
          const alreadySent =
            this.warmupSentThisCycle.get(account.config.email) ?? new Set<string>();
          const upstreamToQuotaKey = new Map<string, string>();
          for (const q of idlePools) {
            const target = this.getKickstartTarget(account, q.modelKey);
            if (!target) continue;
            const upstream = target.upstreamModel;
            if (!upstreamToQuotaKey.has(upstream)) {
              upstreamToQuotaKey.set(upstream, q.modelKey);
            }
          }
          for (const [upstream, quotaKey] of upstreamToQuotaKey) {
            if (!alreadySent.has(upstream)) {
              alreadySent.add(upstream);
              // Fire-and-forget — errors are handled internally by kickstartTimerForAccount
              void this.kickstartTimerForAccount(account.config.email, quotaKey).catch(
                () => {},
              );
            }
          }
          this.warmupSentThisCycle.set(account.config.email, alreadySent);
        }
      }
    }

    if (this.isProtectivePauseActive(Date.now())) {
      return;
    }

    // Check per-model quota-based rotation
    if (this.config.rotateOnQuotaDrop > 0) {
      for (const [modelKey, mState] of this.modelState.entries()) {
        const account = this.accounts[mState.activeAccountIndex];
        if (!account) continue;

        const modelQuota = this.getModelQuota(account, modelKey);
        if (modelQuota < 0) continue; // No data yet

        if (mState.quotaAtRotationStart < 0) {
          // First reading for this rotation
          mState.quotaAtRotationStart = modelQuota;
          this.log(
            `${account.config.label || account.config.email} [${modelKey}]: baseline quota ${modelQuota}%`,
          );
        } else {
          const drop = mState.quotaAtRotationStart - modelQuota;
          if (drop >= this.config.rotateOnQuotaDrop) {
            // Only rotate if there's a healthy account to rotate to
            const hasHealthy = this.accounts.some(
              (a, idx) =>
                idx !== mState.activeAccountIndex &&
                this.isRoutableForModel(a, modelKey, Date.now()),
            );
            if (hasHealthy) {
              this.log(
                `${account.config.label || account.config.email} [${modelKey}]: quota dropped ${drop}% (${mState.quotaAtRotationStart}% -> ${modelQuota}%), rotating`,
              );
              await this.rotateModel(modelKey);
            } else {
              this.log(
                `${account.config.label || account.config.email} [${modelKey}]: quota dropped ${drop}% but no healthy accounts available, staying`,
              );
              mState.quotaAtRotationStart = modelQuota; // Reset baseline
            }
          }
        }
      }
    }
  }

  private reportQuotaPollFlag(
    account: AccountRuntime,
    statusCode: number,
    errorText: string,
  ): void {
    const modelKey = account.quota[0]?.modelKey ?? "quota-poll";
    const ctx = this.getFlagContext(account, modelKey);
    const lower = errorText.toLowerCase();
    const matchedPatterns = FLAG_PATTERNS.filter((p) => lower.includes(p));
    reportFlagEvent({
      flagHttpStatus: statusCode,
      flagPatternsMatched: matchedPatterns.length > 0 ? matchedPatterns : [],
      model: "quota-poll",
      timerType: ctx.timerType as FlagEventData["timerType"],
      accountQuotaPercent: ctx.accountQuotaPercent,
      wasProAccount: ctx.wasProAccount,
      accountTotalRequests: account.totalRequests,
      accountRequestsLastHour: ctx.accountRequestsLastHour,
      accountConcurrentAtFlag: account.inFlightRequests,
      poolSize: ctx.poolSize,
      poolHealthyCount: ctx.poolHealthyCount,
      protectivePauseTriggered: false,
      uptimeSeconds: ctx.uptimeSeconds,
      timeSinceLastFlagSeconds: -1,
    });
  }

  // Get quota % for a specific model on an account. Returns -1 if no data.
  private getModelQuota(account: AccountRuntime, modelKey: string): number {
    const q = account.quota.find((q) => q.modelKey === modelKey) ??
      (modelKey.startsWith(`${CODEX_QUOTA_MODEL_KEY}:`)
        ? account.quota.find((candidate) => candidate.modelKey === CODEX_QUOTA_MODEL_KEY)
        : modelKey.startsWith(`${OPENCODE_ZEN_PROVIDER_ID}:`)
          ? account.quota.find((candidate) => candidate.providerId === OPENCODE_ZEN_PROVIDER_ID)
          : undefined);
    return q ? q.percentRemaining : -1;
  }

  // Get timer type for a specific model on an account
  private getModelTimerType(
    account: AccountRuntime,
    modelKey: string,
  ): "fresh" | "5h" | "7d" {
    const q = account.quota.find((q) => q.modelKey === modelKey) ??
      (modelKey.startsWith(`${CODEX_QUOTA_MODEL_KEY}:`)
        ? account.quota.find((candidate) => candidate.modelKey === CODEX_QUOTA_MODEL_KEY)
        : modelKey.startsWith(`${OPENCODE_ZEN_PROVIDER_ID}:`)
          ? account.quota.find((candidate) => candidate.providerId === OPENCODE_ZEN_PROVIDER_ID)
          : undefined);
    return q?.timerType ?? "fresh";
  }

  // A pool is "idle for kickstart" when it has a fresh pool (no active timer)
  // OR a rolling idle timer (100% quota with resetTime very close to a full 5h or 7d
  // window — the timer exists but the quota is completely untouched). Sending a
  // minimal kickstart request against an idle pool starts the consumption clock.
  private isQuotaIdleForKickstart(q: ModelQuota): boolean {
    if (q.timerType === "fresh") return true;
    if (!q.resetTime || q.percentRemaining !== 100) return false;
    const remaining = new Date(q.resetTime).getTime() - Date.now();
    if (remaining <= 0) return false;
    const within = (target: number) => Math.abs(remaining - target) < 600_000;
    return within(5 * 3600 * 1000) || within(7 * 24 * 3600 * 1000);
  }

  /**
   * Resolve kickstart by quota-pool owner, never by the account's primary
   * provider. Parent accounts may hold several credentials, and Codex pools
   * deliberately have no kickstart implementation.
   */
  private getKickstartTarget(
    account: AccountRuntime,
    quotaModelKey: string,
  ): { providerId: string; adapter: ReturnType<typeof getProviderAdapter>; upstreamModel: string } | null {
    const quota = account.quota.find((candidate) => candidate.modelKey === quotaModelKey);
    const providerId =
      quota?.providerId ??
      (quotaModelKey === "session"
        ? "ollama"
        : quotaModelKey === CODEX_QUOTA_MODEL_KEY ||
            quotaModelKey.startsWith(`${CODEX_QUOTA_MODEL_KEY}:`)
          ? "openai-codex"
          : DEFAULT_PROVIDER);
    if (!hasCredential(account.config, providerId)) return null;

    const adapter = getProviderAdapter(providerId);
    const upstreamModel = adapter.getKickstartModelForPool(quotaModelKey);
    if (!upstreamModel) return null;
    return { providerId, adapter, upstreamModel };
  }

  // Timer priority for a specific model:
  //   1 (highest) = 5h timer -> only class with hard quota loss if underused before reset
  //   2           = 7d timer -> already ticking, keep those long windows moving
  //   3 (lowest)  = fresh -> no visible timer is running yet
  private getModelTimerPriority(
    account: AccountRuntime,
    modelKey: string,
  ): number {
    const type = this.getModelTimerType(account, modelKey);
    if (type === "5h") return 1;
    if (type === "7d") return 2;
    return 3;
  }

  private isFreshWindowAllowed(
    account: AccountRuntime,
    modelKey: string,
  ): boolean {
    if (this.allowFreshWindowStarts) return true;
    if (account.allowFreshWindowStartsOverride) return true;
    return this.getModelTimerType(account, modelKey) !== "fresh";
  }

  private isEffectiveFreshWindowAllowed(account: AccountRuntime): boolean {
    return (
      this.allowFreshWindowStarts || account.allowFreshWindowStartsOverride
    );
  }

  private isTimedWindow(account: AccountRuntime, modelKey: string): boolean {
    return this.getModelTimerType(account, modelKey) !== "fresh";
  }

  private hasTimedCandidate(
    modelKey: string,
    now: number,
    excludeIdx: number = -1,
  ): boolean {
    return this.accounts.some((account, idx) => {
      if (idx === excludeIdx) return false;
      if (!this.isAvailableForModel(account, modelKey, now)) return false;
      if (this.getModelQuota(account, modelKey) === 0) return false;
      return this.isTimedWindow(account, modelKey);
    });
  }

  private isQuotaAwarePolicy(
    policy: Config["routingPolicy"] = this.config.routingPolicy,
  ): boolean {
    return policy === "sequential-quota" || policy === "sticky-quota";
  }

  private pickBestModelAccount(
    modelKey: string,
    now: number,
    excludeIdx: number = -1,
  ): AccountRuntime | null {
    let best: AccountRuntime | null = null;
    let bestMetrics: {
      priority: number;
      quota: number;
      tier: number;
      health: number;
      distance: number;
      tokenRatio: number;
      hybridScore: number;
    } | null = null;
    const policy = this.config.routingPolicy || "timer-first";

    const candidateIndices =
      policy === "sequential-quota"
        ? Array.from({ length: this.accounts.length }, (_, offset) =>
            excludeIdx >= 0
              ? (excludeIdx + 1 + offset) % this.accounts.length
              : offset,
          )
        : Array.from({ length: this.accounts.length }, (_, i) => i);

    for (const i of candidateIndices) {
      if (i === excludeIdx) continue;
      const account = this.accounts[i];
      if (!this.isProviderEligibleForKey(account, modelKey)) continue;
      if (!this.isAvailableForModel(account, modelKey, now)) continue;

      const quota = this.getModelQuota(account, modelKey);
      if (quota === 0) continue;
      if (!this.isFreshWindowAllowed(account, modelKey)) continue;

      const priority = this.getModelTimerPriority(account, modelKey);
      const tier = this.getTierRank(account);
      const health = account.healthScore;
      const distance =
        excludeIdx >= 0
          ? (i - excludeIdx + this.accounts.length) % this.accounts.length
          : i + 1;
      const tokenSnapshot = this.getTokenBucketSnapshot(account, now);
      const tokenRatio =
        tokenSnapshot.capacity > 0
          ? tokenSnapshot.tokens / tokenSnapshot.capacity
          : 0;
      if (
        policy === "hybrid" &&
        tokenSnapshot.enabled &&
        tokenSnapshot.tokens < 1
      )
        continue;
      if (policy === "sequential-quota") return account;
      const metrics = {
        priority,
        quota,
        tier,
        health,
        distance,
        tokenRatio,
        hybridScore: this.calculateHybridScore(
          priority,
          quota,
          tier,
          health,
          tokenRatio,
          distance,
        ),
      };
      if (
        !bestMetrics ||
        this.compareRoutingCandidate(metrics, bestMetrics, policy)
      ) {
        best = account;
        bestMetrics = metrics;
      }
    }

    return best;
  }

  private countModelAssignment(modelKey: string): void {
    const state = this.modelState.get(modelKey);
    if (state) {
      state.requestsOnActiveAccount++;
      this.scheduleStateSave();
    }
  }

  private shouldRotateBeforeRequest(
    account: AccountRuntime,
    modelKey: string,
    state: ModelRotationState | null,
  ): boolean {
    return (
      !!state &&
      this.shouldUseRequestCountRotation(account, modelKey) &&
      state.requestsOnActiveAccount >= this.config.requestsPerRotation
    );
  }

  private async rotateModelForRequest(
    modelKey: string,
    now: number = Date.now(),
    excludeIdx?: number,
  ): Promise<AccountRuntime | null> {
    const account = await this.rotateModel(modelKey, now, excludeIdx);
    if (account) {
      this.countModelAssignment(modelKey);
    }
    return account;
  }

  private rollDailySafetyIfNeeded(now: number): void {
    const day = currentUtcDay(now);
    if (this.safetyDay === day) return;
    this.safetyDay = day;
    this.projectRequests = {};
    for (const account of this.accounts) {
      account.dailyRequestDay = day;
      account.dailyRequestCount = 0;
    }
  }

  private getAccountDailyCount(account: AccountRuntime, now: number): number {
    const day = currentUtcDay(now);
    if (account.dailyRequestDay !== day) {
      account.dailyRequestDay = day;
      account.dailyRequestCount = 0;
    }
    return account.dailyRequestCount;
  }

  private getProjectDailyCount(projectId: string, now: number): number {
    this.rollDailySafetyIfNeeded(now);
    return this.projectRequests[projectId] ?? 0;
  }

  private getDailySafetyRejection(
    account: AccountRuntime,
    now: number,
  ): {
    reason: "daily-account-stop" | "daily-project-stop";
    detail: string;
  } | null {
    const resetIso = new Date(nextUtcDayStartMs(now)).toISOString();
    const accountCount = this.getAccountDailyCount(account, now);
    const accountLimit = this.config.dailyAccountStopRequests ?? 350;
    if (accountCount >= accountLimit) {
      return {
        reason: "daily-account-stop",
        detail: `daily account budget exhausted (${accountCount}/${accountLimit} upstream attempts; resets at ${resetIso})`,
      };
    }

    const projectCount = this.getProjectDailyCount(account.config.projectId ?? "",
      now,
    );
    const projectLimit = this.config.dailyProjectStopRequests ?? 1200;
    if (projectCount >= projectLimit) {
      return {
        reason: "daily-project-stop",
        detail: `daily project budget exhausted (${projectCount}/${projectLimit} upstream attempts; resets at ${resetIso})`,
      };
    }

    return null;
  }

  private isDailySafetyStopped(account: AccountRuntime, now: number): boolean {
    return this.getDailySafetyRejection(account, now) !== null;
  }

  private getProjectInFlight(modelKey: string, projectId: string): number {
    return this.accounts
      .filter((account) => account.config.projectId === projectId)
      .reduce(
        (sum, account) => sum + (account.inFlightByModel[modelKey] ?? 0),
        0,
      );
  }

  private isProjectModelBreakerActive(
    projectId: string,
    modelKey: string,
    now: number,
  ): boolean {
    const until =
      this.projectModelBreakers[projectModelKey(projectId, modelKey)] ?? 0;
    if (until <= now) {
      if (until > 0)
        delete this.projectModelBreakers[projectModelKey(projectId, modelKey)];
      return false;
    }
    return true;
  }

  private isModelBreakerActive(modelKey: string, now: number): boolean {
    const until = this.modelBreakers[modelKey] ?? 0;
    if (until <= now) {
      if (until > 0) delete this.modelBreakers[modelKey];
      return false;
    }
    return true;
  }

  private getUnavailableReasonForModel(
    account: AccountRuntime,
    modelKey: string,
    now: number,
  ): string | null {
    if (this.isModelBreakerActive(modelKey, now))
      return "model circuit breaker active";
    if (
      this.isProjectModelBreakerActive(account.config.projectId ?? "", modelKey, now)
    )
      return "project circuit breaker active";
    if (
      this.getProjectInFlight(modelKey, account.config.projectId ?? "") >=
      (this.config.maxConcurrentRequestsPerProjectModel ?? 1)
    )
      return "project concurrency limit reached";
    const dailySafety = this.getDailySafetyRejection(account, now);
    if (dailySafety) return dailySafety.detail;
    return null;
  }

  private getAccountStatusForUi(
    account: AccountRuntime,
    now: number,
    activeForModels: string[],
  ): AccountStatus["status"] {
    const inCooldownModels = Object.values(account.cooldownsByModel).filter(
      (ts) => ts > now,
    );
    if (account.flagged) return "flagged";
    if (account.disabled) return "disabled";
    if (account.consecutiveErrors > 0 && !account.disabled) return "error";
    if (inCooldownModels.length > 0) return "cooldown";
    if (this.isDailySafetyStopped(account, now)) return "exhausted";
    if (activeForModels.length > 0) return "active";
    return "ready";
  }

  private mapRoutingRejection(reason: string): {
    reason: RoutingRejectionReason;
    detail: string;
  } {
    if (reason === "model circuit breaker active")
      return { reason: "model-breaker", detail: reason };
    if (reason === "project circuit breaker active")
      return { reason: "project-breaker", detail: reason };
    if (reason === "project concurrency limit reached")
      return { reason: "project-concurrency", detail: reason };
    if (reason.startsWith("daily account budget exhausted"))
      return { reason: "daily-account-stop", detail: reason };
    if (reason.startsWith("daily project budget exhausted"))
      return { reason: "daily-project-stop", detail: reason };
    return { reason: "cooldown", detail: reason };
  }

  private getRoutingRejectionForModel(
    account: AccountRuntime,
    modelKey: string,
    now: number,
    policy: Config["routingPolicy"],
  ): { reason: RoutingRejectionReason; detail: string } | null {
    if (account.disabled)
      return { reason: "disabled", detail: "account disabled" };
    if (account.flagged)
      return { reason: "flagged", detail: "account quarantined or flagged" };
    if (!this.isProviderEligibleForKey(account, modelKey))
      return {
        reason: "provider-ineligible",
        detail: "account lacks a credential for this provider pool",
      };
    const defaultCooldown = account.cooldownsByModel["__default__"] ?? 0;
    if (defaultCooldown > now)
      return { reason: "cooldown", detail: "default cooldown active" };
    const modelCooldown = account.cooldownsByModel[modelKey] ?? 0;
    if (modelCooldown > now)
      return { reason: "cooldown", detail: "model cooldown active" };
    // Ollama Cloud (pool key "session") imposes no per-account
    // concurrency limit — the in-flight check would otherwise wedge
    // long-running streams while the same model on another account is
    // still serving. Antigravity keeps the per-account limit.
    if (
      modelKey !== "session" &&
      (account.inFlightByModel[modelKey] ?? 0) >=
      (this.config.maxConcurrentRequestsPerAccount ?? 1)
    ) {
      return {
        reason: "account-concurrency",
        detail: "account concurrency limit reached",
      };
    }
    const unavailable = this.getUnavailableReasonForModel(
      account,
      modelKey,
      now,
    );
    if (unavailable) return this.mapRoutingRejection(unavailable);
    if (this.getModelQuota(account, modelKey) === 0)
      return {
        reason: "quota-zero",
        detail: "quota is exhausted for this model",
      };
    if (!this.isFreshWindowAllowed(account, modelKey))
      return {
        reason: "fresh-window-blocked",
        detail: "fresh window is blocked by operator policy",
      };
    if (policy === "hybrid") {
      const snapshot = this.getTokenBucketSnapshot(account, now);
      if (snapshot.enabled && snapshot.tokens < 1) {
        return {
          reason: "token-bucket-empty",
          detail: "local token bucket is empty",
        };
      }
    }
    return null;
  }

  private summarizeRoutingRejections(
    diagnostics: RoutingAccountDiagnostic[],
  ): string[] {
    const priority: RoutingRejectionReason[] = [
      "model-breaker",
      "project-breaker",
      "daily-account-stop",
      "daily-project-stop",
      "cooldown",
      "account-concurrency",
      "project-concurrency",
      "token-bucket-empty",
      "fresh-window-blocked",
      "quota-zero",
      "provider-ineligible",
      "flagged",
      "disabled",
    ];
    const grouped = new Map<RoutingRejectionReason, Map<string, number>>();

    for (const entry of diagnostics) {
      if (!entry.rejectedReason) continue;
      const details =
        grouped.get(entry.rejectedReason) ?? new Map<string, number>();
      const detail = entry.rejectedDetail || entry.rejectedReason;
      details.set(detail, (details.get(detail) ?? 0) + 1);
      grouped.set(entry.rejectedReason, details);
    }

    const orderedReasons = [
      ...priority.filter((reason) => grouped.has(reason)),
      ...Array.from(grouped.keys()).filter(
        (reason) => !priority.includes(reason),
      ),
    ];
    const summaries: string[] = [];
    for (const reason of orderedReasons) {
      const details = grouped.get(reason);
      if (!details) continue;
      for (const [detail, count] of details.entries()) {
        summaries.push(`${count} account${count === 1 ? "" : "s"}: ${detail}`);
      }
    }

    return summaries;
  }

  private compareRoutingCandidate(
    candidate: {
      priority: number;
      quota: number;
      tier: number;
      health: number;
      distance: number;
      tokenRatio: number;
      hybridScore: number;
    },
    best: {
      priority: number;
      quota: number;
      tier: number;
      health: number;
      distance: number;
      tokenRatio: number;
      hybridScore: number;
    },
    policy: Config["routingPolicy"],
  ): boolean {
    if (policy === "sequential-quota") {
      return candidate.distance < best.distance;
    }
    if (policy === "hybrid") {
      return (
        candidate.hybridScore > best.hybridScore ||
        (candidate.hybridScore === best.hybridScore &&
          candidate.priority < best.priority) ||
        (candidate.hybridScore === best.hybridScore &&
          candidate.priority === best.priority &&
          candidate.distance < best.distance)
      );
    }
    if (policy === "tier-first") {
      return (
        candidate.tier < best.tier ||
        (candidate.tier === best.tier && candidate.quota > best.quota) ||
        (candidate.tier === best.tier &&
          candidate.quota === best.quota &&
          candidate.priority < best.priority) ||
        (candidate.tier === best.tier &&
          candidate.quota === best.quota &&
          candidate.priority === best.priority &&
          candidate.health > best.health) ||
        (candidate.tier === best.tier &&
          candidate.quota === best.quota &&
          candidate.priority === best.priority &&
          candidate.health === best.health &&
          candidate.tokenRatio > best.tokenRatio) ||
        (candidate.tier === best.tier &&
          candidate.quota === best.quota &&
          candidate.priority === best.priority &&
          candidate.health === best.health &&
          candidate.tokenRatio === best.tokenRatio &&
          candidate.distance < best.distance)
      );
    }
    if (policy === "quota-first") {
      return (
        candidate.quota > best.quota ||
        (candidate.quota === best.quota &&
          candidate.priority < best.priority) ||
        (candidate.quota === best.quota &&
          candidate.priority === best.priority &&
          candidate.tier < best.tier) ||
        (candidate.quota === best.quota &&
          candidate.priority === best.priority &&
          candidate.tier === best.tier &&
          candidate.health > best.health) ||
        (candidate.quota === best.quota &&
          candidate.priority === best.priority &&
          candidate.tier === best.tier &&
          candidate.health === best.health &&
          candidate.tokenRatio > best.tokenRatio) ||
        (candidate.quota === best.quota &&
          candidate.priority === best.priority &&
          candidate.tier === best.tier &&
          candidate.health === best.health &&
          candidate.tokenRatio === best.tokenRatio &&
          candidate.distance < best.distance)
      );
    }
    return (
      candidate.priority < best.priority ||
      (candidate.priority === best.priority && candidate.quota > best.quota) ||
      (candidate.priority === best.priority &&
        candidate.quota === best.quota &&
        candidate.tier < best.tier) ||
      (candidate.priority === best.priority &&
        candidate.quota === best.quota &&
        candidate.tier === best.tier &&
        candidate.health > best.health) ||
      (candidate.priority === best.priority &&
        candidate.quota === best.quota &&
        candidate.tier === best.tier &&
        candidate.health === best.health &&
        candidate.tokenRatio > best.tokenRatio) ||
      (candidate.priority === best.priority &&
        candidate.quota === best.quota &&
        candidate.tier === best.tier &&
        candidate.health === best.health &&
        candidate.tokenRatio === best.tokenRatio &&
        candidate.distance < best.distance)
    );
  }

  private calculateHybridScore(
    priority: number,
    quota: number,
    tier: number,
    health: number,
    tokenRatio: number,
    distance: number,
  ): number {
    const timerScore = (4 - priority) * 35;
    const quotaScore = Math.max(0, quota) * 0.7;
    const tierScore = Math.max(0, 4 - tier) * 13.5;
    const healthScore = Math.max(0, Math.min(1, health)) * 25;
    const tokenScore = Math.max(0, Math.min(1, tokenRatio)) * 20;
    const lruScore = Math.max(0, 10 - distance);
    return Number(
      (
        timerScore +
        quotaScore +
        tierScore +
        healthScore +
        tokenScore +
        lruScore
      ).toFixed(3),
    );
  }

  private buildRoutingDiagnostics(
    modelKey: string,
    now: number,
  ): RoutingModelDiagnostics {
    const policy = this.config.routingPolicy || "timer-first";
    let selectedEmail: string | null = null;
    let selectedScore = -Infinity;
    let selectedMetrics: {
      priority: number;
      quota: number;
      tier: number;
      health: number;
      distance: number;
      tokenRatio: number;
      hybridScore: number;
    } | null = null;
    const diagnostics: RoutingAccountDiagnostic[] = [];

    for (let i = 0; i < this.accounts.length; i++) {
      const account = this.accounts[i];
      const activeForModels: string[] = [];
      for (const [model, mState] of this.modelState.entries()) {
        if (
          this.accounts[mState.activeAccountIndex] === account &&
          this.isRoutableForModel(account, model, now)
        )
          activeForModels.push(model);
      }
      const status = this.getAccountStatusForUi(account, now, activeForModels);
      const rejection = this.getRoutingRejectionForModel(
        account,
        modelKey,
        now,
        policy,
      );
      const snapshot = this.getTokenBucketSnapshot(account, now);
      const priority = rejection
        ? null
        : this.getModelTimerPriority(account, modelKey);
      const quota = rejection ? null : this.getModelQuota(account, modelKey);
      const tierRank = this.getTierRank(account);
      const distance = i + 1;
      const healthBreakdown = this.getHealthScoreBreakdown(account);
      const tokenRatio =
        snapshot.capacity > 0 ? snapshot.tokens / snapshot.capacity : 0;
      const hybridScore =
        rejection || priority === null || quota === null
          ? null
          : this.calculateHybridScore(
              priority,
              quota,
              tierRank,
              healthBreakdown.score,
              tokenRatio,
              distance,
            );

      diagnostics.push({
        email: account.config.email,
        label: account.config.label || account.config.email,
        status,
        score: hybridScore,
        timerPriority: priority,
        quota,
        tier: account.config.tier || "unknown",
        healthScore: healthBreakdown.score,
        healthBreakdown,
        distance: rejection ? null : distance,
        tokenBucket: snapshot,
        rejectedReason: rejection?.reason ?? null,
        rejectedDetail: rejection?.detail ?? null,
      });

      if (
        rejection ||
        priority === null ||
        quota === null ||
        hybridScore === null
      )
        continue;
      const metrics = {
        priority,
        quota,
        tier: tierRank,
        health: healthBreakdown.score,
        distance,
        tokenRatio,
        hybridScore,
      };
      if (
        !selectedMetrics ||
        this.compareRoutingCandidate(metrics, selectedMetrics, policy)
      ) {
        selectedMetrics = metrics;
        selectedScore = hybridScore;
        selectedEmail = account.config.email;
      }
    }

    const availableCandidates = diagnostics.filter(
      (entry) => !entry.rejectedReason,
    ).length;
    const rejectedCandidates = diagnostics.length - availableCandidates;
    let reason = selectedEmail
      ? `Best route is ${selectedEmail} using ${policy}.`
      : "No routable account is available for this model.";
    if (!selectedEmail) {
      const reasons = this.summarizeRoutingRejections(diagnostics).slice(0, 5);
      if (reasons.length > 0) reason += ` ${reasons.join("; ")}.`;
    } else if (policy === "hybrid") {
      reason = `Best route is ${selectedEmail} using hybrid score ${selectedScore.toFixed(1)}.`;
    }

    return {
      modelKey,
      policy,
      selectedEmail,
      reason,
      availableCandidates,
      rejectedCandidates,
      accounts: diagnostics,
    };
  }

  // =========================================================================
  // Account Selection (per-model)
  // =========================================================================

  // Get the active account for a specific model.
  // model is the raw model name from the request body.
  async getActiveAccount(model?: string): Promise<AccountRuntime | null> {
    const now = Date.now();
    if (this.accounts.length === 0) return null;
    if (this.isProtectivePauseActive(now)) return null;

    const modelKey = model ? this.resolvePoolKeyForModel(model) : null;
    const state = modelKey ? this.modelState.get(modelKey) : null;
    const idx = state?.activeAccountIndex ?? this.defaultIndex;
    const current = this.accounts[idx];

    if (
      modelKey &&
      !state &&
      current &&
      this.isQuotaAwarePolicy() &&
      this.isRoutableForModel(current, modelKey, now)
    ) {
      // Seed the preference on the first request as well. Without this, a
      // default account that later enters cooldown would be indistinguishable
      // from an account that was never preferred and could not be restored.
      this.modelState.set(modelKey, {
        activeAccountIndex: idx,
        stickyAccountIndex: idx,
        quotaAtRotationStart: this.getModelQuota(current, modelKey),
        requestsOnActiveAccount: 0,
      });
      this.scheduleStateSave();
    }

    if (modelKey && state) {
      try {
        const restored = await this.restorePreferredModelAccount(
          modelKey,
          now,
          state,
          idx,
        );
        if (restored) return restored;
      } catch (error) {
        if (!this.isCodexPoolKey(modelKey)) throw error;
        return this.rotateModelForRequest(modelKey, now, idx);
      }
    }

    if (current && modelKey && !this.isProviderEligibleForKey(current, modelKey)) {
      this.log(
        `${current.config.label || current.config.email}: provider mismatch for model, rotating`,
        "warn",
      );
      return this.rotateModelForRequest(modelKey, now, idx);
    }
    if (
      current &&
      (!modelKey
        ? this.isAvailable(current, now)
        : this.isAvailableForModel(current, modelKey, now))
    ) {
      // Check if this account has quota for the requested model
      if (modelKey) {
        if (this.shouldRotateBeforeRequest(current, modelKey, state ?? null)) {
          this.log(
            `${current.config.label || current.config.email} [${modelKey}]: hit rotation threshold (${this.config.requestsPerRotation})`,
          );
          const rotated = await this.rotateModelForRequest(modelKey, now, idx);
          if (rotated) {
            current.requestsSinceRotation = 0;
            return rotated;
          }
          this.log(
            `${current.config.label || current.config.email} [${modelKey}]: threshold reached but no replacement is available, staying on current account`,
            "warn",
          );
        }
        const quota = this.getModelQuota(current, modelKey);
        if (quota === 0) {
          this.log(
            `${current.config.label || current.config.email} [${modelKey}]: 0% quota, skipping`,
          );
          return this.rotateModelForRequest(modelKey);
        }
        if (!this.isFreshWindowAllowed(current, modelKey)) {
          const label = current.config.label || current.config.email;
          this.log(
            this.hasTimedCandidate(modelKey, now, idx)
              ? `${label} [${modelKey}]: skipping fresh window because fresh starts are disabled and timed buckets are available`
              : `${label} [${modelKey}]: fresh window blocked by operator toggle`,
            "warn",
          );
          return this.rotateModelForRequest(modelKey);
        }
        if ((this.config.routingPolicy || "timer-first") === "hybrid") {
          const tokenSnapshot = this.getTokenBucketSnapshot(current, now);
          if (tokenSnapshot.enabled && tokenSnapshot.tokens < 1) {
            this.log(
              `${current.config.label || current.config.email} [${modelKey}]: local token bucket is empty, rotating to another candidate`,
              "warn",
            );
            return this.rotateModelForRequest(modelKey, now, idx);
          }
        }
      }
      this.startRequest(current, modelKey ?? undefined);
      try {
        await this.ensureValidTokenForModel(current, modelKey);
        if (modelKey) this.countModelAssignment(modelKey);
        return current;
      } catch (err) {
        this.refundTokenBucket(current, Date.now());
        this.finishRequest(current, modelKey ?? undefined);
        if (modelKey && this.isCodexPoolKey(modelKey)) {
          return this.rotateModelForRequest(modelKey, now, idx);
        }
        throw err;
      }
    }

    // Current unavailable, or no per-model assignment yet
    if (modelKey) {
      return this.rotateModelForRequest(modelKey, now, state ? idx : -1);
    }
    return this.rotateDefault();
  }

  private async restorePreferredModelAccount(
    modelKey: string,
    now: number,
    state: ModelRotationState,
    activeIndex: number,
  ): Promise<AccountRuntime | null> {
    if (!this.isQuotaAwarePolicy()) return null;
    const preferredIndex = state.stickyAccountIndex;
    if (
      preferredIndex === undefined ||
      preferredIndex === activeIndex ||
      preferredIndex < 0 ||
      preferredIndex >= this.accounts.length
    ) {
      return null;
    }

    const preferred = this.accounts[preferredIndex];
    if (this.getModelQuota(preferred, modelKey) === 0) {
      // A zero quota is a permanent hand-off for this rotation cycle. The
      // next selected account becomes the new preference in rotateModel().
      state.stickyAccountIndex = undefined;
      this.scheduleStateSave();
      return null;
    }
    if (!this.isRoutableForModel(preferred, modelKey, now)) return null;

    this.log(
      `[${modelKey}] Restoring preferred account ${preferred.config.label || preferred.config.email} after temporary fallback`,
    );
    const restored = await this.activateModelAccount(
      modelKey,
      preferred,
      preferredIndex,
    );
    this.countModelAssignment(modelKey);
    return restored;
  }

  // Rotate a specific model to the best available account.
  async rotateModel(
    modelKey: string,
    now: number = Date.now(),
    excludeIdx: number = this.modelState.get(modelKey)?.activeAccountIndex ??
      -1,
  ): Promise<AccountRuntime | null> {
    const best = this.pickBestModelAccount(modelKey, now, excludeIdx);

    if (best) {
      const previous = this.modelState.get(modelKey);
      let stickyAccountIndex: number | undefined;
      if (this.isQuotaAwarePolicy() && previous) {
        const preferredIndex = previous.stickyAccountIndex;
        const preferred =
          preferredIndex === undefined
            ? undefined
            : this.accounts[preferredIndex];
        if (
          preferredIndex !== undefined &&
          preferred &&
          this.getModelQuota(preferred, modelKey) !== 0 &&
          (preferredIndex !== previous.activeAccountIndex ||
            !this.isAvailableForModel(preferred, modelKey, now))
        ) {
          // Keep the original account as the preference while a cooldown,
          // breaker, or concurrency limit forces a temporary fallback.
          stickyAccountIndex = preferredIndex;
        }
      }
      const quota = this.getModelQuota(best, modelKey);
      const timerType = this.getModelTimerType(best, modelKey);
      this.log(
        `[${modelKey}] Rotated to ${best.config.label || best.config.email} [${timerType}] (quota: ${quota >= 0 ? quota + "%" : "unknown"})`,
      );
      try {
        return await this.activateModelAccount(modelKey, best, stickyAccountIndex);
      } catch (error) {
        if (!this.isCodexPoolKey(modelKey)) throw error;
        // A bad Codex refresh token is provider-scoped. The failed account is
        // marked invalid by ensureValidTokenForProvider, so retry selection
        // with the next Codex account without touching Google/Ollama pools.
        return this.rotateModel(modelKey, now, this.accounts.indexOf(best));
      }
    }

    if (
      !this.allowFreshWindowStarts &&
      this.accounts.some((account, idx) => {
        if (idx === excludeIdx) return false;
        if (!this.isAvailableForModel(account, modelKey, now)) return false;
        if (this.getModelQuota(account, modelKey) === 0) return false;
        return this.getModelTimerType(account, modelKey) === "fresh";
      })
    ) {
      this.log(
        `[${modelKey}] Fresh windows are available but blocked by operator toggle; keeping routing on existing timed buckets only`,
        "warn",
      );
      return null;
    }

    const shortestCooldown = this.accounts.reduce<number | null>(
      (bestRemaining, account) => {
        if (account.disabled || account.flagged) return bestRemaining;
        const defaultCooldown = account.cooldownsByModel["__default__"] ?? 0;
        if (defaultCooldown <= now) return bestRemaining;
        const remaining = defaultCooldown - now;
        if (bestRemaining === null || remaining < bestRemaining)
          return remaining;
        return bestRemaining;
      },
      null,
    );

    if (shortestCooldown !== null) {
      this.log(
        `[${modelKey}] All accounts exhausted. Waiting ${Math.ceil(shortestCooldown / 1000)}s for cooldown`,
      );
    } else {
      const diagnostics = this.buildRoutingDiagnostics(modelKey, now);
      this.routingDiagnostics[modelKey] = diagnostics;
      this.log(
        `[${modelKey}] All accounts disabled or unavailable: ${diagnostics.reason}`,
        "warn",
      );
    }
    return null;
  }

  private async activateModelAccount(
    modelKey: string,
    account: AccountRuntime,
    stickyAccountIndex?: number,
  ): Promise<AccountRuntime> {
    const newIdx = this.accounts.indexOf(account);
    const quota = this.getModelQuota(account, modelKey);
    this.modelState.set(modelKey, {
      activeAccountIndex: newIdx,
      stickyAccountIndex: this.isQuotaAwarePolicy()
        ? stickyAccountIndex ?? newIdx
        : undefined,
      quotaAtRotationStart: quota,
      requestsOnActiveAccount: 0,
    });
    await this.saveState();
    this.startRequest(account, modelKey);
    try {
      await this.ensureValidTokenForModel(account, modelKey);
      return account;
    } catch (err) {
      this.refundTokenBucket(account, Date.now());
      this.finishRequest(account, modelKey);
      throw err;
    }
  }

  // Fallback rotation when model can't be resolved
  private async rotateDefault(
    now: number = Date.now(),
  ): Promise<AccountRuntime | null> {
    let best: AccountRuntime | null = null;

    for (let i = 0; i < this.accounts.length; i++) {
      if (i === this.defaultIndex) continue;
      const account = this.accounts[i];
      if (this.isAvailable(account, now)) {
        best = account;
        break;
      }
    }

    if (best) {
      this.defaultIndex = this.accounts.indexOf(best);
      this.log(
        `[default] Rotated to ${best.config.label || best.config.email}`,
      );
      await this.saveState();
      this.startRequest(best);
      try {
        await this.ensureValidToken(best);
        return best;
      } catch (err) {
        this.refundTokenBucket(best, Date.now());
        this.finishRequest(best);
        throw err;
      }
    }

    const shortestCooldown = this.accounts.reduce<number | null>(
      (bestRemaining, account) => {
        if (account.disabled || account.flagged) return bestRemaining;
        const defaultCooldown = account.cooldownsByModel["__default__"] ?? 0;
        if (defaultCooldown <= now) return bestRemaining;
        const remaining = defaultCooldown - now;
        if (bestRemaining === null || remaining < bestRemaining)
          return remaining;
        return bestRemaining;
      },
      null,
    );

    if (shortestCooldown !== null) {
      this.log(
        `[default] All accounts exhausted. Waiting ${Math.ceil(shortestCooldown / 1000)}s for cooldown`,
      );
    } else {
      this.log("[default] All accounts disabled or unavailable");
    }
    return null;
  }

  // Force rotation for a model (called from proxy on 429 etc.)
  async rotateToNext(model?: string): Promise<AccountRuntime | null> {
    if (this.isProtectivePauseActive(Date.now())) return null;
    const modelKey = model ? this.resolvePoolKeyForModel(model) : null;
    return modelKey ? this.rotateModel(modelKey) : this.rotateDefault();
  }

  // Record a successful request. Returns true if rotation is needed.
  recordRequest(account: AccountRuntime, model?: string): boolean {
    account.requestsSinceRotation++;
    account.totalRequests++;
    account.lastUsed = Date.now();
    account.consecutiveErrors = 0;
    account.lastError = null;

    const modelKey = model ? this.resolvePoolKeyForModel(model) : null;
    const state = modelKey ? this.modelState.get(modelKey) : null;
    const shouldRotate =
      !!modelKey &&
      !!state &&
      this.accounts[state.activeAccountIndex] === account &&
      this.shouldUseRequestCountRotation(account, modelKey) &&
      state.requestsOnActiveAccount >= this.config.requestsPerRotation;

    this.scheduleStateSave();
    if (shouldRotate) {
      this.log(
        `${account.config.label || account.config.email} [${modelKey}]: hit rotation threshold (${state.requestsOnActiveAccount}/${this.config.requestsPerRotation})`,
      );
    }
    return shouldRotate;
  }

  // Record token usage from a completed request
  recordTokenUsage(
    model: string | undefined,
    inputTokens: number,
    outputTokens: number,
  ): void {
    const now = new Date();
    const minuteKey = now.toISOString().slice(0, 16); // "2026-04-28T12:05"
    const modelKey = model ? resolveDisplayModelKey(model) : "unknown";

    // Upsert minute bucket
    let bucket = this.tokenBuckets.minutes.find((b) => b.period === minuteKey);
    if (!bucket) {
      bucket = {
        period: minuteKey,
        inputTokens: 0,
        outputTokens: 0,
        requests: 0,
        byModel: {},
      };
      this.tokenBuckets.minutes.push(bucket);
    }
    bucket.inputTokens += inputTokens;
    bucket.outputTokens += outputTokens;
    bucket.requests += 1;
    if (!bucket.byModel[modelKey]) {
      bucket.byModel[modelKey] = {
        inputTokens: 0,
        outputTokens: 0,
        requests: 0,
      };
    }
    bucket.byModel[modelKey].inputTokens += inputTokens;
    bucket.byModel[modelKey].outputTokens += outputTokens;
    bucket.byModel[modelKey].requests += 1;

    // Lazy consolidation
    this.consolidateTokenBuckets(now);
    this.scheduleTokenUsageSave();
  }

  recordLatency(
    model: string | undefined,
    ttfbMs: number,
    totalMs: number,
  ): void {
    const modelKey = model ? resolveDisplayModelKey(model) : "unknown";
    let records = this.latencyRecords.get(modelKey);
    if (!records) {
      records = [];
      this.latencyRecords.set(modelKey, records);
    }
    records.push({ ttfbMs, totalMs });
    if (records.length > AccountRotator.MAX_LATENCY_RECORDS) {
      records.splice(0, records.length - AccountRotator.MAX_LATENCY_RECORDS);
    }
  }

  getLatencyStats(): Record<
    string,
    {
      ttfb: { p50: number; p95: number };
      total: { p50: number; p95: number };
      count: number;
    }
  > {
    const stats: Record<
      string,
      {
        ttfb: { p50: number; p95: number };
        total: { p50: number; p95: number };
        count: number;
      }
    > = {};
    for (const [model, records] of this.latencyRecords) {
      if (records.length === 0) continue;
      const ttfbs = records.map((r) => r.ttfbMs).sort((a, b) => a - b);
      const totals = records.map((r) => r.totalMs).sort((a, b) => a - b);
      stats[model] = {
        ttfb: {
          p50: ttfbs[Math.floor(ttfbs.length * 0.5)],
          p95: ttfbs[Math.floor(ttfbs.length * 0.95)],
        },
        total: {
          p50: totals[Math.floor(totals.length * 0.5)],
          p95: totals[Math.floor(totals.length * 0.95)],
        },
        count: records.length,
      };
    }
    return stats;
  }

  recordRequestLog(entry: {
    model: string;
    account: string;
    statusCode: number;
    ttfbMs: number;
    totalMs: number;
    inputTokens: number;
    outputTokens: number;
  }): void {
    const ollamaAccount = this.accounts.find(
      (a) =>
        hasCredential(a.config, "ollama") &&
        (a.config.email === entry.account ||
          a.config.label === entry.account),
    );
    if (ollamaAccount && entry.statusCode >= 200 && entry.statusCode < 300) {
      this.usagePredictor.recordUsage(
        ollamaAccount.config.email,
        entry.model,
        entry.inputTokens,
        entry.outputTokens,
      );
    }
    this.requestLog.unshift({
      timestamp: Date.now(),
      ...entry,
    });
    if (this.requestLog.length > AccountRotator.MAX_REQUEST_LOG) {
      this.requestLog.length = AccountRotator.MAX_REQUEST_LOG;
    }
  }

    getPredictionSummary(): Record<string, ExhaustionPrediction> {
    const result: Record<string, ExhaustionPrediction> = {};
    const now = Date.now();
    for (const account of this.accounts) {
      if (!hasCredential(account.config, "ollama")) continue;
      const session = account.quota.find((q) => q.modelKey === "session");
      const weekly = account.quota.find((q) => q.modelKey === "weekly");
      if (
        !session ||
        !weekly ||
        !Number.isFinite(session.usageRaw) ||
        !Number.isFinite(weekly.usageRaw)
      ) {
        continue;
      }
      const model = this.getOllamaModels()[0] ?? "gpt-oss:20b";
      result[account.config.email] = this.usagePredictor.predict(
        account.config.email,
        model,
        session.usageRaw ?? 0,
        weekly.usageRaw ?? 0,
        now,
      );
    }
    return result;
  }

  private consolidateTokenBuckets(now: Date): void {
    const nowMs = now.getTime();
    const KEEP_MINUTES_MS = 12 * 3600 * 1000; // keep 12h of minutes
    const KEEP_HOURS_MS = 60 * 86400 * 1000; // keep 60d of hours
    const KEEP_DAYS_MS = 60 * 86400 * 1000; // keep 60d of days

    // Helper: parse period string to epoch ms (approximate, enough for cutoff)
    const periodToMs = (p: string): number =>
      new Date(p.length <= 7 ? p + "-01" : p).getTime();

    // Minutes older than 2h → consolidate into hours, keep rest
    const minuteCutoff = nowMs - KEEP_MINUTES_MS;
    const staleMinutes = this.tokenBuckets.minutes.filter(
      (b) => periodToMs(b.period) < minuteCutoff,
    );
    if (staleMinutes.length > 0) {
      const byHour = new Map<string, TokenBucket>();
      for (const m of staleMinutes) {
        const hKey = m.period.slice(0, 13);
        let h = byHour.get(hKey);
        if (!h) {
          h = {
            period: hKey,
            inputTokens: 0,
            outputTokens: 0,
            requests: 0,
            byModel: {},
          };
          byHour.set(hKey, h);
        }
        this.mergeBucket(h, m);
      }
      for (const [hKey, consolidated] of byHour) {
        const existing = this.tokenBuckets.hours.find((b) => b.period === hKey);
        if (existing) {
          this.mergeBucket(existing, consolidated);
        } else {
          this.tokenBuckets.hours.push(consolidated);
        }
      }
      this.tokenBuckets.minutes = this.tokenBuckets.minutes.filter(
        (b) => periodToMs(b.period) >= minuteCutoff,
      );
    }

    // Hours older than 48h → consolidate into days
    const hourCutoff = nowMs - KEEP_HOURS_MS;
    const staleHours = this.tokenBuckets.hours.filter(
      (b) => periodToMs(b.period) < hourCutoff,
    );
    if (staleHours.length > 0) {
      const byDay = new Map<string, TokenBucket>();
      for (const h of staleHours) {
        const dKey = h.period.slice(0, 10);
        let d = byDay.get(dKey);
        if (!d) {
          d = {
            period: dKey,
            inputTokens: 0,
            outputTokens: 0,
            requests: 0,
            byModel: {},
          };
          byDay.set(dKey, d);
        }
        this.mergeBucket(d, h);
      }
      for (const [dKey, consolidated] of byDay) {
        const existing = this.tokenBuckets.days.find((b) => b.period === dKey);
        if (existing) {
          this.mergeBucket(existing, consolidated);
        } else {
          this.tokenBuckets.days.push(consolidated);
        }
      }
      this.tokenBuckets.hours = this.tokenBuckets.hours.filter(
        (b) => periodToMs(b.period) >= hourCutoff,
      );
    }

    // Days older than 60d → consolidate into months
    const dayCutoff = nowMs - KEEP_DAYS_MS;
    const staleDays = this.tokenBuckets.days.filter(
      (b) => periodToMs(b.period) < dayCutoff,
    );
    if (staleDays.length > 0) {
      const byMonth = new Map<string, TokenBucket>();
      for (const d of staleDays) {
        const mKey = d.period.slice(0, 7);
        let mo = byMonth.get(mKey);
        if (!mo) {
          mo = {
            period: mKey,
            inputTokens: 0,
            outputTokens: 0,
            requests: 0,
            byModel: {},
          };
          byMonth.set(mKey, mo);
        }
        this.mergeBucket(mo, d);
      }
      for (const [mKey, consolidated] of byMonth) {
        const existing = this.tokenBuckets.months.find(
          (b) => b.period === mKey,
        );
        if (existing) {
          this.mergeBucket(existing, consolidated);
        } else {
          this.tokenBuckets.months.push(consolidated);
        }
      }
      this.tokenBuckets.days = this.tokenBuckets.days.filter(
        (b) => periodToMs(b.period) >= dayCutoff,
      );
    }
  }

  private mergeBucket(target: TokenBucket, source: TokenBucket): void {
    target.inputTokens += source.inputTokens;
    target.outputTokens += source.outputTokens;
    target.requests += source.requests;
    for (const [model, data] of Object.entries(source.byModel)) {
      if (!target.byModel[model]) {
        target.byModel[model] = {
          inputTokens: 0,
          outputTokens: 0,
          requests: 0,
        };
      }
      target.byModel[model].inputTokens += data.inputTokens;
      target.byModel[model].outputTokens += data.outputTokens;
      target.byModel[model].requests += data.requests;
    }
  }

  private getTierRank(account: AccountRuntime): number {
    const tier = account.config.tier || "unknown";
    if (tier === "ultra") return 0;
    if (tier === "pro") return 1;
    if (tier === "plus") return 2;
    if (tier === "free") return 3;
    return 4;
  }

  private refreshHealthScores(): void {
    for (const account of this.accounts) {
      account.healthScore = this.getHealthScoreBreakdown(account).score;
    }
  }

  private getHealthScoreBreakdown(
    account: AccountRuntime,
  ): HealthScoreBreakdown {
    const quotaAverage =
      account.quota.length > 0
        ? account.quota.reduce(
            (sum, quota) => sum + quota.percentRemaining,
            0,
          ) / account.quota.length
        : 50;
    const errorPenalty = Math.min(0.5, account.consecutiveErrors * 0.1);
    const cooldownPenalty =
      Object.keys(account.cooldownsByModel).length > 0 ? 0.1 : 0;
    const availabilityPenalty = account.flagged
      ? 1
      : account.disabled
        ? 0.75
        : 0;
    const score = Number(
      Math.max(
        0,
        Math.min(
          1,
          quotaAverage / 100 -
            errorPenalty -
            cooldownPenalty -
            availabilityPenalty,
        ),
      ).toFixed(4),
    );
    return {
      quotaComponent: quotaAverage / 100,
      errorPenalty,
      cooldownPenalty,
      availabilityPenalty,
      score,
    };
  }

  private async saveTokenUsage(): Promise<void> {
    try {
      await setCachedTokenUsage(this.tokenBuckets);
    } catch {
      /* best effort */
    }
  }

  /**
   * Schedule a debounced token-usage save. Same coalescing pattern as
   * scheduleStateSave: multiple calls within TOKEN_USAGE_SAVE_DEBOUNCE_MS
   * collapse into a single write. recordTokenUsage() calls this instead of
   * saveTokenUsage() to avoid blocking the event loop on every request.
   */
  scheduleTokenUsageSave(): void {
    if (this.tokenUsageSaveTimer) return;
    this.tokenUsageSaveTimer = setTimeout(() => {
      this.tokenUsageSaveTimer = null;
      void this.runScheduledTokenUsageSave();
    }, AccountRotator.TOKEN_USAGE_SAVE_DEBOUNCE_MS);
    if (this.tokenUsageSaveTimer.unref) this.tokenUsageSaveTimer.unref();
  }

  private async runScheduledTokenUsageSave(): Promise<void> {
    if (this.tokenUsageSaveInflight) {
      this.tokenUsageSavePending = true;
      return;
    }
    this.tokenUsageSaveInflight = true;
    try {
      await this.saveTokenUsage();
    } finally {
      this.tokenUsageSaveInflight = false;
      if (this.tokenUsageSavePending) {
        this.tokenUsageSavePending = false;
        this.scheduleTokenUsageSave();
      }
    }
  }

  /**
   * Force-flush any pending token-usage write. Called by SIGTERM/SIGINT in
   * index.ts to minimise data loss on shutdown.
   */
  async flushPendingTokenUsageSave(): Promise<void> {
    if (this.tokenUsageSaveTimer) {
      clearTimeout(this.tokenUsageSaveTimer);
      this.tokenUsageSaveTimer = null;
    }
    await this.saveTokenUsage();
  }

  getTokenUsage(): TokenUsageData {
    // Buckets are hierarchical rollups: minutes → hours → days → months.
    // A minute period that has already been rolled into an hour bucket must
    // NOT be counted again. Same logic applies to hours→days and days→months.
    const hourPeriods = new Set(this.tokenBuckets.hours.map((b) => b.period));
    const dayPeriods = new Set(this.tokenBuckets.days.map((b) => b.period));
    const monthPeriods = new Set(this.tokenBuckets.months.map((b) => b.period));

    const minutesFiltered = this.tokenBuckets.minutes.filter(
      (b) => !hourPeriods.has(b.period.slice(0, 13)),
    );
    const hoursFiltered = this.tokenBuckets.hours.filter(
      (b) => !dayPeriods.has(b.period.slice(0, 10)),
    );
    const daysFiltered = this.tokenBuckets.days.filter(
      (b) => !monthPeriods.has(b.period.slice(0, 7)),
    );

    const all = [
      ...minutesFiltered,
      ...hoursFiltered,
      ...daysFiltered,
      ...this.tokenBuckets.months,
    ];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalRequests = 0;
    const modelTotals: Record<string, { input: number; output: number }> = {};
    for (const b of all) {
      totalInputTokens += b.inputTokens;
      totalOutputTokens += b.outputTokens;
      totalRequests += b.requests;
      for (const [model, data] of Object.entries(b.byModel)) {
        if (!modelTotals[model]) modelTotals[model] = { input: 0, output: 0 };
        modelTotals[model].input += data.inputTokens;
        modelTotals[model].output += data.outputTokens;
      }
    }

    // Calculate savings
    let totalUsd = 0;
    const byModel: TokenUsageData["savings"]["byModel"] = {};
    for (const [model, totals] of Object.entries(modelTotals)) {
      let pricing = MODEL_PRICING[model];
      if (!pricing) {
        const lower = model.toLowerCase();
        if (lower.includes("opus")) pricing = MODEL_PRICING["claude-opus-4-6-thinking"];
        else if (lower.includes("sonnet")) pricing = MODEL_PRICING["claude-sonnet-4-6"];
        else if (lower.includes("3.7-flash")) pricing = MODEL_PRICING["gemini-3.7-flash-tiered"];
        else if (lower.includes("3.6-flash")) pricing = MODEL_PRICING["gemini-3.6-flash-high"];
        else if (lower.includes("3.5-flash")) pricing = MODEL_PRICING["gemini-3.5-flash-high"];
        else if (lower.includes("flash")) pricing = MODEL_PRICING["gemini-3-flash"];
        else if (lower.includes("pro")) pricing = MODEL_PRICING["gemini-3.1-pro"];
      }
      if (!pricing) continue;
      const inputUsd = (totals.input / 1_000_000) * pricing.inputPer1M;
      const outputUsd = (totals.output / 1_000_000) * pricing.outputPer1M;
      byModel[model] = { inputUsd, outputUsd, totalUsd: inputUsd + outputUsd };
      totalUsd += inputUsd + outputUsd;
    }

    // Build tokensByModel with raw counts (from deduplicated buckets)
    const tokensByModel: Record<
      string,
      { input: number; output: number; requests: number }
    > = {};
    for (const [model, t] of Object.entries(modelTotals)) {
      tokensByModel[model] = { input: t.input, output: t.output, requests: 0 };
    }
    for (const b of all) {
      for (const [model, data] of Object.entries(b.byModel)) {
        if (tokensByModel[model])
          tokensByModel[model].requests += data.requests;
      }
    }

    return {
      minutes: this.tokenBuckets.minutes
        .slice()
        .sort((a, b) => a.period.localeCompare(b.period)),
      hours: this.tokenBuckets.hours
        .slice()
        .sort((a, b) => a.period.localeCompare(b.period)),
      days: this.tokenBuckets.days
        .slice()
        .sort((a, b) => a.period.localeCompare(b.period)),
      months: this.tokenBuckets.months
        .slice()
        .sort((a, b) => a.period.localeCompare(b.period)),
      totalInputTokens,
      totalOutputTokens,
      totalRequests,
      tokensByModel,
      savings: { totalUsd, byModel },
    };
  }

  // Mark an account as exhausted (429 or quota exceeded)
  markExhausted(
    account: AccountRuntime,
    model: string | undefined,
    cooldownMs: number,
    errorText?: string,
  ): void {
    const now = Date.now();
    const modelKey = model
      ? (this.resolvePoolKeyForModel(model) ?? resolveQuotaModelKey(model) ?? "__default__")
      : "__default__";
    if (model && (modelKey.startsWith(`${CODEX_QUOTA_MODEL_KEY}:`) || isCodexRequestModel(model))) {
      this.setProviderCooldown(account, "openai-codex", cooldownMs);
    }
    account.cooldownsByModel[modelKey] = now + cooldownMs;
    account.quotaExhaustedAt = now;

    const errorDetail = errorText ? ` | ${errorText}` : "";
    this.log(
      `${account.config.label || account.config.email} [${modelKey}]: EXHAUSTED, cooldown ${Math.ceil(cooldownMs / 1000)}s${errorDetail}`,
      "warn",
    );
    this.scheduleStateSave();
  }

  recordProvider429(
    account: AccountRuntime,
    model: string | undefined,
    cooldownMs: number,
    providerResourceExhausted = false,
  ): void {
    const now = Date.now();
    if (model && isCodexRequestModel(model)) {
      this.setProviderCooldown(account, "openai-codex", cooldownMs);
      return;
    }
    const poolKey = model ? this.resolvePoolKeyForModel(model) : null;
    const isAccountScopedProvider =
      providerResourceExhausted ||
      (poolKey && (poolKey.startsWith("opencode-zen") || poolKey.startsWith("session")));

    if (isAccountScopedProvider) {
      // Account-level daily/weekly quota exhaustion or per-key rate limit is not a model outage:
      // the account already gets an individual cooldown from markExhausted,
      // so it must not arm the project or model circuit breaker and block
      // healthy accounts that still have quota.
      return;
    }
    const modelKey = model
      ? (this.resolvePoolKeyForModel(model) ?? resolveQuotaModelKey(model) ?? "__default__")
      : "__default__";
    const windowMs =
      this.config.projectCircuitBreakerWindowMs ?? 10 * 60 * 1000;
    const threshold = this.config.projectCircuitBreaker429Threshold ?? 3;
    const breakerCooldownMs =
      this.config.projectCircuitBreakerCooldownMs ?? 60 * 60 * 1000;
    const projectId = account.config.projectId ?? "";
    this.provider429Events = this.provider429Events
      .filter((event) => now - event.ts <= windowMs)
      .concat({ ts: now, projectId, modelKey, account: account.config.email });
    const uniqueAccounts = new Set(
      this.provider429Events
        .filter(
          (event) =>
            event.projectId === projectId && event.modelKey === modelKey,
        )
        .map((event) => event.account),
    );
    const modelUniqueAccounts = new Set(
      this.provider429Events
        .filter((event) => event.modelKey === modelKey)
        .map((event) => event.account),
    );
    if (uniqueAccounts.size >= threshold) {
      const until = now + Math.max(cooldownMs, breakerCooldownMs);
      this.projectModelBreakers[projectModelKey(projectId, modelKey)] = until;
      this.log(
        `[${modelKey}] Project circuit breaker active for projectId=${projectId} after ${uniqueAccounts.size} accounts hit 429; cooldown ${Math.ceil((until - now) / 1000)}s`,
        "warn",
      );
    }
    const modelThreshold =
      this.config.modelCircuitBreaker429Threshold ?? threshold;
    if (modelUniqueAccounts.size >= modelThreshold) {
      const until =
        now +
        Math.max(
          cooldownMs,
          this.config.modelCircuitBreakerCooldownMs ?? 6 * 60 * 60 * 1000,
        );
      this.modelBreakers[modelKey] = until;
      this.log(
        `[${modelKey}] Model circuit breaker active after ${modelUniqueAccounts.size} unique accounts hit provider 429; cooldown ${Math.ceil((until - now) / 1000)}s`,
        "warn",
      );
    }
    void this.saveState();
  }

  recordUpstreamAttempt(account: AccountRuntime): void {
    const now = Date.now();
    this.rollDailySafetyIfNeeded(now);
    this.getAccountDailyCount(account, now);
    account.dailyRequestCount++;
    this.projectRequests[account.config.projectId ?? ""] =
      (this.projectRequests[account.config.projectId ?? ""] ?? 0) + 1;
    this.scheduleStateSave();
  }

  getSafetyJitterMs(account: AccountRuntime): number {
    const now = Date.now();
    const accountSlow =
      this.getAccountDailyCount(account, now) >=
      (this.config.dailyAccountSlowRequests ?? 250);
    const projectSlow =
      this.getProjectDailyCount(account.config.projectId ?? "", now) >=
      (this.config.dailyProjectSlowRequests ?? 900);
    if (!accountSlow && !projectSlow) return 0;
    const min = this.config.slowModeJitterMinMs ?? 8_000;
    const max = Math.max(min, this.config.slowModeJitterMaxMs ?? 25_000);
    return Math.floor(min + Math.random() * (max - min + 1));
  }

  getGlobalDelayMs(): number {
    return this.config.globalRequestDelayMs ?? 0;
  }

  markError(account: AccountRuntime, error: string): void {
    account.lastError = error;
    account.consecutiveErrors++;
    if (account.consecutiveErrors >= 5) {
      account.disabled = true;
      this.log(
        `${account.config.email}: DISABLED after ${account.consecutiveErrors} consecutive errors`,
        "error",
      );
    }
    this.scheduleStateSave();
  }

  async enableAccount(email: string): Promise<boolean> {
    const account = this.accounts.find((a) => a.config.email === email);
    if (!account) return false;
    if (account.flagged) {
      this.log(
        `${email}: refused re-enable because account is flagged; resolve the provider block first`,
        "warn",
      );
      return false;
    }
    account.disabled = false;
    account.flagged = false;
    account.consecutiveErrors = 0;
    account.lastError = null;
    account.cooldownsByModel = {};
    await this.saveState();
    this.log(`${email}: re-enabled`);
    return true;
  }

  async disableAccount(email: string): Promise<boolean> {
    const account = this.accounts.find((a) => a.config.email === email);
    if (!account) return false;
    account.disabled = true;
    account.lastError = "Disabled by operator";
    await this.saveState();
    this.log(`${email}: disabled by operator`, "warn");
    return true;
  }

  async quarantineAccount(
    email: string,
    reason = "Quarantined by operator",
  ): Promise<boolean> {
    const account = this.accounts.find((a) => a.config.email === email);
    if (!account) return false;
    account.flagged = true;
    account.lastError = reason;
    await this.saveState();
    this.log(`${email}: quarantined by operator`, "warn");
    return true;
  }

  async restoreAccount(email: string): Promise<boolean> {
    const account = this.accounts.find((a) => a.config.email === email);
    if (!account) return false;
    account.disabled = false;
    account.flagged = false;
    account.consecutiveErrors = 0;
    account.lastError = null;
    await this.saveState();
    this.log(`${email}: restored by operator`, "warn");
    return true;
  }

  async updateAccountMetadata(
    email: string,
    patch: Partial<AccountConfig>,
  ): Promise<boolean> {
    const account = this.accounts.find((a) => a.config.email === email);
    if (!account) return false;
    account.config = { ...account.config, ...patch };
    const existing = this.config.accounts.find(
      (entry) => entry.email === email,
    );
    if (existing) Object.assign(existing, patch);
    await saveAccountsConfig(this.config);
    await this.saveState();
    this.log(`${email}: metadata updated by operator`, "warn");
    return true;
  }

  async setAllowFreshWindowStarts(enabled: boolean): Promise<boolean> {
    if (this.allowFreshWindowStarts === enabled) return false;
    this.allowFreshWindowStarts = enabled;
    await this.saveState();
    this.log(
      enabled
        ? "Operator enabled fresh window starts; the rotator may seed new timer windows again"
        : "Operator disabled fresh window starts; the rotator will only use buckets whose timers are already running",
      "warn",
    );
    return true;
  }

  async setAccountAllowFreshWindowStartsOverride(
    email: string,
    enabled: boolean,
  ): Promise<boolean> {
    const account = this.accounts.find((a) => a.config.email === email);
    if (!account) return false;
    if (account.allowFreshWindowStartsOverride === enabled) return true;
    account.allowFreshWindowStartsOverride = enabled;
    await this.saveState();
    this.log(
      enabled
        ? `${email}: operator override enabled fresh window starts for this account`
        : `${email}: operator override cleared; this account now follows the global fresh-window policy`,
      "warn",
    );
    return true;
  }

  async setAutoWarmup(enabled: boolean): Promise<boolean> {
    if (this.autoWarmupEnabled === enabled) return false;
    this.autoWarmupEnabled = enabled;
    await this.saveState();
    this.log(
      enabled
        ? "Operator enabled auto-warmup; accounts with fresh-window override will automatically receive minimal kickstart requests on each quota poll"
        : "Operator disabled auto-warmup; no automatic kickstart requests will be sent",
      "warn",
    );
    return true;
  }

  async clearModelBreaker(modelKey: string): Promise<boolean> {
    const now = Date.now();
    const hasModelBreaker = (this.modelBreakers[modelKey] ?? 0) > now;
    const hadAny = hasModelBreaker;
    delete this.modelBreakers[modelKey];
    // Also clear all project-level breakers for this model
    for (const key of Object.keys(this.projectModelBreakers)) {
      if (key.endsWith(`:${modelKey}`)) {
        delete this.projectModelBreakers[key];
      }
    }
    // Clear the 429 event window so the breaker doesn't immediately re-fire
    this.provider429Events = this.provider429Events.filter(
      (e) => e.modelKey !== modelKey,
    );
    await this.saveState();
    this.log(`[${modelKey}] Operator manually cleared circuit breaker`, "warn");
    return hadAny;
  }

  async clearAllBreakers(): Promise<number> {
    const count =
      Object.keys(this.modelBreakers).length +
      Object.keys(this.projectModelBreakers).length;
    this.modelBreakers = {};
    this.projectModelBreakers = {};
    this.provider429Events = [];
    await this.saveState();
    this.log(
      `Operator cleared all circuit breakers (${count} entries)`,
      "warn",
    );
    return count;
  }

  clearInFlightRequests(email: string, modelKey?: string): boolean {
    const account = this.accounts.find((a) => a.config.email === email);
    if (!account) return false;
    if (modelKey) {
      const previous = account.inFlightByModel[modelKey] ?? 0;
      account.inFlightByModel[modelKey] = 0;
      this.recalculateInFlightRequests(account);
      this.log(
        `${email}: operator cleared ${previous} in-flight request(s) for ${modelKey}`,
        "warn",
      );
      return true;
    }
    const previous = account.inFlightRequests;
    account.inFlightRequests = 0;
    account.inFlightByModel = {};
    this.log(
      `${email}: operator cleared ${previous} in-flight request(s)`,
      "warn",
    );
    return true;
  }

  async ensureValidToken(account: AccountRuntime, providerId?: string): Promise<void> {
    if (providerId) {
      await this.ensureValidTokenForProvider(account, providerId);
      return;
    }
    const adapter = getProviderForAccount(account.config);
    try {
      await adapter.ensureValidToken(account);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("Token refresh failed")) {
        this.markError(account, msg);
        throw err;
      }
      const wrapped = `Token refresh error: ${msg}`;
      this.markError(account, wrapped);
      throw new Error(wrapped, { cause: err });
    }
  }

  async ensureValidTokenForProvider(
    account: AccountRuntime,
    providerId: string,
  ): Promise<void> {
    const adapter = getProviderAdapter(providerId);
    try {
      await adapter.ensureValidToken(account);
    } catch (error) {
      if (
        providerId === "openai-codex" &&
        (error instanceof CodexOAuthError ||
          (typeof error === "object" && error !== null &&
            (error as { reloginRequired?: unknown }).reloginRequired === true))
      ) {
        const reason = error instanceof Error
          ? error.message
          : "Codex credential requires re-authentication";
        this.markProviderInvalid(account, providerId, reason);
      }
      throw error;
    }
  }

  private isCodexPoolKey(modelKey: string): boolean {
    return modelKey.startsWith(`${CODEX_QUOTA_MODEL_KEY}:`);
  }

  private async ensureValidTokenForModel(
    account: AccountRuntime,
    modelKey: string | null,
  ): Promise<void> {
    if (modelKey) {
      const providerId = getProviderIdForPoolKey(modelKey);
      await this.ensureValidToken(account, providerId);
      return;
    }
    await this.ensureValidToken(account);
  }

  markProviderInvalid(
    account: AccountRuntime,
    providerId: string,
    reason: string,
  ): void {
    account.invalidProviders ??= {};
    account.invalidProviders[providerId] = reason;
    account.providerTokens ??= {};
    account.providerTokens[providerId] = { accessToken: null, tokenExpires: 0 };
    account.lastError = reason;
    this.log(`${account.config.email}: ${providerId} credential requires re-authentication`, "warn");
    this.scheduleStateSave();
  }

  setProviderCooldown(
    account: AccountRuntime,
    providerId: string,
    durationMs: number,
  ): void {
    account.providerCooldowns ??= {};
    account.providerCooldowns[providerId] = Math.max(
      account.providerCooldowns[providerId] ?? 0,
      Date.now() + Math.max(0, durationMs),
    );
    this.scheduleStateSave();
  }

  private isAvailable(account: AccountRuntime, now: number): boolean {
    if (account.disabled) return false;
    if (account.flagged) return false;
    const defaultCooldown = account.cooldownsByModel["__default__"] ?? 0;
    if (defaultCooldown > now) return false;
    return true;
  }

  private isAvailableForModel(
    account: AccountRuntime,
    modelKey: string,
    now: number,
  ): boolean {
    if (!this.isAvailable(account, now)) return false;
    const providerId = getProviderIdForPoolKey(modelKey);
    if (account.invalidProviders?.[providerId]) return false;
    if ((account.providerCooldowns?.[providerId] ?? 0) > now) return false;
    const modelCooldown = account.cooldownsByModel[modelKey] ?? 0;
    if (modelCooldown > now) return false;
    // Ollama Cloud (pool key "session") imposes no per-account concurrency
    // limit. Antigravity keeps it so long streams don't pile up on a
    // single account while siblings sit idle.
    if (
      modelKey !== "session" &&
      (account.inFlightByModel[modelKey] ?? 0) >=
      (this.config.maxConcurrentRequestsPerAccount ?? 1)
    )
      return false;
    if (this.getUnavailableReasonForModel(account, modelKey, now)) return false;
    return true;
  }

  // Mark an account as flagged for infringement/abuse. Immediately excluded from rotation.
  markFlagged(
    account: AccountRuntime,
    reason: string,
    options: { triggerProtectivePause?: boolean } = {},
  ): void {
    account.flagged = true;
    account.lastError = reason;
    account.inFlightRequests = 0;
    account.inFlightByModel = {};
    this.log(`${account.config.email}: FLAGGED - ${reason}`, "error");
    const triggerProtectivePause = options.triggerProtectivePause ?? true;
    if (triggerProtectivePause && this.shouldTriggerProtectivePause(reason)) {
      this.protectivePauseUntil =
        Date.now() + (this.config.protectivePauseMs ?? 6 * 60 * 60 * 1000);
      this.protectivePauseReason = `${account.config.email}: ${reason}`;
      this.log(
        `Protective pause enabled for ${Math.ceil((this.protectivePauseUntil - Date.now()) / 1000)}s after serious provider flag`,
        "warn",
      );
    }
    this.scheduleStateSave();
  }

  startRequest(account: AccountRuntime, modelKey?: string): void {
    const key = modelKey ?? "__default__";
    // Ollama Cloud imposes no per-account concurrency limit, so its
    // requests must not activate in-flight tracking at all (pool key
    // "session" and raw ollama model names from benchmark probes).
    if (key === "session" || this.ollamaModels.has(key)) {
      this.consumeTokenBucket(account, Date.now());
      return;
    }
    account.inFlightByModel[key] = (account.inFlightByModel[key] ?? 0) + 1;
    this.recalculateInFlightRequests(account);
    this.consumeTokenBucket(account, Date.now());
  }

  finishRequest(account: AccountRuntime, modelKey?: string): void {
    const key = modelKey ?? "__default__";
    if (key === "session" || this.ollamaModels.has(key)) return;
    account.inFlightByModel[key] = Math.max(
      0,
      (account.inFlightByModel[key] ?? 0) - 1,
    );
    if (account.inFlightByModel[key] === 0) delete account.inFlightByModel[key];
    this.recalculateInFlightRequests(account);
  }

  private recalculateInFlightRequests(account: AccountRuntime): void {
    account.inFlightRequests = Object.values(account.inFlightByModel).reduce(
      (sum, count) => sum + count,
      0,
    );
  }

  private isProviderEligibleForKey(
    account: AccountRuntime,
    modelKey: string,
  ): boolean {
    const providerId = getProviderIdForPoolKey(modelKey);
    return hasCredential(account.config, providerId) &&
      !account.invalidProviders?.[providerId] &&
      (account.providerCooldowns?.[providerId] ?? 0) <= Date.now();
  }

  /** Public pool-key resolution for quota routing display/logging. */
  resolveQuotaModelKeyForDisplay(model: string): string | null {
    return this.resolvePoolKeyForModel(model);
  }

  private resolvePoolKeyForModel(model: string): string | null {
    const context = {
      ollamaModels: this.ollamaModels,
      codexModels: this.codexModels,
    };
    const adapter = findProviderForModel(model, context);
    if (adapter?.getPoolKey) {
      return adapter.getPoolKey(model);
    }
    return resolveQuotaModelKey(model) ?? null;
  }

  /** Map a candidate key (model name or pool key) to the account's pool key. */
  private resolvePoolKey(account: AccountRuntime, key: string): string {
    if (
      hasCredential(account.config, "ollama") &&
      key !== "session" &&
      this.ollamaModels.has(key)
    ) {
      return "session";
    }
    return key;
  }

  private isRoutableForModel(
    account: AccountRuntime,
    modelKey: string,
    now: number,
  ): boolean {
    modelKey = this.resolvePoolKey(account, modelKey);
    if (!this.isProviderEligibleForKey(account, modelKey)) return false;
    if (!this.isAvailableForModel(account, modelKey, now)) return false;
    if (this.getModelQuota(account, modelKey) === 0) return false;
    if (!this.isFreshWindowAllowed(account, modelKey)) return false;
    if ((this.config.routingPolicy || "timer-first") === "hybrid") {
      const tokenSnapshot = this.getTokenBucketSnapshot(account, now);
      if (tokenSnapshot.enabled && tokenSnapshot.tokens < 1) return false;
    }
    return true;
  }

  getRetryAfterMs(model?: string): number {
    const now = Date.now();
    const retryTimes: number[] = [];
    if (this.protectivePauseUntil > now)
      retryTimes.push(this.protectivePauseUntil);
    const modelKey = model
      ? (this.resolvePoolKeyForModel(model) ?? resolveQuotaModelKey(model) ?? "__default__")
      : "__default__";
    const dailyResetAt = nextUtcDayStartMs(now);
    const modelBreaker = this.modelBreakers[modelKey] ?? 0;
    if (modelBreaker > now) retryTimes.push(modelBreaker);
    for (const account of this.accounts) {
      if (account.disabled || account.flagged) continue;
      if (this.isDailySafetyStopped(account, now))
        retryTimes.push(dailyResetAt);
      const cooldown = Math.max(
        account.cooldownsByModel[modelKey] ?? 0,
        account.cooldownsByModel.__default__ ?? 0,
      );
      if (cooldown > now) retryTimes.push(cooldown);
      const projectBreaker =
        this.projectModelBreakers[
          projectModelKey(account.config.projectId ?? "", modelKey)
        ] ?? 0;
      if (projectBreaker > now) retryTimes.push(projectBreaker);
      if ((this.config.routingPolicy || "timer-first") === "hybrid") {
        const tokenSnapshot = this.getTokenBucketSnapshot(account, now);
        if (
          tokenSnapshot.enabled &&
          tokenSnapshot.tokens < 1 &&
          tokenSnapshot.nextRefillInMs > 0
        ) {
          retryTimes.push(now + tokenSnapshot.nextRefillInMs);
        }
      }
    }
    if (retryTimes.length === 0) return 0;
    return Math.max(1000, Math.min(...retryTimes) - now);
  }

  getStatus(): StatusResponse {
    const now = Date.now();
    this.refreshHealthScores();

    // Build per-model active account map from accounts that can actually serve now.
    const activeAccounts: Record<string, string> = {};
    for (const [model, mState] of this.modelState.entries()) {
      const account = this.accounts[mState.activeAccountIndex];
      if (account && this.isRoutableForModel(account, model, now)) {
        activeAccounts[model] = account.config.email;
      }
    }

    const accounts: AccountStatus[] = this.accounts.map((a) => {
      // Determine which models this account is active for
      const activeForModels: string[] = [];
      for (const [model, mState] of this.modelState.entries()) {
        if (
          this.accounts[mState.activeAccountIndex] === a &&
          this.isRoutableForModel(a, model, now)
        ) {
          activeForModels.push(model);
        }
      }
      const status = this.getAccountStatusForUi(a, now, activeForModels);
      const tokenBucket = this.getTokenBucketSnapshot(a, now);

      return {
        email: a.config.email,
        provider:
          (a.config.credentials ?? []).map((c) => c.provider).join("+") ||
          a.config.provider ||
          "google-antigravity",
        label: a.config.label || a.config.email,
        status,
        activeForModels,
        requestsSinceRotation: a.requestsSinceRotation,
        totalRequests: a.totalRequests,
        dailyRequestCount: this.getAccountDailyCount(a, now),
        dailyAccountStopRequests: this.config.dailyAccountStopRequests ?? 350,
        dailyProjectRequestCount: this.getProjectDailyCount(a.config.projectId ?? "",
          now,
        ),
        dailyProjectStopRequests: this.config.dailyProjectStopRequests ?? 1200,
        cooldownsByModel: a.cooldownsByModel,
        lastUsed: a.lastUsed,
        lastError: a.lastError,
        consecutiveErrors: a.consecutiveErrors,
        hasValidToken: !!(a.accessToken && a.tokenExpires > now),
        invalidProviders: a.invalidProviders,
        providerCooldowns: a.providerCooldowns,
        quota: a.quota,
        inFlightRequests: a.inFlightRequests,
        inFlightByModel: a.inFlightByModel,
        proDetected: a.config.type === "pro",
        tier: a.config.tier || "unknown",
        healthScore: a.healthScore,
        tokenBucket,
        allowFreshWindowStartsOverride: a.allowFreshWindowStartsOverride,
        effectiveFreshWindowStartsAllowed:
          this.isEffectiveFreshWindowAllowed(a),
      };
    });

    const routingHealth = this.getRoutingHealth(now, accounts);
    const knownModels = new Set<string>();
    for (const model of this.modelState.keys()) knownModels.add(model);
    for (const model of Object.keys(this.modelBreakers)) knownModels.add(model);
    for (const key of Object.keys(this.projectModelBreakers)) {
      const model = key.split("::")[1];
      if (model) knownModels.add(model);
    }
    for (const account of this.accounts) {
      for (const quota of account.quota) knownModels.add(quota.modelKey);
      for (const cooldownModel of Object.keys(account.cooldownsByModel)) {
        if (cooldownModel !== "__default__") knownModels.add(cooldownModel);
      }
    }
    const routingDiagnostics: Record<string, RoutingModelDiagnostics> = {};
    for (const modelKey of knownModels) {
      routingDiagnostics[modelKey] = this.buildRoutingDiagnostics(
        modelKey,
        now,
      );
    }
    this.routingDiagnostics = routingDiagnostics;

    const updateInfo = getUpdateInfo();

    // Build circuit breaker summary for the dashboard
    const modelBreakersSummary: Record<
      string,
      { until: number; remainingMs: number }
    > = {};
    for (const [key, until] of Object.entries(this.modelBreakers)) {
      if (until > now) {
        modelBreakersSummary[key] = { until, remainingMs: until - now };
      }
    }
    const projectBreakersSummary: Record<
      string,
      { until: number; remainingMs: number }
    > = {};
    for (const [key, until] of Object.entries(this.projectModelBreakers)) {
      if (until > now) {
        projectBreakersSummary[key] = { until, remainingMs: until - now };
      }
    }

    const adminWarning = getConfiguredAdminToken()
      ? null
      : `Admin routes are exposed on ${this.config.bindHost}:${this.config.proxyPort} because TUXEVIL_ROTATOR_ADMIN_TOKEN is not configured.`;
    const proxyWarning = getProxyExposureWarning(this.config);

    return {
      version: updateInfo.currentVersion,
      proxyPort: this.config.proxyPort,
      requestsPerRotation: this.config.requestsPerRotation,
      activeAccounts,
      totalRequestsAllAccounts: this.accounts.reduce(
        (sum, a) => sum + a.totalRequests,
        0,
      ),
      uptime: now - this.startTime,
      protectivePauseUntil: this.protectivePauseUntil,
      protectivePauseRemaining: Math.max(0, this.protectivePauseUntil - now),
      protectivePauseReason: this.isProtectivePauseActive(now)
        ? this.protectivePauseReason
        : null,
      operatorControls: {
        allowFreshWindowStarts: this.allowFreshWindowStarts,
        autoWarmupEnabled: this.autoWarmupEnabled,
      },
      security: {
        adminTokenConfigured: !!getConfiguredAdminToken(),
        warning: [adminWarning, proxyWarning].filter(Boolean).join(" ") || null,
        bindHost: this.config.bindHost || "0.0.0.0",
      },
      routingDiagnostics,
      circuitBreakers: {
        model: modelBreakersSummary,
        project: projectBreakersSummary,
      },
      routingHealth,
      accounts,
      recentEvents: [...this.recentEvents],
      requestLog: this.requestLog.slice(0, 100),
      tokenUsage: this.getTokenUsage(),
      latencyStats: this.getLatencyStats(),
      updateInfo,
      notifications: getNotifications(),
      hostedOAuthConfigured: isHostedOAuthConfigured(),
      ollamaModels: this.getOllamaModels(),
      codexModels: this.getCodexModels(),
      modelTierAccess: this.accounts.some((a) =>
        hasCredential(a.config, "ollama"),
      )
        ? MODEL_TIER_ACCESS
        : undefined,
      predictions: this.getPredictionSummary(),
    };
  }

  getConfig(): Config {
    return applyConfigDefaults(structuredClone(this.config));
  }

  async replaceConfig(nextConfig: Config): Promise<void> {
    const normalized = applyConfigDefaults(nextConfig);
    const previous = new Map(
      this.accounts.map((account) => [account.config.email, account]),
    );
    this.config = normalized;
    this.accounts = normalized.accounts.map((config) => {
      const existing = previous.get(config.email);
      if (existing) {
        return {
          ...existing,
          config: { ...existing.config, ...config },
        };
      }
      return {
        config,
        accessToken: null,
        tokenExpires: 0,
        requestsSinceRotation: 0,
        totalRequests: 0,
        cooldownsByModel: {},
        quotaExhaustedAt: 0,
        quota: [],
        lastQuotaPoll: 0,
        lastUsed: 0,
        lastError: null,
        consecutiveErrors: 0,
        disabled: false,
        flagged: false,
        inFlightRequests: 0,
        inFlightByModel: {},
        allowFreshWindowStartsOverride: false,
        dailyRequestCount: 0,
        dailyRequestDay: currentUtcDay(),
        healthScore: 1,
        tokenBucket: {
          tokens: Math.max(
            0,
            Math.min(
              this.config.tokenBucketInitialTokens ?? 50,
              this.config.tokenBucketMaxTokens ?? 50,
            ),
          ),
          lastRefillAt: Date.now(),
        },
      };
    });
    await saveAccountsConfig(this.config);
    await this.saveState();
    this.refreshHealthScores();
  }

  getAccountCount(): number {
    return this.accounts.length;
  }

  /**
   * Get contextual data for telemetry flag reporting.
   * Returns anonymous pool state — no emails or PII.
   */
  getFlagContext(
    account: AccountRuntime,
    modelKey: string,
  ): {
    wasProAccount: boolean;
    accountQuotaPercent: number;
    timerType: string;
    poolSize: number;
    poolHealthyCount: number;
    protectivePauseTriggered: boolean;
    accountRequestsLastHour: number;
    uptimeSeconds: number;
  } {
    const now = Date.now();
    const quota = this.getModelQuota(account, modelKey);
    const timerType = this.getModelTimerType(account, modelKey);
    const healthyCount = this.accounts.filter(
      (a) => !a.disabled && !a.flagged && this.isAvailable(a, now),
    ).length;

    // Count requests in the last hour from request log
    const oneHourAgo = now - 3600_000;
    const label = account.config.label || account.config.email;
    const requestsLastHour = this.requestLog.filter(
      (e) => e.timestamp >= oneHourAgo && e.account === label,
    ).length;

    return {
      wasProAccount: account.config.type === "pro",
      accountQuotaPercent: quota,
      timerType,
      poolSize: this.accounts.length,
      poolHealthyCount: healthyCount,
      protectivePauseTriggered: this.protectivePauseUntil > now,
      accountRequestsLastHour: requestsLastHour,
      uptimeSeconds: Math.round((now - this.startTime) / 1000),
    };
  }

  async addOrUpdateAccount(accountConfig: AccountConfig): Promise<void> {
    const existingIndex = this.accounts.findIndex(
      (account) => account.config.email === accountConfig.email,
    );
    if (existingIndex >= 0) {
      const existing = this.accounts[existingIndex];
      existing.config = {
        ...existing.config,
        ...accountConfig,
        tier: accountConfig.tier || existing.config.tier || "unknown",
      };
      existing.disabled = false;
      existing.flagged = false;
      existing.lastError = null;
      existing.consecutiveErrors = 0;
      existing.accessToken = null;
      existing.tokenExpires = 0;
      this.config.accounts[existingIndex] = existing.config;
      this.log(`${accountConfig.email}: account updated via hosted login`);
    } else {
      const runtime: AccountRuntime = {
        config: { ...accountConfig, tier: accountConfig.tier || "unknown" },
        accessToken: null,
        tokenExpires: 0,
        requestsSinceRotation: 0,
        totalRequests: 0,
        cooldownsByModel: {},
        quotaExhaustedAt: 0,
        quota: [],
        lastQuotaPoll: 0,
        lastUsed: 0,
        lastError: null,
        consecutiveErrors: 0,
        disabled: false,
        flagged: false,
        inFlightRequests: 0,
        inFlightByModel: {},
        allowFreshWindowStartsOverride: false,
        dailyRequestCount: 0,
        dailyRequestDay: currentUtcDay(),
        healthScore: 1,
        tokenBucket: {
          tokens: Math.max(
            0,
            Math.min(
              this.config.tokenBucketInitialTokens ?? 50,
              this.config.tokenBucketMaxTokens ?? 50,
            ),
          ),
          lastRefillAt: Date.now(),
        },
      };
      this.accounts.push(runtime);
      this.config.accounts.push(runtime.config);
      this.log(`${accountConfig.email}: account added via hosted login`);
    }

    await saveAccountsConfig(this.config);
    await this.saveState();
    void this.pollAllQuotas();
  }

  async removeAccount(email: string): Promise<boolean> {
    const idx = this.accounts.findIndex((a) => a.config.email === email);
    if (idx < 0) return false;
    const account = this.accounts[idx];
    if (account.inFlightRequests > 0) {
      this.log(
        `${email}: refusing to remove - ${account.inFlightRequests} in-flight requests`,
        "warn",
      );
      return false;
    }
    this.accounts.splice(idx, 1);
    const configIdx = this.config.accounts.findIndex((a) => a.email === email);
    if (configIdx >= 0) this.config.accounts.splice(configIdx, 1);

    // Fix up modelState indices that may now be stale after the splice
    for (const [, mState] of this.modelState.entries()) {
      if (mState.activeAccountIndex > idx) {
        mState.activeAccountIndex--;
      } else if (mState.activeAccountIndex === idx) {
        mState.activeAccountIndex =
          this.accounts.length > 0
            ? Math.min(mState.activeAccountIndex, this.accounts.length - 1)
            : 0;
      }
    }
    if (this.defaultIndex > idx) {
      this.defaultIndex--;
    } else if (
      this.defaultIndex >= this.accounts.length &&
      this.accounts.length > 0
    ) {
      this.defaultIndex = this.accounts.length - 1;
    }

    await removeAccountFromConfig(email);
    await this.saveState();
    this.log(`${email}: account removed`);
    return true;
  }

  async setAccountTier(email: string, tier: string): Promise<boolean> {
    const validTiers = ["unknown", "free", "plus", "pro", "ultra"];
    if (!validTiers.includes(tier)) return false;
    const account = this.accounts.find((a) => a.config.email === email);
    if (!account) return false;
    account.config.tier = tier as AccountTier;
    const configAccount = this.config.accounts.find((a) => a.email === email);
    if (configAccount) configAccount.tier = tier as AccountTier;
    await saveAccountsConfig(this.config);
    await this.saveState();
    this.log(`${email}: tier changed to ${tier}`);
    return true;
  }

  recordProxyEvent(
    msg: string,
    level: "info" | "warn" | "error" = "info",
  ): void {
    this.pushRecentEvent("proxy", msg, level);
  }

  private log(msg: string, level: "info" | "warn" | "error" = "info"): void {
    rotatorLogger.log(level, msg);
    this.pushRecentEvent("rotator", msg, level);
  }

  private pushRecentEvent(
    source: "rotator" | "proxy",
    message: string,
    level: "info" | "warn" | "error",
  ): void {
    this.recentEvents.unshift({
      timestamp: Date.now(),
      source,
      level,
      message,
    });
    if (this.recentEvents.length > AccountRotator.RECENT_EVENT_LIMIT) {
      this.recentEvents.length = AccountRotator.RECENT_EVENT_LIMIT;
    }
  }

  public getAccountByEmail(email: string): AccountRuntime | undefined {
    return this.accounts.find((a) => a.config.email === email);
  }

  public getBenchmarkAccounts(): AccountRuntime[] {
    return this.accounts.filter((account) => !account.disabled && !account.flagged);
  }

  private shouldUseRequestCountRotation(
    account: AccountRuntime,
    model?: string,
  ): boolean {
    if (this.isQuotaAwarePolicy()) return false;
    if (!this.config.useRequestCountRotationWhenQuotaUnknownOnly) return true;
    const modelKey = model ? this.resolvePoolKeyForModel(model) : null;
    if (!modelKey) return true;
    return this.getModelQuota(account, modelKey) < 0;
  }

  private shouldTriggerProtectivePause(reason: string): boolean {
    const lower = reason.toLowerCase();
    const severePatterns = [
      "terms of service",
      "violat",
      "suspend",
      "banned",
      "abus",
      "infring",
    ];
    return severePatterns.some((pattern) => lower.includes(pattern));
  }

  private isProtectivePauseActive(now: number): boolean {
    return this.protectivePauseUntil > now;
  }

  private getRoutingHealth(
    now: number,
    accounts: AccountStatus[],
  ): StatusResponse["routingHealth"] {
    const activeCount = accounts.filter((a) => a.status === "active").length;
    const readyCount = accounts.filter((a) => a.status === "ready").length;
    const exhaustedCount = accounts.filter(
      (a) => a.status === "exhausted",
    ).length;
    const cooldownCount = accounts.filter(
      (a) => a.status === "cooldown",
    ).length;
    const flaggedCount = accounts.filter((a) => a.status === "flagged").length;
    const disabledCount = accounts.filter(
      (a) => a.status === "disabled",
    ).length;
    const errorCount = accounts.filter((a) => a.status === "error").length;
    const busyCount = accounts.filter(
      (a) =>
        a.status !== "disabled" &&
        a.status !== "flagged" &&
        a.inFlightRequests > 0,
    ).length;
    const rawAvailableCount = this.accounts.filter(
      (a) => this.isAvailable(a, now) && !this.isDailySafetyStopped(a, now),
    ).length;
    const timedAvailableCount = this.accounts.filter((account) => {
      if (!this.isAvailable(account, now)) return false;
      if (this.isDailySafetyStopped(account, now)) return false;
      const hasTimedQuota = account.quota.some(
        (q) => q.percentRemaining !== 0 && q.timerType !== "fresh",
      );
      return hasTimedQuota || account.allowFreshWindowStartsOverride;
    }).length;
    const availableCount = this.allowFreshWindowStarts
      ? rawAvailableCount
      : timedAvailableCount;
    const shortestCooldown = accounts
      .flatMap((a) =>
        Object.values(a.cooldownsByModel).map((ts) => Math.max(0, ts - now)),
      )
      .filter((rem) => rem > 0)
      .reduce((best, rem) => (best === 0 || rem < best ? rem : best), 0);
    const pauseRemaining = Math.max(0, this.protectivePauseUntil - now);
    const freshOnlyBlocked =
      !this.allowFreshWindowStarts &&
      rawAvailableCount > 0 &&
      timedAvailableCount === 0;

    if (pauseRemaining > 0) {
      return {
        state: "paused",
        reason:
          this.protectivePauseReason ||
          "Protective pause active after provider flag",
        nextRetryIn: pauseRemaining,
        availableCount,
        readyCount,
        activeCount,
        cooldownCount,
        busyCount,
        flaggedCount,
        disabledCount,
        errorCount,
      };
    }

    if (availableCount > 0) {
      const freshPolicyNote = !this.allowFreshWindowStarts
        ? " Fresh window starts are currently disabled by the operator."
        : "";
      return {
        state: "healthy",
        reason: `Routing can serve requests.${freshPolicyNote}`,
        nextRetryIn: 0,
        availableCount,
        readyCount,
        activeCount,
        cooldownCount,
        busyCount,
        flaggedCount,
        disabledCount,
        errorCount,
      };
    }

    if (freshOnlyBlocked) {
      return {
        state: "stopped",
        reason:
          "Only fresh windows remain, and the operator toggle is preventing the rotator from opening them right now.",
        nextRetryIn: 0,
        availableCount,
        readyCount,
        activeCount,
        cooldownCount,
        busyCount,
        flaggedCount,
        disabledCount,
        errorCount,
      };
    }

    if (cooldownCount > 0) {
      return {
        state: "cooldown_wait",
        reason: "All non-quarantined accounts are cooling down",
        nextRetryIn: shortestCooldown,
        availableCount,
        readyCount,
        activeCount,
        cooldownCount,
        busyCount,
        flaggedCount,
        disabledCount,
        errorCount,
      };
    }

    if (busyCount > 0) {
      return {
        state: "busy",
        reason:
          "All available accounts are currently busy with in-flight requests",
        nextRetryIn: 0,
        availableCount,
        readyCount,
        activeCount,
        cooldownCount,
        busyCount,
        flaggedCount,
        disabledCount,
        errorCount,
      };
    }

    if (exhaustedCount > 0) {
      return {
        state: "stopped",
        reason:
          "All otherwise available accounts are stopped by local daily safety budgets until the next UTC day.",
        nextRetryIn: Math.max(0, nextUtcDayStartMs(now) - now),
        availableCount,
        readyCount,
        activeCount,
        cooldownCount,
        busyCount,
        flaggedCount,
        disabledCount,
        errorCount,
      };
    }

    return {
      state: "stopped",
      reason: !this.allowFreshWindowStarts
        ? "No timed bucket is currently routable. Fresh window starts are disabled, so the rotator is waiting for an already-running timer, cooldown recovery, or operator action."
        : "No account is currently routable. All accounts are flagged, disabled, or unavailable.",
      nextRetryIn: 0,
      availableCount,
      readyCount,
      activeCount,
      cooldownCount,
      busyCount,
      flaggedCount,
      disabledCount,
      errorCount,
    };
  }

  /**
   * Send a minimal single-token request to the upstream Antigravity endpoint for a specific
   * quota pool key on a given account. Uses the cheapest model in that pool to minimise cost.
   * Applies normal error handling (markExhausted, markFlagged, markError) so the account state
   * stays consistent with regular traffic.
   */
  async kickstartTimerForAccount(
    email: string,
    quotaModelKey: string,
  ): Promise<{ ok: boolean; status: number; upstreamModel: string; error?: string }> {
    const account = this.accounts.find((a) => a.config.email === email);
    if (!account) {
      return { ok: false, status: 404, upstreamModel: "", error: "account not found" };
    }
    if (account.disabled || account.flagged) {
      return {
        ok: false,
        status: 409,
        upstreamModel: "",
        error: account.disabled ? "account disabled" : "account flagged",
      };
    }

    const target = this.getKickstartTarget(account, quotaModelKey);
    if (!target) {
      return {
        ok: false,
        status: 409,
        upstreamModel: "",
        error: "quota pool has no configured kickstart provider",
      };
    }

    try {
      await this.ensureValidTokenForProvider(account, target.providerId);
    } catch (err) {
      return {
        ok: false,
        status: 401,
        upstreamModel: "",
        error: `token refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const kickstartAdapter = target.adapter;
    const isOllamaAccount = kickstartAdapter.id === "ollama";
    if (!account.accessToken && !isOllamaAccount) {
      return { ok: false, status: 401, upstreamModel: "", error: "no access token" };
    }

    const upstreamModel = target.upstreamModel;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    let response: Response;
    if (isOllamaAccount) {
      const ollamaBody: RequestBody = {
        project: "",
        model: upstreamModel,
        request: {
          messages: [{ role: "user", content: "." }],
          options: { num_predict: 1 },
          stream: false,
        },
      };
      try {
        const forwarded = await kickstartAdapter.forwardRequest(
          account,
          ollamaBody,
          {},
          controller.signal,
        );
        response = forwarded.response;
      } catch (err) {
        clearTimeout(timeout);
        const msg = `kickstart network error: ${err instanceof Error ? err.message : String(err)}`;
        this.markError(account, msg);
        return { ok: false, status: 0, upstreamModel, error: msg };
      }
      clearTimeout(timeout);
    } else {
      const body = JSON.stringify({
        project: account.config.projectId,
        model: upstreamModel,
        request: {
          contents: [{ role: "user", parts: [{ text: "." }] }],
          generationConfig: { maxOutputTokens: 1 },
        },
      });

      const endpoint = ANTIGRAVITY_ENDPOINTS[ANTIGRAVITY_ENDPOINTS.length - 1];
      const url = `${endpoint}/v1internal:streamGenerateContent?alt=sse`;

      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${account.accessToken}`,
            "User-Agent": QUOTA_USER_AGENT,
            "X-Goog-Api-Client": REQUEST_GOOG_API_CLIENT,
            "Client-Metadata": REQUEST_CLIENT_METADATA,
          },
          body,
          signal: controller.signal,
          dispatcher: getAccountProxyDispatcher(account, "google-antigravity"),
        } as RequestInitWithDispatcher);
      } catch (err) {
        clearTimeout(timeout);
        const msg = `kickstart network error: ${err instanceof Error ? err.message : String(err)}`;
        this.markError(account, msg);
        return { ok: false, status: 0, upstreamModel, error: msg };
      }
      clearTimeout(timeout);
    }

    // Consume and discard the response body to free the connection
    try {
      await response.body?.cancel();
    } catch {
      // ignore
    }

    const label = account.config.label || account.config.email;

    if (response.status === 429) {
      const cooldownMs = 60_000;
      this.markExhausted(account, quotaModelKey, cooldownMs, "kickstart 429");
      this.recordProvider429(account, quotaModelKey, cooldownMs);
      this.log(
        `${label} [${quotaModelKey}]: kickstart 429 — cooldown ${cooldownMs / 1000}s`,
        "warn",
      );
      return { ok: false, status: 429, upstreamModel };
    }

    if (response.status === 401 || response.status === 403) {
      this.markFlagged(
        account,
        `kickstart ${response.status} on ${upstreamModel}`,
        { triggerProtectivePause: false },
      );
      return { ok: false, status: response.status, upstreamModel };
    }

    if (response.status >= 500) {
      this.markError(account, `kickstart ${response.status} on ${upstreamModel}`);
      return { ok: false, status: response.status, upstreamModel };
    }

    if (response.ok) {
      this.recordRequest(account, quotaModelKey);
      this.log(
        `${label} [${quotaModelKey}]: kickstart sent via ${upstreamModel} — timer should start within the next quota poll`,
      );
    }

    return { ok: response.ok, status: response.status, upstreamModel };
  }

  /**
   * Kickstart all quota pools that are currently idle (no active timer, or rolling
   * idle with 100% quota and a fresh resetTime) for a given account. Deduplicates by
   * upstream model so that pools sharing the same upstream (e.g. gemini-3.5-flash and
   * gemini-3.1-pro → gemini-3-flash) only receive one request.
   */
  async kickstartAllFreshTimers(email: string): Promise<{
    ok: boolean;
    error?: string;
    results: Array<{
      quotaPools: string[];
      upstreamModel: string;
      ok: boolean;
      status: number;
    }>;
  }> {
    const account = this.accounts.find((a) => a.config.email === email);
    if (!account) {
      return { ok: false, error: "account not found", results: [] };
    }

    const idlePools = account.quota.filter(
      (q) =>
        this.isQuotaIdleForKickstart(q) &&
        this.getKickstartTarget(account, q.modelKey) !== null,
    );
    if (idlePools.length === 0) {
      return { ok: true, results: [] };
    }

    // Deduplicate: group quota pool keys by their upstream model
    const upstreamToQuotaPools = new Map<string, string[]>();
    for (const q of idlePools) {
      const target = this.getKickstartTarget(account, q.modelKey);
      if (!target) continue;
      const upstream = target.upstreamModel;
      const list = upstreamToQuotaPools.get(upstream) ?? [];
      list.push(q.modelKey);
      upstreamToQuotaPools.set(upstream, list);
    }

    const results: Array<{
      quotaPools: string[];
      upstreamModel: string;
      ok: boolean;
      status: number;
    }> = [];

    for (const [upstreamModel, quotaPools] of upstreamToQuotaPools) {
      // Use the primary quota pool key for this upstream (for recordRequest/markExhausted)
      const primaryQuotaKey =
        QUOTA_POOL_FOR_KICKSTART_MODEL[upstreamModel] ?? quotaPools[0];
      const result = await this.kickstartTimerForAccount(email, primaryQuotaKey);
      results.push({ quotaPools, upstreamModel, ok: result.ok, status: result.status });
    }

    const allOk = results.every((r) => r.ok);
    return { ok: allOk, results };
  }
}
