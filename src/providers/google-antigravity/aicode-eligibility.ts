import { getCredentialGeneration } from "../../account-identity.js";
import { fetchWithRetry } from "../../fetch-with-retry.js";
import type { AccountAuthWarning, AccountRuntime } from "../../types.js";
import {
  AICODE_SCOPE,
  ANTIGRAVITY_CLIENT_METADATA,
  LIST_EXPERIMENTS_URL,
  LOAD_CODE_ASSIST_URL,
} from "../../types.js";
import { DEFAULT_PROVIDER, getProviderProjectId } from "../credential-helpers.js";
import { getAccountProxyDispatcher } from "../proxy-dispatcher.js";

const AICODE_ELIGIBILITY_TTL_MS = 6 * 60 * 60 * 1000;
const AICODE_ELIGIBILITY_RETRY_MS = 15 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasGoogleAntigravityCredential(account: AccountRuntime): boolean {
  if (account.config.credentials && account.config.credentials.length > 0) {
    return account.config.credentials.some((c) => c.provider === DEFAULT_PROVIDER);
  }
  return !account.config.provider || account.config.provider === DEFAULT_PROVIDER;
}

export function hasTokenScopes(account: AccountRuntime): boolean {
  return Array.isArray(account.tokenScopes) && account.tokenScopes.length > 0;
}

export function hasAicodeScope(account: AccountRuntime): boolean {
  return hasTokenScopes(account) && account.tokenScopes!.includes(AICODE_SCOPE);
}

export function hasMissingAicodeScope(account: AccountRuntime): boolean {
  return hasTokenScopes(account) && !account.tokenScopes!.includes(AICODE_SCOPE);
}

export function parseLoadCodeAssistPersonalConsumer(raw: unknown): {
  personalConsumer: boolean | null;
  userTierId: string | null;
} {
  if (!isRecord(raw)) {
    return { personalConsumer: null, userTierId: null };
  }
  const currentTier = isRecord(raw.currentTier) ? raw.currentTier : null;
  const paidTier = isRecord(raw.paidTier) ? raw.paidTier : null;
  const paidId = typeof paidTier?.id === "string" ? paidTier.id.trim() : "";
  const currentId = typeof currentTier?.id === "string" ? currentTier.id.trim() : "";
  const userTierId = paidId || currentId || null;

  if (raw.gcpManaged === true) {
    return { personalConsumer: false, userTierId };
  }
  if (
    /enterprise|business/i.test(currentId) ||
    /enterprise|business/i.test(paidId)
  ) {
    return { personalConsumer: false, userTierId };
  }
  if (userTierId || raw.gcpManaged === false) {
    return { personalConsumer: true, userTierId };
  }
  return { personalConsumer: null, userTierId: null };
}

export const USE_AICODE_MENDEL_FLAG = "use-aicode-mendel";
// Antigravity.app (2.34.0–2.35.2) only routes generation to AICode when this
// Mendel flag feeds SetUseAICodePredictionFlow; use-aicode-mendel only moves
// ListExperiments to fetchConfig.
export const INFERENCE_TRAFFIC_MIGRATION_FLAG = "enable-inference-traffic-migration";
export const DARK_LAUNCH_AICODE_QUOTA_STATUS_FLAG = "dark-launch-aicode-quota-status";

/**
 * Read a boolean experiment flag from a `listExperiments` (`{ flags }`) or
 * `fetchConfig.experimentConfig` (`{ experimentFlags }`) payload. Returns
 * null when the payload is not a flag list, false when the flag is absent.
 */
export function parseExperimentBoolFlag(raw: unknown, name: string): boolean | null {
  if (!isRecord(raw)) return null;
  const flags = Array.isArray(raw.flags)
    ? raw.flags
    : Array.isArray(raw.experimentFlags)
      ? raw.experimentFlags
      : null;
  if (!flags) return null;
  for (const entry of flags) {
    if (!isRecord(entry)) continue;
    if (entry.name === name && typeof entry.boolValue === "boolean") {
      return entry.boolValue;
    }
  }
  return false;
}

export function parseUseAicodeMendel(raw: unknown): boolean | null {
  return parseExperimentBoolFlag(raw, USE_AICODE_MENDEL_FLAG);
}

