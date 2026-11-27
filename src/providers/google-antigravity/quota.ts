import { observeQuota } from "../../quota-observation.js";
// Google Antigravity quota polling: fetch per-model quota from
// fetchAvailableModels and dynamic groups/windows from retrieveUserQuotaSummary.

import type {
  AccountRuntime,
  GoogleQuotaResponse,
  GoogleQuotaSummaryBucket,
  GoogleQuotaSummaryGroup,
  GoogleQuotaSummaryResponse,
  ModelQuota,
  QuotaWindow,
} from "../../types.js";
import {
  QUOTA_API_URL,
  QUOTA_SUMMARY_API_URL,
  QUOTA_USER_AGENT,
  QUOTA_MODEL_KEYS,
  resolveQuotaModelKey,
} from "../../types.js";
import { fetchWithRetry } from "../../fetch-with-retry.js";
import {
  getAccountIdentity,
  getCredentialGeneration,
} from "../../account-identity.js";
import type { QuotaFetchContext } from "../adapter.js";
import {
  DEFAULT_PROVIDER,
  formatQuotaResetRemaining,
  getProviderProjectId,
  isOllamaQuotaPoolKey,
  isSafePoolKey,
} from "../credential-helpers.js";
import { getAccountProxyDispatcher } from "../proxy-dispatcher.js";
import { sortQuotaPools } from "../registry.js";

import {
  dynamicCatalog,
  DynamicModelRegistry,
  parseGoogleQuotaResponse,
} from "./dynamic-catalog.js";
import { refreshAicodeEligibilityIfNeeded } from "./aicode-eligibility.js";
import { fetchAicodeQuotaStatus } from "./aicode.js";
import { shouldShadowAicodeQuotaStatus } from "./aicode-forward.js";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const RESERVED_POOL_KEYS = new Set(["openai-codex", "opencode-zen", "__default__"]);

