import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { AccessReport } from "../../model-access-api.js";
import { api } from "../state/api.js";
import { query } from "../state/router.js";
import { masker } from "../state/store.js";
import { Panel, Button } from "../components/ui.js";

export function ModelAccessPanel(): JSX.Element {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, []);
  const [report, setReport] = useState<AccessReport | null>(null);
  const [accountId, setAccount] = useState(query.value.get("accessAccount") ?? "");
  const [provider, setProvider] = useState("google-antigravity");
  const [plan, setPlan] = useState("");
  const [client, setClient] = useState("unknown");
  const [at, setAt] = useState("");
  const [ruleFilter, setRuleFilter] = useState("");
  const [model, setModel] = useState("gemini-3.8-flash-medium");
  const [decision, setDecision] = useState<AccessReport | null>(null);
  const [decisionKey, setDecisionKey] = useState("");
  const formKey = JSON.stringify([accountId, provider, plan, client, model, at]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    api.modelAccess().then(value => { if (active) setReport(value); }).catch(() => { if (active) setError("Access rules could not be loaded."); });
    return () => { active = false; };
  }, []);
  // Clear an earlier decision when its inputs no longer apply.
  useEffect(() => { setDecision(null); }, [accountId, provider, plan, client, model, at]);
  const selected = report?.accounts.find(a => a.id === accountId);
  useEffect(() => {
    if (selected && !selected.providers.includes(provider)) setProvider(selected.providers[0] ?? "google-antigravity");
  }, [selected, provider]);
  const catalog = selected?.providerCatalogs?.find(c => c.provider === provider);
  const catalogFreshness = catalog?.freshness === "fresh" && catalog.expiresAt !== null && catalog.expiresAt <= now ? "stale" : catalog?.freshness;
  const declaredPlan = selected?.providerPlans.find(p => p.provider === provider);
  const effectivePlan = plan || declaredPlan?.plan || selected?.inferredPlan || "unknown";
  const rules = report?.rules.filter(r => r.modelPrefix.toLowerCase().includes(ruleFilter.toLowerCase()) && r.provider === provider && ((effectivePlan === "unknown" || !accountId && !plan) || r.plans.includes(effectivePlan) || r.plans.includes("*"))) ?? [];
  const inspect = async () => {
    setBusy(true); setError("");
    try {
      const params = new URLSearchParams({ provider, model, client });
      if (accountId) params.set("accountId", accountId);
      if (plan) params.set("plan", plan);
      if (at) params.set("at", at);
      const result = await api.modelAccess(params);
      setReport(result); setDecision(result); setDecisionKey(formKey);
    } catch { setError("Check the selected account, provider and model."); }
    finally { setBusy(false); }
  };
  const savePlan = async () => {
    if (!accountId || !plan) return;
    setBusy(true); setError("");
    try { setReport(await api.declareProviderPlan(accountId, provider, plan)); setPlan(""); setDecision(null); }
    catch { setError("Provider plan could not be persisted."); }
    finally { setBusy(false); }
  };
  return <Panel id="model-access" title="Model access" subtitle="Informational rules only. Quota, credentials, capabilities and routing are checked separately.">
    <div class="form-grid">
      <label>Account<select value={accountId} onChange={e => setAccount(e.currentTarget.value)}><option value="">No account — simulate policy</option>{report?.accounts.map(a => <option key={a.id} value={a.id}>{masker.value.email(a.label)}</option>)}</select></label>
      <label>Provider<select value={provider} onChange={e => setProvider(e.currentTarget.value)}>{["google-antigravity", "openai-codex", "ollama", "opencode-zen"].map(p => <option key={p}>{p}</option>)}</select></label>
      <label>Plan assumption<select value={plan} onChange={e => setPlan(e.currentTarget.value)}><option value="">Use known account plan</option>{["unknown", "free", "plus", "pro-trial", "pro-paid", "ultra", "enterprise"].map(p => <option key={p}>{p}</option>)}</select></label>
      <label>Client declaration<select value={client} onChange={e => setClient(e.currentTarget.value)}>{["unknown", "opencode", "other"].map(p => <option key={p}>{p}</option>)}</select></label>
      <label>Policy date (optional)<input type="date" value={at} onInput={e => setAt(e.currentTarget.value)} /></label>
      <label>Model ID<input value={model} onInput={e => setModel(e.currentTarget.value)} maxLength={256} /></label>
    </div>
    <p>Plan: {effectivePlan}. {selected && selected.providers.length > 1 ? "Linked providers need separate plan evidence." : "Pro without billing evidence remains unknown."} Client identity is not verified here.</p>
    <p>{declaredPlan ? `Stored provider declaration: ${declaredPlan.plan}, expires ${new Date(declaredPlan.expiresAt).toISOString()}.` : "No current provider-specific plan declaration."}</p>
    <Button onClick={() => { void savePlan(); }} disabled={busy || !accountId || !plan}>Save provider plan declaration</Button>
    <Button onClick={() => { void inspect(); }} disabled={busy || !report || !model}>{busy ? "Checking…" : "Explain access"}</Button>
    {error && <p role="alert">{error}</p>}
    {decisionKey === formKey && decision?.decision && <div role="status"><strong>{decision.decision.state}</strong><p>{decision.decision.reason}</p><p>Plan source: {decision.planSource}. This result does not grant access.</p><p>Account catalog: {decision.catalogAvailability?.expiresAt != null && decision.catalogAvailability.expiresAt <= now ? "unknown (expired snapshot)" : decision.catalogAvailability?.state ?? "unknown"}.</p></div>}
    {selected && <details><summary>Recent account observations ({selected.observations.filter(o => o.provider === provider).length})</summary>
      <p>Latest result per model and declared client. No plan inference or routing blocks are created.</p>
      <div class="table-wrap"><table><thead><tr><th>Model</th><th>Client</th><th>Result</th><th>HTTP</th><th>Observed</th><th>Expires</th></tr></thead><tbody>{selected.observations.filter(o => o.provider === provider).map(o => <tr key={`${o.provider}/${o.model}/${o.client}`}><td>{o.model}</td><td>{o.client}</td><td>{o.kind === "model-unavailable" ? "Provider rejects this model for this account" : o.kind}</td><td>{o.status ?? "—"}</td><td>{new Date(o.observedAt).toISOString()}</td><td>{new Date(o.expiresAt).toISOString()}</td></tr>)}</tbody></table></div>
    </details>}
    {selected && <details><summary>Provider-advertised models ({catalog?.observedAt == null ? "unknown" : catalog.models.length})</summary>
      <p>{catalog ? `Source: ${catalog.source}. Snapshot: ${catalogFreshness}. Observed: ${catalog.observedAt === null ? "unknown" : new Date(catalog.observedAt).toISOString()}. Valid until: ${catalog.expiresAt === null ? "unknown" : new Date(catalog.expiresAt).toISOString()}.` : "No account-level provider catalog is available for this provider."}</p>
      <p>Advertisement is separate from subscription rules and observed access. Missing or stale data means unknown.</p>
      {catalog && <ul>{catalog.models.map(id => <li key={id}>{id}</li>)}</ul>}
    </details>}
    <label>Filter rule models<input value={ruleFilter} onInput={e => setRuleFilter(e.currentTarget.value)} /></label>
    <div class="table-wrap"><table><thead><tr><th>Model / family</th><th>Plans</th><th>Declared access</th><th>Evidence</th><th>Availability ends</th><th>Notes / source</th></tr></thead><tbody>{rules.map(r => <tr key={r.id}><td>{r.modelPrefix}{r.exact ? " (exact model)" : ""}</td><td>{r.plans.join(", ")}</td><td>{r.state}</td><td>{r.evidence}<br />{r.verifiedAt}<br />Review: {r.reviewAfter}</td><td>{r.validUntil ?? "Not specified"}</td><td>{r.note}<br />{r.source.startsWith("https://") ? <a href={r.source} target="_blank" rel="noreferrer">Source</a> : r.source}</td></tr>)}</tbody></table></div>
    {!report && !error && <p>Loading access rules…</p>}
  </Panel>;
}
