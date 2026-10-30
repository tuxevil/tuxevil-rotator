// Model-first view of the fleet: one row per quota pool (Claude, Gemini,
// Codex, Ollama session/weekly, …) instead of one card per account.

import { quotaFreshness } from "./quota-observation.js";
import type { AccountTier, ModelQuota } from "./types.js";
import type {
  DashboardAccount,
  DashboardOverview,
  DashboardRoutingAccount,
  DashboardRoutingDiagnostics,
} from "./dashboard-types.js";
import { isOutOfService, providerRank, providerIds, quotaProvider } from "./web/lib/status.js";

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
  /** Collision-safe observability identity; key remains the router's model key. */
  id: string;
  observedCapacity: number | null;
  catalogAccessible: boolean | null;
  observedWithQuota: number | null;
  eligibleNow: number | null;
  observedAt: number | null;
  freshness: "fresh" | "stale" | "unknown";
  capacityBasis: "tier-estimate" | "included-credits" | "unknown";
  resetBasis: "reported" | "estimated" | "unknown";
  observedNextResetAt: number | null;
  name: string;
  provider: string;
  /** In-service accounts that carry this pool. */
  members: PoolMember[];
  /** Members with quota left. */
  withQuota: number;
  /** Remaining included quota, weighted by credit allowance or account tier, 0–100. */
  capacity: number;
  /** Actual included credits, summed across in-service accounts. */
  credits: ModelQuota["credits"] | null;
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


/** Shared dashboard/future API calculation; tier weights are relative estimates. */
export function pooledCapacity(members: PoolMember[]): number {
  let weighted = 0;
  let weightTotal = 0;
  let balance = 0;
  let allowance = 0;
  for (const { account, quota } of members) {
    const weight = quota.credits?.allowanceUsd ?? tierWeight(account.tier);
    weighted += Math.max(0, Math.min(100, quota.percentRemaining || 0)) * weight;
    weightTotal += weight;
    balance += quota.credits?.balanceUsd ?? 0;
    allowance += quota.credits?.allowanceUsd ?? 0;
  }
  return allowance > 0 ? Math.max(0, Math.min(100, Math.round(balance / allowance * 100)))
    : weightTotal > 0 ? Math.round(weighted / weightTotal) : 0;
}