type GoogleModelInfo = GoogleQuotaResponse["models"][string];
type GoogleModelInfoWithQuota = GoogleModelInfo & {
  quotaInfo: NonNullable<GoogleModelInfo["quotaInfo"]>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeSummaryBucket(raw: unknown): GoogleQuotaSummaryBucket | null {
  if (!isRecord(raw)) return null;
  const fraction = raw.remainingFraction;
  if (
    fraction !== undefined &&
    (typeof fraction !== "number" || !Number.isFinite(fraction) || fraction < 0 || fraction > 1)
  ) {
    return null;
  }
  const bucket: GoogleQuotaSummaryBucket = {};
  if (typeof raw.bucketId === "string" && raw.bucketId.trim()) bucket.bucketId = raw.bucketId.trim();
  if (typeof raw.displayName === "string" && raw.displayName.trim()) bucket.displayName = raw.displayName.trim();
  if (typeof raw.description === "string" && raw.description.trim()) bucket.description = raw.description.trim();
  const rawWindow =
    typeof raw.window === "string" && raw.window.trim()
      ? raw.window.trim()
      : typeof raw.refreshWindowLabel === "string" && raw.refreshWindowLabel.trim()
        ? raw.refreshWindowLabel.trim()
        : undefined;
  if (rawWindow) bucket.window = rawWindow;
  if (fraction !== undefined) bucket.remainingFraction = fraction;
  if (typeof raw.remainingAmount === "string" || typeof raw.remainingAmount === "number") {
    bucket.remainingAmount = raw.remainingAmount;
  }
  if (typeof raw.disabled === "boolean") bucket.disabled = raw.disabled;
  if (typeof raw.resetTime === "string" && raw.resetTime.trim()) bucket.resetTime = raw.resetTime.trim();
  if (!bucket.bucketId && !bucket.window && !bucket.displayName && fraction === undefined && !bucket.resetTime) {
    return null;
  }
  return bucket;
}

export function parseGoogleQuotaSummaryResponse(value: unknown): GoogleQuotaSummaryResponse | null {
  if (!isRecord(value)) return null;
  const parsed: GoogleQuotaSummaryResponse = {};
  if (typeof value.description === "string" && value.description.trim()) {
    parsed.description = value.description.trim();
  }
  if (Array.isArray(value.groups)) {
    const groups: GoogleQuotaSummaryGroup[] = [];
    for (const rawGroup of value.groups) {
      if (!isRecord(rawGroup) || !Array.isArray(rawGroup.buckets)) continue;
      const buckets = rawGroup.buckets
        .map(sanitizeSummaryBucket)
        .filter((bucket): bucket is GoogleQuotaSummaryBucket => bucket !== null);
      if (buckets.length === 0) continue;
      const group: GoogleQuotaSummaryGroup = { buckets };
      if (typeof rawGroup.displayName === "string" && rawGroup.displayName.trim()) {
        group.displayName = rawGroup.displayName.trim();
      }
      if (typeof rawGroup.description === "string" && rawGroup.description.trim()) {
        group.description = rawGroup.description.trim();
      }
      groups.push(group);
    }
    if (groups.length > 0) parsed.groups = groups;
  }
  if (Array.isArray(value.buckets)) {
    const buckets = value.buckets
      .map(sanitizeSummaryBucket)
      .filter((bucket): bucket is GoogleQuotaSummaryBucket => bucket !== null);
    if (buckets.length > 0) parsed.buckets = buckets;
  }
  if (!parsed.groups?.length && !parsed.buckets?.length) return null;
  return parsed;
}

function slugifyPoolKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function stripWindowSuffix(bucketId: string): string {
  return bucketId
    .toLowerCase()
    .replace(/-(?:wtu-)?(?:weekly|daily|monthly|hourly|\d+[smhdw])$/i, "");
}

function resolveSummaryGroupIdentity(group: GoogleQuotaSummaryGroup): {
  key: string;
  displayName: string;
} {
  const displayLower = (group.displayName ?? "").trim().toLowerCase();
  const bucketIds = (group.buckets ?? []).map((b) => (b.bucketId ?? "").toLowerCase()).filter(Boolean);
  const isCoreGeminiBucket =
    bucketIds.length > 0 &&
    bucketIds.every((id) => /^gemini-(?:weekly|daily|monthly|\d+[smhdw])$/.test(id));
  const isCoreClaudeBucket =
    bucketIds.length > 0 &&
    bucketIds.every((id) => /^(?:3p|claude)-(?:wtu-)?(?:weekly|daily|monthly|\d+[smhdw])$/.test(id));

  if (isCoreGeminiBucket || displayLower === "gemini models" || displayLower === "gemini") {
    return { key: "gemini", displayName: group.displayName?.trim() || "Gemini" };
  }
  if (
    isCoreClaudeBucket ||
    displayLower === "claude and gpt models" ||
    displayLower === "claude" ||
    (displayLower.includes("claude") && !/\d/.test(displayLower))
  ) {
    return { key: "claude", displayName: group.displayName?.trim() || "Claude" };
  }

  let slug = group.displayName ? slugifyPoolKey(group.displayName) : "";
  if (!slug && bucketIds[0]) {
    slug = slugifyPoolKey(stripWindowSuffix(bucketIds[0]));
  }
  if (!slug) slug = "google-pool";
  if (isOllamaQuotaPoolKey(slug) || RESERVED_POOL_KEYS.has(slug) || slug === "gemini" || slug === "claude") {
    slug = slugifyPoolKey(`google-${slug}`);
  }
  if (!isSafePoolKey(slug)) slug = "google-pool";
  return {
    key: slug,
    displayName: group.displayName?.trim() || group.buckets?.[0]?.displayName?.trim() || slug,
  };
}

function inferGroupsFromTopLevelBuckets(buckets: GoogleQuotaSummaryBucket[]): GoogleQuotaSummaryGroup[] {
  const byPrefix = new Map<string, GoogleQuotaSummaryBucket[]>();
  for (const bucket of buckets) {
    const prefix = bucket.bucketId ? stripWindowSuffix(bucket.bucketId) : "google";
    const list = byPrefix.get(prefix) ?? [];
    list.push(bucket);
    byPrefix.set(prefix, list);
  }
  return Array.from(byPrefix.entries()).map(([prefix, groupBuckets]) => ({
    displayName:
      prefix === "gemini"
        ? "Gemini Models"
        : prefix === "3p" || prefix === "claude"
          ? "Claude and GPT models"
          : groupBuckets[0]?.displayName || prefix,
    buckets: groupBuckets,
  }));
}

function parseWindowDurationMs(
  windowKey: string,
  resetTime: string | null,
  now: number,
): number | undefined {
  const lower = windowKey.trim().toLowerCase();
  if (lower === "5h") return 5 * 3600_000;
  if (lower === "daily" || lower === "1d") return DAY_MS;
  if (lower === "weekly" || lower === "7d") return 7 * DAY_MS;
  if (lower === "monthly" || lower === "30d") return 30 * DAY_MS;
  const match = lower.match(/^(\d+)\s*([smhdw])$/);
  if (match) {
    const value = Number(match[1]);
    const unitMs: Record<string, number> = {
      s: 1000,
      m: 60_000,
      h: 3600_000,
      d: DAY_MS,
      w: 7 * DAY_MS,
    };
    return value * (unitMs[match[2]] ?? 0);
  }
  if (resetTime) {
    const resetMs = Date.parse(resetTime);
    if (Number.isFinite(resetMs) && resetMs > now) return resetMs - now;
  }
  return undefined;
}

function resolveBucketWindowKey(bucket: GoogleQuotaSummaryBucket, now: number): string {
  const explicit = bucket.window?.trim().toLowerCase();
  if (explicit) return explicit;
  const fromId = bucket.bucketId?.trim().toLowerCase().match(/(?:^|-)(weekly|daily|monthly|\d+[smhdw])$/)?.[1];
  if (fromId) return fromId;
  if (bucket.resetTime) {
    const resetMs = Date.parse(bucket.resetTime);
    if (Number.isFinite(resetMs) && resetMs > now) {
      return resetMs - now < SIX_HOURS_MS ? "5h" : "weekly";
    }
  }
  return "weekly";
}

function formatWindowLabel(windowKey: string, bucketDisplayName?: string): string {
  const lower = windowKey.trim().toLowerCase();
  if (lower === "daily") return "Daily limit";
  if (lower === "weekly" || lower === "7d") return "Weekly limit";
  if (lower === "monthly") return "Monthly limit";
  if (/^\d+[smhdw]$/.test(lower)) return `${lower} limit`;
  return bucketDisplayName?.trim() || windowKey;
}

function classifyWindowTimerType(
  windowKey: string,
  durationMs: number | undefined,
  active: boolean,
): ModelQuota["timerType"] {
  if (!active) return "fresh";
  const lower = windowKey.trim().toLowerCase();
  if (lower === "5h") return "5h";
  if (lower === "weekly" || lower === "7d") return "7d";
  if (lower === "monthly") return "monthly";
  if (lower === "daily" || /^\d+[smhdw]$/.test(lower)) {
    if (durationMs !== undefined && durationMs <= SIX_HOURS_MS && lower === "5h") return "5h";
    return lower;
  }
  if (durationMs !== undefined) {
    return durationMs < SIX_HOURS_MS ? "5h" : "7d";
  }
  return "7d";
}

function normalizeModelMatchText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/(\d)\.(\d)/g, "$1-$2")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function extractGroupModelPhrases(group: GoogleQuotaSummaryGroup, poolKey: string): string[] {
  const phrases: string[] = [];
  if (group.description) {
    const descMatch = group.description.match(/models\s+within\s+this\s+group\s*:\s*([^\n]+)/i);
    if (descMatch) {
      const listPart = descMatch[1].replace(/\.$/, "");
      for (const item of listPart.split(",")) {
        const norm = normalizeModelMatchText(item);
        if (norm) phrases.push(norm);
      }
    }
  }
  if (group.displayName && poolKey !== "gemini" && poolKey !== "claude") {
    const normDisplay = normalizeModelMatchText(group.displayName);
    if (normDisplay) phrases.push(normDisplay);
  }
  if (poolKey !== "gemini" && poolKey !== "claude") {
    const normKey = normalizeModelMatchText(poolKey);
    if (normKey) phrases.push(normKey);
  }
  return Array.from(new Set(phrases));
}

