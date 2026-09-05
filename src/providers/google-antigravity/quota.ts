// Google Antigravity quota polling: fetch per-model quota from the internal
// fetchAvailableModels endpoint and classify timer windows.

import type {
  AccountRuntime,
  GoogleQuotaResponse,
  ModelQuota,
} from "../../types.js";
import {
  QUOTA_API_URL,
  QUOTA_USER_AGENT,
  QUOTA_MODEL_KEYS,
} from "../../types.js";
import { fetchWithRetry } from "../../fetch-with-retry.js";
import {
  getAccountIdentity,
  getCredentialGeneration,
} from "../../account-identity.js";
import type { QuotaFetchContext } from "../adapter.js";
import { DEFAULT_PROVIDER, getProviderProjectId } from "../credential-helpers.js";
import { getAccountProxyDispatcher } from "../proxy-dispatcher.js";
import { sortQuotaPools } from "../registry.js";

import {
  dynamicCatalog,
  DynamicModelRegistry,
  parseGoogleQuotaResponse,
} from "./dynamic-catalog.js";

type GoogleModelInfo = GoogleQuotaResponse["models"][string];
type GoogleModelInfoWithQuota = GoogleModelInfo & {
  quotaInfo: NonNullable<GoogleModelInfo["quotaInfo"]>;
};

function hasUsableQuotaInfo(
  info: GoogleModelInfo | undefined,
): info is GoogleModelInfoWithQuota {
  if (!info?.quotaInfo) return false;
  const remaining = info.quotaInfo.remainingFraction;
  if (remaining === undefined) {
    // Google omits remainingFraction for active quota windows. A resetTime
    // without a fraction is the partial shape used by the legacy parser.
    return typeof info.quotaInfo.resetTime === "string" &&
      info.quotaInfo.resetTime.trim().length > 0;
  }
  return typeof remaining === "number" && Number.isFinite(remaining) &&
    remaining >= 0 && remaining <= 1;
}

function getRemainingFraction(info: GoogleModelInfoWithQuota): number {
  const remaining = info.quotaInfo.remainingFraction;
  return typeof remaining === "number" && Number.isFinite(remaining) &&
      remaining >= 0 && remaining <= 1
    ? remaining
    : 0;
}

function applyActiveCooldown(
  quota: ModelQuota,
  cooldownUntil: number | undefined,
  now: number,
): void {
  if (!cooldownUntil || !Number.isFinite(cooldownUntil) || cooldownUntil <= now) {
    return;
  }
  const advertisedReset = quota.resetTime
    ? new Date(quota.resetTime).getTime()
    : 0;
  const resetAt = Math.max(
    cooldownUntil,
    Number.isFinite(advertisedReset) && advertisedReset > now ? advertisedReset : 0,
  );
  quota.percentRemaining = 0;
  quota.resetTime = new Date(resetAt).toISOString();
  quota.timerType = resetAt - now < 6 * 60 * 60 * 1000 ? "5h" : "7d";
}

function getActiveCooldownForPool(
  account: AccountRuntime,
  poolKey: string,
): number | undefined {
  let cooldownUntil = account.cooldownsByModel[poolKey] ?? 0;
  for (const [modelKey, deadline] of Object.entries(account.cooldownsByModel)) {
    if (
      modelKey !== poolKey &&
      dynamicCatalog.resolveQuotaPool(modelKey) === poolKey
    ) {
      cooldownUntil = Math.max(cooldownUntil, deadline);
    }
  }
  return cooldownUntil || undefined;
}

/**
 * Extract per-model quotas from a Google quota response, preserving the
 * previously classified timer type when the reset time is unchanged.
 */
export function extractQuotas(
  data: GoogleQuotaResponse,
  oldQuota: ModelQuota[],
): ModelQuota[] {
  const quotas: ModelQuota[] = [];
  const now = Date.now();

  for (const [, config] of Object.entries(QUOTA_MODEL_KEYS)) {
    const candidates: GoogleModelInfoWithQuota[] = [];
    for (const candidate of [config.key, ...config.altKeys]) {
      const info = data.models[candidate];
      if (hasUsableQuotaInfo(info)) {
        candidates.push(info);
      }
    }

    for (const [modelKey, info] of Object.entries(data.models)) {
      if (
        ![config.key, ...config.altKeys].includes(modelKey) &&
        DynamicModelRegistry.inferFamilyAndPool(modelKey).quotaPool === config.key &&
        hasUsableQuotaInfo(info)
      ) {
        candidates.push(info);
      }
    }

    // A shared pool is usable only as far as its most exhausted model. Google
    // may report one sibling at 100% while the model we route to is exhausted.
    const modelInfo = candidates.sort(
      (a, b) => getRemainingFraction(a) - getRemainingFraction(b) ||
        Number(Boolean(b.quotaInfo.resetTime)) -
          Number(Boolean(a.quotaInfo.resetTime)),
    )[0];
    if (modelInfo?.quotaInfo) {
      const remainingFraction = getRemainingFraction(modelInfo);
      // Google can publish a nominal reset for an untouched pool; no usage means
      // there is no active quota window yet.
      const resetTime =
        remainingFraction >= 1 ? null : modelInfo.quotaInfo.resetTime ?? null;
      let timerType: ModelQuota["timerType"] = "fresh";

      if (resetTime) {
        const oldQ = oldQuota.find((q) => q.modelKey === config.key);
        // If the resetTime is exactly the same as the previous poll, preserve
        // the old timerType. A timer doesn't change its nature just because it
        // gets closer to zero.
        if (oldQ && oldQ.resetTime === resetTime && oldQ.timerType !== "fresh") {
          timerType = oldQ.timerType;
        } else {
          // Brand new timer (or service restart): measure the distance to
          // determine its type. < 6 hours → 5h timer, otherwise 7d.
          const resetMs = new Date(resetTime).getTime();
          if (resetMs > now) {
            const durationMs = resetMs - now;
            timerType = durationMs < 6 * 60 * 60 * 1000 ? "5h" : "7d";
          }
        }
      }

      quotas.push({
        modelKey: config.key,
        displayName: config.display,
        percentRemaining: Math.round(remainingFraction * 100),
        resetTime,
        timerType,
      });
    }
  }

  return quotas;
}

