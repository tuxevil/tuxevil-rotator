/** Informational access policy. Never grants authorization or changes routing. */
export type AccessState = "allowed" | "blocked" | "conditional" | "unknown";
export interface AccessRule {
  id: string;
  provider: string;
  plans: string[];
  modelPrefix: string;
  exact?: boolean;
  state: AccessState;
  evidence: "documented" | "operator-pending";
  source: string;
  verifiedAt: string;
  validFrom: string;
  reviewAfter: string;
  validUntil?: string;
  client?: string;
  note: string;
}
const google = "https://antigravity.google/docs/models";
const rule = (id: string, provider: string, plans: string[], modelPrefix: string, state: AccessState, evidence: AccessRule["evidence"], source: string, note: string, extra: Partial<AccessRule> = {}): AccessRule => ({ id, provider, plans, modelPrefix, state, evidence, source, verifiedAt: "2026-10-30", validFrom: "2026-10-30", reviewAfter: "2026-11-29", note, ...extra });
export const MODEL_ACCESS_RULES: readonly AccessRule[] = [
  rule("ag-flash-free", "google-antigravity", ["free", "plus", "pro-trial", "pro-paid", "ultra", "enterprise"], "gemini-3.8-flash", "allowed", "documented", google, "Gemini 3.8 Flash is listed for Free/Plus."),
  ...["claude-sonnet-4-6", "claude-opus-4-6"].map(model => rule(`ag-legacy-${model}`, "google-antigravity", ["free", "plus"], model, "allowed", "documented", google, "Removal announced for November 2; diagnostic cutoff uses UTC, exact upstream rollout may differ.", { validUntil: "2026-11-02" })),
  ...["gemini-4-argon", "claude-sonnet-5-5", "claude-opus-5-5"].map(model => rule(`ag-paid-${model}`, "google-antigravity", ["free", "plus"], model, "blocked", "documented", google, "Not included in Free/Plus.")),
  ...["claude-sonnet-5-5", "claude-opus-5-5"].map(model => rule(`ag-trial-${model}`, "google-antigravity", ["pro-trial"], model, "blocked", "documented", google, "Claude 5.5 requires a non-trial Pro subscription or higher eligible plan.")),
  ...["gemini-4-argon", "claude-sonnet-5-5", "claude-opus-5-5"].map(model => rule(`ag-entitled-${model}`, "google-antigravity", ["pro-paid", "ultra", "enterprise"], model, "allowed", "documented", google, "Listed for paid Pro/Ultra; account entitlement and quota still apply.")),
  rule("ag-argon-trial", "google-antigravity", ["pro-trial"], "gemini-4-argon", "conditional", "documented", google, "Only eligible premium-device trials; generic trial status is insufficient."),
  ...["gpt-6-luna", "gpt-5.6-terra", "gpt-5.6-luna"].map(model => rule(`codex-free-${model}`, "openai-codex", ["free"], model, "allowed", "operator-pending", "Operator account-access report, 2026-10-30", "Provisional free-plan list; Luna 5.6 inclusion needs confirmation. Not independently verified.")),
  rule("codex-terra61-free", "openai-codex", ["free"], "gpt-6.1-terra", "blocked", "documented", "https://learn.chatgpt.com/docs/pricing", "Official ChatGPT Work/Codex availability lists paid plans for Terra 6.1. Free is not included; account-specific provider rejections are separate evidence.", { exact: true, verifiedAt: "2026-10-31", validFrom: "2026-10-26", reviewAfter: "2026-11-30" }),
  rule("codex-terra61-plus", "openai-codex", ["plus"], "gpt-6.1-terra", "allowed", "documented", "https://learn.chatgpt.com/docs/pricing", "Terra 6.1 is listed for Plus in Work/Codex; rollout, surface access, quota and account restrictions still apply.", { exact: true, verifiedAt: "2026-10-31", validFrom: "2026-10-26", reviewAfter: "2026-11-30" }),
  ...["beam", "gemma4:31b", "gpt-oss:120b", "gpt-oss:20b", "nemotron-3-nano:30b", "nemotron-3-super", "nemotron-3-ultra"].map(model => rule(`ollama-free-${model}`, "ollama", ["free"], model, "allowed", "operator-pending", "Operator-provided Ollama free-credit list, 2026-10-30", "Included in the supplied free-credit list; quota and live entitlement are separate.")),
  rule("zen-big-pickle-client", "opencode-zen", ["*"], "big-pickle", "conditional", "documented", "https://github.com/anomalyco/opencode/issues/56702", "Free model without a -free suffix; genuine OpenCode context is required.", { client: "opencode" }),
  rule("zen-free-client", "opencode-zen", ["*"], "*-free", "conditional", "documented", "https://github.com/anomalyco/opencode/issues/56702", "Free tier requires a genuine OpenCode client context. Client declaration is not authentication or proof of acceptance.", { client: "opencode" }),
];
export interface AccessQuery { provider: string; model: string; plan?: string; client?: string; at?: string }
export interface AccessDecision { state: AccessState; reason: string; rules: AccessRule[]; informational: true; declaredPlan: string; clientVerified: false }
function matches(pattern: string, model: string): boolean {
  if (pattern === "*-free") return model.endsWith("-free");
  return model === pattern || model.startsWith(pattern + "-");
}
export function evaluateModelAccess(query: AccessQuery): AccessDecision {
  const instant = query.at === undefined ? new Date() : new Date(query.at);
  if (!Number.isFinite(instant.getTime())) throw new Error("Invalid evaluation date");
  const plan = query.plan ?? "unknown";
  const rules = MODEL_ACCESS_RULES.filter(r => r.provider === query.provider && (r.plans.includes(plan) || r.plans.includes("*")) && (r.exact ? r.modelPrefix === query.model : matches(r.modelPrefix, query.model)));
  const decision = (state: AccessState, reason: string): AccessDecision => ({ state, reason, rules, informational: true, declaredPlan: plan, clientVerified: false });
  if (!rules.length) return decision("unknown", "No verified rule for this provider, plan and model; absence is not permission.");
  if (rules.some(r => instant < new Date(r.validFrom + "T00:00:00Z"))) return decision("unknown", "No historical policy evidence for the requested date.");
  if (rules.some(r => instant >= new Date(r.reviewAfter + "T00:00:00Z"))) return decision("unknown", "Policy evidence needs re-verification; the review date has passed.");
  if (rules.some(r => r.evidence === "operator-pending")) return decision("unknown", "Operator-reported policy pending verification; see declared states and evidence.");
  if (rules.some(r => r.validUntil && instant >= new Date(r.validUntil + "T00:00:00Z"))) return decision("blocked", "Announced model availability window has ended (UTC diagnostic cutoff).");
  if (rules.some(r => r.state === "blocked")) return decision("blocked", rules.find(r => r.state === "blocked")!.note);
  if (rules.some(r => r.client)) return decision("conditional", query.client === "opencode" ? "OpenCode client declared; upstream acceptance still requires genuine context." : "Requires an OpenCode-originated request; origin is unknown or another client.");
  if (rules.some(r => r.state === "conditional")) return decision("conditional", rules.find(r => r.state === "conditional")!.note);
  return decision("allowed", "Documented plan access; not a guarantee of quota, credentials or request capability.");
}