function modelMatchesPhrase(modelId: string, modelDisplayName: string | undefined, phrase: string): boolean {
  const normId = normalizeModelMatchText(modelId);
  if (normId === phrase || normId.startsWith(`${phrase}-`) || normId.includes(phrase)) {
    return true;
  }
  if (modelDisplayName) {
    const normDisp = normalizeModelMatchText(modelDisplayName);
    if (normDisp === phrase || normDisp.startsWith(`${phrase}-`) || normDisp.includes(phrase)) {
      return true;
    }
  }
  return false;
}

export function buildSummaryModelPoolMap(
  data: GoogleQuotaResponse,
  summary: GoogleQuotaSummaryResponse | null | undefined,
): Map<string, string> {
  const result = new Map<string, string>();
  if (!summary) return result;
  const groups = summary.groups?.length
    ? summary.groups
    : summary.buckets?.length
      ? inferGroupsFromTopLevelBuckets(summary.buckets)
      : [];
  if (groups.length === 0) return result;

  const resolvedGroups = groups.map((group) => {
    const identity = resolveSummaryGroupIdentity(group);
    return {
      group,
      key: identity.key,
      phrases: extractGroupModelPhrases(group, identity.key),
    };
  });
  const groupKeys = new Set(resolvedGroups.map((entry) => entry.key));

  // Rank phrase matchers longest-first so specific pools (e.g. "gemini-4-argon") win
  // over generic family substrings.
  const phraseMatchers = resolvedGroups
    .flatMap((entry) => entry.phrases.map((phrase) => ({ phrase, key: entry.key })))
    .sort((a, b) => b.phrase.length - a.phrase.length);

  const now = Date.now();
  for (const [rawId, info] of Object.entries(data.models)) {
    const lowerId = rawId.trim().toLowerCase();
    if (!lowerId) continue;

    let matchedKey: string | undefined;
    for (const matcher of phraseMatchers) {
      if (modelMatchesPhrase(lowerId, info.displayName, matcher.phrase)) {
        matchedKey = matcher.key;
        break;
      }
    }

    // Fallback: correlate active/exhausted model quota signature against summary buckets.
    if (!matchedKey && info.quotaInfo) {
      const mFrac = info.quotaInfo.remainingFraction;
      const mResetMs = info.quotaInfo.resetTime ? Date.parse(info.quotaInfo.resetTime) : NaN;
      const candidateKeys = new Set<string>();
      for (const entry of resolvedGroups) {
        for (const bucket of entry.group.buckets ?? []) {
          const bResetMs = bucket.resetTime ? Date.parse(bucket.resetTime) : NaN;
          const resetMatch =
            Number.isFinite(mResetMs) &&
            Number.isFinite(bResetMs) &&
            Math.abs(mResetMs - bResetMs) <= 120_000;
          const fracMatch =
            typeof mFrac === "number" &&
            typeof bucket.remainingFraction === "number" &&
            (mFrac < 1 || bucket.remainingFraction < 1) &&
            Math.abs(mFrac - bucket.remainingFraction) <= 0.02;
          if (resetMatch && (typeof mFrac !== "number" || typeof bucket.remainingFraction !== "number" || Math.abs(mFrac - bucket.remainingFraction) <= 0.05)) {
            candidateKeys.add(entry.key);
          } else if (fracMatch && !Number.isFinite(bResetMs)) {
            candidateKeys.add(entry.key);
          }
        }
      }
      if (candidateKeys.size === 1) {
        matchedKey = Array.from(candidateKeys)[0];
      }
    }

    if (!matchedKey) {
      const inferred = DynamicModelRegistry.inferFamilyAndPool(lowerId).quotaPool;
      if (groupKeys.has(inferred)) {
        matchedKey = inferred;
      } else {
        // Match custom group pool slug prefix directly against model ID when possible.
        const customMatch = resolvedGroups
          .filter((entry) => entry.key !== "gemini" && entry.key !== "claude")
          .sort((a, b) => b.key.length - a.key.length)
          .find((entry) => lowerId.startsWith(entry.key) && now >= 0);
        if (customMatch) matchedKey = customMatch.key;
      }
    }

    if (matchedKey) {
      result.set(lowerId, matchedKey);
    }
  }

  return result;
}

