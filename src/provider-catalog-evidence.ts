import type { AccountConfig } from "./types.js";
import { applyModelAlias } from "./types.js";
import { getAccountIdentity, getCredentialGeneration } from "./account-identity.js";
import { dynamicCatalog } from "./providers/google-antigravity/dynamic-catalog.js";

export interface ProviderCatalogEvidence {
  provider: "google-antigravity";
  source: "fetchAvailableModels";
  freshness: "fresh" | "stale" | "unknown";
  observedAt: number | null;
  expiresAt: number | null;
  models: string[];
}
export function antigravityCatalogEvidence(account: AccountConfig, pollIntervalMs = 300000, now = Date.now()): ProviderCatalogEvidence {
  const snapshot = dynamicCatalog.getAccountSnapshot(getAccountIdentity(account), getCredentialGeneration(account, "google-antigravity"));
  const base = { provider: "google-antigravity", source: "fetchAvailableModels" } as const;
  if (!snapshot) return { ...base, freshness: "unknown", observedAt: null, expiresAt: null, models: [] };
  const maxAge = Math.min(1800000, Math.max(60000, pollIntervalMs * 2));
  const expiresAt = snapshot.observedAt + maxAge;
  return { ...base, ...snapshot, expiresAt, freshness: snapshot.observedAt > now ? "unknown" : expiresAt > now ? "fresh" : "stale" };
}
export function advertisedModelState(catalog: ProviderCatalogEvidence, model: string): "advertised" | "not-advertised" | "unknown" {
  if (catalog.freshness !== "fresh") return "unknown";
  const target = applyModelAlias(model).trim().replace(/^models\//i, "").toLowerCase();
  return catalog.models.some(id => id.toLowerCase() === target) ? "advertised" : "not-advertised";
}