/**
 * Poll quota for one account and write the result into account.quota.
 * Non-OK responses flag the account via the core-provided callbacks.
 */
export async function fetchProviderQuota(
  account: AccountRuntime,
  ctx: QuotaFetchContext,
): Promise<void> {
  if (!account.accessToken) return;
  const accountId = getAccountIdentity(account);
  const credentialGeneration = getCredentialGeneration(
    account,
    DEFAULT_PROVIDER,
  );
  const accountEpoch = dynamicCatalog.captureAccountEpoch(
    accountId,
    credentialGeneration,
  );
  if (accountEpoch === null) return;
  const isCurrentGeneration = (): boolean =>
    accountId === getAccountIdentity(account) &&
    credentialGeneration === getCredentialGeneration(account, DEFAULT_PROVIDER) &&
    dynamicCatalog.isAccountGenerationActive(
      accountId,
      credentialGeneration,
      accountEpoch,
    );

  try {
    const response = await fetchWithRetry(QUOTA_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${account.accessToken}`,
        "User-Agent": QUOTA_USER_AGENT,
      },
      body: JSON.stringify({
        project: getProviderProjectId(account.config, DEFAULT_PROVIDER),
      }),
      timeoutMs: 8000,
      dispatcher: getAccountProxyDispatcher(account, "google-antigravity"),
    });
    if (!isCurrentGeneration()) return;

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        const errorText = await response.text();
        if (!isCurrentGeneration()) return;
        ctx.log(
          `${account.config.email}: quota API returned ${response.status}, flagging account`,
        );
        ctx.reportQuotaPollFlag(account, response.status, errorText);
        ctx.markFlagged(
          account,
          `Quota API ${response.status}: ${errorText}`,
          { triggerProtectivePause: false },
        );
      }
      return;
    }

    const rawData = await response.json();
    if (!isCurrentGeneration()) return;
    const data = parseGoogleQuotaResponse(rawData);
    if (!data) return;
    const oldQuota = account.quota || [];
    const fresh = extractQuotas(data, oldQuota);
    if (fresh.length === 0) return;
    const newModels = dynamicCatalog.updateFromEndpointResponse(
      data,
      accountId,
      credentialGeneration,
      accountEpoch,
    );
    if (newModels > 0) {
      ctx.log(
        `${account.config.email}: discovered ${newModels} Antigravity model(s) from quota response`,
      );
    }
    // Drop the previous Antigravity entries so the new ones fully replace
    // them; keep entries from OTHER providers (Ollama) so multi-provider
    // accounts accumulate quotas across credentials without overwriting
    // one another.
    const otherProviders = (oldQuota || []).filter(
      (q) => (q as { providerId?: string }).providerId &&
        (q as { providerId?: string }).providerId !== "google-antigravity",
    );
    fresh.forEach(
      (q) => ((q as { providerId?: string }).providerId = "google-antigravity"),
    );
    const freshKeys = new Set(fresh.map((quota) => quota.modelKey));
    const previousGooglePools = oldQuota.filter(
      (q) => (q as { providerId?: string }).providerId === DEFAULT_PROVIDER &&
        !freshKeys.has(q.modelKey),
    );
    for (const quota of [...previousGooglePools, ...fresh]) {
      if (
        freshKeys.has(quota.modelKey) &&
        quota.percentRemaining === 0 &&
        quota.resetTime
      ) {
        // A newly reported exhausted window is authoritative; the poll
        // reconciler will persist its reset time instead of stale local state.
        continue;
      }
      applyActiveCooldown(
        quota,
        getActiveCooldownForPool(account, quota.modelKey),
        Date.now(),
      );
    }
    account.quota = sortQuotaPools([
      ...otherProviders,
      ...previousGooglePools,
      ...fresh,
    ]);
    account.lastQuotaPoll = Date.now();

    // Stash the provider-local poll log for the rotator to emit as a
    // single consolidated line per cycle.
    account.lastPollByProvider ??= {};
    account.lastPollByProvider["google-antigravity"] = account.quota
      .filter(
        (q) =>
          (q as { providerId?: string }).providerId === "google-antigravity",
      )
      .map((q) => {
        const remain = q.resetTime
          ? Math.round(
              (new Date(q.resetTime).getTime() - Date.now()) / 60000,
            ) + "m"
          : "no_reset";
        return `[${q.modelKey}: ${q.timerType} ${q.percentRemaining}% in ${remain}]`;
      })
      .join(" | ");
  } catch {
    // Network error, skip
  }
}
