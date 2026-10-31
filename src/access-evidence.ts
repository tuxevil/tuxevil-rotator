import { createHash } from "node:crypto";
import { evaluateModelAccess } from "./model-access.js";
import type { AccountConfig } from "./types.js";
import { getAccountIdentity, getCredentialGenerationFingerprint } from "./account-identity.js";
import { getCachedAccessEvidence, isSettingsRepositoryInitialized, setCachedAccessEvidence } from "./db-store.js";
export type ObservationKind = "success" | "authentication" | "quota" | "payment-or-plan" | "client-restriction" | "entitlement" | "transport" | "unknown";
export interface ProviderPlanEvidence { accountId: string; provider: string; credential: string; plan: string; source: "operator"; observedAt: number; expiresAt: number }
export interface AccessObservation { accountId: string; provider: string; credential: string; model: string; client: string; kind: ObservationKind; status: number | null; observedAt: number; expiresAt: number }
export interface AccessEvidenceSnapshot { version: 1; plans: ProviderPlanEvidence[]; observations: AccessObservation[] }
export const ACCESS_PLANS = ["unknown", "free", "plus", "pro-trial", "pro-paid", "ultra", "enterprise", "team"];
export function classifyAccessObservation(status: number | null, detail = "", transport = false): ObservationKind {
  if (transport) return "transport";
  if (status !== null && status >= 200 && status < 300) return "success";
  if (status === 401) return "authentication";
  if (status === 429) return "quota";
  if (status === 402) return "payment-or-plan";
  // Require an explicit structured code; never infer plan access from generic prose/400.
  let code: unknown;
  try { const body = JSON.parse(detail); code = body?.error?.code ?? body?.error?.type ?? body?.type; } catch { /* unknown */ }
  if (status === 403 && code === "FreeTierError") return "client-restriction";
  if ([400, 403].includes(status ?? 0) && ["MODEL_NOT_SUPPORTED_FOR_PLAN", "model_not_available_for_plan", "insufficient_entitlement"].includes(String(code))) return "entitlement";
  return "unknown";
}
const scope = (a: { accountId: string; provider: string; credential: string }) => JSON.stringify([a.accountId, a.provider, a.credential]);
export class AccessEvidenceStore {
  private plans: ProviderPlanEvidence[] = [];
  private observations: AccessObservation[] = [];
  constructor(input?: unknown) {
    const value = input as Partial<AccessEvidenceSnapshot> | null;
    if (value?.version !== 1) return;
    // Whitelist fields on load; never round-trip arbitrary stored objects.
    if (Array.isArray(value.plans)) for (const p of value.plans.slice(-2000)) {
      if (p && [p.accountId, p.provider, p.credential, p.plan].every(x => typeof x === "string") && ACCESS_PLANS.includes(p.plan) && Number.isFinite(p.observedAt) && Number.isFinite(p.expiresAt)) this.plans.push({ accountId: p.accountId, provider: p.provider, credential: p.credential, plan: p.plan, source: "operator", observedAt: p.observedAt, expiresAt: p.expiresAt });
    }
    if (Array.isArray(value.observations)) for (const o of value.observations.slice(-2000)) {
      if (o && [o.accountId, o.provider, o.credential, o.model, o.client].every(x => typeof x === "string") && ["success", "authentication", "quota", "payment-or-plan", "client-restriction", "entitlement", "transport", "unknown"].includes(o.kind) && (o.status === null || Number.isInteger(o.status)) && Number.isFinite(o.observedAt) && Number.isFinite(o.expiresAt)) this.observations.push({ accountId: o.accountId, provider: o.provider, credential: o.credential, model: o.model, client: o.client, kind: o.kind, status: o.status, observedAt: o.observedAt, expiresAt: o.expiresAt });
    }
  }
  snapshot(now = Date.now()): AccessEvidenceSnapshot {
    this.plans = this.plans.filter(p => p.expiresAt > now);
    this.observations = this.observations.filter(o => o.expiresAt > now);
    return { version: 1, plans: this.plans.map(p => ({ ...p })), observations: this.observations.map(o => ({ ...o })) };
  }
  declarePlan(account: AccountConfig, provider: string, plan: string, now = Date.now()): void {
    if (!ACCESS_PLANS.includes(plan)) throw new Error("Unknown plan");
    const entry: ProviderPlanEvidence = { accountId: getAccountIdentity(account), provider, credential: getCredentialGenerationFingerprint(account, provider), plan, source: "operator", observedAt: now, expiresAt: now + 30 * 86400000 };
    this.snapshot(now);
    this.plans = this.plans.filter(p => scope(p) !== scope(entry));
    this.plans.push(entry); this.plans = this.plans.slice(-2000);
  }
  observe(account: AccountConfig, provider: string, model: string, client: string, status: number | null, detail = "", transport = false, now = Date.now()): void {
    if (model.length > 256) return;
    const kind = classifyAccessObservation(status, detail, transport);
    const ttl = kind === "success" ? 86400000 : ["authentication", "quota", "transport"].includes(kind) ? 300000 : 3600000;
    const entry: AccessObservation = { accountId: getAccountIdentity(account), provider, credential: getCredentialGenerationFingerprint(account, provider), model: model.slice(0, 256), client, status, kind, observedAt: now, expiresAt: now + ttl };
    this.snapshot(now);
    this.observations = this.observations.filter(o => !(scope(o) === scope(entry) && o.model === entry.model && o.client === client));
    this.observations.push(entry); this.observations = this.observations.slice(-2000);
  }
  /** Only the OAuth refresh path may attest this same-principal transition. */
  continueCodexRefresh(before: AccountConfig, after: AccountConfig, verifiedAccountId: string, now = Date.now()): boolean {
    const provider = "openai-codex";
    const oldId = before.credentials?.find(c => c.provider === provider)?.providerAccountId;
    const newId = after.credentials?.find(c => c.provider === provider)?.providerAccountId;
    if (!verifiedAccountId || oldId !== verifiedAccountId || newId !== verifiedAccountId || getAccountIdentity(before) !== getAccountIdentity(after)) return false;
    const oldScope = scope({ accountId: getAccountIdentity(before), provider, credential: getCredentialGenerationFingerprint(before, provider) });
    const credential = getCredentialGenerationFingerprint(after, provider);
    const newScope = scope({ accountId: getAccountIdentity(after), provider, credential });
    if (oldScope === newScope) return false;
    this.snapshot(now);
    let changed = false;
    for (const entry of this.plans.filter(p => scope(p) === oldScope)) {
      const existing = this.plans.find(p => scope(p) === newScope);
      this.plans = this.plans.filter(p => p !== entry && p !== existing);
      this.plans.push(existing && existing.observedAt >= entry.observedAt ? existing : { ...entry, credential });
      changed = true;
    }
    for (const entry of this.observations.filter(o => scope(o) === oldScope)) {
      const existing = this.observations.find(o => scope(o) === newScope && o.model === entry.model && o.client === entry.client);
      this.observations = this.observations.filter(o => o !== entry && o !== existing);
      this.observations.push(existing && existing.observedAt >= entry.observedAt ? existing : { ...entry, credential });
      changed = true;
    }
    return changed;
  }
  forAccount(account: AccountConfig, now = Date.now()) {
    const snapshot = this.snapshot(now);
    const valid = (entry: { accountId: string; provider: string; credential: string }) => entry.accountId === getAccountIdentity(account) && entry.credential === getCredentialGenerationFingerprint(account, entry.provider);
    return { plans: snapshot.plans.filter(valid), observations: snapshot.observations.filter(valid) };
  }
}
let singleton: AccessEvidenceStore | undefined;
let hydrated = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let pendingWrite: AccessEvidenceSnapshot | undefined;
let writer: Promise<void> | undefined;
export function accessEvidenceStore(): AccessEvidenceStore {
  if (isSettingsRepositoryInitialized() && !hydrated) { singleton = new AccessEvidenceStore(getCachedAccessEvidence()); hydrated = true; }
  singleton ??= new AccessEvidenceStore();
  return singleton;
}
export async function persistAccessEvidence(): Promise<void> {
  if (!isSettingsRepositoryInitialized()) return;
  pendingWrite = accessEvidenceStore().snapshot();
  if (!writer) writer = (async () => {
    while (pendingWrite) {
      const snapshot = pendingWrite;
      pendingWrite = undefined;
      await setCachedAccessEvidence(snapshot);
    }
  })().finally(() => { writer = undefined; });
  await writer;
  if (pendingWrite) await persistAccessEvidence();
}
export function observeAccessAttempt(account: AccountConfig, provider: string, model: string, headers: Record<string, string>, status: number | null, detail = "", transport = false): void {
  if (!isSettingsRepositoryInitialized()) return;
  try {
    const agent = Object.entries(headers).find(([key]) => key.toLowerCase() === "user-agent")?.[1];
    const client = !agent ? "unknown" : agent.toLowerCase().startsWith("opencode/") ? "opencode-declared" : "other";
    accessEvidenceStore().observe(account, provider, model, client, status, detail, transport);
    if (!timer) { timer = setTimeout(() => { timer = undefined; void persistAccessEvidence().catch(() => {}); }, 250); timer.unref(); }
  } catch { /* Optional evidence must never fail a completion. */ }
}