function hasUsableQuotaInfo(
  info: GoogleModelInfo | undefined,
): info is GoogleModelInfoWithQuota {
  if (!info?.quotaInfo) return false;
  const remaining = info.quotaInfo.remainingFraction;
  if (remaining === undefined) {
    // Google omits remainingFraction for active quota windows. A resetTime
    // without a fraction is the partial shape used by the legacy parser.
    return typeof info.quotaInfo.resetTime === "string" &&
      info.quotaInfo.resetTime.trim().length > 0;
  }
  return typeof remaining === "number" && Number.isFinite(remaining) &&
    remaining >= 0 && remaining <= 1;
}

function getRemainingFraction(info: GoogleModelInfoWithQuota): number {
  const remaining = info.quotaInfo.remainingFraction;
  return typeof remaining === "number" && Number.isFinite(remaining) &&
      remaining >= 0 && remaining <= 1
    ? remaining
    : 0;
}

function applyActiveCooldown(
  quota: ModelQuota,
  cooldownUntil: number | undefined,
  now: number,
): void {
  if (!cooldownUntil || !Number.isFinite(cooldownUntil) || cooldownUntil <= now) {
    return;
  }
  const advertisedReset = quota.resetTime
    ? new Date(quota.resetTime).getTime()
    : 0;
  // Only adopt the upstream reset time if the upstream already reported 0%
  // quota; a local 429 cooldown on an otherwise healthy pool expires at
  // cooldownUntil, not at the pool's 5h/weekly refresh boundary.
  const resetAt =
    quota.percentRemaining === 0 && Number.isFinite(advertisedReset) && advertisedReset > now
      ? Math.max(cooldownUntil, advertisedReset)
      : cooldownUntil;
  const resetIso = new Date(resetAt).toISOString();
  quota.percentRemaining = 0;
  quota.resetTime = resetIso;
  quota.timerType = resetAt - now < SIX_HOURS_MS ? "5h" : "7d";
  if (quota.windows?.length) {
    // Keep windows consistent when local 429 cooldown marks the pool empty.
    const matching = quota.windows.find(
      (w) =>
        (quota.timerType === "5h" && w.window === "5h") ||
        (quota.timerType === "7d" && (w.window === "weekly" || w.window === "7d")),
    ) ?? quota.windows[0];
    if (matching) {
      matching.percentRemaining = 0;
      matching.resetTime = resetIso;
      matching.active = true;
    }
  }
}

function getActiveCooldownForPool(
  account: AccountRuntime,
  poolKey: string,
): number | undefined {
  let cooldownUntil = account.cooldownsByModel[poolKey] ?? 0;
  const accountId = getAccountIdentity(account);
  for (const [modelKey, deadline] of Object.entries(account.cooldownsByModel)) {
    if (
      modelKey !== poolKey &&
      dynamicCatalog.resolveQuotaPoolForAccount(accountId, modelKey) === poolKey
    ) {
      cooldownUntil = Math.max(cooldownUntil, deadline);
    }
  }
  return cooldownUntil || undefined;
}

