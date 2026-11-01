import type { AccountRuntime, AccountConfig } from "../../types.js";
import type { ModelListContext, ProviderAdapter, ProviderModel, QuotaFetchContext, CredentialValidationResult } from "../adapter.js";
import { logger } from "../../logger.js";
import {
  getCodexAccountId,
  getCodexRefreshToken,
  getCodexTokenState,
  persistCodexRefreshToken,
  setCodexTokenState,
} from "./credentials.js";
import {
  CodexOAuthError,
  refreshCodexToken,
  parseCodexIdentity,
} from "./oauth.js";
import { runCodexLogin } from "./login.js";
import {
  CodexSseAccumulator,
  consumeCodexKickstartResponse,
  extractCodexUsage,
  forwardCodexRequest,
} from "./forward.js";
import {
  clearCodexQuotaCache,
  fetchCodexQuota,
  CODEX_QUOTA_MODEL_KEY,
} from "./quota.js";
import { getCodexModel, getCodexModels, isCodexRequestModel, isCodexProviderModelId } from "./catalog.js";

const providerLog = logger.child("provider/openai-codex");
const refreshFlights = new Map<string, Promise<void>>();

function refreshKey(account: AccountRuntime): string {
  return `${account.config.email.toLowerCase()}:${getCodexAccountId(account.config) ?? "unknown"}`;
}

async function ensureCodexToken(account: AccountRuntime): Promise<void> {
  const current = getCodexTokenState(account);
  if (current.accessToken && current.tokenExpires > Date.now() + 60_000) return;
  const key = refreshKey(account);
  const inFlight = refreshFlights.get(key);
  if (inFlight) {
    await inFlight;
    return;
  }
  const operation = (async () => {
    const latest = getCodexTokenState(account);
    if (latest.accessToken && latest.tokenExpires > Date.now() + 60_000) return;
    const refreshToken = getCodexRefreshToken(account.config);
    if (!refreshToken) {
      throw new CodexOAuthError(
        `Account ${account.config.email} has no Codex refresh token; re-authenticate`,
        { code: "missing_refresh_token", reloginRequired: true },
      );
    }
    const refreshed = await refreshCodexToken(refreshToken);
    const identity = parseCodexIdentity(refreshed.accessToken, refreshed.idToken);
    const expectedId = getCodexAccountId(account.config);
    const returnedIdentities = [parseCodexIdentity(refreshed.accessToken), parseCodexIdentity(refreshed.idToken)];
    if (returnedIdentities.some(candidate => (expectedId && candidate.providerAccountId && candidate.providerAccountId !== expectedId) || (candidate.email && candidate.email.trim().toLowerCase() !== account.config.email.trim().toLowerCase()))) {
      throw new CodexOAuthError("Codex OAuth refresh returned a different account identity", { code: "refresh_identity_mismatch", reloginRequired: true });
    }
    const verifiedIdentity = expectedId && identity.providerAccountId === expectedId ? identity : undefined;
    setCodexTokenState(account, {
      accessToken: refreshed.accessToken,
      tokenExpires: refreshed.expiresAt,
    });
    // Rotating refresh tokens are one-time credentials. Persist the returned
    // generation before allowing another request to use this account.
    try {
      await persistCodexRefreshToken(account, refreshed.refreshToken, verifiedIdentity);
    } catch (error) {
      setCodexTokenState(account, { accessToken: null, tokenExpires: 0 });
      throw new Error("Could not persist the rotated Codex refresh token", { cause: error });
    }
    account.consecutiveErrors = 0;
  })();
  refreshFlights.set(key, operation);
  try {
    await operation;
  } finally {
    if (refreshFlights.get(key) === operation) refreshFlights.delete(key);
  }
}

export async function ensureOpenAICodexToken(account: AccountRuntime): Promise<void> {
  await ensureCodexToken(account);
}

