import { observeQuota } from "../../quota-observation.js";
// Ollama Cloud quota polling: `GET /api/balance` → included credits/windows.
//
// Ported from the ollama-rotator project (same author) into the
// tuxevil-rotator provider layer.

import { fetchWithRetry } from "../../fetch-with-retry.js";
import { OLLAMA_BALANCE_URL, OLLAMA_USAGE_URL, OLLAMA_USER_AGENT } from "../../types.js";
import { getOllamaApiKey } from "./credentials.js";
import type { AccountRuntime, ModelQuota } from "../../types.js";
import type { QuotaFetchContext } from "../adapter.js";
import { recordParsedQuotaPolls, recordUsagePoll } from "./quota-poll-store.js";
import {
  nextWeeklyResetMs,
  sessionWindowEndMs,
  SESSION_WINDOW_MS,
} from "./usage-windows.js";
import { getAccountProxyDispatcher } from "../proxy-dispatcher.js";
import { sortQuotaPools } from "../registry.js";
import { getQuotaItemProviderId, OLLAMA_QUOTA_POOL_KEY } from "../credential-helpers.js";

/**
 * Poll balance for actual remaining quota; the usage endpoint now reports
 * historical consumption, not subscription limits.
 * Non-2xx responses flag the account (401/403) via the context callbacks;
 * network errors are swallowed (quota stays stale, rotation falls back to
 * request-count based rotation).
 */
export async function fetchProviderUsage(
  account: AccountRuntime,
  ctx: QuotaFetchContext,
): Promise<void> {
  try {
    const options = {
      method: "GET",
      headers: {
        Authorization: `Bearer ${getOllamaApiKey(account.config) ?? ""}`,
        "User-Agent": OLLAMA_USER_AGENT,
      },
      timeoutMs: 8000,
      dispatcher: getAccountProxyDispatcher(account, "ollama"),
    };
    let response = await fetchWithRetry(OLLAMA_BALANCE_URL, options);
    const legacy = response.status === 404;
    if (legacy) {
      await response.body?.cancel();
      response = await fetchWithRetry(OLLAMA_USAGE_URL, options);
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        const errorText = await response.text().catch(() => "");
        ctx.log(
          `${account.config.email}: Ollama quota API returned ${response.status}, invalidating provider credential`,
        );
        ctx.reportQuotaPollFlag(account, response.status, errorText);
        if (ctx.markProviderInvalid) {
          ctx.markProviderInvalid(
            account,
            "ollama",
            `Ollama quota API ${response.status}: ${errorText}`,
          );
        }
      }
      return;
    }

    const data: unknown = await response.json();
    const oldQuota = account.quota || [];
    const fresh = legacy
      ? extractUsagePools(data as OllamaUsageResponse, oldQuota)
      : extractBalancePools(data);
    if (fresh.length === 0) {
      ctx.log(`${account.config.email}: Ollama quota response has no recognized limits; retaining last known quota`);
      return;
    }
    // Replace only this provider's quota after parsing a valid response.
    const otherProviders = (oldQuota || []).filter(
      (q) => getQuotaItemProviderId(q) !== "ollama",
    );
    fresh.forEach(
      (q) => (q.providerId = "ollama"),
    );
    const observedAt = Date.now();
    for (const quota of fresh) quota.observation = observeQuota(quota, observedAt,
      !legacy && !quota.credits ? "reported" : "derived", legacy ? "estimated" : "reported");
    account.quota = sortQuotaPools([...otherProviders, ...fresh]);
    account.lastQuotaPoll = Date.now();
    const polledAt = new Date(account.lastQuotaPoll).toISOString();
    if (legacy) void recordUsagePoll(account.config.email, polledAt, data as OllamaUsageResponse);
    else void recordParsedQuotaPolls(account.config.email, polledAt, fresh);

    // Stash the provider-local poll log for the rotator to emit as a
    // single consolidated line per cycle.
    account.lastPollByProvider ??= {};
    account.lastPollByProvider["ollama"] = account.quota
      .filter(
        (q) => q.providerId === "ollama",
      )
      .map((q) => {
        const remain = q.resetTime
          ? Math.round(
              (new Date(q.resetTime).getTime() - Date.now()) / 60000,
            ) + "m"
          : "no_reset";
        const fraction =
          typeof q.usageRaw === "number" ? `@${q.usageRaw.toFixed(3)}` : "";
        return `[${q.modelKey}: ${q.timerType} ${q.percentRemaining}%${fraction} in ${remain}]`;
      })
      .join(" | ");
  } catch {
    ctx.log(`${account.config.email}: Ollama quota poll failed; retaining last known quota`);
  }
}

export interface OllamaUsageResponse {
  limits?: Record<
    string,
    | { usage?: number | string; models?: unknown[] }
    | undefined
  >;
}

/**
 * Parse `GET /api/usage` into Ollama quota pools.
 *
 * Older Ollama Cloud usage responses exposed a monthly pool or legacy
 * session/weekly pools. Used only when /api/balance is unavailable; today
 * /api/usage returns consumption totals and must not be treated as quota.
 */
