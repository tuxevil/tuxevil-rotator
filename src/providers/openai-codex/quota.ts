import { observeQuota } from "../../quota-observation.js";
import type { AccountRuntime, ModelQuota } from "../../types.js";
import type { QuotaFetchContext } from "../adapter.js";
import { getAccountProxyDispatcher } from "../proxy-dispatcher.js";
import { getCodexAccountId, getCodexTokenState } from "./credentials.js";
import { CODEX_PROVIDER_ID } from "./oauth.js";
import { sortQuotaPools } from "../registry.js";

export const CODEX_QUOTA_MODEL_KEY = "openai-codex";
export const CODEX_SPARK_QUOTA_MODEL_KEY = "openai-codex-spark";
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const CODEX_QUOTA_CACHE_TTL_MS = 60_000;
export const CODEX_QUOTA_TIMEOUT_MS = 8_000;
// The Codex usage API reports roughly 30 days for a window that has not been
// started yet. Treat anything above 29d 23h 55m as that sentinel rather than
// exposing a fictitious long-running timer.
export const CODEX_UNSTARTED_TIMER_THRESHOLD_SECONDS =
  30 * 24 * 60 * 60 - 5 * 60;

export interface CodexQuotaWindow {
  usedPercent: number;
  percentRemaining: number;
  resetAt: string | null;
  resetAfterSeconds: number | null;
}

