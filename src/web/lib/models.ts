// Models page: one row per model id across providers, and a summary per
// provider built from the catalog API and the live overview.

import type {
  CatalogModelEntry,
  CatalogProvider,
  DashboardAccount,
  DashboardOverview,
  ModelCatalogResponse,
} from "../../dashboard-types.js";
import type { ModelQuota } from "../../types.js";
import { buildPools } from "./pools.js";
import { canServe, providerIds, quotaProvider } from "./status.js";

/** Two-letter marks and hues for provider monograms. */
export const PROVIDER_MARKS: Record<string, { mark: string; hue: number }> = {
  "google-antigravity": { mark: "AG", hue: 215 },
  "openai-codex": { mark: "CX", hue: 165 },
  ollama: { mark: "OL", hue: 28 },
  "opencode-zen": { mark: "ZN", hue: 280 },
};

export function providerMark(id: string): { mark: string; hue: number } {
  return PROVIDER_MARKS[id] ?? { mark: id.slice(0, 2).toUpperCase(), hue: 250 };
}

/** Config key for one provider's copy of a model. */
export function offeringKey(entry: Pick<CatalogModelEntry, "providerId" | "id">): string {
  return `${entry.providerId}/${entry.id}`;
}

export function isServed(entry: CatalogModelEntry): boolean {
  return entry.offReason === null;
}

export interface ModelRow {
  /** Lower-cased id: one row per id across providers. */
  key: string;
  id: string;
  /** Every provider that lists the id, in provider order. */
  offerings: CatalogModelEntry[];
  /** Served by at least one provider. */
  on: boolean;
  /** Listed by more than one provider. */
  shared: boolean;
  /** Waiting for review on at least one provider. */
  waiting: boolean;
  /** Requests in the last hour. */
  requests: number;
  /** The effort-routed model ID that sends one of its levels to this model. */
  effortRoute: { alias: string; effort: string } | null;
}

export function buildModelRows(
  catalog: ModelCatalogResponse,
  requestsByModel: Record<string, number>,
): ModelRow[] {
  const requests = new Map<string, number>();
  for (const [model, count] of Object.entries(requestsByModel)) {
    const key = model.toLowerCase();
    requests.set(key, (requests.get(key) ?? 0) + count);
  }
  const rows = new Map<string, ModelRow>();
  for (const entry of catalog.models) {
    const key = entry.id.toLowerCase();
    const row = rows.get(key) ?? {
      key,
      id: entry.id,
      offerings: [],
      on: false,
      shared: false,
      waiting: false,
      requests: requests.get(key) ?? 0,
      effortRoute: null,
    };
    row.offerings.push(entry);
    row.effortRoute ??= entry.effortRoute ?? null;
    row.on ||= isServed(entry);
    row.waiting ||= entry.modelSwitch === "review";
    row.shared = row.offerings.length > 1;
    rows.set(key, row);
  }
  return [...rows.values()];
}

export type ModelFilter = "all" | "on" | "off" | "shared" | "waiting" | "effort";

export const MODEL_FILTERS: Array<{ id: ModelFilter; label: string; match: (row: ModelRow) => boolean }> = [
  { id: "all", label: "All", match: () => true },
  { id: "on", label: "On", match: (row) => row.on },
  { id: "off", label: "Off", match: (row) => !row.on },
  { id: "shared", label: "Shared", match: (row) => row.shared },
  { id: "waiting", label: "Waiting for review", match: (row) => row.waiting },
  { id: "effort", label: "Effort routing", match: (row) => row.effortRoute !== null },
];

export function isModelFilter(value: unknown): value is ModelFilter {
  return MODEL_FILTERS.some((filter) => filter.id === value);
}

export type ModelSort = "requests" | "name";

export function filterModelRows(
  rows: ModelRow[],
  options: { filter: ModelFilter; provider: string; query: string },
): ModelRow[] {
  const match = MODEL_FILTERS.find((filter) => filter.id === options.filter)?.match ?? (() => true);
  const query = options.query.trim().toLowerCase();
  return rows.filter(
    (row) =>
      match(row) &&
      (!options.provider || row.offerings.some((entry) => entry.providerId === options.provider)) &&
      (!query || row.offerings.some((entry) => entry.id.toLowerCase().includes(query))),
  );
}

/** Busiest first, then by name; models that are off sink below the rest. */
export function sortModelRows(rows: ModelRow[], sort: ModelSort): ModelRow[] {
  return [...rows].sort((a, b) => {
    if (a.on !== b.on) return a.on ? -1 : 1;
    if (sort === "requests" && a.requests !== b.requests) return b.requests - a.requests;
    return a.id.localeCompare(b.id);
  });
}

export type ProviderState = "off" | "not-connected" | "needs-sign-in" | "unavailable" | "healthy";

export interface ProviderQuota {
  key: string;
  name: string;
  /** Tier-weighted remaining quota across in-service accounts, 0–100. */
  percent: number;
}

export interface ProviderSummary {
  provider: CatalogProvider;
  /** 0-based position in the routing order. */
  rank: number;
  /** Accounts holding a credential for this provider. */
  accounts: DashboardAccount[];
  /** Accounts that can serve this provider now. */
  canServe: number;
  /** Accounts whose credential for this provider was rejected. */
  rejected: DashboardAccount[];
  models: number;
  modelsOn: number;
  quotas: ProviderQuota[];
  state: ProviderState;
}

