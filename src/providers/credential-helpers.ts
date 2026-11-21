// Credential helpers for the parent-account model: independent of the
// provider adapters so they can be imported from the config layer without
// pulling in the translators/responses-store cycle.

export const DEFAULT_PROVIDER = "google-antigravity";

export interface CredentialEntry {
  provider: string;
  apiKey?: string;
  refreshToken?: string;
  projectId?: string;
  providerAccountId?: string;
  projectSource?: "google" | "manual";
  proxyUrl?: string;
}

export interface AccountLike {
  credentials?: CredentialEntry[];
  provider?: string;
  apiKey?: string;
  refreshToken?: string;
  projectId?: string;
  codexRefreshToken?: string;
  codexAccountId?: string;
  projectSource?: "google" | "manual";
  proxyUrl?: string;
}

export function primaryProviderId(account: AccountLike): string {
  if (account.credentials && account.credentials.length > 0) {
    return account.credentials[0].provider;
  }
  return account.provider ?? DEFAULT_PROVIDER;
}

export function hasCredential(account: AccountLike, providerId: string): boolean {
  if (account.credentials && account.credentials.length > 0) {
    return account.credentials.some((c) => c.provider === providerId);
  }
  return (account.provider ?? DEFAULT_PROVIDER) === providerId;
}

export function getCredential(
  account: AccountLike,
  providerId: string,
): CredentialEntry | undefined {
  if (account.credentials && account.credentials.length > 0) {
    const found = account.credentials.find((c) => c.provider === providerId);
    if (found) return found;
  }
  if ((account.provider ?? DEFAULT_PROVIDER) === providerId) {
    const legacy: CredentialEntry = { provider: providerId };
    if (account.apiKey !== undefined) legacy.apiKey = account.apiKey;
    if (account.refreshToken !== undefined) legacy.refreshToken = account.refreshToken;
    if (account.projectId !== undefined) legacy.projectId = account.projectId;
    if (providerId === "openai-codex") {
      if (account.codexRefreshToken !== undefined) legacy.refreshToken = account.codexRefreshToken;
      if (account.codexAccountId !== undefined) legacy.providerAccountId = account.codexAccountId;
    }
    if (account.projectSource !== undefined) legacy.projectSource = account.projectSource;
    if (account.proxyUrl !== undefined) legacy.proxyUrl = account.proxyUrl;
    return legacy;
  }
  return undefined;
}

/** Resolve a provider project without letting whitespace mask legacy fallback. */
export function getProviderProjectId(
  account: AccountLike,
  providerId: string,
): string {
  const nested = account.credentials
    ?.find((credential) => credential.provider === providerId)
    ?.projectId?.trim();
  if (nested) return nested;
  return providerId === DEFAULT_PROVIDER ? account.projectId?.trim() || "" : "";
}

/**
 * Resolve the egress proxy configured for one provider credential. Incoming
 * request headers are deliberately not consulted here; proxy selection is
 * always an account/configuration concern.
 */
export function getProviderProxyUrl(
  account: AccountLike,
  providerId: string,
): string | undefined {
  const credential = getCredential(account, providerId);
  if (credential?.proxyUrl !== undefined) return credential.proxyUrl;
  return undefined;
}

export const PROVIDER_ORDER: string[] = [
  "google-antigravity",
  "ollama",
  "opencode-zen",
  "openai-codex",
];

export const PROVIDER_ORDER_RANK: Record<string, number> = {
  "google-antigravity": 1,
  ollama: 2,
  "opencode-zen": 3,
  "openai-codex": 4,
};

// Ollama Cloud currently exposes one account-wide usage pool. Keep the old
// names as aliases so persisted state and older API responses remain readable
// during the transition.
export const OLLAMA_QUOTA_POOL_KEY = "monthly";

export function isOllamaQuotaPoolKey(poolKey: string): boolean {
  return poolKey === OLLAMA_QUOTA_POOL_KEY ||
    poolKey === "session" ||
    poolKey === "weekly";
}

export function isSafePoolKey(poolKey: unknown): poolKey is string {
  return (
    typeof poolKey === "string" &&
    poolKey.length > 0 &&
    poolKey.length <= 64 &&
    /^[a-z0-9][a-z0-9._:-]*$/.test(poolKey) &&
    poolKey !== "__proto__" &&
    poolKey !== "constructor" &&
    poolKey !== "prototype"
  );
}

export function getProviderIdForPoolKey(poolKey: string): string {
  if (poolKey.startsWith("codex:") || poolKey.startsWith("openai-codex")) return "openai-codex";
  if (poolKey.startsWith("opencode-zen:") || poolKey === "opencode-zen") return "opencode-zen";
  if (isOllamaQuotaPoolKey(poolKey)) return "ollama";
  if (poolKey === "claude" || poolKey === "gemini") return "google-antigravity";
  if (PROVIDER_ORDER_RANK[poolKey] !== undefined) return poolKey;
  return DEFAULT_PROVIDER;
}

export type QuotaPoolLike = {
  modelKey: string;
  providerId?: string;
};

export function getQuotaItemProviderId(q: QuotaPoolLike): string {
  if (q.providerId && PROVIDER_ORDER_RANK[q.providerId] !== undefined) {
    return q.providerId;
  }
  return getProviderIdForPoolKey(q.modelKey);
}

export function sortQuotaPools<T extends QuotaPoolLike>(quotas: T[]): T[] {
  return [...quotas].sort((a, b) => {
    const rankA = PROVIDER_ORDER_RANK[getQuotaItemProviderId(a)] ?? 99;
    const rankB = PROVIDER_ORDER_RANK[getQuotaItemProviderId(b)] ?? 99;
    if (rankA !== rankB) {
      return rankA - rankB;
    }
    return 0;
  });
}

export function sortAccountCredentials<T extends { provider: string }>(credentials: T[]): T[] {
  return [...credentials].sort((a, b) => {
    const rankA = PROVIDER_ORDER_RANK[a.provider] ?? 99;
    const rankB = PROVIDER_ORDER_RANK[b.provider] ?? 99;
    if (rankA !== rankB) {
      return rankA - rankB;
    }
    return 0;
  });
}

/**
 * Format remaining time until an ISO reset timestamp for RAW POLL logs using
 * days, hours, and minutes depending on magnitude (e.g. "45m", "2h 8m", "6d 21h 8m").
 */
export function formatQuotaResetRemaining(
  resetTime: string,
  now = Date.now(),
): string {
  const resetMs = Date.parse(resetTime);
  if (!Number.isFinite(resetMs)) return "unknown";
  const totalMinutes = Math.max(0, Math.round((resetMs - now) / 60_000));
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  return parts.join(" ");
}