function buildWindowsFromSummaryGroup(
  group: GoogleQuotaSummaryGroup,
  matchedModels: GoogleModelInfoWithQuota[],
  now: number,
): {
  windows: QuotaWindow[];
  percentageSource: "derived" | "unknown";
  resetSource: "reported" | "unknown";
} {
  let hasUnknownFraction = false;
  let hasReportedReset = false;

  const rawWindows = (group.buckets ?? []).map((bucket) => {
    const windowKey = resolveBucketWindowKey(bucket, now);
    const hasFraction = typeof bucket.remainingFraction === "number";
    const fraction = hasFraction ? bucket.remainingFraction! : bucket.resetTime ? 0 : 1;
    const resetTime: string | null = fraction >= 1 ? null : (bucket.resetTime ?? null);
    if (!hasFraction && bucket.resetTime) hasUnknownFraction = true;
    if (resetTime) hasReportedReset = true;
    const durationMs = parseWindowDurationMs(windowKey, bucket.resetTime ?? null, now);
    return {
      id: bucket.bucketId || windowKey,
      window: windowKey,
      label: formatWindowLabel(windowKey, bucket.displayName),
      hasFraction,
      fraction,
      resetTime,
      durationMs,
      description: bucket.description,
      disabled: bucket.disabled,
    };
  });

  // Only fill summary buckets that omitted remainingFraction using
  // fetchAvailableModels. When retrieveUserQuotaSummary explicitly reports
  // remainingFraction (e.g. 1.0 after a weekly reset), treat the summary as
  // authoritative instead of letting stale legacy quotaInfo override it.
  if (matchedModels.length > 0 && rawWindows.some((w) => !w.hasFraction)) {
    const modelMin = [...matchedModels].sort(
      (a, b) =>
        getRemainingFraction(a) - getRemainingFraction(b) ||
        Number(Boolean(b.quotaInfo.resetTime)) - Number(Boolean(a.quotaInfo.resetTime)),
    )[0];
    if (modelMin) {
      const mFraction = getRemainingFraction(modelMin);
      const mResetTime = mFraction >= 1 ? null : (modelMin.quotaInfo.resetTime ?? null);
      const mResetMs = mResetTime ? Date.parse(mResetTime) : NaN;
      const mClass = Number.isFinite(mResetMs) && mResetMs > now
        ? (mResetMs - now < SIX_HOURS_MS ? "5h" : "weekly")
        : undefined;

      const missingWindows = rawWindows.filter((w) => !w.hasFraction);
      const targetWin =
        (mResetTime
          ? missingWindows.find(
              (w) =>
                w.resetTime &&
                Math.abs(Date.parse(w.resetTime) - mResetMs) <= 120_000,
            )
          : undefined) ??
        (mClass
          ? missingWindows.find(
              (w) =>
                w.window === mClass ||
                (mClass === "weekly" && (w.window === "weekly" || w.window === "7d")),
            )
          : undefined) ??
        missingWindows[missingWindows.length - 1];

      if (targetWin && typeof modelMin.quotaInfo.remainingFraction === "number") {
        targetWin.fraction = mFraction;
        targetWin.hasFraction = true;
        if (!targetWin.resetTime && mResetTime) {
          targetWin.resetTime = mResetTime;
          hasReportedReset = true;
        }
        hasUnknownFraction = rawWindows.some((w) => !w.hasFraction && Boolean(w.resetTime));
      }
    }
  }

  const windows: QuotaWindow[] = rawWindows
    .sort((a, b) => (a.durationMs ?? Infinity) - (b.durationMs ?? Infinity))
    .map((entry) => {
      const percentRemaining = Math.round(entry.fraction * 100);
      const active = (percentRemaining < 100 || entry.fraction < 1) && Boolean(entry.resetTime);
      return {
        id: entry.id,
        window: entry.window,
        label: entry.label,
        percentRemaining,
        resetTime: active || percentRemaining === 0 ? entry.resetTime : null,
        ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
        active: Boolean(active || (percentRemaining === 0 && entry.resetTime)),
        ...(entry.description ? { description: entry.description } : {}),
        ...(entry.disabled !== undefined ? { disabled: entry.disabled } : {}),
      };
    });

  return {
    windows,
    percentageSource: hasUnknownFraction ? "unknown" : "derived",
    resetSource: hasReportedReset ? "reported" : "unknown",
  };
}

function summarizeGroupQuota(
  poolKey: string,
  displayName: string,
  description: string | undefined,
  windows: QuotaWindow[],
  percentageSource: "derived" | "unknown",
  resetSource: "reported" | "unknown",
  now: number,
  oldQ?: ModelQuota,
): ModelQuota {
  const usable = windows.filter((w) => !w.disabled);
  const poolWindows = usable.length > 0 ? usable : windows;
  const percentRemaining = Math.min(...poolWindows.map((w) => w.percentRemaining));

  const exhaustedWithReset = poolWindows
    .filter((w) => w.percentRemaining === 0 && w.resetTime)
    .sort((a, b) => Date.parse(b.resetTime!) - Date.parse(a.resetTime!));
  const activeWithReset = poolWindows
    .filter((w) => w.active && w.resetTime)
    .sort((a, b) => (a.durationMs ?? Infinity) - (b.durationMs ?? Infinity));

  const primary = exhaustedWithReset[0] ?? activeWithReset[0];
  let timerType: ModelQuota["timerType"] = "fresh";
  const resetTime = primary?.resetTime ?? null;
  if (primary && resetTime) {
    if (
      !primary.window &&
      oldQ &&
      oldQ.resetTime === resetTime &&
      oldQ.timerType !== "fresh"
    ) {
      timerType = oldQ.timerType;
    } else {
      timerType = classifyWindowTimerType(primary.window, primary.durationMs, true);
    }
  }

  return {
    modelKey: poolKey,
    displayName,
    ...(description ? { groupDescription: description } : {}),
    windows,
    observation: observeQuota(
      { percentRemaining, resetTime },
      now,
      percentageSource,
      resetTime ? resetSource : "unknown",
    ),
    percentRemaining,
    resetTime,
    timerType,
  };
}

/**
 * Extract per-pool quotas from Google quota responses.
 * When `summary` (from `retrieveUserQuotaSummary`) is present, its dynamic groups
 * and time windows are authoritative (reconciled against `fetchAvailableModels`).
 * Without `summary`, falls back to model-level `fetchAvailableModels` extraction.
 */
