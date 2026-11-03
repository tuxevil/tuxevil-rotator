// Model access: what each plan is documented to reach, and an explainer for
// one account, provider and model. Informational only; nothing here routes.

import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { AccessReport } from "../../model-access-api.js";
import type { AccessRule, AccessState } from "../../model-access.js";
import { formatDateTime, pluralize } from "../lib/format.js";
import { providerLabel, type Tone } from "../lib/status.js";
import { api } from "../state/api.js";
import { query } from "../state/router.js";
import { masker } from "../state/store.js";
import { Icon, type IconName } from "../components/icons.js";
import { EmptyState, Panel, Pill, SearchInput, Segmented, Spinner } from "../components/ui.js";

const PROVIDERS = ["google-antigravity", "openai-codex", "ollama", "opencode-zen"];
const PLANS = ["unknown", "free", "plus", "pro-trial", "pro-paid", "ultra", "enterprise"];
const CLIENTS = ["unknown", "opencode", "other"] as const;
const CLIENT_LABEL: Record<(typeof CLIENTS)[number], string> = { unknown: "Unknown", opencode: "OpenCode", other: "Other" };

const STATE: Record<AccessState, { label: string; tone: Tone; icon: IconName }> = {
  allowed: { label: "Allowed", tone: "ok", icon: "checkCircle" },
  blocked: { label: "Blocked", tone: "bad", icon: "ban" },
  conditional: { label: "Conditional", tone: "warn", icon: "warning" },
  unknown: { label: "Unknown", tone: "neutral", icon: "info" },
};

const EVIDENCE: Record<AccessRule["evidence"], string> = {
  documented: "Documented",
  "operator-confirmed": "Operator confirmed",
  "operator-pending": "Operator pending",
};

const PLAN_SOURCE: Record<NonNullable<AccessReport["planSource"]>, string> = {
  "query-assumption": "Plan assumed for this check",
  "single-provider-account": "Plan from the account tier",
  "provider-declaration": "Plan from the stored declaration",
  unknown: "Plan unknown",
};

function sourceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function ModelAccessPanel(): JSX.Element {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, []);
  const [report, setReport] = useState<AccessReport | null>(null);
  const [accountId, setAccount] = useState(query.value.get("accessAccount") ?? "");
  const [provider, setProvider] = useState("google-antigravity");
  const [plan, setPlan] = useState("");
  const [morePlans, setMorePlans] = useState(false);
  const [client, setClient] = useState<(typeof CLIENTS)[number]>("unknown");
  const [at, setAt] = useState("");
  const [ruleFilter, setRuleFilter] = useState("");
  const [model, setModel] = useState("gemini-3.8-flash-medium");
  const [decision, setDecision] = useState<{ report: AccessReport; key: string; model: string } | null>(null);
  const [openObservations, setOpenObservations] = useState(false);
  const [openCatalog, setOpenCatalog] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [checkError, setCheckError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const trimmedModel = model.trim();
  const formKey = JSON.stringify([accountId, provider, plan, client, trimmedModel, at]);
  const request = useRef(0);

  useEffect(() => {
    let active = true;
    api.modelAccess().then(value => { if (active) setReport(value); }).catch(() => { if (active) setLoadError("Access rules could not be loaded."); });
    return () => { active = false; };
  }, []);

  const selected = report?.accounts.find(a => a.id === accountId);
  useEffect(() => {
    if (selected && !selected.providers.includes(provider)) setProvider(selected.providers[0] ?? "google-antigravity");
  }, [selected, provider]);

  const catalog = selected?.providerCatalogs?.find(c => c.provider === provider);
  const catalogFreshness = catalog?.freshness === "fresh" && catalog.expiresAt !== null && catalog.expiresAt <= now ? "stale" : catalog?.freshness;
  const declaredPlan = selected?.providerPlans.find(p => p.provider === provider);
  const knownPlan = declaredPlan?.plan || selected?.inferredPlan || "unknown";
  const effectivePlan = plan || knownPlan;
  const allPlans = effectivePlan === "unknown" || !accountId && !plan;
  const ruleSet = report?.rules.filter(r => r.provider === provider) ?? [];
  const providerRules = ruleSet.filter(r => allPlans || r.plans.includes(effectivePlan) || r.plans.includes("*"));
  const rules = providerRules.filter(r => r.modelPrefix.toLowerCase().includes(ruleFilter.toLowerCase()));
  const observations = selected?.observations.filter(o => o.provider === provider) ?? [];

  // Plans that change this provider's rules come first; the rest wait behind "more".
  const rulePlans = new Set(ruleSet.flatMap(r => r.plans).filter(p => p !== "*"));
  const offeredPlans = PLANS.filter(p => p !== "unknown" || selected);
  const relevantPlans = offeredPlans.filter(p => rulePlans.has(p) || p === plan);
  // Folding away a single plan saves nothing, so only fold two or more.
  const foldable = offeredPlans.length - relevantPlans.length >= 2;
  const planChoices = morePlans || !foldable ? offeredPlans : relevantPlans;
  const planMatters = rulePlans.size > 0;
  const clientMatters = ruleSet.some(r => r.client);

  // Suggestions for the model field: rule families and the account's advertised IDs.
  const suggestions = [...new Set([...ruleSet.filter(r => !r.modelPrefix.includes("*")).map(r => r.modelPrefix), ...(catalog?.models ?? [])])].sort();

  // Explain as the inputs change. The previous answer stays visible, dimmed,
  // until the new one arrives; late responses for older inputs are dropped.
  const ready = Boolean(report) && (!accountId || Boolean(selected?.providers.includes(provider)));
  useEffect(() => {
    if (!ready) return;
    if (!trimmedModel) { request.current++; setDecision(null); setCheckError(""); return; }
    const id = ++request.current;
    const key = formKey;
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ provider, model: trimmedModel, client });
      if (accountId) params.set("accountId", accountId);
      if (plan) params.set("plan", plan);
      if (at) params.set("at", at);
      api.modelAccess(params)
        .then(result => {
          if (id !== request.current) return;
          setReport(result); setDecision({ report: result, key, model: trimmedModel }); setCheckError("");
        })
        .catch(() => {
          if (id !== request.current) return;
          setDecision(null); setCheckError("Access could not be explained for this account, provider and model.");
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [formKey, ready]);

  const savePlan = async () => {
    if (!accountId || !plan) return;
    setSaving(true); setSaveError("");
    try { setReport(await api.declareProviderPlan(accountId, provider, plan)); setPlan(""); }
    catch { setSaveError("The plan could not be saved."); }
    finally { setSaving(false); }
  };

  let planHint: string;
  if (plan && accountId) planHint = "Assumed for this check";
  else if (plan) planHint = "Simulated plan";
  else if (declaredPlan) planHint = `Stored declaration, expires ${formatDateTime(declaredPlan.expiresAt)}`;
  else if (selected && selected.providers.length > 1) planHint = "Linked providers need separate plan evidence";
  else if (selected && selected.inferredPlan !== "unknown") planHint = "From the account tier";
  else if (selected) planHint = "Pro without billing evidence stays unknown";
  else planHint = "Every rule is listed; checks stay unknown without a plan";

  const result = decision?.report;
  const pending = decision !== null && decision.key !== formKey;
  const resultState = result?.decision ? STATE[result.decision.state] : null;
  const catalogState = result?.catalogAvailability;
  const catalogText = !catalogState || catalogState.state === "unknown"
    ? "Account catalog unknown"
    : catalogState.expiresAt != null && catalogState.expiresAt <= now
      ? "Account catalog snapshot expired"
      : catalogState.state === "advertised" ? "Listed in the account catalog" : "Not listed in the account catalog";

  return (
    <Panel
      flush
      id="model-access"
      class="access-panel"
      title="Model access"
      subtitle="What each plan is documented to reach. Quota, credentials, capabilities and routing are checked separately."
      actions={
        <label class="access-account">
          Account
          <select class="select" value={accountId} onChange={e => { setAccount(e.currentTarget.value); setPlan(""); }}>
            <option value="">None, simulate</option>
            {report?.accounts.map(a => <option key={a.id} value={a.id}>{masker.value.email(a.label)}</option>)}
          </select>
        </label>
      }
    >
      <div class="access-check">
        <div class="access-context">
          <span class="access-context-label">Provider</span>
          <div class="access-context-control">
            <Segmented
              label="Provider"
              value={provider}
              onChange={p => { setProvider(p); setPlan(""); setMorePlans(false); }}
              options={PROVIDERS.map(p => {
                const missing = Boolean(selected) && !selected!.providers.includes(p);
                return { value: p, label: providerLabel(p), disabled: missing, title: missing ? "Not connected on this account" : undefined };
              })}
            />
          </div>

          {planMatters && (
            <>
              <span class="access-context-label">Plan</span>
              <div class="access-context-control">
                <div class="chips" role="group" aria-label="Plan">
                  <button type="button" class={`filter-chip${plan === "" ? " is-active" : ""}`} aria-pressed={plan === ""} onClick={() => setPlan("")}>
                    {selected ? <>Account plan <span class="filter-count">{knownPlan}</span></> : "Unknown"}
                  </button>
                  {planChoices.map(p => (
                    <button key={p} type="button" class={`filter-chip${plan === p ? " is-active" : ""}`} aria-pressed={plan === p} onClick={() => setPlan(p)}>
                      {p}
                    </button>
                  ))}
                  {foldable && (
                    <button type="button" class="link-button access-more" aria-expanded={morePlans} onClick={() => setMorePlans(!morePlans)}>
                      {morePlans ? "Fewer" : `${offeredPlans.length - relevantPlans.length} more`}
                    </button>
                  )}
                </div>
                <div class="access-hint-row">
                  <span class="field-hint">{planHint}</span>
                  {accountId && plan && (
                    <button type="button" class="link-button" disabled={saving} onClick={() => { void savePlan(); }} title="Stores an unverified operator declaration for 30 days">
                      {saving ? "Saving…" : `Save as this account's ${providerLabel(provider)} plan`}
                    </button>
                  )}
                </div>
                {saveError && <span class="form-error" role="alert">{saveError}</span>}
              </div>
            </>
          )}

          {clientMatters && (
            <>
              <span class="access-context-label">Client</span>
              <div class="access-context-control">
                <Segmented label="Client" size="sm" value={client} onChange={setClient} options={CLIENTS.map(c => ({ value: c, label: CLIENT_LABEL[c] }))} />
                <span class="field-hint">Declared, not verified</span>
              </div>
            </>
          )}
        </div>

        <div class="access-query">
          <label class="field">
            <span class="field-label">Check a model</span>
            <input
              class="input mono-input"
              value={model}
              onInput={e => setModel(e.currentTarget.value)}
              maxLength={256}
              spellcheck={false}
              autocomplete="off"
              placeholder="Model ID"
              list="access-model-suggestions"
            />
            <datalist id="access-model-suggestions">
              {suggestions.map(id => <option key={id} value={id} />)}
            </datalist>
          </label>
          <label class="field">
            <span class="field-label">On date</span>
            <input class="input" type="date" value={at} onInput={e => setAt(e.currentTarget.value)} />
          </label>
        </div>

        {loadError && (
          <div class="callout tone-bad" role="alert">
            <Icon name="critical" size={16} />
            <div>{loadError}</div>
          </div>
        )}

        {checkError && (
          <div class="callout tone-bad" role="alert">
            <Icon name="critical" size={16} />
            <div>{checkError}</div>
          </div>
        )}

        {!checkError && result?.decision && resultState && (
          <div class={`callout tone-${resultState.tone} access-result${pending ? " is-pending" : ""}`} role="status" aria-busy={pending}>
            <Icon name={resultState.icon} size={16} />
            <div class="access-result-body">
              <div class="access-result-head">
                <strong>{resultState.label}</strong>
                <span class="model-id">{decision!.model}</span>
              </div>
              <p>{result.decision.reason}</p>
              <p class="access-result-meta">
                {PLAN_SOURCE[result.planSource ?? "unknown"]} · {catalogText} · This result does not grant access
              </p>
            </div>
          </div>
        )}

        {selected && (
          <div class="access-evidence">
            <button type="button" class="access-disclosure" aria-expanded={openObservations} onClick={() => setOpenObservations(!openObservations)}>
              <Icon name="chevronRight" size={14} />
              <span>Recent observations</span>
              <span class="num muted">{observations.length}</span>
            </button>
            {openObservations && (
              <div class="access-disclosure-body">
                <p class="field-hint">Latest result per model and declared client. Observations never infer a plan or block routing.</p>
                {observations.length === 0 ? (
                  <p class="muted">No observations for {providerLabel(provider)} on this account yet.</p>
                ) : (
                  <div class="table-scroll">
                    <table class="table table-compact">
                      <thead>
                        <tr>
                          <th scope="col">Model</th>
                          <th scope="col">Client</th>
                          <th scope="col">Result</th>
                          <th scope="col" class="num-col">HTTP</th>
                          <th scope="col" class="hide-sm">Observed</th>
                          <th scope="col" class="hide-sm">Expires</th>
                        </tr>
                      </thead>
                      <tbody>
                        {observations.map(o => (
                          <tr key={`${o.provider}/${o.model}/${o.client}`}>
                            <th scope="row"><span class="model-id">{o.model}</span></th>
                            <td>{o.client}</td>
                            <td>{o.kind === "model-unavailable" ? "Provider rejects this model for this account" : o.kind}</td>
                            <td class="num num-col">{o.status ?? <span class="muted">—</span>}</td>
                            <td class="num hide-sm" title={new Date(o.observedAt).toISOString()}>{formatDateTime(o.observedAt)}</td>
                            <td class="num hide-sm" title={new Date(o.expiresAt).toISOString()}>{formatDateTime(o.expiresAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            <button type="button" class="access-disclosure" aria-expanded={openCatalog} onClick={() => setOpenCatalog(!openCatalog)}>
              <Icon name="chevronRight" size={14} />
              <span>Advertised models</span>
              <span class="num muted">{catalog?.observedAt == null ? "unknown" : catalog.models.length}</span>
            </button>
            {openCatalog && (
              <div class="access-disclosure-body">
                {catalog ? (
                  <p class="access-catalog-meta">
                    <span>Source {catalog.source}</span>
                    <span>Snapshot {catalogFreshness}</span>
                    <span>Observed <span class="num">{catalog.observedAt === null ? "unknown" : formatDateTime(catalog.observedAt)}</span></span>
                    <span>Valid until <span class="num">{catalog.expiresAt === null ? "unknown" : formatDateTime(catalog.expiresAt)}</span></span>
                  </p>
                ) : (
                  <p class="muted">No account-level catalog is available for {providerLabel(provider)}.</p>
                )}
                <p class="field-hint">Advertisement is separate from plan rules and observed access. Missing or stale data means unknown. Select a model to check it.</p>
                {catalog && catalog.models.length > 0 && (
                  <div class="tag-row">
                    {catalog.models.map(id => (
                      <button key={id} type="button" class="tag access-model-tag" onClick={() => setModel(id)}>{id}</button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div class="toolbar panel-toolbar access-rules-toolbar">
        <div class="access-rules-title">
          <h3>Rules</h3>
          <span class="muted">
            {providerLabel(provider)} · {allPlans ? "all plans" : `${effectivePlan} plan`} · <span class="num">{pluralize(rules.length, "rule")}</span>
          </span>
        </div>
        <div class="toolbar-right">
          <SearchInput value={ruleFilter} onInput={setRuleFilter} placeholder="Model" label="Filter rules by model" />
        </div>
      </div>

      {!report ? (
        loadError ? null : <div class="panel-loading"><Spinner /></div>
      ) : rules.length === 0 ? (
        <EmptyState icon="search" title={providerRules.length === 0 ? "No rules for this provider and plan" : "No rules match"}>
          {providerRules.length === 0 ? "Absence of a rule is not permission; checks report it as unknown." : undefined}
        </EmptyState>
      ) : (
        <div class="table-scroll">
          <table class="table access-table">
            <thead>
              <tr>
                <th scope="col">Model or family</th>
                <th scope="col">Plans</th>
                <th scope="col">Access</th>
                <th scope="col" class="hide-sm">Evidence</th>
                <th scope="col" class="hide-sm">Ends</th>
                <th scope="col">Note</th>
              </tr>
            </thead>
            <tbody>
              {rules.map(r => {
                const state = STATE[r.state];
                return (
                  <tr key={r.id}>
                    <th scope="row">
                      <span class="model-id">{r.modelPrefix}</span>
                      {(r.exact || r.client) && (
                        <div class="cell-sub">
                          {r.exact && "Exact model"}
                          {r.exact && r.client && " · "}
                          {r.client && `${r.client === "opencode" ? "OpenCode" : r.client} client only`}
                        </div>
                      )}
                    </th>
                    <td>
                      <span class="tag-row">
                        {r.plans.map(p => <span key={p} class="tag">{p === "*" ? "Any plan" : p}</span>)}
                      </span>
                    </td>
                    <td><Pill tone={state.tone}>{state.label}</Pill></td>
                    <td class="hide-sm">
                      {EVIDENCE[r.evidence]}
                      <div class="cell-sub num access-evidence-dates">Verified {r.verifiedAt}</div>
                      <div class="cell-sub num access-evidence-dates">Review {r.reviewAfter}</div>
                    </td>
                    <td class="hide-sm num">{r.validUntil ?? <span class="muted">—</span>}</td>
                    <td class="access-note">
                      {r.note}
                      <div class="cell-sub">
                        {r.source.startsWith("https://") ? (
                          <a href={r.source} target="_blank" rel="noreferrer" class="access-source">
                            {sourceHost(r.source)}
                            <Icon name="arrowUpRight" size={12} />
                          </a>
                        ) : (
                          r.source
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