/** A comparison only. Never interpreted as authorization by the rotation code. */
export function buildAccessShadowDecision(account: AccountConfig, provider: string, model: string, headers: Record<string, string>, store: AccessEvidenceStore = accessEvidenceStore(), now = Date.now()) {
  const plans = store.forAccount(account, now).plans;
  const declared = plans.find(p => p.provider === provider);
  const providers = account.credentials?.map(c => c.provider) ?? [account.provider ?? "google-antigravity"];
  const tier = account.tier ?? account.type ?? "unknown";
  const inferred = providers.length === 1 && ["free", "plus", "ultra"].includes(tier) ? tier : "unknown";
  const agent = Object.entries(headers).find(([name]) => name.toLowerCase() === "user-agent")?.[1];
  const client = agent?.toLowerCase().startsWith("opencode/") ? "opencode" : agent ? "other" : "unknown";
  const decision = evaluateModelAccess({ provider, model, plan: declared?.plan ?? inferred, client, at: new Date(now).toISOString() });
  return { event: "model-access-policy-shadow", account: createHash("sha256").update(getAccountIdentity(account)).digest("hex"), provider, model,
    plan: decision.declaredPlan, planSource: declared ? "provider-declaration" : inferred === "unknown" ? "unknown" : "single-provider-account",
    clientDeclaration: client, clientVerified: false, policyState: decision.state, wouldBlock: decision.state === "blocked", reason: decision.reason,
    ruleIds: decision.rules.map(r => r.id), enforced: false };
}
export function logAccessPolicyShadow(account: AccountConfig, provider: string, model: string, headers: Record<string, string>): void {
  try { console.info("[tuxevil-rotator]", JSON.stringify(buildAccessShadowDecision(account, provider, model, headers))); } catch { /* Never change a request outcome. */ }
}
