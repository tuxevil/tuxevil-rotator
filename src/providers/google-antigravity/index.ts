// Google Antigravity provider adapter.
//
// Implements the ProviderAdapter contract for Google's Cloud Code Assist
// (Antigravity) endpoints: OAuth2 credential lifecycle, per-model quota
// polling, v1internal SSE forwarding, and the Gemini-native request/response
// translation used by the compat layer.

import type {
  ProviderAdapter,
  ProviderModel,
  QuotaFetchContext,
} from "../adapter.js";
import {
  getEffectiveAntigravityModels,
  isDynamicallyAvailableAntigravityModel,
} from "./catalog.js";
import { dynamicCatalog } from "./dynamic-catalog.js";
import { fetchProviderQuota } from "./quota.js";
import {
  forwardRequest,
  createGoogleStreamAccumulator,
  getBenchmarkSpec,
} from "./forward.js";
import {
  forwardCodeAssistRequest,
  isCodeAssistAction,
} from "./code-assist.js";
import { runLogin } from "./login.js";
import { validateCredentials } from "./credentials.js";
import {
  getOAuthClientConfig,
  isHostedOAuthConfigured,
} from "./oauth.js";
import {
  TOKEN_URL,
  KICKSTART_MODEL_FOR_QUOTA_POOL,
  KICKSTART_FALLBACK_MODELS_FOR_QUOTA_POOL,
  KICKSTART_PRO_MODELS_FOR_QUOTA_POOL,
  REQUEST_USER_AGENT,
  applyModelAlias,
  resolveQuotaModelKey,
} from "../../types.js";
import type { AccountRuntime } from "../../types.js";
import {
  getAccountIdentity,
  getCredentialGeneration,
} from "../../account-identity.js";
import { fetchWithRetry } from "../../fetch-with-retry.js";
import { logger } from "../../logger.js";
import { DEFAULT_PROVIDER, getProviderProjectId } from "../credential-helpers.js";
import { getAccountProxyDispatcher } from "../proxy-dispatcher.js";

const providerLog = logger.child("provider/google");

/**
 * Refresh the OAuth access token for a Google account if it is missing or
 * about to expire. Throws on unrecoverable refresh failures.
 */