export function extractUsagePools(
  data: OllamaUsageResponse,
  oldQuota: ModelQuota[],
): ModelQuota[] {
  const quotas: ModelQuota[] = [];
  const now = Date.now();
  const limits = data?.limits;
  if (!limits || typeof limits !== "object") return quotas;

  const monthly = limits[OLLAMA_QUOTA_POOL_KEY];
  if (monthly && typeof monthly === "object") {
    const usageFraction =
      typeof monthly.usage === "number"
        ? monthly.usage
        : typeof monthly.usage === "string"
          ? parseFloat(monthly.usage)
          : NaN;
    if (Number.isFinite(usageFraction)) {
      quotas.push({
        modelKey: OLLAMA_QUOTA_POOL_KEY,
        displayName: "Ollama",
        percentRemaining: Math.max(
          0,
          Math.min(100, Math.round((1 - usageFraction) * 100)),
        ),
        usageRaw: usageFraction,
        resetTime: null,
        timerType: "monthly",
      });
      return quotas;
    }
  }

  for (const pool of ["session", "weekly"] as const) {
    const info = limits[pool];
    if (!info || typeof info !== "object") continue;

    const usageFraction =
      typeof info.usage === "number"
        ? info.usage
        : typeof info.usage === "string"
          ? parseFloat(info.usage)
          : NaN;
    if (!Number.isFinite(usageFraction)) continue;

    const percentRemaining = Math.max(
      0,
      Math.min(100, Math.round((1 - usageFraction) * 100)),
    );

    if (pool === "weekly") {
      quotas.push({
        modelKey: "weekly",
        displayName: "Weekly",
        percentRemaining,
        usageRaw: usageFraction,
        resetTime: new Date(nextWeeklyResetMs(now)).toISOString(),
        timerType: "7d",
      });
      continue;
    }

    // session: active only while usage > 0. Anchor the window at the
    // first observation of usage (or a detected reset) and keep that
    // anchor while the window is still valid.
    const running = usageFraction > 0;
    const old = oldQuota.find((q) => q.modelKey === "session");
    let windowStart: number | null = null;
    if (running) {
      const oldUsed =
        old && old.percentRemaining >= 0
          ? 1 - old.percentRemaining / 100
          : NaN;
      const resetDetected =
        Number.isFinite(oldUsed) && usageFraction < oldUsed - 0.01;
      const oldAnchor = old?.resetTime
        ? new Date(old.resetTime).getTime() - SESSION_WINDOW_MS
        : NaN;
      if (
        resetDetected ||
        !Number.isFinite(oldAnchor) ||
        now >= oldAnchor + SESSION_WINDOW_MS
      ) {
        windowStart = now;
      } else {
        windowStart = oldAnchor;
      }
    }

    quotas.push({
      modelKey: "session",
      displayName: "Session",
      percentRemaining,
      usageRaw: usageFraction,
      resetTime:
        windowStart !== null
          ? new Date(sessionWindowEndMs(windowStart)).toISOString()
          : null,
      timerType: windowStart !== null ? "5h" : "fresh",
    });
  }

  return quotas;
}

/** Read the current balance endpoint without guessing budgets from historic spend. */
export function extractBalancePools(data: unknown): ModelQuota[] {
  if (!isObject(data) || !isObject(data.included)) return [];
  const included = data.included;
  const balance = included.balance_usd;
  const allowance = included.allowance_usd;
  const purchased = isObject(data.purchased) ? data.purchased.balance_usd : undefined;
  if (isFiniteNumber(balance) && isFiniteNumber(allowance) && allowance > 0) {
    const remaining = Math.max(0, Math.min(1, balance / allowance));
    return [{
      modelKey: OLLAMA_QUOTA_POOL_KEY,
      displayName: "Ollama",
      percentRemaining: remainingPercent(remaining * 100),
      usageRaw: 1 - remaining,
      credits: {
        balanceUsd: Math.max(0, balance),
        allowanceUsd: allowance,
        purchasedUsd: isFiniteNumber(purchased) ? Math.max(0, purchased) : 0,
      },
      resetTime: isObject(included.period) ? validResetTime(included.period.until) : null,
      timerType: "monthly",
    }];
  }

  const quotas: ModelQuota[] = [];
  for (const pool of ["monthly", "session", "weekly"] as const) {
    const window = included[pool];
    if (!isObject(window) || !isFiniteNumber(window.remaining_percent)) continue;
    const percentRemaining = remainingPercent(window.remaining_percent);
    const resetTime = validResetTime(window.resets_at);
    quotas.push({
      modelKey: pool,
      displayName: pool === "monthly" ? "Ollama" : pool === "session" ? "Session" : "Weekly",
      percentRemaining,
      usageRaw: 1 - Math.max(0, Math.min(100, window.remaining_percent)) / 100,
      resetTime,
      timerType: pool === "monthly" ? "monthly" : pool === "weekly" ? "7d"
        : !resetTime && percentRemaining === 100 ? "fresh" : "5h",
    });
  }
  return quotas;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function remainingPercent(percent: number): number {
  // A rounding artifact must not make a still-usable credit balance unroutable.
  return percent > 0 ? Math.max(1, Math.min(100, Math.round(percent))) : 0;
}

function validResetTime(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}
