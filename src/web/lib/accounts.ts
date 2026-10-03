// Account list filtering and sorting for the Accounts table.

import type { DashboardAccount } from "../../dashboard-types.js";
import {
  canServe,
  isCooling,
  needsAttention,
  providerIds,
  providerLabel,
  type AccountState,
} from "./status.js";

export type AccountFilter = "all" | "serving" | "cooling" | "attention";

export const ACCOUNT_FILTERS: Array<{ id: AccountFilter; label: string; match: (a: { status: AccountState }) => boolean }> = [
  { id: "all", label: "All", match: () => true },
  { id: "serving", label: "Can serve", match: canServe },
  { id: "cooling", label: "Cooling down", match: isCooling },
  { id: "attention", label: "Needs attention", match: needsAttention },
];

export function isAccountFilter(value: unknown): value is AccountFilter {
  return ACCOUNT_FILTERS.some((f) => f.id === value);
}

export type AccountSortKey = "name" | "status" | "quota" | "health" | "requests" | "lastUsed";

export function isAccountSortKey(value: unknown): value is AccountSortKey {
  return ["name", "status", "quota", "health", "requests", "lastUsed"].includes(String(value));
}

const STATUS_ORDER: Record<AccountState, number> = {
  active: 0,
  ready: 1,
  cooldown: 2,
  exhausted: 3,
  error: 4,
  disabled: 5,
  flagged: 6,
};

/** Lowest remaining quota across pools: the pool that will stop the account first. */
export function lowestQuota(account: DashboardAccount): number | null {
  const pools = account.quota || [];
  if (pools.length === 0) return null;
  return Math.min(...pools.map((q) => q.percentRemaining));
}

export function averageQuota(account: DashboardAccount): number | null {
  const pools = account.quota || [];
  if (pools.length === 0) return null;
  return pools.reduce((sum, q) => sum + q.percentRemaining, 0) / pools.length;
}

export function matchesQuery(
  account: DashboardAccount,
  query: string,
  displayName: string,
  masked: boolean,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    displayName,
    masked ? "" : account.email,
    masked ? "" : account.label,
    account.status,
    account.tier,
    ...providerIds(account).flatMap((p) => [p, providerLabel(p)]),
    ...(account.quota || []).map((quota) => quota.displayName),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

export function sortAccounts(
  accounts: DashboardAccount[],
  key: AccountSortKey,
  direction: 1 | -1,
  displayName: (email: string) => string,
): DashboardAccount[] {
  const value = (a: DashboardAccount): number | string => {
    switch (key) {
      case "name":
        return displayName(a.email).toLowerCase();
      case "status":
        return STATUS_ORDER[a.status] ?? 9;
      case "quota":
        return averageQuota(a) ?? -1;
      case "health":
        return a.healthScore || 0;
      case "requests":
        return a.totalRequests || 0;
      case "lastUsed":
        return a.lastUsed || 0;
    }
  };
  return [...accounts].sort((a, b) => {
    const av = value(a);
    const bv = value(b);
    let cmp =
      typeof av === "string" && typeof bv === "string"
        ? av.localeCompare(bv, undefined, { numeric: true })
        : (av as number) - (bv as number);
    if (cmp === 0) cmp = a.email.localeCompare(b.email);
    return cmp * direction;
  });
}