export async function validateCodexCredentials(config: AccountConfig): Promise<CredentialValidationResult> {
  if (config.provider !== "openai-codex" && !(config.credentials ?? []).some((entry) => entry.provider === "openai-codex")) {
    return { ok: false, status: 0, error: "Missing openai-codex provider credential" };
  }
  if (!getCodexRefreshToken(config)) {
    return { ok: false, status: 0, error: "Missing refreshToken for OpenAI Codex" };
  }
  return { ok: true };
}

export const openaiCodexAdapter: ProviderAdapter = {
  id: "openai-codex",
  displayName: "OpenAI Codex",
  credentialKind: "oauth",
  tierRanking: { max: 0, team: 1, pro: 2, plus: 3, free: 4, unknown: 5 },
  features: { circuitBreakers: false, concurrencyLimits: true, proactiveRotation: false },
  runLogin: runCodexLogin,
  validateCredentials: validateCodexCredentials,

  hasValidCredentials(account): boolean {
    const token = getCodexTokenState(account);
    return Boolean((token.accessToken && token.tokenExpires > Date.now()) || getCodexRefreshToken(account.config));
  },

  async ensureValidToken(account): Promise<void> {
    try {
      await ensureCodexToken(account);
    } catch (error) {
      providerLog.log("warn", `Codex token refresh failed for ${account.config.email}: ${error instanceof Error ? error.message : "unknown error"}`);
      throw error;
    }
  },

  getAuthHeader(account): string {
    const token = getCodexTokenState(account).accessToken;
    return token ? `Bearer ${token}` : "Bearer";
  },

  shouldRetryOnQuotaExhaustion(): boolean { return true; },

  async fetchQuota(account: AccountRuntime, ctx: QuotaFetchContext): Promise<void> {
    await ensureCodexToken(account);
    await fetchCodexQuota(account, ctx);
  },

  forwardRequest: forwardCodexRequest,
  createStreamAccumulator: () => new CodexSseAccumulator(),

  async forwardKickstartRequest(account, model, signal) {
    const forwarded = await forwardCodexRequest(
      account,
      {
        project: "",
        model,
        request: { input: ".", stream: true, store: false },
      },
      {},
      signal,
    );
    if (forwarded.response.ok) {
      await consumeCodexKickstartResponse(forwarded.response);
    }
    return forwarded;
  },

  clearQuotaCache: clearCodexQuotaCache,

  getKickstartModelForPool(): string | undefined { return "gpt-5.6-luna"; },

  listModels(context: ModelListContext): ProviderModel[] {
    // Discovery can surface other vendors' models; only GPT ids belong to Codex.
    const ids = context.codexModels.length > 0
      ? context.codexModels.filter((id) => isCodexRequestModel(id) || isCodexProviderModelId(id))
      : getCodexModels().map((model) => model.id);
    return ids.map((id) => {
      const model = getCodexModel(id);
      return {
        id,
        contextWindow: model?.contextWindow ?? null,
        quotaPool: CODEX_QUOTA_MODEL_KEY,
        source: model?.source === "allowlist" ? "catalog" : "discovered",
      };
    });
  },

  ownsModel(model: string, context?: { codexModels?: Set<string> }): boolean {
    if (isCodexRequestModel(model)) return true;
    if (isCodexProviderModelId(model) && (context?.codexModels?.has(model) ?? false)) return true;
    return false;
  },

  getPoolKey(model: string): string {
    return `${CODEX_QUOTA_MODEL_KEY}:${model}`;
  },

  getBenchmark() {
    return {
      body: {
        project: "",
        model: "gpt-5.6-luna",
        request: { model: "gpt-5.6-luna", input: "Reply with one word.", stream: true, store: false },
      },
      parseUsage(raw: string) {
        const usage = extractCodexUsage(raw);
        return usage ? { outputTokens: usage.outputTokens } : null;
      },
      parseText(raw: string) {
        return raw.slice(0, 1000);
      },
    };
  },
};
