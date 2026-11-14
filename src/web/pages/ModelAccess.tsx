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
import { Icon } from "../components/icons.js";
import { EmptyState, Panel, SearchInput, Segmented, Spinner } from "../components/ui.js";

const PROVIDERS = ["google-antigravity", "openai-codex", "ollama", "opencode-zen"];
const PLANS = ["free", "plus", "pro-trial", "pro-paid", "ultra", "enterprise"];
const CLIENTS = ["unknown", "opencode", "other"] as const;
const CLIENT_LABEL: Record<(typeof CLIENTS)[number], string> = { unknown: "Unknown", opencode: "OpenCode", other: "Other" };

const STATE: Record<AccessState, { label: string; tone: Tone }> = {
  allowed: { label: "Allowed", tone: "ok" },
  blocked: { label: "Blocked", tone: "bad" },
  conditional: { label: "Conditional", tone: "warn" },
  unknown: { label: "Unknown", tone: "neutral" },
};

const EVIDENCE: Record<AccessRule["evidence"], string> = {
  documented: "Documented",
  "operator-confirmed": "Operator confirmed",
  "operator-pending": "Operator pending",
};

const PLAN_SOURCE: Record<NonNullable<AccessReport["planSource"]>, string> = {
  "query-assumption": "Assumed plan",
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

function planList(plans: string[]): string {
  if (plans.includes("*")) return "Any plan";
  return plans.length <= 3 ? plans.join(", ") : `${plans.slice(0, 2).join(", ")} +${plans.length - 2}`;
}

function StateMark({ state, title }: { state: AccessState; title?: string }): JSX.Element {
  const meta = STATE[state];
  return (
    <span class={`access-state tone-${meta.tone}`} title={title}>
      <span class="access-dot" aria-hidden="true" />
      {meta.label}
    </span>
  );
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
  const [pickDate, setPickDate] = useState(false);
  const [ruleFilter, setRuleFilter] = useState("");
  const [model, setModel] = useState("gemini-3.8-flash-medium");
  const [decision, setDecision] = useState<{ report: AccessReport; key: string; model: string } | null>(null);
  const [evidence, setEvidence] = useState<"observations" | "catalog" | null>(null);
  const [loadError, setLoadError] = useState("");
  const [checkError, setCheckError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const trimmedModel = model.trim();
  const formKey = JSON.stringify([accountId, provider, plan, client, trimmedModel, at]);
  const request = useRef(0);
  const currentForm = useRef(formKey);
  currentForm.current = formKey;

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

  // Plans that change this provider's rules come first; the rest fold away.
  const rulePlans = new Set(ruleSet.flatMap(r => r.plans).filter(p => p !== "*"));
  const offeredPlans = PLANS;
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
    if (!ready || saving) return;
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
  }, [formKey, ready, saving]);

  const savePlan = async () => {
    if (!accountId || !plan) return;
    const savedForm = formKey;
    request.current++;
    setSaving(true); setSaveError("");
    try {
      const updated = await api.declareProviderPlan(accountId, provider, plan);
      request.current++;
      setReport(updated);
      if (currentForm.current === savedForm) setPlan("");
    }
    catch { setSaveError("The plan could not be saved."); }
    finally { setSaving(false); }
  };

  let planHint: string;
  if (declaredPlan) planHint = `Stored declaration, expires ${formatDateTime(declaredPlan.expiresAt)}`;
  else if (selected && selected.providers.length > 1) planHint = "Linked providers need separate plan evidence";
  else if (selected && selected.inferredPlan !== "unknown") planHint = "From the account tier";
  else if (selected) planHint = "Pro without billing evidence stays unknown";
  else planHint = "Lists every rule; checks stay unknown without a plan";

  const result = decision?.report;
  const pending = decision !== null && decision.key !== formKey;
  const catalogState = result?.catalogAvailability;
  const catalogText = !catalogState || catalogState.state === "unknown"
    ? null
    : catalogState.expiresAt != null && catalogState.expiresAt <= now
      ? "Catalog snapshot expired"
      : catalogState.state === "advertised" ? "In the account catalog" : "Not in the account catalog";

  const meta = result?.decision
    ? [PLAN_SOURCE[result.planSource ?? "unknown"], catalogText, clientMatters ? "Client declared, not verified" : null, "Does not grant access"].filter(Boolean).join(" · ")
    : null;

  return (
    <Panel
      flush
      id="model-access"
      class="access-panel"
      title="Model access"
      subtitle="Which plans each model is documented for. Informational only."
      actions={
        <label class="access-account">
          <span class="sr-only">Account</span>
          <select class="select" value={accountId} onChange={e => { setAccount(e.currentTarget.value); setPlan(""); setEvidence(null); }}>
            <option value="">No account</option>
            {report?.accounts.map(a => <option key={a.id} value={a.id}>{masker.value.email(a.label)}</option>)}
          </select>
        </label>
      }
    >
      <div class="access-context">
        <Segmented
          label="Provider"
          size="sm"
          value={provider}
          onChange={p => { setProvider(p); setPlan(""); setMorePlans(false); setEvidence(null); }}
          options={PROVIDERS.map(p => {
            const missing = Boolean(selected) && !selected!.providers.includes(p);
            return { value: p, label: providerLabel(p), disabled: missing, title: missing ? "Not connected on this account" : undefined };
          })}
        />
        {planMatters && (
          <div class="access-context-group">
            <Segmented
              label="Plan"
              size="sm"
              value={plan}
              onChange={setPlan}
              options={[
                { value: "", label: selected ? <>Account <span class="access-known">{knownPlan}</span></> : "Any", title: planHint },
                ...planChoices.map(p => ({ value: p, label: p, title: selected ? "Assume this plan for the check" : undefined })),
              ]}
            />
            {foldable && (
              <button type="button" class="link-button access-quiet-link" aria-expanded={morePlans} onClick={() => setMorePlans(!morePlans)}>
                {morePlans ? "Fewer" : `+${offeredPlans.length - relevantPlans.length}`}
              </button>
            )}
          </div>
        )}
        {clientMatters && (
          <Segmented label="Client" size="sm" value={client} onChange={setClient} options={CLIENTS.map(c => ({ value: c, label: CLIENT_LABEL[c], title: "Declared client, not verified" }))} />
        )}
      </div>

      <div class="access-check">
        <div class="access-check-head">
          <label class="field-label" for="access-model">Check a model</label>
          {pickDate || at ? (
            <span class="access-date">
              <input class="input input-sm" type="date" aria-label="Policy date" value={at} onInput={e => setAt(e.currentTarget.value)} />
              <button type="button" class="access-icon-button" aria-label="Use today" onClick={() => { setAt(""); setPickDate(false); }}>
                <Icon name="x" size={14} />
              </button>
            </span>
          ) : (
            <button type="button" class="link-button access-quiet-link" onClick={() => setPickDate(true)}>As of today</button>
          )}
        </div>
        <div class={`access-probe${pending ? " is-pending" : ""}`}>
          <input
            id="access-model"
            class="input input-lg mono-input"
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
          {result?.decision && !checkError && <span class="access-verdict"><StateMark state={result.decision.state} /></span>}
        </div>
        <div class="access-explain" role="status" aria-busy={pending}>
          {checkError || loadError ? (
            <p class="form-error">{checkError || loadError}</p>
          ) : result?.decision ? (
            <>
              <p class="access-reason">{result.decision.reason}</p>
              <p class="access-meta">{meta}</p>
            </>
          ) : null}
          {accountId && plan && (
            <p class="access-meta">
              <button type="button" class="link-button" disabled={saving} onClick={() => { void savePlan(); }} title="Stores an unverified operator declaration for 30 days">
                {saving ? "Saving…" : `Save ${plan} as this account's ${providerLabel(provider)} plan`}
              </button>
              {saveError && <span class="form-error"> {saveError}</span>}
            </p>
          )}
        </div>

        {selected && (
          <div class="access-evidence">
            <p class="access-meta">
              {observations.length > 0 ? (
                <button type="button" class="link-button access-quiet-link" aria-expanded={evidence === "observations"} onClick={() => setEvidence(evidence === "observations" ? null : "observations")}>
                  {pluralize(observations.length, "recent observation")}
                </button>
              ) : (
                <span>No recent observations</span>
              )}
              <span aria-hidden="true"> · </span>
              {catalog && catalog.observedAt != null ? (
                <button type="button" class="link-button access-quiet-link" aria-expanded={evidence === "catalog"} onClick={() => setEvidence(evidence === "catalog" ? null : "catalog")}>
                  {pluralize(catalog.models.length, "advertised model")}{catalogFreshness === "fresh" ? "" : `, ${catalogFreshness}`}
                </button>
              ) : (
                <span>Advertised models unknown</span>
              )}
            </p>
            {evidence === "observations" && (
              <div class="access-well">
                <table class="table table-compact">
                  <thead>
                    <tr>
                      <th scope="col">Model</th>
                      <th scope="col">Result</th>
                      <th scope="col" class="num-col">HTTP</th>
                      <th scope="col" class="hide-sm">Observed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {observations.map(o => (
                      <tr key={`${o.provider}/${o.model}/${o.client}`}>
                        <th scope="row">
                          <span class="model-id">{o.model}</span>
                          <div class="cell-sub">{o.client} client</div>
                        </th>
                        <td>{o.kind === "model-unavailable" ? "Rejected for this account" : o.kind}</td>
                        <td class="num num-col">{o.status ?? <span class="muted">—</span>}</td>
                        <td class="num hide-sm" title={`Expires ${new Date(o.expiresAt).toISOString()}`}>{formatDateTime(o.observedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {evidence === "catalog" && catalog && (
              <div class="access-well">
                <p class="access-meta">
                  {catalog.source} · observed {catalog.observedAt === null ? "unknown" : formatDateTime(catalog.observedAt)} · valid until {catalog.expiresAt === null ? "unknown" : formatDateTime(catalog.expiresAt)}
                </p>
                <div class="tag-row">
                  {catalog.models.map(id => (
                    <button key={id} type="button" class="tag access-model-tag" title="Check this model" onClick={() => setModel(id)}>{id}</button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div class="toolbar panel-toolbar access-rules-toolbar">
        <h3 class="access-rules-title">
          Rules <span class="num muted">{rules.length}</span>
        </h3>
        <SearchInput value={ruleFilter} onInput={setRuleFilter} placeholder="Filter" label="Filter rules by model" />
      </div>

      {!report ? (
        loadError ? null : <div class="panel-loading"><Spinner /></div>
      ) : rules.length === 0 ? (
        <EmptyState icon="search" title={providerRules.length === 0 ? "No rules for this provider and plan" : "No rules match"}>
          {providerRules.length === 0 ? "Without a rule, checks report access as unknown." : undefined}
        </EmptyState>
      ) : (
        <div class="table-scroll">
          <table class="table access-table">
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Access</th>
                <th scope="col" class="hide-sm">Plans</th>
                <th scope="col">Note</th>
              </tr>
            </thead>
            <tbody>
              {rules.map(r => {
                const url = r.source.startsWith("https://");
                return (
                  <tr key={r.id}>
                    <th scope="row">
                      <span class="model-id">{r.modelPrefix}</span>
                      {(r.exact || r.client) && (
                        <div class="cell-sub">
                          {r.exact ? "Exact ID" : `${r.client === "opencode" ? "OpenCode" : r.client} client`}
                        </div>
                      )}
                    </th>
                    <td>
                      <StateMark state={r.state} title={`${EVIDENCE[r.evidence]} · verified ${r.verifiedAt} · review ${r.reviewAfter}`} />
                      {r.validUntil && <div class="cell-sub num">Until {r.validUntil}</div>}
                      {r.evidence !== "documented" && <div class="cell-sub">{EVIDENCE[r.evidence]}</div>}
                    </td>
                    <td class="hide-sm access-plans" title={r.plans.join(", ")}>{planList(r.plans)}</td>
                    <td class="access-note">
                      {r.note}
                      {url ? (
                        <a href={r.source} target="_blank" rel="noreferrer" class="access-source" title={r.source} aria-label={`Source: ${sourceHost(r.source)}`}>
                          <Icon name="arrowUpRight" size={13} />
                        </a>
                      ) : (
                        <div class="cell-sub">{r.source}</div>
                      )}
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