async function ensureGoogleToken(account: AccountRuntime): Promise<void> {
  const now = Date.now();
  if (account.accessToken && account.tokenExpires > now) {
    return;
  }
  if (!account.config.refreshToken) {
    throw new Error(
      `Account ${account.config.email} has no refreshToken; re-run login`,
    );
  }
  if (account.config.refreshToken.startsWith("enc:")) {
    throw new Error(
      `Account ${account.config.email} has an encrypted refreshToken (enc:*) but it could not be decrypted. Set TUXEVIL_ROTATOR_ENCRYPTION_KEY or re-run login.`,
    );
  }
  const oauth = getOAuthClientConfig();
  const response = await fetchWithRetry(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": REQUEST_USER_AGENT,
    },
      body: new URLSearchParams({
      client_id: oauth.clientId,
      client_secret: oauth.clientSecret,
      refresh_token: account.config.refreshToken,
        grant_type: "refresh_token",
      }),
      dispatcher: getAccountProxyDispatcher(account, "google-antigravity"),
    });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${errorText}`);
  }
  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };
  account.accessToken = data.access_token;
  account.tokenExpires = now + data.expires_in * 1000 - 5 * 60 * 1000;
  account.consecutiveErrors = 0;
}

export const googleAntigravityAdapter: ProviderAdapter = {
  id: "google-antigravity",
  displayName: "Google Antigravity",
  credentialKind: "oauth",
  tierRanking: {
    ultra: 0,
    pro: 1,
    plus: 2,
    free: 3,
    unknown: 4,
  },
  features: {
    circuitBreakers: true,
    concurrencyLimits: true,
    proactiveRotation: false,
  },

  runLogin,
  validateCredentials,

  hasValidCredentials(account: AccountRuntime): boolean {
    if (account.accessToken && account.tokenExpires > Date.now()) {
      return true;
    }
    return typeof account.config.refreshToken === "string" &&
      account.config.refreshToken.length > 0;
  },

  async ensureValidToken(account: AccountRuntime): Promise<void> {
    try {
      await ensureGoogleToken(account);
    } catch (err) {
      providerLog.log(
        "warn",
        `Token refresh failed for ${account.config.email}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw err;
    }
  },

  getAuthHeader(account: AccountRuntime): string {
    return `Bearer ${account.accessToken}`;
  },

  shouldRetryOnQuotaExhaustion(): boolean {
    // Antigravity quota buckets are attached to the OAuth account/project
    // being used. A different eligible account has an independent bucket.
    return true;
  },

  async fetchQuota(
    account: AccountRuntime,
    ctx: QuotaFetchContext,
  ): Promise<void> {
    await fetchProviderQuota(account, ctx);
  },

  forwardRequest,
  async forwardCodeAssistRequest(
    account,
    action,
    body,
    originalHeaders,
    signal,
  ) {
    if (!isCodeAssistAction(action)) {
      throw new Error(`Unsupported Code Assist action: ${action}`);
    }
    return forwardCodeAssistRequest(
      account,
      action,
      body,
      originalHeaders,
      signal,
    );
  },
  createStreamAccumulator: createGoogleStreamAccumulator,

  async forwardKickstartRequest(
    account: AccountRuntime,
    model: string,
    signal?: AbortSignal,
  ) {
    return forwardRequest(
      account,
      {
        project: getProviderProjectId(account.config, DEFAULT_PROVIDER),
        model,
        request: {
          contents: [{ role: "user", parts: [{ text: "." }] }],
          generationConfig: { maxOutputTokens: 1 },
        },
      },
      {},
      signal,
      { apiRetry: false },
    );
  },

  getKickstartModelForPool(quotaModelKey: string): string | undefined {
    return (
      KICKSTART_MODEL_FOR_QUOTA_POOL[quotaModelKey] ??
      KICKSTART_MODEL_FOR_QUOTA_POOL[resolveQuotaModelKey(quotaModelKey) ?? ""]
    );
  },

  getKickstartModelsForPool(
    quotaModelKey: string,
    account?: AccountRuntime,
  ): string[] {
    const pool = KICKSTART_MODEL_FOR_QUOTA_POOL[quotaModelKey]
      ? quotaModelKey
      : resolveQuotaModelKey(quotaModelKey) ?? "";
    const primary = KICKSTART_MODEL_FOR_QUOTA_POOL[pool];
    if (!pool || !primary) return [];

    const snapshot = account
      ? dynamicCatalog.getAccountSnapshot(
          getAccountIdentity(account),
          getCredentialGeneration(account.config, "google-antigravity"),
        )
      : undefined;
    const snapshotSet = snapshot
      ? new Set(snapshot.models.map((model) => model.toLowerCase()))
      : null;

    const tier = account?.config.tier;
    const isExplicitlyFree = tier === "free";
    const isProOrHigher = isExplicitlyFree
      ? false
      : tier === "pro" || tier === "ultra" || tier === "plus" ||
        tier === "max" || tier === "team" || account?.config.type === "pro";
    const snapshotHasSonnet55 = Boolean(
      snapshotSet &&
        (snapshotSet.has("claude-sonnet-5-5-low") ||
          snapshotSet.has("claude-sonnet-5-5-medium")),
    );
    const useProOrder = pool === "claude" && !isExplicitlyFree &&
      (isProOrHigher || snapshotHasSonnet55);
    const preferred =
      (useProOrder
        ? KICKSTART_PRO_MODELS_FOR_QUOTA_POOL[pool]
        : KICKSTART_FALLBACK_MODELS_FOR_QUOTA_POOL[pool]) ?? [primary];

    if (snapshotSet) {
      const inSnapshot = preferred.filter((model) =>
        snapshotSet.has(model.toLowerCase()),
      );
      if (inSnapshot.length > 0) return inSnapshot;
      return [primary];
    }

    // Without a per-account catalog, preserve only the existing primary.
    if (pool === "gemini") return [primary];
    return [...preferred];
  },

  listModels(): ProviderModel[] {
    return getEffectiveAntigravityModels().map((model) => ({
      id: model.id,
      contextWindow: model.ctx,
      quotaPool: model.quotaPool,
      source: "discovered",
    }));
  },

  ownsModel(model: string): boolean {
    return isDynamicallyAvailableAntigravityModel(model);
  },

  getPoolKey(model: string): string {
    const normalize = (value: string) => value.trim().replace(/^models\//i, "");
    const observed = dynamicCatalog.getModel(normalize(model)) ??
      dynamicCatalog.getModel(normalize(applyModelAlias(model)));
    return observed?.id ?? resolveQuotaModelKey(model) ?? model;
  },

  getBenchmark(account: AccountRuntime) {
    return getBenchmarkSpec(account);
  },
};

export type { TokenExchangeResult, OAuthClientConfig } from "./oauth.js";
export { isHostedOAuthConfigured, getOAuthClientConfig };