export function buildPools(overview: DashboardOverview, now: number): ModelPool[] {
  const byKey = new Map<string, { name: string; provider: string; members: PoolMember[] }>();

  for (const account of overview.accounts) {
    for (const quota of account.quota || []) {
      const identity = JSON.stringify([quotaProvider(quota), quota.modelKey]);
      let pool = byKey.get(identity);
      if (!pool) {
        pool = {
          name: quota.displayName || quota.modelKey,
          provider: quotaProvider(quota),
          members: [],
        };
        byKey.set(identity, pool);
      }
      if (isOutOfService(account) || account.disabledProviders?.includes(quotaProvider(quota))) continue;
      const diag = overview.routingDiagnostics[quota.modelKey];
      pool.members.push({
        account,
        quota,
        diagnostic: diag?.accounts.find((d) => d.id && account.id ? d.id === account.id : d.email === account.email) ?? null,
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

  for (const [id, pool] of byKey) {
    const key = (JSON.parse(id) as [string, string])[1];
    const diagnostics = overview.routingDiagnostics[key] ?? null;
    let remainingRequests = 0;
    let withQuota = 0;
    let nextResetAt: number | null = null;
    let credits: ModelQuota["credits"] | null = null;

    for (const member of pool.members) {
      const credit = member.quota.credits;
      const weight = credit?.allowanceUsd ?? tierWeight(member.account.tier);
      if (credit) {
        credits ??= { balanceUsd: 0, allowanceUsd: 0, purchasedUsd: 0 };
        credits.balanceUsd += credit.balanceUsd;
        credits.allowanceUsd += credit.allowanceUsd;
        credits.purchasedUsd += credit.purchasedUsd;
      }
      const pct = Math.max(0, Math.min(100, member.quota.percentRemaining || 0));
      remainingRequests += (pct / 100) * weight;
      if (pct > 0 || (credit?.purchasedUsd ?? 0) > 0) withQuota += 1;
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

    const capacity = pooledCapacity(pool.members);
    const availableCapacity = credits && credits.allowanceUsd > 0
      ? (credits.balanceUsd + credits.purchasedUsd) / credits.allowanceUsd * 100
      : capacity;
    const burnPerHour = burnByPool[key] || 0;
    const hoursLeft = !credits && burnPerHour > 0 ? remainingRequests / burnPerHour : null;
    const breaker = overview.circuitBreakers.model[key];
    const breakerUntil = breaker && breaker > now ? breaker : null;

    let state: PoolState = "ok";
    if (breakerUntil || (pool.members.length > 0 && withQuota === 0)) state = "blocked";
    else if (diagnostics && !diagnostics.selectedEmail && diagnostics.availableCandidates === 0)
      state = "blocked";
    else if (availableCapacity === 0) state = "empty";
    else if (availableCapacity < 20) state = "low";

    const known = pool.members.length > 0 && pool.members.every(({ quota }) =>
      quota.observation?.percentageSource !== "unknown" &&
      quota.observation?.remainingPercent != null && Number.isFinite(quota.observation.remainingPercent));
    const observedMembers = pool.members.map((member) => ({ ...member, quota: {
      ...member.quota, percentRemaining: member.quota.observation?.remainingPercent ?? 0,
    } }));
    const ages = pool.members.map(({ quota }) => quotaFreshness(quota, now, 15 * 60_000));
    const freshness = ages.length === 0 || ages.includes("unknown") ? "unknown"
      : ages.includes("stale") ? "stale" : "fresh";
    const observedAt = freshness === "unknown" ? null
      : Math.min(...pool.members.map(({ quota }) => quota.observation!.observedAt));
    const resetMembers = pool.members.filter(({ quota }) => quota.observation?.resetAt &&
      Date.parse(quota.observation.resetAt) > now);
    const observedNextResetAt = resetMembers.length ? Math.min(...resetMembers.map(({ quota }) =>
      Date.parse(quota.observation!.resetAt!))) : null;
    const selectedResets = resetMembers.filter(({ quota }) => Date.parse(quota.observation!.resetAt!) === observedNextResetAt);
    const collision = [...byKey.keys()].filter((identity) => (JSON.parse(identity) as string[])[1] === key).length > 1;
    const eligibleNow = !diagnostics || collision || pool.members.some(member => !member.diagnostic) ? null : pool.members.filter(({ diagnostic }) =>
      diagnostic && !diagnostic.rejectedReason).length;
    pools.push({
      key,
      id,
      catalogAccessible: pool.members.some(({ quota }) => quota.observation?.catalogAccessible === true) ? true : null,
      observedCapacity: known ? pooledCapacity(observedMembers) : null,
      observedWithQuota: known ? observedMembers.filter(({ quota }) => quota.percentRemaining > 0 || (quota.credits?.purchasedUsd ?? 0) > 0).length : null,
      eligibleNow,
      observedAt,
      freshness,
      capacityBasis: !known ? "unknown" : credits ? "included-credits" : "tier-estimate",
      resetBasis: selectedResets.length === 0 ? "unknown" : selectedResets.some(({ quota }) => quota.observation!.resetSource === "estimated") ? "estimated" : selectedResets.every(({ quota }) => quota.observation!.resetSource === "reported") ? "reported" : "unknown",
      observedNextResetAt,
      name: pool.name,
      provider: pool.provider,
      members: pool.members,
      withQuota,
      capacity,
      credits,
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

export interface ProviderGroup {
  provider: string;
  accounts: DashboardAccount[];
  pools: ModelPool[];
}

/** Connected providers remain visible even before their first successful quota poll. */
export function buildProviderGroups(overview: DashboardOverview, now: number): ProviderGroup[] {
  const groups = new Map<string, ProviderGroup>();
  const ensure = (provider: string): ProviderGroup => {
    let group = groups.get(provider);
    if (!group) {
      group = { provider, accounts: [], pools: [] };
      groups.set(provider, group);
    }
    return group;
  };
  for (const account of overview.accounts) {
    const providers = new Set([
      ...providerIds(account),
      ...account.quota.map(quotaProvider),
    ]);
    for (const provider of providers) ensure(provider).accounts.push(account);
  }
  for (const pool of buildPools(overview, now)) ensure(pool.provider).pools.push(pool);
  return [...groups.values()].sort((a, b) => providerRank(a.provider) - providerRank(b.provider));
}
