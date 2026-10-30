import { readLimitedBody } from "./body-limit.js";
import { isSettingsRepositoryInitialized } from "./db-store.js";
import { accessEvidenceStore, persistAccessEvidence, ACCESS_PLANS, type ProviderPlanEvidence, type AccessObservation } from "./access-evidence.js";
import type { ServerResponse, IncomingMessage } from "node:http";
import type { Config } from "./types.js";
import { getAccountIdentity } from "./account-identity.js";
import { MODEL_ACCESS_RULES, evaluateModelAccess, type AccessDecision } from "./model-access.js";

export interface AccessAccount { id: string; label: string; providers: string[]; inferredPlan: string; providerPlans: Omit<ProviderPlanEvidence, "credential">[]; observations: Omit<AccessObservation, "credential">[] }
export interface AccessReport { informational: true; rules: typeof MODEL_ACCESS_RULES; accounts: AccessAccount[]; decision?: AccessDecision; accountId?: string; planSource?: "query-assumption" | "single-provider-account" | "provider-declaration" | "unknown" }
export function buildModelAccessReport(config: Config, params: URLSearchParams): AccessReport {
  const accounts = config.accounts.map(account => {
    const providers = [...new Set(account.credentials?.map(c => c.provider) ?? [account.provider ?? "google-antigravity"])];
    // A shared account tier cannot establish each linked provider's subscription.
    const tier = account.tier ?? account.type ?? "unknown";
    const inferredPlan = providers.length === 1 && ["free", "plus", "ultra"].includes(tier) ? tier : "unknown";
    const evidence = accessEvidenceStore().forAccount(account);
    return { id: getAccountIdentity(account), label: account.label ?? account.email, providers, inferredPlan,
      providerPlans: evidence.plans.map(({ credential: _credential, ...plan }) => plan),
      observations: evidence.observations.map(({ credential: _credential, ...observation }) => observation) };
  });
  const report: AccessReport = { informational: true, rules: MODEL_ACCESS_RULES, accounts };
  if (!params.has("model") && !params.has("provider") && !params.has("accountId")) return report;
  const provider = params.get("provider"), model = params.get("model");
  if (!provider || !model || model.length > 256) throw new Error("provider and model are required (model up to 256 characters)");
  const accountId = params.get("accountId");
  const account = accountId ? accounts.find(a => a.id === accountId) : undefined;
  if (accountId && !account) throw new Error("Unknown account ID");
  if (account && !account.providers.includes(provider)) throw new Error("Selected account does not have this provider");
  const declared = account?.providerPlans.find(p => p.provider === provider);
  const plan = params.get("plan") || declared?.plan || account?.inferredPlan || "unknown";
  report.planSource = params.get("plan") ? "query-assumption" : declared ? "provider-declaration" : account?.inferredPlan !== "unknown" && account ? "single-provider-account" : "unknown";
  report.accountId = accountId ?? undefined;
  report.decision = evaluateModelAccess({ provider, model, plan, client: params.get("client") ?? undefined, at: params.get("at") ?? undefined });
  return report;
}
export function serveModelAccessApi(res: ServerResponse, config: Config, params: URLSearchParams): void {
  res.setHeader("Cache-Control", "no-store");
  try {
    const report = buildModelAccessReport(config, params);
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(report));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid access query. Check account, provider, model and date." }));
  }
}

export function validateProviderPlanDeclaration(config: Config, value: unknown) {
  const body = value as { accountId?: unknown; provider?: unknown; plan?: unknown } | null;
  if (!body || typeof body.accountId !== "string" || typeof body.provider !== "string" || typeof body.plan !== "string" || !ACCESS_PLANS.includes(body.plan)) throw new Error("Invalid declaration");
  const account = config.accounts.find(a => getAccountIdentity(a) === body.accountId);
  const providers = account?.credentials?.map(c => c.provider) ?? [account?.provider ?? "google-antigravity"];
  if (!account || !providers.includes(body.provider)) throw new Error("Account/provider mismatch");
  return { account, provider: body.provider, plan: body.plan };
}

export async function serveProviderPlanApi(req: IncomingMessage, res: ServerResponse, config: Config): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (!isSettingsRepositoryInitialized()) throw new Error("Store not ready");
    const body = JSON.parse((await readLimitedBody(req, 4096)).toString("utf8"));
    const declaration = validateProviderPlanDeclaration(config, body);
    accessEvidenceStore().declarePlan(declaration.account, declaration.provider, declaration.plan);
    await persistAccessEvidence();
    serveModelAccessApi(res, config, new URLSearchParams());
  } catch {
    if (!res.headersSent) res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid declaration or evidence persistence unavailable." }));
  }
}