export function extractQuotas(
  data: GoogleQuotaResponse,
  oldQuota: ModelQuota[],
  summary?: GoogleQuotaSummaryResponse | null,
  now: number = Date.now(),
): ModelQuota[] {
  const summaryGroups = summary?.groups?.length
    ? summary.groups
    : summary?.buckets?.length
      ? inferGroupsFromTopLevelBuckets(summary.buckets)
      : null;

  if (summaryGroups && summaryGroups.length > 0) {
    const modelPoolMap = buildSummaryModelPoolMap(data, { groups: summaryGroups });
    const modelsByPool = new Map<string, GoogleModelInfoWithQuota[]>();
    for (const [modelId, info] of Object.entries(data.models)) {
      if (!hasUsableQuotaInfo(info)) continue;
      const poolKey =
        modelPoolMap.get(modelId.trim().toLowerCase()) ??
        DynamicModelRegistry.inferFamilyAndPool(modelId).quotaPool;
      const list = modelsByPool.get(poolKey) ?? [];
      list.push(info);
      modelsByPool.set(poolKey, list);
    }

    const quotas: ModelQuota[] = [];
    const seenKeys = new Set<string>();
    for (const group of summaryGroups) {
      const identity = resolveSummaryGroupIdentity(group);
      if (seenKeys.has(identity.key)) continue;
      seenKeys.add(identity.key);
      const matched = modelsByPool.get(identity.key) ?? [];
      const built = buildWindowsFromSummaryGroup(group, matched, now);
      if (built.windows.length === 0) continue;
      const oldQ = oldQuota.find((q) => q.modelKey === identity.key);
      quotas.push(
        summarizeGroupQuota(
          identity.key,
          identity.displayName,
          group.description,
          built.windows,
          built.percentageSource,
          built.resetSource,
          now,
          oldQ,
        ),
      );
    }
    return quotas;
  }

  const quotas: ModelQuota[] = [];
  const resolveFallbackPoolKey = (modelKey: string): string =>
    dynamicCatalog.resolveQuotaPool(modelKey) ??
    DynamicModelRegistry.inferFamilyAndPool(modelKey).quotaPool;

  const fallbackPoolMeta = new Map<string, { key: string; display: string }>();
  for (const [, config] of Object.entries(QUOTA_MODEL_KEYS)) {
    fallbackPoolMeta.set(config.key, config);
  }
  for (const modelKey of Object.keys(data.models)) {
    const resolvedKey = resolveFallbackPoolKey(modelKey);
    if (!fallbackPoolMeta.has(resolvedKey) && hasUsableQuotaInfo(data.models[modelKey])) {
      const oldDisplay = oldQuota.find((q) => q.modelKey === resolvedKey)?.displayName;
      fallbackPoolMeta.set(resolvedKey, {
        key: resolvedKey,
        display: oldDisplay ?? resolvedKey,
      });
    }
  }

  for (const [, config] of fallbackPoolMeta) {
    const candidates: GoogleModelInfoWithQuota[] = [];
    const sharedPoolInfo = data.models[config.key];
    if (hasUsableQuotaInfo(sharedPoolInfo)) {
      candidates.push(sharedPoolInfo);
    }

    for (const [modelKey, info] of Object.entries(data.models)) {
      if (
        modelKey !== config.key &&
        resolveFallbackPoolKey(modelKey) === config.key &&
        hasUsableQuotaInfo(info)
      ) {
        candidates.push(info);
      }
    }

    // A shared pool is usable only as far as its most exhausted model. Google
    // may report one sibling at 100% while the model we route to is exhausted.
    const modelInfo = candidates.sort(
      (a, b) => getRemainingFraction(a) - getRemainingFraction(b) ||
        Number(Boolean(b.quotaInfo.resetTime)) -
          Number(Boolean(a.quotaInfo.resetTime)),
    )[0];
    if (modelInfo?.quotaInfo) {
      const remainingFraction = getRemainingFraction(modelInfo);
      // Google can publish a nominal reset for an untouched pool; no usage means
      // there is no active quota window yet.
      const resetTime =
        remainingFraction >= 1 ? null : modelInfo.quotaInfo.resetTime ?? null;
      let timerType: ModelQuota["timerType"] = "fresh";

      if (resetTime) {
        const oldQ = oldQuota.find((q) => q.modelKey === config.key);
        // If the resetTime is exactly the same as the previous poll, preserve
        // the old timerType. A timer doesn't change its nature just because it
        // gets closer to zero.
        if (oldQ && oldQ.resetTime === resetTime && oldQ.timerType !== "fresh") {
          timerType = oldQ.timerType;
        } else {
          // Brand new timer (or service restart): measure the distance to
          // determine its type. < 6 hours → 5h timer, otherwise 7d.
          const resetMs = new Date(resetTime).getTime();
          if (resetMs > now) {
            const durationMs = resetMs - now;
            timerType = durationMs < SIX_HOURS_MS ? "5h" : "7d";
          }
        }
      }

      quotas.push({
        modelKey: config.key,
        displayName: config.display,
        observation: observeQuota({ percentRemaining: Math.round(remainingFraction * 100), resetTime },
          now, modelInfo.quotaInfo.remainingFraction === undefined ? "unknown" : "derived", "reported"),
        percentRemaining: Math.round(remainingFraction * 100),
        resetTime,
        timerType,
      });
    }
  }

  return quotas;
}

