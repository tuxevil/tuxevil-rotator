// The dashboard's single status vocabulary. Every label, tone and grouping
// for accounts, routing health and providers comes from here.

import type { AccountTier, ModelQuota } from "../../types.js";
import type {
  DashboardAccount,
  RoutingHealthState,
} from "../../dashboard-types.js";

export type Tone = "neutral" | "ok" | "info" | "warn" | "bad" | "muted";

export type AccountState = DashboardAccount["status"];

export interface StatusMeta {
  label: string;
  tone: Tone;
  description: string;
}

export const ACCOUNT_STATUS: Record<AccountState, StatusMeta> = {
  active: {
    label: "Serving",
    tone: "ok",
    description: "Currently the routing target for at least one model.",
  },
  ready: {
    label: "Ready",
    tone: "neutral",
    description: "Healthy and available, waiting for its turn.",
  },
  cooldown: {
    label: "Cooling down",
    tone: "warn",
    description:
      "Waiting out a provider rate-limit window instead of forcing more traffic into it.",
  },
  exhausted: {
    label: "Out of quota",
    tone: "warn",
    description: "Quota is used up until the provider window resets.",
  },
  error: {
    label: "Erroring",
    tone: "bad",
    description:
      "Recent requests failed. Review the error before it escalates to disabled.",
  },
  disabled: {
    label: "Disabled",
    tone: "muted",
    description:
      "Out of service after repeated errors or by an operator. Re-enable once the cause is fixed.",
  },
  flagged: {
    label: "Quarantined",
    tone: "bad",
    description:
      "Flagged by the provider or quarantined by an operator. Excluded from routing until restored.",
  },
};

export function accountStatus(state: AccountState): StatusMeta {
  return ACCOUNT_STATUS[state] ?? ACCOUNT_STATUS.ready;
}

export function canServe(account: { status: AccountState }): boolean {
  return account.status === "active" || account.status === "ready";
}

export function isCooling(account: { status: AccountState }): boolean {
  return account.status === "cooldown" || account.status === "exhausted";
}

export function needsAttention(account: {
  status: AccountState;
  invalidProviders?: Record<string, string>;
}): boolean {
  return (
    account.status === "error" ||
    account.status === "disabled" ||
    account.status === "flagged" ||
    Boolean(account.invalidProviders?.["openai-codex"])
  );
}

export function isOutOfService(account: { status: AccountState }): boolean {
  return account.status === "disabled" || account.status === "flagged";
}

export const ROUTING_STATE: Record<RoutingHealthState, StatusMeta> = {
  healthy: {
    label: "Routing healthy",
    tone: "ok",
    description: "Requests are being served.",
  },
  busy: {
    label: "All accounts busy",
    tone: "warn",
    description: "Every routable account is at its concurrency limit.",
  },
  cooldown_wait: {
    label: "Waiting for cooldowns",
    tone: "warn",
    description: "No account is free right now; routing resumes when a cooldown ends.",
  },
  paused: {
    label: "Routing paused",
    tone: "bad",
    description: "A protective pause is holding all traffic.",
  },
  stopped: {
    label: "Routing stopped",
    tone: "bad",
    description: "No account can serve requests.",
  },
};

export function routingState(state: RoutingHealthState | undefined): StatusMeta {
  return ROUTING_STATE[state ?? "stopped"] ?? ROUTING_STATE.stopped;
}

export const PROVIDER_LABELS: Record<string, string> = {
  "google-antigravity": "Antigravity",
  ollama: "Ollama",
  "openai-codex": "Codex",
  "opencode-zen": "OpenCode Zen",
};

export function providerIds(account: { provider?: string }): string[] {
  return String(account.provider || "")
    .split("+")
    .filter(Boolean);
}

export function providerLabel(id: string): string {
  return PROVIDER_LABELS[id] ?? id;
}

