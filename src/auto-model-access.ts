import { accessEvidenceStore, type AccessEvidenceStore } from "./access-evidence.js";
import { evaluateModelAccess, MODEL_ACCESS_RULES } from "./model-access.js";
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
}

export interface AutoAccountScope {
  providerId: string;
  modelId: string;
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

  if (plan === "unknown") {
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

  // Free accounts have a complete, operator-confirmed catalog for these
  // providers. Unknown or stale entries must not silently inherit free access.
  if ((provider === "ollama" || provider === "openai-codex") && plan === "free") {
    const confirmedAllow = matchingRules.some((rule) =>
      rule.state === "allowed" && rule.evidence === "operator-confirmed",
    );
    if (!confirmedAllow || decision.state === "unknown") {
      return {
        eligible: false,
        plan,
        planSource,
        reason: confirmedAllow
          ? "Free-plan model policy needs re-verification"
          : "model is outside the confirmed Free-plan auto-routing list",
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