export async function refreshAicodeEligibilityIfNeeded(
  account: AccountRuntime,
  headers: Record<string, string>,
  isCurrentGeneration: () => boolean,
): Promise<void> {
  if (
    !hasGoogleAntigravityCredential(account) ||
    !hasTokenScopes(account) ||
    !account.accessToken
  ) {
    return;
  }

  const gen = getCredentialGeneration(account, DEFAULT_PROVIDER);
  const now = Date.now();
  const prev =
    account.aicodeEligibility?.credentialGeneration === gen
      ? account.aicodeEligibility
      : undefined;

  const isComplete =
    prev !== undefined &&
    prev.personalConsumer !== null &&
    prev.useAicodeMendel !== null &&
    prev.inferenceTrafficMigration !== undefined &&
    prev.inferenceTrafficMigration !== null;
  const ttl = isComplete ? AICODE_ELIGIBILITY_TTL_MS : AICODE_ELIGIBILITY_RETRY_MS;
  if (prev && now - prev.checkedAt < ttl) {
    return;
  }

  let personalConsumer = prev?.personalConsumer ?? null;
  let userTierId = prev?.userTierId ?? null;
  let useAicodeMendel = prev?.useAicodeMendel ?? null;
  let inferenceTrafficMigration = prev?.inferenceTrafficMigration ?? null;
  let darkLaunchAicodeQuotaStatus = prev?.darkLaunchAicodeQuotaStatus ?? null;
  const dispatcher = getAccountProxyDispatcher(account, DEFAULT_PROVIDER);

  if (personalConsumer === null || now - (prev?.checkedAt ?? 0) >= AICODE_ELIGIBILITY_TTL_MS) {
    try {
      const lcRes = await fetchWithRetry(LOAD_CODE_ASSIST_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ metadata: ANTIGRAVITY_CLIENT_METADATA }),
        timeoutMs: 8000,
        retries: 0,
        dispatcher,
      });
      if (!isCurrentGeneration()) return;
      if (lcRes.ok) {
        const parsed = parseLoadCodeAssistPersonalConsumer(
          await lcRes.json().catch(() => null),
        );
        if (parsed.personalConsumer !== null) {
          personalConsumer = parsed.personalConsumer;
        }
        if (parsed.userTierId !== null) {
          userTierId = parsed.userTierId;
        }
      }
    } catch {
      // Non-fatal: keep cached/partial value and retry on next cycle.
    }
  }

  const projectId = getProviderProjectId(account.config, DEFAULT_PROVIDER);
  if (
    projectId &&
    (useAicodeMendel === null ||
      inferenceTrafficMigration === null ||
      now - (prev?.checkedAt ?? 0) >= AICODE_ELIGIBILITY_TTL_MS)
  ) {
    try {
      const expRes = await fetchWithRetry(LIST_EXPERIMENTS_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({
          project: projectId,
          metadata: ANTIGRAVITY_CLIENT_METADATA,
        }),
        timeoutMs: 8000,
        retries: 0,
        dispatcher,
      });
      if (!isCurrentGeneration()) return;
      if (expRes.ok) {
        const raw: unknown = await expRes.json().catch(() => null);
        const mendel = parseUseAicodeMendel(raw);
        if (mendel !== null) {
          useAicodeMendel = mendel;
        }
        const migration = parseExperimentBoolFlag(raw, INFERENCE_TRAFFIC_MIGRATION_FLAG);
        if (migration !== null) {
          inferenceTrafficMigration = migration;
        }
        const darkLaunch = parseExperimentBoolFlag(raw, DARK_LAUNCH_AICODE_QUOTA_STATUS_FLAG);
        if (darkLaunch !== null) {
          darkLaunchAicodeQuotaStatus = darkLaunch;
        }
      }
    } catch {
      // Non-fatal: keep cached/partial value and retry on next cycle.
    }
  }

  if (!isCurrentGeneration()) return;
  account.aicodeEligibility = {
    credentialGeneration: gen,
    checkedAt: Date.now(),
    personalConsumer,
    useAicodeMendel,
    inferenceTrafficMigration,
    darkLaunchAicodeQuotaStatus,
    userTierId,
  };
}

export function buildAccountAuthWarning(
  account: AccountRuntime,
): AccountAuthWarning | null {
  if (
    !hasGoogleAntigravityCredential(account) ||
    account.disabled ||
    account.flagged ||
    account.invalidProviders?.[DEFAULT_PROVIDER] ||
    account.disabledProviders?.includes(DEFAULT_PROVIDER)
  ) {
    return null;
  }

  const gen = getCredentialGeneration(account, DEFAULT_PROVIDER);
  const eligibility = account.aicodeEligibility;
  if (!eligibility || eligibility.credentialGeneration !== gen) {
    return null;
  }

  const personalConsumer = eligibility.personalConsumer === true;
  const useAicodeMendel = eligibility.useAicodeMendel === true;
  const missingAicodeScope = hasMissingAicodeScope(account);

  if (!personalConsumer || !useAicodeMendel || !missingAicodeScope) {
    return null;
  }

  return {
    code: "missing-aicode-scope",
    message:
      "Re-authenticate required: personal consumer account has use-aicode-mendel active and is missing the aicode OAuth scope.",
    rules: {
      personalConsumer: true,
      useAicodeMendel: true,
      missingAicodeScope: true,
    },
  };
}