/** Provider that owns a quota pool, inferred from its key when not reported. */
export function quotaProvider(quota: Pick<ModelQuota, "providerId" | "modelKey">): string {
  if (quota.providerId) return quota.providerId;
  const key = String(quota.modelKey || "");
  if (key === "claude" || key === "gemini") return "google-antigravity";
  if (key === "monthly" || key === "session" || key === "weekly") return "ollama";
  if (key.startsWith("opencode")) return "opencode-zen";
  if (key.startsWith("openai-codex") || key.startsWith("codex")) return "openai-codex";
  return "google-antigravity";
}

const PROVIDER_ORDER = ["google-antigravity", "ollama", "opencode-zen", "openai-codex"];

export function providerRank(id: string): number {
  const index = PROVIDER_ORDER.indexOf(id);
  return index < 0 ? PROVIDER_ORDER.length : index;
}

export const ACCOUNT_TIERS: AccountTier[] = ["unknown", "free", "plus", "pro", "ultra"];

export function tierLabel(tier: AccountTier | string | undefined): string {
  const value = String(tier || "unknown");
  if (value === "unknown") return "Unknown tier";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export const TIMER_LABELS: Record<ModelQuota["timerType"], string> = {
  fresh: "Idle — no window running",
  "5h": "5-hour window",
  "7d": "7-day window",
  monthly: "Monthly pool",
};

/** Idle pools can be started with a minimal request ("kickstart"). */
export function isKickstartable(quota: ModelQuota): boolean {
  if (quota.timerType !== "fresh") return false;
  if (quota.providerId === "opencode-zen") return false;
  if (quota.providerId === "ollama" && quota.modelKey !== "session") return false;
  const key = String(quota.modelKey || "");
  return key !== "opencode-zen" && !key.startsWith("opencode-zen:") && key !== "weekly";
}

/** Error-message hints for problems that need action outside the rotator. */
export function errorHint(message: string | null | undefined): string | null {
  const lower = String(message || "").toLowerCase();
  if (!lower) return null;
  if (lower.includes("verif"))
    return "Open the Antigravity IDE, sign in with this account and finish the verification prompt there. Keep it quarantined until that is done.";
  if (lower.includes("terms of service"))
    return "Google suspended this account. Appeal through Google Account Recovery and keep it out of rotation unless access is restored.";
  if (lower.includes("invalid_grant") || lower.includes("revoked"))
    return "The refresh token was revoked. Sign in again with Add account to replace the credential.";
  return null;
}

export const REJECTION_LABELS: Record<string, string> = {
  disabled: "Disabled",
  flagged: "Quarantined",
  "provider-ineligible": "Provider cannot serve this model",
  "account-concurrency": "At its concurrency limit",
  "project-concurrency": "Project at its concurrency limit",
  cooldown: "Cooling down",
  "fresh-window-blocked": "Would open a fresh window (blocked)",
  "quota-zero": "No quota left",
  "project-breaker": "Project circuit breaker open",
  "model-breaker": "Model circuit breaker open",
  "daily-account-stop": "Daily account budget reached",
  "daily-project-stop": "Daily project budget reached",
  "token-bucket-empty": "Token bucket empty",
};

export function rejectionLabel(reason: string | null | undefined): string {
  if (!reason) return "Eligible";
  return REJECTION_LABELS[reason] ?? reason;
}

export const ROUTING_POLICIES: Array<{ value: string; label: string; description: string }> = [
  {
    value: "timer-first",
    label: "Timer first (default)",
    description: "Drain running 5-hour windows first, then 7-day windows, then idle accounts.",
  },
  {
    value: "tier-first",
    label: "Tier first",
    description: "Prefer the highest tier: Ultra, then Pro, Plus, Free and Unknown.",
  },
  {
    value: "quota-first",
    label: "Quota first",
    description: "The account with the most remaining quota wins.",
  },
  {
    value: "hybrid",
    label: "Hybrid",
    description: "A weighted score combining timer, tier, quota and health, with an optional token bucket.",
  },
  {
    value: "sequential-quota",
    label: "Sequential quota",
    description: "Walk accounts in configured order, skipping cooldowns and empty pools.",
  },
  {
    value: "sticky-quota",
    label: "Sticky quota",
    description: "Keep the current account while it has quota; fall back during cooldowns and return when it recovers.",
  },
];