export interface CodexQuotaSnapshot {
  primary: CodexQuotaWindow;
  secondary: CodexQuotaWindow;
  spark?: { primary?: CodexQuotaWindow; secondary?: CodexQuotaWindow };
  bankedResetCredits?: number;
  rateLimitReachedType?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function resetAt(window: Record<string, unknown>): { at: string | null; after: number | null } {
  const absolute = number(window.reset_at ?? window.resetAt);
  if (absolute !== null && absolute > 0) {
    const millis = absolute > 10_000_000_000 ? absolute : absolute * 1000;
    return { at: new Date(millis).toISOString(), after: Math.max(0, Math.round((millis - Date.now()) / 1000)) };
  }
  const after = number(window.reset_after_seconds ?? window.resetAfterSeconds);
  return {
    at: after !== null && after > 0 ? new Date(Date.now() + after * 1000).toISOString() : null,
    after: after !== null && after > 0 ? after : null,
  };
}

export function parseCodexQuotaWindow(value: unknown): CodexQuotaWindow | null {
  const window = record(value);
  if (Object.keys(window).length === 0) return null;
  const used = number(window.used_percent ?? window.usedPercent);
  const reset = resetAt(window);
  const usedPercent = Math.max(0, Math.min(100, used ?? 0));
  return {
    usedPercent,
    percentRemaining: Math.max(0, Math.min(100, 100 - usedPercent)),
    resetAt: reset.at,
    resetAfterSeconds: reset.after,
  };
}

function findAdditionalLimit(data: Record<string, unknown>, matcher: (text: string) => boolean): Record<string, unknown> {
  const limits = data.additional_rate_limits ?? data.additionalRateLimits;
  if (!Array.isArray(limits)) return {};
  for (const item of limits) {
    const entry = record(item);
    const descriptor = [entry.limit_name, entry.limitName, entry.metered_feature, entry.meteredFeature, entry.limit_id, entry.limitId, entry.id, entry.name]
      .filter((part): part is string => typeof part === "string")
      .join(" ")
      .toLowerCase();
    if (matcher(descriptor)) return record(entry.rate_limit ?? entry.rateLimit);
  }
  return {};
}

export function parseCodexUsageResponse(value: unknown): CodexQuotaSnapshot | null {
  const data = record(value);
  const rateLimit = record(data.rate_limit ?? data.rateLimit);
  const primary = parseCodexQuotaWindow(rateLimit.primary_window ?? rateLimit.primaryWindow);
  const secondary = parseCodexQuotaWindow(rateLimit.secondary_window ?? rateLimit.secondaryWindow);
  if (!primary && !secondary) return null;
  const empty: CodexQuotaWindow = { usedPercent: 0, percentRemaining: 100, resetAt: null, resetAfterSeconds: null };
  const sparkRateLimit = findAdditionalLimit(data, (text) => text.includes("spark"));
  const sparkPrimary = parseCodexQuotaWindow(sparkRateLimit.primary_window ?? sparkRateLimit.primaryWindow);
  const sparkSecondary = parseCodexQuotaWindow(sparkRateLimit.secondary_window ?? sparkRateLimit.secondaryWindow);
  const credits = record(data.rate_limit_reset_credits ?? data.rateLimitResetCredits);
  const banked = number(credits.available_count ?? credits.availableCount);
  const reached = data.rate_limit_reached_type ?? data.rateLimitReachedType;
  return {
    primary: primary ?? empty,
    secondary: secondary ?? empty,
    ...(sparkPrimary || sparkSecondary ? { spark: { primary: sparkPrimary ?? undefined, secondary: sparkSecondary ?? undefined } } : {}),
    ...(banked !== null ? { bankedResetCredits: banked } : {}),
    ...(typeof reached === "string" && reached.trim() ? { rateLimitReachedType: reached.trim() } : {}),
  };
}

function dominantWindow(snapshot: CodexQuotaSnapshot): CodexQuotaWindow {
  return snapshot.primary.usedPercent >= snapshot.secondary.usedPercent
    ? snapshot.primary
    : snapshot.secondary;
}

function remainingSeconds(window: CodexQuotaWindow): number | null {
  if (window.resetAfterSeconds !== null) return window.resetAfterSeconds;
  if (!window.resetAt) return null;
  return Math.round((new Date(window.resetAt).getTime() - Date.now()) / 1000);
}

function timerType(window: CodexQuotaWindow): "fresh" | "5h" | "7d" {
  const remaining = remainingSeconds(window);
  if (
    remaining === null ||
    remaining > CODEX_UNSTARTED_TIMER_THRESHOLD_SECONDS
  ) {
    return "fresh";
  }
  return remaining > 24 * 60 * 60 ? "7d" : "5h";
}

function visibleResetTime(window: CodexQuotaWindow): string | null {
  return timerType(window) === "fresh" ? null : window.resetAt;
}

export function codexQuotaRows(snapshot: CodexQuotaSnapshot): ModelQuota[] {
  const dominant = dominantWindow(snapshot);
  const rows: ModelQuota[] = [{
    modelKey: CODEX_QUOTA_MODEL_KEY,
    displayName: "Codex",
    providerId: CODEX_PROVIDER_ID,
    percentRemaining: dominant.percentRemaining,
    resetTime: visibleResetTime(dominant),
    timerType: timerType(dominant),
  }];
  if (snapshot.spark) {
    const spark = snapshot.spark.primary && snapshot.spark.secondary
      ? snapshot.spark.primary.usedPercent >= snapshot.spark.secondary.usedPercent ? snapshot.spark.primary : snapshot.spark.secondary
      : snapshot.spark.primary ?? snapshot.spark.secondary;
    if (spark) rows.push({
      modelKey: CODEX_SPARK_QUOTA_MODEL_KEY,
      displayName: "Codex Spark",
      providerId: CODEX_PROVIDER_ID,
      percentRemaining: spark.percentRemaining,
      resetTime: visibleResetTime(spark),
      timerType: timerType(spark),
    });
  }
  return rows;
}

const quotaCache = new Map<string, { fetchedAt: number; snapshot: CodexQuotaSnapshot }>();
let lastQuotaFetchAt = 0;
let quotaFetchChain = Promise.resolve();

async function throttleQuotaFetch(): Promise<void> {
  const previous = quotaFetchChain;
  let release!: () => void;
  quotaFetchChain = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  const wait = Math.max(0, 250 - (Date.now() - lastQuotaFetchAt));
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastQuotaFetchAt = Date.now();
  release();
}

function cacheKey(account: AccountRuntime): string {
  return `${account.config.email.toLowerCase()}:${getCodexAccountId(account.config) ?? "unknown"}`;
}

export function clearCodexQuotaCache(account?: AccountRuntime): void {
  if (account) {
    quotaCache.delete(cacheKey(account));
    return;
  }
  quotaCache.clear();
}

export async function fetchCodexQuota(
  account: AccountRuntime,
  ctx: QuotaFetchContext,
): Promise<void> {
  const key = cacheKey(account);
  const cached = quotaCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CODEX_QUOTA_CACHE_TTL_MS) {
    applyQuotaRows(account, cached.snapshot, cached.fetchedAt);
    return;
  }
  const token = getCodexTokenState(account).accessToken;
  if (!token) return;
  try {
    await throttleQuotaFetch();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    const accountId = getCodexAccountId(account.config);
    if (accountId) headers["chatgpt-account-id"] = accountId;
    const response = await fetch(process.env.CODEX_USAGE_URL?.trim() || CODEX_USAGE_URL, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(CODEX_QUOTA_TIMEOUT_MS),
      dispatcher: getAccountProxyDispatcher(account, CODEX_PROVIDER_ID),
    } as RequestInit & { dispatcher?: unknown });
    if (response.status === 401 || response.status === 403) {
      const message = `Codex usage endpoint returned ${response.status}; re-authentication required`;
      ctx.markProviderInvalid?.(account, CODEX_PROVIDER_ID, message);
      ctx.log(`${account.config.email}: ${message}`);
      quotaCache.delete(key);
      return;
    }
    if (response.status === 429 || response.status >= 500) {
      const cooldown = Math.min(5 * 60_000, Math.max(30_000, Number(response.headers.get("retry-after")) * 1000 || 60_000));
      ctx.setProviderCooldown?.(account, CODEX_PROVIDER_ID, cooldown);
      return;
    }
    if (!response.ok) return;
    const snapshot = parseCodexUsageResponse(await response.json());
    if (!snapshot) return;
    const fetchedAt = Date.now();
    quotaCache.set(key, { fetchedAt, snapshot });
    applyQuotaRows(account, snapshot, fetchedAt);
    account.lastQuotaPoll = Date.now();
  } catch {
    // Quota is best-effort and never blocks a generation request.
  }
}

function applyQuotaRows(account: AccountRuntime, snapshot: CodexQuotaSnapshot, observedAt: number): void {
  const other = (account.quota ?? []).filter(
    (quota) => quota.providerId !== CODEX_PROVIDER_ID,
  );
  const codexRows = codexQuotaRows(snapshot);
  for (const quota of codexRows) quota.observation = observeQuota(quota, observedAt, "derived", "reported");
  account.quota = sortQuotaPools([...other, ...codexRows]);

  account.lastPollByProvider ??= {};
  account.lastPollByProvider[CODEX_PROVIDER_ID] = codexRows
    .map((q) => {
      const remain = q.resetTime
        ? Math.round((new Date(q.resetTime).getTime() - Date.now()) / 60000) + "m"
        : "no_reset";
      return `[${q.modelKey}: ${q.timerType} ${q.percentRemaining}% in ${remain}]`;
    })
    .join(" | ");
}
