import { accessEvidenceStore, type AccessEvidenceStore } from "./access-evidence.js";
import { evaluateModelAccess, MODEL_ACCESS_RULES } from "./model-access.js";
import { antigravityCatalogEvidence, catalogModelState, type CatalogModelState } from "./provider-catalog-evidence.js";
import type { AccountConfig } from "./types.js";

export interface AutoModelAccessDecision {
  eligible: boolean;
  plan: string;
  planSource:
    | "provider-declaration"
    | "operator-provider-default"
    | "account-tier"
    | "unknown";
  reason: string;
  /** Present when the account's live Antigravity catalog decided eligibility. */
  catalog?: Exclude<CatalogModelState, "unknown">;
}

export interface AutoAccountScope {
  providerId: string;
  modelId: string;
}

export function requiresAntigravityAccessPolicy(model: string): boolean {
  return /^(?:claude-(?:opus|sonnet)-(?:5-5|4-6)(?:-|$)|gemini-4(?:-|$)|gemini-3\.(?:7-flash|6-flash|1-pro)(?:-|$))/i.test(model);
}

function matchesRule(rule: (typeof MODEL_ACCESS_RULES)[number], model: string): boolean {
  if (rule.modelPrefix === "*-free") return model.endsWith("-free");
  return rule.exact
    ? rule.modelPrefix === model
    : model === rule.modelPrefix || model.startsWith(`${rule.modelPrefix}-`);
}

function providersForAccount(account: AccountConfig): string[] {
  const providers = account.credentials?.map((credential) => credential.provider) ?? [];
  if (providers.length) return [...new Set(providers)];
  return [
    account.provider === "google"
      ? "google-antigravity"
      : account.provider ?? "google-antigravity",
  ];
}

function accountTierPlan(account: AccountConfig, provider: string): string | undefined {
  const tier = account.tier ?? account.type;
  if (tier && ["free", "plus", "ultra", "team"].includes(tier)) return tier;
  // The operator has confirmed that the configured Antigravity Pro accounts
  // are paid. This inference applies only to their primary Google provider.
  if (provider === "google-antigravity" && tier === "pro") return "pro-paid";
  return undefined;
}

function isModelAccessRejection(kind: string): boolean {
  return ["payment-or-plan", "entitlement", "model-unavailable"].includes(kind);
}