/**
 * Poll quota for one account and write the result into account.quota.
 * Non-OK responses flag the account via the core-provided callbacks.
 */
export async function fetchProviderQuota(
  account: AccountRuntime,
  ctx: QuotaFetchContext,
): Promise<void> {
  if (!account.accessToken) return;
  const accountId = getAccountIdentity(account);
  const credentialGeneration = getCredentialGeneration(
    account,
    DEFAULT_PROVIDER,
  );
  const accountEpoch = dynamicCatalog.captureAccountEpoch(
    accountId,
    credentialGeneration,
  );
  if (accountEpoch === null) return;
  const isCurrentGeneration = (): boolean =>
    accountId === getAccountIdentity(account) &&
    credentialGeneration === getCredentialGeneration(account, DEFAULT_PROVIDER) &&
    dynamicCatalog.isAccountGenerationActive(
      accountId,
      credentialGeneration,
      accountEpoch,
    );
  const cooldownSnapshotAtStart: Record<string, number> = {
    ...account.cooldownsByModel,
  };

  const projectId = getProviderProjectId(account.config, DEFAULT_PROVIDER);
  const quotaHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${account.accessToken}`,
    "User-Agent": QUOTA_USER_AGENT,
  };
  try {
    const response = await fetchWithRetry(QUOTA_API_URL, {
      method: "POST",
      headers: quotaHeaders,
      body: JSON.stringify({
        project: projectId,
      }),
      timeoutMs: 8000,
      retryPolicy: "antigravity",
      dispatcher: getAccountProxyDispatcher(account, "google-antigravity"),
    });
    if (!isCurrentGeneration()) return;

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        const errorText = await response.text();
        if (!isCurrentGeneration()) return;
        ctx.log(
          `${account.config.email}: quota API returned ${response.status}, invalidating provider credential`,
        );
        ctx.reportQuotaPollFlag(account, response.status, errorText);
        if (ctx.markProviderInvalid) {
          ctx.markProviderInvalid(
            account,
            DEFAULT_PROVIDER,
            `Quota API ${response.status}: ${errorText}`,
          );
        }
      }
      return;
    }

    const rawData = await response.json();
    if (!isCurrentGeneration()) return;
    const data = parseGoogleQuotaResponse(rawData);
    if (!data) return;

    await refreshAicodeEligibilityIfNeeded(
      account,
      quotaHeaders,
      isCurrentGeneration,
    );
    if (!isCurrentGeneration()) return;

    const hasModels = Object.keys(data.models).length > 0;
    let summary: GoogleQuotaSummaryResponse | null = null;
    if (shouldShadowAicodeQuotaStatus(account)) {
      // Shadow-only, like Antigravity.app: the result never replaces CCPA quota.
      await fetchAicodeQuotaStatus(account, quotaHeaders).catch(() => null);
      if (!isCurrentGeneration()) return;
    }

    if (hasModels) {
      try {
        const summaryResponse = await fetchWithRetry(QUOTA_SUMMARY_API_URL, {
          method: "POST",
          headers: quotaHeaders,
          body: JSON.stringify({ project: projectId }),
          timeoutMs: 8000,
          retries: 0,
          dispatcher: getAccountProxyDispatcher(account, "google-antigravity"),
        });
        if (!isCurrentGeneration()) return;
        if (summaryResponse.ok) {
          summary = parseGoogleQuotaSummaryResponse(await summaryResponse.json());
        }
      } catch {
        // Quota summary is additive; fall back to fetchAvailableModels when unavailable.
      }
      if (!isCurrentGeneration()) return;
    }

    const oldQuota = account.quota || [];
    const poolOverrides = buildSummaryModelPoolMap(data, summary);
    const fresh = extractQuotas(data, oldQuota, summary);
    const newModels = dynamicCatalog.updateFromEndpointResponse(
      data,
      accountId,
      credentialGeneration,
      accountEpoch,
      poolOverrides.size > 0 ? poolOverrides : undefined,
    );
    if (newModels > 0) {
      ctx.log(
        `${account.config.email}: discovered ${newModels} Antigravity model(s) from quota response`,
      );
    }
    if (fresh.length === 0) return;
    // Drop the previous Antigravity entries so the new ones fully replace
    // them; keep entries from OTHER providers (Ollama) so multi-provider
    // accounts accumulate quotas across credentials without overwriting
    // one another.
    const otherProviders = (oldQuota || []).filter(
      (q) => (q as { providerId?: string }).providerId &&
        (q as { providerId?: string }).providerId !== "google-antigravity",
    );
    fresh.forEach(
      (q) => ((q as { providerId?: string }).providerId = "google-antigravity"),
    );
    const freshKeys = new Set(fresh.map((quota) => quota.modelKey));
    const hasAuthoritativeSummary = Boolean(summary?.groups?.length || summary?.buckets?.length);
    // When retrieveUserQuotaSummary returned authoritative groups, drop pools
    // Google removed instead of retaining stale pools across polls. Only retain
    // missing pools during partial fetchAvailableModels-only responses.
    const previousGooglePools = hasAuthoritativeSummary
      ? []
      : oldQuota.filter(
          (q) => (q as { providerId?: string }).providerId === DEFAULT_PROVIDER &&
            !freshKeys.has(q.modelKey),
        );
    const now = Date.now();
    if (hasAuthoritativeSummary) {
      // 1) Self-heal legacy/collapsed cooldowns: before dynamic pool separation,
      // an exhausted custom group (e.g. "gemini-4-argon") could store its reset
      // deadline under its parent family pool ("gemini"). When Google's summary
      // separates that exhausted group while reporting the parent pool healthy,
      // migrate that matching deadline off the parent pool so healthy sibling
      // models (e.g. Hydrogen/Neon) are not locked out.
      for (const customQuota of fresh) {
        if (customQuota.percentRemaining !== 0 || !customQuota.resetTime) continue;
        const parentPool = resolveQuotaModelKey(customQuota.modelKey);
        if (!parentPool || parentPool === customQuota.modelKey) continue;
        const customResetAt = Date.parse(customQuota.resetTime);
        if (!Number.isFinite(customResetAt) || customResetAt <= now) continue;
        const parentQuota = fresh.find((q) => q.modelKey === parentPool);
        if (!parentQuota || parentQuota.percentRemaining <= 0) continue;
        const parentCooldown = account.cooldownsByModel[parentPool];
        if (
          typeof parentCooldown === "number" &&
          parentCooldown === cooldownSnapshotAtStart[parentPool] &&
          Math.abs(parentCooldown - customResetAt) <= 1000
        ) {
          delete account.cooldownsByModel[parentPool];
          account.cooldownsByModel[customQuota.modelKey] = Math.max(
            account.cooldownsByModel[customQuota.modelKey] ?? 0,
            customResetAt,
          );
        }
      }

      // 2) Clear superseded multi-day (>= 6h) cooldowns when Google's
      // authoritative summary reports the pool healthy (> 0%) with an active
      // long window (e.g. weekly) whose reset time no longer matches the stored
      // cooldown (e.g. quota rolled over to a new weekly cycle or was reset early).
      for (const quota of fresh) {
        if (quota.percentRemaining <= 0) continue;
        const cooldownUntil = account.cooldownsByModel[quota.modelKey];
        if (
          typeof cooldownUntil !== "number" ||
          !Number.isFinite(cooldownUntil) ||
          cooldownUntil - now < SIX_HOURS_MS ||
          cooldownUntil !== cooldownSnapshotAtStart[quota.modelKey]
        ) {
          continue;
        }
        const longWindow = quota.windows?.find(
          (w) =>
            !w.disabled &&
            (w.window === "weekly" ||
              w.window === "7d" ||
              (w.durationMs !== undefined && w.durationMs >= SIX_HOURS_MS)),
        );
        if (!longWindow || longWindow.percentRemaining <= 0) {
          continue;
        }
        const isResetToFull = longWindow.percentRemaining === 100 && !longWindow.resetTime;
        const longResetAt = longWindow.resetTime ? Date.parse(longWindow.resetTime) : NaN;
        const resetMoved =
          Number.isFinite(longResetAt) &&
          longResetAt > now &&
          Math.abs(longResetAt - cooldownUntil) > 5 * 60_000;
        if (isResetToFull || resetMoved) {
          delete account.cooldownsByModel[quota.modelKey];
          for (const [modelKey, deadline] of Object.entries(account.cooldownsByModel)) {
            if (
              deadline === cooldownSnapshotAtStart[modelKey] &&
              Math.abs(deadline - cooldownUntil) <= 1000 &&
              dynamicCatalog.resolveQuotaPoolForAccount(accountId, modelKey) === quota.modelKey
            ) {
              delete account.cooldownsByModel[modelKey];
            }
          }
        }
      }
    }
    for (const quota of [...previousGooglePools, ...fresh]) {
      if (
        freshKeys.has(quota.modelKey) &&
        quota.percentRemaining === 0 &&
        quota.resetTime
      ) {
        // A newly reported exhausted window is authoritative; the poll
        // reconciler will persist its reset time instead of stale local state.
        continue;
      }
      applyActiveCooldown(
        quota,
        getActiveCooldownForPool(account, quota.modelKey),
        now,
      );
    }
    account.quota = sortQuotaPools([
      ...otherProviders,
      ...previousGooglePools,
      ...fresh,
    ]);
    account.lastQuotaPoll = Date.now();

    // Stash the provider-local poll log for the rotator to emit as a
    // single consolidated line per cycle.
    account.lastPollByProvider ??= {};
    account.lastPollByProvider["google-antigravity"] = account.quota
      .filter(
        (q) =>
          (q as { providerId?: string }).providerId === "google-antigravity",
      )
      .map((q) => {
        const logNow = Date.now();
        if (q.windows?.length) {
          const parts = q.windows.map((w) => {
            const rem = w.resetTime
              ? formatQuotaResetRemaining(w.resetTime, logNow)
              : "fresh";
            return `${w.window}:${w.percentRemaining}%/${rem}`;
          });
          return `[${q.modelKey}: ${parts.join(", ")}]`;
        }
        const remain = q.resetTime
          ? formatQuotaResetRemaining(q.resetTime, logNow)
          : "no_reset";
        return `[${q.modelKey}: ${q.timerType} ${q.percentRemaining}% in ${remain}]`;
      })
      .join(" | ");
  } catch {
    // Network error, skip
  }
}
