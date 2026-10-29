import type { ModelQuota, QuotaObservation } from "./types.js";

/** Pure annotation; preserves all router-facing values. Call only for fresh data. */
export function observeQuota(
  quota: Pick<ModelQuota, "percentRemaining" | "resetTime">,
  observedAt: number,
  percentageSource: QuotaObservation["percentageSource"],
  resetSource: QuotaObservation["resetSource"],
): QuotaObservation {
  const known = percentageSource !== "unknown" && Number.isFinite(quota.percentRemaining)
    && quota.percentRemaining >= 0 && quota.percentRemaining <= 100;
  return {
    observedAt,
    percentageSource: known ? percentageSource : "unknown",
    remainingPercent: known ? quota.percentRemaining : null,
    resetSource: quota.resetTime && Number.isFinite(Date.parse(quota.resetTime)) ? resetSource : "unknown",
    resetAt: quota.resetTime && Number.isFinite(Date.parse(quota.resetTime)) ? quota.resetTime : null,
  };
}

/** No global poll timestamp fallback, including for restored legacy rows. */
export function quotaFreshness(quota: ModelQuota, now: number, maxAgeMs: number): "fresh" | "stale" | "unknown" {
  const at = quota.observation?.observedAt;
  if (!Number.isFinite(at) || !at || at > now || maxAgeMs < 0) return "unknown";
  return now - at > maxAgeMs ? "stale" : "fresh";
}