export function hasProvider(account: DashboardAccount, providerId: string): boolean {
  return providerIds(account).includes(providerId);
}

export function isTurnedOffForAccount(account: DashboardAccount, providerId: string): boolean {
  return account.disabledProviders?.includes(providerId) ?? false;
}

/** Account can take this provider's traffic now. */
export function canServeProvider(
  account: DashboardAccount,
  providerId: string,
  now: number,
  routing?: {
    quotaPools: readonly string[];
    diagnostics: DashboardOverview["routingDiagnostics"];
  },
): boolean {
  if (
    !canServe(account) ||
    account.invalidProviders?.[providerId] ||
    (account.providerCooldowns?.[providerId] ?? 0) > now ||
    isTurnedOffForAccount(account, providerId)
  ) return false;

  const quotas = providerQuotaRows(account, providerId);
  const pools = new Set(routing?.quotaPools.length ? routing.quotaPools : quotas.map((quota) => quota.modelKey));
  if (pools.size === 0) return true;
  return [...pools].some((key) => {
    const diagnostics = routing?.diagnostics[key]?.accounts ?? [];
    const identified = account.id ? diagnostics.filter((entry) => entry.id === account.id) : [];
    const byEmail = diagnostics.filter((entry) => entry.email === account.email);
    // A legacy producer may omit identity. Email is usable only if unique
    // and must never replace a different identity supplied by the server.
    const diagnostic = identified.length === 1
      ? identified[0]
      : identified.length === 0 && byEmail.length === 1 && (!account.id || !byEmail[0].id)
        ? byEmail[0]
        : null;
    if (diagnostic) return diagnostic.rejectedReason === null;
    if ((account.cooldownsByModel[key] ?? 0) > now) return false;
    // Missing and negative quota mean unknown, which routing permits.
    return quotas.find((quota) => quota.modelKey === key)?.percentRemaining !== 0;
  });
}

export function providerQuotaRows(account: DashboardAccount, providerId: string): ModelQuota[] {
  return (account.quota ?? []).filter((quota) => quotaProvider(quota) === providerId);
}

export function summarizeProviders(
  catalog: ModelCatalogResponse,
  overview: DashboardOverview,
  now: number,
): ProviderSummary[] {
  const pools = buildPools(overview, now);
  return catalog.providers.map((provider, rank) => {
    const accounts = overview.accounts.filter((account) => hasProvider(account, provider.id));
    const rejected = accounts.filter((account) => Boolean(account.invalidProviders?.[provider.id]));
    const models = catalog.models.filter((entry) => entry.providerId === provider.id);
    const routing = { quotaPools: models.map((entry) => entry.quotaPool), diagnostics: overview.routingDiagnostics };
    const servable = accounts.filter((account) => canServeProvider(account, provider.id, now, routing)).length;
    const state: ProviderState = !provider.enabled
      ? "off"
      : accounts.length === 0
        ? "not-connected"
        : rejected.length > 0
          ? "needs-sign-in"
          : servable === 0
            ? "unavailable"
            : "healthy";
    return {
      provider,
      rank,
      accounts,
      canServe: servable,
      rejected,
      models: models.length,
      modelsOn: models.filter(isServed).length,
      quotas: pools
        .filter((pool) => pool.provider === provider.id && pool.members.length > 0)
        .map((pool) => ({ key: pool.key, name: pool.name, percent: pool.capacity })),
      state,
    };
  });
}

/** Move one provider up or down the routing order. */
export function moveProvider(order: string[], id: string, offset: number): string[] {
  const from = order.indexOf(id);
  const to = from + offset;
  if (from < 0 || to < 0 || to >= order.length) return order;
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

/** Drop `id` just before or after `targetId` (drag and drop). */
export function placeProvider(order: string[], id: string, targetId: string, after: boolean): string[] {
  if (id === targetId) return order;
  const next = order.filter((entry) => entry !== id);
  const at = next.indexOf(targetId);
  if (at < 0 || !order.includes(id)) return order;
  next.splice(after ? at + 1 : at, 0, id);
  return next;
}

/** Context windows as people say them: 128K, 1M, 1.05M. */
export function formatContextWindow(tokens: number | null): string {
  if (tokens === null || !Number.isFinite(tokens) || tokens <= 0) return "—";
  if (tokens >= 1_000_000) {
    const millions = tokens % 1_048_576 === 0 ? tokens / 1_048_576 : tokens / 1_000_000;
    return `${Number(millions.toFixed(2))}M`;
  }
  if (tokens % 1000 === 0) return `${tokens / 1000}K`;
  if (tokens % 1024 === 0) return `${tokens / 1024}K`;
  return `${Math.round(tokens / 1000)}K`;
}

const POOL_NAMES: Record<string, string> = {
  claude: "Claude",
  gemini: "Gemini",
  monthly: "Monthly",
  session: "Session",
  weekly: "Weekly",
  "openai-codex": "Codex",
  "openai-codex-spark": "Codex Spark",
  "opencode-zen": "Zen",
};

export function quotaPoolLabel(key: string): string {
  if (POOL_NAMES[key]) return POOL_NAMES[key];
  return key
    .split("-")
    .filter(Boolean)
    .map((part) => (/^\d+(?:\.\d+)?$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ") || key;
}