export function evaluateAutoModelAccess(
  account: AccountConfig,
  provider: string,
  model: string,
  store: AccessEvidenceStore = accessEvidenceStore(),
  now = Date.now(),
  catalogPollIntervalMs?: number,
): AutoModelAccessDecision {
  const evidence = store.forAccount(account, now);
  const declared = evidence.plans
    .filter((entry) => entry.provider === provider)
    .sort((a, b) => b.observedAt - a.observedAt)[0];
  let plan = declared?.plan ?? "unknown";
  let planSource: AutoModelAccessDecision["planSource"] = declared
    ? "provider-declaration"
    : "unknown";

  if (!declared && provider === "ollama") {
    // The operator confirmed that all linked Ollama accounts are Free.
    plan = "free";
    planSource = "operator-provider-default";
  } else if (!declared) {
    const providers = providersForAccount(account);
    const isPrimaryGoogle =
      provider === "google-antigravity" &&
      (account.provider === undefined ||
        account.provider === "google" ||
        account.provider === "google-antigravity");
    if (isPrimaryGoogle || providers.length === 1) {
      const inferred = accountTierPlan(account, provider);
      if (inferred) {
        plan = inferred;
        planSource = "account-tier";
      }
    }
  }

  const latestObservation = evidence.observations
    .filter(
      (entry) =>
        entry.provider === provider &&
        entry.model === model &&
        ["success", "payment-or-plan", "entitlement", "model-unavailable"].includes(
          entry.kind,
        ),
    )
    .sort(
      (a, b) =>
        b.observedAt - a.observedAt ||
        Number(isModelAccessRejection(b.kind)) - Number(isModelAccessRejection(a.kind)),
    )[0];
  if (
    latestObservation &&
    isModelAccessRejection(latestObservation.kind)
  ) {
    return {
      eligible: false,
      plan,
      planSource,
      reason: `recent ${latestObservation.kind} rejection for this account and model`,
    };
  }

  // A fresh account catalog is the provider's own entitlement statement and
  // outranks the static plan table; without one, fall back to plan rules.
  if (provider === "google-antigravity") {
    const catalog = catalogModelState(antigravityCatalogEvidence(account, catalogPollIntervalMs, now), model);
    if (catalog !== "unknown") {
      const reason = catalog === "advertised"
        ? "model is advertised in this account's catalog"
        : catalog === "disabled"
          ? "model is disabled in this account's catalog"
          : "model is not in this account's catalog";
      return { eligible: catalog === "advertised", plan, planSource, reason, catalog };
    }
  }

  if (plan === "unknown") {
    // A verified Free-plan model is also safe to try when the Codex plan is
    // unknown; paid-only and unlisted models still require a known plan.
    if (provider === "openai-codex" && MODEL_ACCESS_RULES.some((rule) =>
      rule.provider === provider && rule.plans.includes("free") && rule.state === "allowed" &&
      matchesRule(rule, model) && evaluateModelAccess({ provider, model, plan: "free", at: new Date(now).toISOString() }).state === "allowed",
    )) {
      return { eligible: true, plan, planSource, reason: "model is documented for Codex Free" };
    }
    const hasPlanSpecificRule = MODEL_ACCESS_RULES.some((rule) =>
      rule.provider === provider && matchesRule(rule, model),
    );
    if (provider === "openai-codex" || hasPlanSpecificRule) {
      return {
        eligible: false,
        plan,
        planSource,
        reason: "provider plan is unknown for this model's access policy",
      };
    }
    return {
      eligible: true,
      plan,
      planSource,
      reason: "no confirmed plan restriction for this model",
    };
  }

  const matchingRules = MODEL_ACCESS_RULES.filter((rule) =>
    rule.provider === provider &&
    (rule.plans.includes(plan) || rule.plans.includes("*")) &&
    matchesRule(rule, model),
  );

  const decision = evaluateModelAccess({
    provider,
    model,
    plan,
    at: new Date(now).toISOString(),
  });

  // An overdue review must not turn a documented denial into permission.
  if (provider === "google-antigravity" && matchingRules.some((rule) =>
    (rule.state === "blocked" || rule.state === "conditional" ||
      (rule.validUntil !== undefined && now >= Date.parse(`${rule.validUntil}T00:00:00Z`))) &&
    now >= Date.parse(`${rule.validFrom}T00:00:00Z`),
  )) {
    return { eligible: false, plan, planSource, reason: decision.reason };
  }

  if (provider === "google-antigravity" && model.startsWith("gemini-4-") && decision.state === "unknown") {
    return { eligible: false, plan, planSource, reason: decision.reason };
  }

  // Unknown or stale entries must not silently inherit free access.
  if ((provider === "ollama" || provider === "openai-codex") && plan === "free") {
    const confirmedAllow = matchingRules.some((rule) =>
      rule.state === "allowed" && (rule.evidence === "operator-confirmed" ||
        (provider === "openai-codex" && rule.evidence === "documented")),
    );
    if (!confirmedAllow || decision.state === "unknown") {
      return {
        eligible: false,
        plan,
        planSource,
        reason: confirmedAllow
          ? "Free-plan model policy needs re-verification"
          : provider === "ollama" ? "model is outside the confirmed Free-plan auto-routing list" : "model is outside the confirmed Free-plan model list",
      };
    }
  }
  if (provider === "google-antigravity" && ["free", "plus"].includes(plan)) {
    // The operator confirmed Free/Plus access is limited to the listed model
    // families. Do not treat an unlisted dynamic-catalog entry as permission.
    const listedAllow = matchingRules.some((rule) => rule.state === "allowed");
    if (!listedAllow) {
      return {
        eligible: false,
        plan,
        planSource,
        reason: decision.state === "blocked"
          ? decision.reason
          : "model is outside the confirmed Antigravity Free/Plus auto-routing list",
      };
    }
    if (decision.state !== "allowed") {
      return { eligible: false, plan, planSource, reason: decision.reason };
    }
  }
  if (decision.state === "blocked" || decision.state === "conditional") {
    return { eligible: false, plan, planSource, reason: decision.reason };
  }
  return { eligible: true, plan, planSource, reason: decision.reason };
}
