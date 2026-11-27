// Google AICode (aicode.googleapis.com / v1alpha) client helpers:
// management discovery (fetchConfig, fetchLicenses), entitlement resolution,
// and 1h scope-cooldown tracking when ACCESS_TOKEN_SCOPE_INSUFFICIENT occurs.

import { getAccountIdentity, getCredentialGeneration } from "../../account-identity.js";
import { fetchWithRetry, type RequestInitWithDispatcher } from "../../fetch-with-retry.js";
import { logger } from "../../logger.js";
import { AICODE_ENDPOINTS, REQUEST_USER_AGENT } from "../../types.js";
import type { AccountRuntime } from "../../types.js";
import { DEFAULT_PROVIDER } from "../credential-helpers.js";
import { getAccountProxyDispatcher } from "../proxy-dispatcher.js";
import {
  INFERENCE_TRAFFIC_MIGRATION_FLAG,
  parseExperimentBoolFlag,
  parseUseAicodeMendel,
} from "./aicode-eligibility.js";

const aicodeLogger = logger.child("google-aicode");

export const AICODE_SCOPE_COOLDOWN_MS = 60 * 60 * 1000;
export const AICODE_DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000;

export type AicodeConfigSnapshot = NonNullable<
  NonNullable<AccountRuntime["aicodeState"]>["config"]
>;
export type AicodeLicenseSnapshot = NonNullable<
  NonNullable<AccountRuntime["aicodeState"]>["licenses"]
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveAicodeEndpoint(): string {
  const override = process.env.AICODE_ENDPOINT_URL?.trim();
  const base = override || AICODE_ENDPOINTS[0] || "https://aicode.googleapis.com";
  return base.replace(/\/+$/, "");
}

