// Model-first view of the fleet: one row per quota pool (Claude, Gemini,
// Codex, Ollama session/weekly, …) instead of one card per account.

import type { AccountTier, ModelQuota } from "../../types.js";
import type {
  DashboardAccount,
  DashboardOverview,
  DashboardRoutingAccount,
  DashboardRoutingDiagnostics,
} from "../../dashboard-types.js";
import { isOutOfService, providerRank, quotaProvider } from "./status.js";

/** Rough requests per full quota window, used only to weight pooled capacity. */
const TIER_CAPACITY: Record<string, number> = {
  ultra: 2000,
  max: 2000,
  team: 1500,
  pro: 1500,
  plus: 1000,
  free: 250,
  unknown: 250,
};

export function tierWeight(tier: AccountTier | string | undefined): number {
  return TIER_CAPACITY[String(tier || "unknown")] ?? 250;
}

export type PoolState = "ok" | "low" | "empty" | "blocked";

export interface PoolMember {
  account: DashboardAccount;
  quota: ModelQuota;
  diagnostic: DashboardRoutingAccount | null;
}

export interface ModelPool {
  key: string;
  name: string;
  provider: string;
  /** In-service accounts that carry this pool. */
  members: PoolMember[];
  /** Members with quota left. */
  withQuota: number;
  /** Tier-weighted remaining quota, 0–100. */
  capacity: number;
  /** The account routing this pool now; null before its first request or after it stops being routable. */
  serving: DashboardAccount | null;
  /** Eligible accounts after `serving`, the policy's pick first. */
  nextUp: DashboardAccount[];
  nextResetAt: number | null;
  /** Requests per hour over the last hour (estimate). */
  burnPerHour: number;
  /** Hours until the pool runs dry at the current burn; null when idle. */
  hoursLeft: number | null;
  breakerUntil: number | null;
  diagnostics: DashboardRoutingDiagnostics | null;
  state: PoolState;
  /** Why nothing is serving, when that is the case. */
  blockedReason: string | null;
}

/** Map a request model id to the quota pool it draws from (best effort). */
export function poolKeyForModel(model: string): string {
  const lower = model.toLowerCase();
  if (lower === "big-pickle" || lower.endsWith("-free")) return "opencode-zen";
  if (lower.includes("claude") || lower.startsWith("gpt-oss-120b")) return "claude";
  if (lower.includes("gemini")) return "gemini";
  if (/^gpt-\d/.test(lower) || lower.includes("codex")) return "openai-codex";
  return "session";
}

function isRollingFullWindow(quota: ModelQuota, remaining: number): boolean {
  // A pool at 100% whose reset is exactly one window away is a rolling
  // window that has not started; its "reset" is not a real event.
  if (quota.percentRemaining !== 100) return false;
  const tolerance = 10 * 60_000;
  return (
    Math.abs(remaining - 5 * 3_600_000) < tolerance ||
    Math.abs(remaining - 7 * 86_400_000) < tolerance
  );
}

export function buildPools(overview: DashboardOverview, now: number): ModelPool[] {
  const byKey = new Map<string, { name: string; provider: string; members: PoolMember[] }>();

  for (const account of overview.accounts) {
    for (const quota of account.quota || []) {
      let pool = byKey.get(quota.modelKey);
      if (!pool) {
        pool = {
          name: quota.displayName || quota.modelKey,
          provider: quotaProvider(quota),
          members: [],
        };
        byKey.set(quota.modelKey, pool);
      }
      if (isOutOfService(account)) continue;
      const diag = overview.routingDiagnostics[quota.modelKey];
      pool.members.push({
        account,
        quota,
        diagnostic: diag?.accounts.find((d) => d.email === account.email) ?? null,
      });
    }
  }

  const burnByPool: Record<string, number> = {};
  for (const [model, requests] of Object.entries(overview.recentRequestsByModel || {})) {
    const key = poolKeyForModel(model);
    burnByPool[key] = (burnByPool[key] || 0) + requests;
  }

  const accountByEmail = new Map(overview.accounts.map((a) => [a.email, a]));
  const pools: ModelPool[] = [];

  for (const [key, pool] of byKey) {
    const diagnostics = overview.routingDiagnostics[key] ?? null;
    let weighted = 0;
    let weightTotal = 0;
    let remainingRequests = 0;
    let withQuota = 0;
    let nextResetAt: number | null = null;

    for (const member of pool.members) {
      const weight = tierWeight(member.account.tier);
      const pct = Math.max(0, Math.min(100, member.quota.percentRemaining || 0));
      weighted += pct * weight;
      weightTotal += weight;
      remainingRequests += (pct / 100) * weight;
      if (pct > 0) withQuota += 1;
      if (member.quota.resetTime && member.quota.timerType !== "fresh") {
        const resetAt = Date.parse(member.quota.resetTime);
        const remaining = resetAt - now;
        if (remaining > 0 && !isRollingFullWindow(member.quota, remaining)) {
          if (nextResetAt === null || resetAt < nextResetAt) nextResetAt = resetAt;
        }
      }
    }

    // The account routing this pool right now, the same one whose status reads
    // Serving. The policy's pick for the next rotation leads nextUp.
    const servingEmail = overview.activeAccounts[key] ?? null;
    const serving = servingEmail ? accountByEmail.get(servingEmail) ?? null : null;
    const selectedEmail = diagnostics?.selectedEmail ?? null;

    const nextUp = (diagnostics?.accounts ?? [])
      .filter((d) => !d.rejectedReason && d.email !== servingEmail)
      .sort(
        (a, b) =>
          Number(b.email === selectedEmail) - Number(a.email === selectedEmail) ||
          (b.score ?? -Infinity) - (a.score ?? -Infinity),
      )
      .map((d) => accountByEmail.get(d.email))
      .filter((a): a is DashboardAccount => Boolean(a))
      .slice(0, 2);

    const capacity = weightTotal > 0 ? Math.round(weighted / weightTotal) : 0;
    const burnPerHour = burnByPool[key] || 0;
    const hoursLeft = burnPerHour > 0 ? remainingRequests / burnPerHour : null;
    const breaker = overview.circuitBreakers.model[key];
    const breakerUntil = breaker && breaker > now ? breaker : null;

    let state: PoolState = "ok";
    if (breakerUntil || (pool.members.length > 0 && withQuota === 0)) state = "blocked";
    else if (diagnostics && !diagnostics.selectedEmail && diagnostics.availableCandidates === 0)
      state = "blocked";
    else if (capacity === 0) state = "empty";
    else if (capacity < 20) state = "low";

    pools.push({
      key,
      name: pool.name,
      provider: pool.provider,
      members: pool.members,
      withQuota,
      capacity,
      serving,
      nextUp,
      nextResetAt,
      burnPerHour,
      hoursLeft,
      breakerUntil,
      diagnostics,
      state,
      blockedReason:
        state === "blocked"
          ? breakerUntil
            ? "Circuit breaker open after repeated provider rate limits."
            : diagnostics?.reason || "No account has quota left in this pool."
          : null,
    });
  }

  return pools.sort(
    (a, b) =>
      providerRank(a.provider) - providerRank(b.provider) ||
      a.name.localeCompare(b.name),
  );
}
