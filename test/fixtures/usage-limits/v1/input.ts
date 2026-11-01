import type { DashboardOverview, DashboardAccount } from "../../../../src/dashboard-types.js";
import type { ModelQuota } from "../../../../src/types.js";
export const NOW = 1800000000000;
export const INSTANCE = "40000000-0000-4000-8000-000000000001";
const quota = (providerId: string, modelKey: string, percentRemaining: number, estimated = false): ModelQuota => ({
  providerId, modelKey, displayName: modelKey, percentRemaining, resetTime: new Date(NOW + 3600000).toISOString(), timerType: "5h",
  observation: { observedAt: NOW, percentageSource: "derived", remainingPercent: percentRemaining,
    resetSource: estimated ? "estimated" : "reported", resetAt: new Date(NOW + 3600000).toISOString() },
});
export function fixtureOverview(): DashboardOverview {
  const account = (email: string, quota: ModelQuota[], tier = "pro") => ({
    id: `private-${email}`, email, label: email, provider: quota[0].providerId, tier, quota,
    status: "ready", disabledProviders: [], activeForModels: [],
    lastError: "SECRET_ERROR", refreshToken: "SECRET_OAUTH", apiKey: "SECRET_KEY",
  }) as unknown as DashboardAccount;
  const credit = quota("ollama", "monthly", 25, true);
  credit.credits = { balanceUsd: 5, allowanceUsd: 20, purchasedUsd: 3 };
  const zen = quota("opencode-zen", "opencode-zen", 100);
  zen.observation = { ...zen.observation!, percentageSource: "unknown", remainingPercent: null, catalogAccessible: true, resetAt: null, resetSource: "unknown" };
  const accounts = [
    account("a@secret.invalid", [quota("google-antigravity", "claude", 80)], "ultra"),
    account("b@secret.invalid", [quota("google-antigravity", "claude", 20)], "free"),
    account("c@secret.invalid", [credit]), account("d@secret.invalid", [zen]),
  ];
  return { accounts, routingDiagnostics: {}, circuitBreakers: { model: {}, project: {} }, activeAccounts: {}, recentRequestsByModel: {} } as unknown as DashboardOverview;
}