export function buildAicodeWireHeaders(
  account: AccountRuntime,
  originalHeaders: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${account.accessToken ?? ""}`,
    "User-Agent": REQUEST_USER_AGENT,
  };
  let requestReason = "";
  let userProjectHeader = "";
  for (const [key, value] of Object.entries(originalHeaders)) {
    const lower = key.toLowerCase();
    if (lower === "x-goog-request-reason" && typeof value === "string" && value.trim()) {
      requestReason = value.trim();
    } else if (lower === "x-goog-user-project" && typeof value === "string" && value.trim()) {
      userProjectHeader = value.trim();
    }
  }
  requestReason ||= process.env.GOOG_REQUEST_REASON?.trim() || "";
  userProjectHeader ||=
    process.env.AICODE_DEV_PROJECT?.trim() ||
    process.env.GOOG_USER_PROJECT?.trim() ||
    "";
  if (requestReason) {
    headers["X-Goog-Request-Reason"] = requestReason;
  }
  if (userProjectHeader) {
    headers["X-Goog-User-Project"] = userProjectHeader;
  }
  return headers;
}

export function isAicodeInsufficientScopeError(
  status: number,
  errorText: string,
): boolean {
  return status === 403 && errorText.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT");
}

function ensureAicodeState(account: AccountRuntime): NonNullable<AccountRuntime["aicodeState"]> {
  const gen = getCredentialGeneration(account, DEFAULT_PROVIDER);
  if (!account.aicodeState || account.aicodeState.credentialGeneration !== gen) {
    account.aicodeState = { credentialGeneration: gen };
  }
  return account.aicodeState;
}

export function clearAicodeState(account: AccountRuntime): void {
  delete account.aicodeState;
}

export function isInAicodeScopeCooldown(
  account: AccountRuntime,
  now = Date.now(),
): boolean {
  const gen = getCredentialGeneration(account, DEFAULT_PROVIDER);
  const state = account.aicodeState;
  if (!state || state.credentialGeneration !== gen) return false;
  return typeof state.scopeCooldownUntil === "number" && state.scopeCooldownUntil > now;
}

export function markAicodeScopeMissing(
  account: AccountRuntime,
  now = Date.now(),
): number {
  const state = ensureAicodeState(account);
  const until = now + AICODE_SCOPE_COOLDOWN_MS;
  const wasCooling = typeof state.scopeCooldownUntil === "number" && state.scopeCooldownUntil > now;
  state.scopeCooldownUntil = until;
  if (!wasCooling) {
    const label = account.config.label || account.config.email;
    aicodeLogger.log(
      "warn",
      `[${label}] OAuth token lacks aicode scope (ACCESS_TOKEN_SCOPE_INSUFFICIENT); routing AICode traffic to CCPA for 60m`,
    );
  }
  return until;
}

export function parseAicodeFetchConfig(
  raw: unknown,
  credentialGeneration: string,
  fetchedAt = Date.now(),
): AicodeConfigSnapshot | null {
  if (!isRecord(raw)) return null;
  const experiencesByLowerName: Record<string, string> = Object.create(null);
  const experienceMetaByLowerName: Record<
    string,
    { modelId?: string; displayName?: string }
  > = Object.create(null);
  const experienceNames: string[] = [];
  const rawExperiences = Array.isArray(raw.availableExperiences)
    ? raw.availableExperiences
    : [];
  for (const entry of rawExperiences) {
    if (!isRecord(entry)) continue;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name || !isRecord(entry.model)) continue;
    const lower = name.toLowerCase();
    if (!Object.hasOwn(experiencesByLowerName, lower)) {
      experiencesByLowerName[lower] = name;
      experienceNames.push(name);
      const modelId =
        typeof entry.model.modelId === "string" && entry.model.modelId.trim()
          ? entry.model.modelId.trim()
          : undefined;
      const displayName =
        typeof entry.model.displayName === "string" && entry.model.displayName.trim()
          ? entry.model.displayName.trim()
          : undefined;
      experienceMetaByLowerName[lower] = {
        ...(modelId ? { modelId } : {}),
        ...(displayName ? { displayName } : {}),
      };
    }
  }
  const useAicodeMendel = isRecord(raw.experimentConfig)
    ? parseUseAicodeMendel(raw.experimentConfig)
    : null;
  const inferenceTrafficMigration = isRecord(raw.experimentConfig)
    ? parseExperimentBoolFlag(raw.experimentConfig, INFERENCE_TRAFFIC_MIGRATION_FLAG)
    : null;

  return {
    credentialGeneration,
    fetchedAt,
    experiencesByLowerName,
    experienceNames,
    experienceMetaByLowerName,
    useAicodeMendel,
    inferenceTrafficMigration,
  };
}

export function parseAicodeFetchLicenses(
  raw: unknown,
  credentialGeneration: string,
  fetchedAt = Date.now(),
): AicodeLicenseSnapshot | null {
  if (!isRecord(raw)) return null;
  const licenses = Array.isArray(raw.licenses) ? raw.licenses : [];
  let userTier: string | null = null;
  let tierDisplayName: string | null = null;
  for (const entry of licenses) {
    if (!isRecord(entry)) continue;
    const tier = typeof entry.userTier === "string" ? entry.userTier.trim() : "";
    if (tier) {
      userTier = tier;
      tierDisplayName =
        typeof entry.tierDisplayName === "string" && entry.tierDisplayName.trim()
          ? entry.tierDisplayName.trim()
          : null;
      break;
    }
  }
  return {
    credentialGeneration,
    fetchedAt,
    userTier,
    tierDisplayName,
  };
}

export function resolveAicodeExperience(
  config: AicodeConfigSnapshot | undefined,
  model: string,
): string | null {
  if (!config) return null;
  const normalized = model.trim().toLowerCase();
  if (!normalized) return null;
  return Object.hasOwn(config.experiencesByLowerName, normalized)
    ? config.experiencesByLowerName[normalized]
    : null;
}

const inFlightConfigFetches = new Map<string, Promise<AicodeConfigSnapshot | null>>();
const inFlightLicenseFetches = new Map<string, Promise<AicodeLicenseSnapshot | null>>();

export async function fetchAicodeConfig(
  account: AccountRuntime,
  originalHeaders: Record<string, string> = {},
  signal?: AbortSignal,
  options?: { force?: boolean; now?: number },
): Promise<AicodeConfigSnapshot | null> {
  if (!account.accessToken) return null;
  const now = options?.now ?? Date.now();
  const gen = getCredentialGeneration(account, DEFAULT_PROVIDER);
  const state = ensureAicodeState(account);
  if (
    !options?.force &&
    state.config &&
    state.config.credentialGeneration === gen &&
    now - state.config.fetchedAt < AICODE_DISCOVERY_CACHE_TTL_MS
  ) {
    return state.config;
  }

  const flightKey = `${getAccountIdentity(account)}:${gen}`;
  const existing = inFlightConfigFetches.get(flightKey);
  if (existing) {
    return existing;
  }

  const promise = (async (): Promise<AicodeConfigSnapshot | null> => {
    try {
      const endpoint = resolveAicodeEndpoint();
      const response = await fetchWithRetry(`${endpoint}/v1alpha:fetchConfig`, {
        method: "GET",
        headers: buildAicodeWireHeaders(account, originalHeaders),
        timeoutMs: 8000,
        retries: 0,
        signal,
        dispatcher: getAccountProxyDispatcher(account, DEFAULT_PROVIDER),
      } as RequestInitWithDispatcher);

      if (getCredentialGeneration(account, DEFAULT_PROVIDER) !== gen) {
        return null;
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        if (isAicodeInsufficientScopeError(response.status, errorText)) {
          markAicodeScopeMissing(account);
        }
        return state.config?.credentialGeneration === gen ? state.config : null;
      }

      const raw = await response.json().catch(() => null);
      if (getCredentialGeneration(account, DEFAULT_PROVIDER) !== gen) {
        return null;
      }
      const parsed = parseAicodeFetchConfig(raw, gen, Date.now());
      if (parsed) {
        ensureAicodeState(account).config = parsed;
      }
      return parsed;
    } catch (err) {
      if (signal?.aborted) throw err;
      return state.config?.credentialGeneration === gen ? state.config : null;
    }
  })().finally(() => {
    inFlightConfigFetches.delete(flightKey);
  });

  inFlightConfigFetches.set(flightKey, promise);
  return promise;
}

export async function fetchAicodeLicenses(
  account: AccountRuntime,
  originalHeaders: Record<string, string> = {},
  signal?: AbortSignal,
  options?: { force?: boolean; now?: number },
): Promise<AicodeLicenseSnapshot | null> {
  if (!account.accessToken) return null;
  const now = options?.now ?? Date.now();
  const gen = getCredentialGeneration(account, DEFAULT_PROVIDER);
  const state = ensureAicodeState(account);
  if (
    !options?.force &&
    state.licenses &&
    state.licenses.credentialGeneration === gen &&
    now - state.licenses.fetchedAt < AICODE_DISCOVERY_CACHE_TTL_MS
  ) {
    return state.licenses;
  }

  const flightKey = `${getAccountIdentity(account)}:${gen}`;
  const existing = inFlightLicenseFetches.get(flightKey);
  if (existing) {
    return existing;
  }

  const promise = (async (): Promise<AicodeLicenseSnapshot | null> => {
    try {
      const endpoint = resolveAicodeEndpoint();
      const response = await fetchWithRetry(`${endpoint}/v1alpha:fetchLicenses`, {
        method: "GET",
        headers: buildAicodeWireHeaders(account, originalHeaders),
        timeoutMs: 8000,
        retries: 0,
        signal,
        dispatcher: getAccountProxyDispatcher(account, DEFAULT_PROVIDER),
      } as RequestInitWithDispatcher);

      if (getCredentialGeneration(account, DEFAULT_PROVIDER) !== gen) {
        return null;
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        if (isAicodeInsufficientScopeError(response.status, errorText)) {
          markAicodeScopeMissing(account);
        }
        return state.licenses?.credentialGeneration === gen ? state.licenses : null;
      }

      const raw = await response.json().catch(() => null);
      if (getCredentialGeneration(account, DEFAULT_PROVIDER) !== gen) {
        return null;
      }
      const parsed = parseAicodeFetchLicenses(raw, gen, Date.now());
      if (parsed) {
        ensureAicodeState(account).licenses = parsed;
      }
      return parsed;
    } catch (err) {
      if (signal?.aborted) throw err;
      return state.licenses?.credentialGeneration === gen ? state.licenses : null;
    }
  })().finally(() => {
    inFlightLicenseFetches.delete(flightKey);
  });

  inFlightLicenseFetches.set(flightKey, promise);
  return promise;
}

export interface AicodeQuotaBucket {
  modelId: string;
  displayName?: string;
  description?: string;
  remainingFraction?: number;
  resetTime?: string;
}

export interface AicodeQuotaStatusResult {
  buckets: AicodeQuotaBucket[];
  quotaSummary: unknown;
}

export function parseAicodeQuotaStatus(raw: unknown): AicodeQuotaStatusResult | null {
  if (!isRecord(raw)) return null;
  const rawBuckets = Array.isArray(raw.buckets) ? raw.buckets : [];
  const buckets: AicodeQuotaBucket[] = [];
  for (const entry of rawBuckets) {
    if (!isRecord(entry) || !isRecord(entry.model)) continue;
    const modelId =
      typeof entry.model.modelId === "string" ? entry.model.modelId.trim() : "";
    if (!modelId) continue;
    const fraction =
      typeof entry.remainingFraction === "number" &&
      Number.isFinite(entry.remainingFraction) &&
      entry.remainingFraction >= 0 &&
      entry.remainingFraction <= 1
        ? entry.remainingFraction
        : undefined;
    const resetTime =
      typeof entry.resetTime === "string" && entry.resetTime.trim()
        ? entry.resetTime.trim()
        : undefined;
    const displayName =
      typeof entry.model.displayName === "string" && entry.model.displayName.trim()
        ? entry.model.displayName.trim()
        : undefined;
    const description =
      typeof entry.model.description === "string" && entry.model.description.trim()
        ? entry.model.description.trim()
        : undefined;
    buckets.push({
      modelId,
      ...(displayName ? { displayName } : {}),
      ...(description ? { description } : {}),
      ...(fraction !== undefined ? { remainingFraction: fraction } : {}),
      ...(resetTime ? { resetTime } : {}),
    });
  }
  if (buckets.length === 0 && !isRecord(raw.quotaSummary)) {
    return null;
  }
  return {
    buckets,
    quotaSummary: isRecord(raw.quotaSummary) ? raw.quotaSummary : null,
  };
}

export async function fetchAicodeQuotaStatus(
  account: AccountRuntime,
  originalHeaders: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<AicodeQuotaStatusResult | null> {
  if (!account.accessToken) return null;
  const gen = getCredentialGeneration(account, DEFAULT_PROVIDER);
  try {
    const endpoint = resolveAicodeEndpoint();
    const response = await fetchWithRetry(`${endpoint}/v1alpha:fetchQuotaStatus`, {
      method: "GET",
      headers: buildAicodeWireHeaders(account, originalHeaders),
      timeoutMs: 8000,
      retries: 0,
      signal,
      dispatcher: getAccountProxyDispatcher(account, DEFAULT_PROVIDER),
    } as RequestInitWithDispatcher);

    if (getCredentialGeneration(account, DEFAULT_PROVIDER) !== gen) {
      return null;
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      if (isAicodeInsufficientScopeError(response.status, errorText)) {
        markAicodeScopeMissing(account);
      }
      return null;
    }

    const raw = await response.json().catch(() => null);
    if (getCredentialGeneration(account, DEFAULT_PROVIDER) !== gen) {
      return null;
    }
    return parseAicodeQuotaStatus(raw);
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
}
