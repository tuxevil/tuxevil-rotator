import { ModelAccessPanel } from "./ModelAccess.js";
// Models: which providers serve traffic, in what order, and which models
// clients can call. The provider drawer lives at /dashboard/models/<provider>.

import type { JSX } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { CatalogModelEntry, ModelCatalogResponse } from "../../dashboard-types.js";
import { pluralize } from "../lib/format.js";
import {
  buildModelRows,
  canServeProvider,
  filterModelRows,
  formatContextWindow,
  isModelFilter,
  isServed,
  isTurnedOffForAccount,
  MODEL_FILTERS,
  moveProvider,
  offeringKey,
  placeProvider,
  providerMark,
  providerQuotaRows,
  quotaPoolLabel,
  sortModelRows,
  summarizeProviders,
  type ModelRow,
  type ModelSort,
  type ProviderState,
  type ProviderSummary,
} from "../lib/models.js";
import { providerLabel, type Tone } from "../lib/status.js";
import { run } from "../state/actions.js";
import { api } from "../state/api.js";
import { createModelCatalogState } from "../state/model-catalog.js";
import { accountPath, BASE, effortPath, navigate, providerPath, query, route, setQuery } from "../state/router.js";
import { masker, now, overview } from "../state/store.js";
import { Icon } from "../components/icons.js";
import { Drawer, Menu } from "../components/overlays.js";
import {
  AsyncButton,
  Button,
  EmptyState,
  Link,
  Meter,
  PageHeader,
  Panel,
  Pill,
  SearchInput,
  Spinner,
  Stat,
  StatusPill,
  Switch,
} from "../components/ui.js";
import { EffortRouteDrawer, EffortRoutingPanel } from "./EffortRouting.js";
import { openAddAccount } from "./shared.js";

const catalogState = createModelCatalogState(() => api.catalog());
const { catalog, catalogError, loadCatalog } = catalogState;

/** Apply a change, show its outcome, and keep the returned catalog. */
async function change(
  fn: () => Promise<ModelCatalogResponse>,
  messages: { success?: string; failure: string },
): Promise<void> {
  await catalogState.change(() => run(fn, messages));
}

const PROVIDER_STATE: Record<ProviderState, { label: string; tone: Tone }> = {
  off: { label: "Off", tone: "muted" },
  "not-connected": { label: "Not connected", tone: "muted" },
  "needs-sign-in": { label: "Needs sign-in", tone: "warn" },
  unavailable: { label: "No account can serve", tone: "warn" },
  healthy: { label: "Healthy", tone: "ok" },
};

const OFF_REASON: Record<NonNullable<CatalogModelEntry["offReason"]>, string> = {
  provider: "Provider is off",
  model: "Turned off",
  review: "Waiting for review",
};

function ProviderMark({ id, size = "md" }: { id: string; size?: "sm" | "md" | "lg" }): JSX.Element {
  const mark = providerMark(id);
  return (
    <span class={`provider-mark provider-mark-${size}`} style={{ "--hue": String(mark.hue) }} aria-hidden="true">
      {mark.mark}
    </span>
  );
}

function authLabel(kind: "oauth" | "api-key"): string {
  return kind === "oauth" ? "Sign-in" : "API key";
}

export function ModelsPage(): JSX.Element {
  useEffect(() => catalogState.watchRouting(overview, window), []);

  const data = overview.value!;
  const state = catalog.value;
  const drawerId = route.value.provider;

  const providers = useMemo(
    () => (state ? summarizeProviders(state, data, now.value) : []),
    [state, data, Math.floor(now.value / 30_000)],
  );

  const header = (
    <PageHeader
      title="Models"
      description="Choose which providers serve traffic and which models clients can call."
      actions={
        <>
          <AsyncButton
            icon="refresh"
            onClick={() => change(() => api.refreshCatalog(), { success: "Model lists refreshed", failure: "Could not refresh the model lists" })}
          >
            Refresh model lists
          </AsyncButton>
          <Button variant="primary" icon="plus" onClick={openAddAccount}>
            Add account
          </Button>
        </>
      }
    />
  );

  if (!state) {
    return (
      <>
        {header}
        <div class="panel">
          {catalogError.value ? (
            <EmptyState icon="critical" title="Could not load the model catalog" action={<Button onClick={() => void loadCatalog()}>Try again</Button>}>
              {catalogError.value}
            </EmptyState>
          ) : (
            <div class="panel-loading">
              <Spinner />
            </div>
          )}
        </div>
      </>
    );
  }

  const closeDrawer = () => {
    const params = new URLSearchParams(query.value);
    params.delete("from");
    const back = params.toString();
    navigate(`${BASE}/models${back ? `?${back}` : ""}`);
  };
  const drawerSummary = providers.find((summary) => summary.provider.id === drawerId) ?? null;

  return (
    <>
      {header}
      <ModelStats state={state} providers={providers} />
      <ProvidersPanel state={state} providers={providers} />
      <EffortRoutingPanel state={state} change={change} />
      <ModelsPanel state={state} />
      <ModelAccessPanel />
      <Drawer open={Boolean(drawerId)} onClose={closeDrawer} label="Provider details">
        {drawerId &&
          (drawerSummary ? (
            <ProviderDetail summary={drawerSummary} state={state} onClose={closeDrawer} />
          ) : (
            <div class="drawer-empty">
              <div class="drawer-head">
                <h2>Provider not found</h2>
                <Button variant="ghost" icon="x" iconOnly onClick={closeDrawer}>
                  Close
                </Button>
              </div>
              <p class="muted">There is no provider called “{drawerId}”.</p>
            </div>
          ))}
      </Drawer>
      <EffortRouteDrawer
        state={state}
        match={route.value.effort}
        change={change}
        commit={(fn) => catalogState.change(fn)}
        onClose={closeDrawer}
      />
    </>
  );
}

function ModelStats({ state, providers }: { state: ModelCatalogResponse; providers: ProviderSummary[] }): JSX.Element {
  const rows = buildModelRows(state, {});
  const on = rows.filter((row) => row.on).length;
  const shared = rows.filter((row) => row.shared).length;
  const waiting = rows.filter((row) => row.waiting).length;
  const connected = providers.filter((summary) => summary.accounts.length > 0);
  const routing = connected.filter((summary) => summary.provider.enabled).length;
  return (
    <div class="stats stats-card">
      <Stat
        label="Providers"
        value={
          <>
            {routing}
            <span class="stat-of"> of {connected.length}</span>
          </>
        }
        sub="connected providers routing traffic"
      />
      <Stat
        label="Models on"
        value={
          <>
            {on}
            <span class="stat-of"> of {rows.length}</span>
          </>
        }
        sub={rows.length - on > 0 ? `${rows.length - on} off` : "every model is on"}
      />
      <Stat label="Shared" value={shared} sub={shared === 1 ? "model listed by two providers" : "models listed by more than one provider"} />
      {!state.autoEnableNewModels && (
        <Stat label="Waiting for review" value={waiting} sub="new models stay off until you turn them on" tone={waiting > 0 ? "warn" : undefined} />
      )}
    </div>
  );
}

// ── Providers ───────────────────────────────────────────────────────────

function ProvidersPanel({ state, providers }: { state: ModelCatalogResponse; providers: ProviderSummary[] }): JSX.Element {
  const order = state.providers.map((provider) => provider.id);
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);

  const reorder = (next: string[]) => {
    if (next.join() === order.join()) return;
    void change(() => api.setProviderOrder(next), { success: "Provider order saved", failure: "Could not save the provider order" });
  };

  return (
    <Panel
      flush
      class="providers-panel"
      title="Providers"
      subtitle="When more than one provider lists the same model, the one higher in this list gets the request. Drag a provider to change the order."
    >
      <div class="table-scroll">
        <table class="table providers-table">
          <thead>
            <tr>
              <th scope="col">
                <span class="sr-only">Order</span>
              </th>
              <th scope="col">Provider</th>
              <th scope="col" class="hide-sm">
                Accounts
              </th>
              <th scope="col" class="hide-sm">
                Models
              </th>
              <th scope="col" class="hide-sm">
                Quota
              </th>
              <th scope="col">Status</th>
              <th scope="col">Routing</th>
              <th scope="col">
                <span class="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {providers.map((summary) => {
              const { provider } = summary;
              const meta = PROVIDER_STATE[summary.state];
              const dropClass = drop?.id === provider.id && dragging !== provider.id ? (drop.after ? " drop-after" : " drop-before") : "";
              return (
                <tr
                  key={provider.id}
                  class={`provider-row${provider.enabled ? "" : " is-off"}${dragging === provider.id ? " is-dragging" : ""}${dropClass}`}
                  draggable
                  onDragStart={(event) => {
                    setDragging(provider.id);
                    if (event.dataTransfer) {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", provider.id);
                    }
                  }}
                  onDragEnd={() => {
                    setDragging(null);
                    setDrop(null);
                  }}
                  onDragOver={(event) => {
                    if (!dragging) return;
                    event.preventDefault();
                    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                    setDrop({ id: provider.id, after: event.clientY > rect.top + rect.height / 2 });
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (dragging && drop) reorder(placeProvider(order, dragging, drop.id, drop.after));
                    setDragging(null);
                    setDrop(null);
                  }}
                  onClick={(event) => {
                    if ((event.target as HTMLElement).closest("button, a, .switch-field")) return;
                    navigate(providerPath(provider.id));
                  }}
                >
                  <td class="rank-cell">
                    <span class="rank">
                      <span class="grip" title="Drag to reorder" aria-hidden="true">
                        <Icon name="grip" size={15} />
                      </span>
                      <span class="rank-num num">{summary.rank + 1}</span>
                    </span>
                  </td>
                  <th scope="row">
                    <div class="provider-cell">
                      <ProviderMark id={provider.id} />
                      <div>
                        <Link href={providerPath(provider.id)} class="provider-name">
                          {provider.name}
                        </Link>
                        <div class="cell-sub">{authLabel(provider.credentialKind)}</div>
                      </div>
                    </div>
                  </th>
                  <td class="hide-sm">
                    {summary.accounts.length === 0 ? (
                      <span class="muted">None</span>
                    ) : (
                      <>
                        <span class="num">{summary.accounts.length}</span>
                        <span class="muted"> · {summary.canServe} can serve</span>
                      </>
                    )}
                  </td>
                  <td class="hide-sm">
                    <span class="num">{summary.modelsOn}</span>
                    <span class="muted"> of {summary.models} on</span>
                  </td>
                  <td class="hide-sm">
                    <QuotaList quotas={summary.quotas} />
                  </td>
                  <td>
                    <Pill tone={meta.tone}>{meta.label}</Pill>
                    {summary.state === "needs-sign-in" && (
                      <div class="cell-sub">
                        {summary.rejected.length} of {pluralize(summary.accounts.length, "credential")} rejected
                      </div>
                    )}
                  </td>
                  <td class="cell-switch">
                    <Switch
                      label={provider.enabled ? "On" : "Off"}
                      ariaLabel={`Route traffic to ${provider.name}`}
                      checked={provider.enabled}
                      onChange={(on) =>
                        change(() => api.setProviderEnabled(provider.id, on), {
                          success: on ? `${provider.name} is routing traffic again` : `${provider.name} turned off. Its accounts stay signed in.`,
                          failure: `Could not turn ${provider.name} ${on ? "on" : "off"}`,
                        })
                      }
                    />
                  </td>
                  <td class="cell-action">
                    <Menu
                      label={`Actions for ${provider.name}`}
                      items={[
                        { label: "Manage", icon: "settings", onSelect: () => navigate(providerPath(provider.id)) },
                        { label: "Move up", icon: "arrowUp", disabled: summary.rank === 0, onSelect: () => reorder(moveProvider(order, provider.id, -1)) },
                        { label: "Move down", icon: "arrowDown", disabled: summary.rank === order.length - 1, onSelect: () => reorder(moveProvider(order, provider.id, 1)) },
                        "separator",
                        { label: "Add account", icon: "plus", onSelect: openAddAccount },
                      ]}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function QuotaList({ quotas }: { quotas: ProviderSummary["quotas"] }): JSX.Element {
  if (quotas.length === 0) return <span class="muted">—</span>;
  return (
    <div class="quota-mini">
      {quotas.map((quota) => (
        <div class="quota-mini-row" key={quota.key}>
          <span class="truncate">{quota.name}</span>
          <Meter value={quota.percent} label={`${quota.name} quota remaining`} size="sm" />
          <span class="num">{Math.round(quota.percent)}%</span>
        </div>
      ))}
    </div>
  );
}

// ── Models ──────────────────────────────────────────────────────────────

function ModelsPanel({ state }: { state: ModelCatalogResponse }): JSX.Element {
  const params = query.value;
  const filterParam = params.get("filter");
  const filter = isModelFilter(filterParam) ? filterParam : "all";
  const provider = params.get("provider") ?? "";
  const search = params.get("q") ?? "";
  const sort: ModelSort = params.get("sort") === "name" ? "name" : "requests";
  const [open, setOpen] = useState<Set<string>>(new Set());
  const requests = overview.value?.recentRequestsByModel ?? {};

  const rows = useMemo(() => buildModelRows(state, requests), [state, requests]);
  const visible = useMemo(
    () => sortModelRows(filterModelRows(rows, { filter, provider, query: search }), sort),
    [rows, filter, provider, search, sort],
  );
  const counts = Object.fromEntries(MODEL_FILTERS.map((entry) => [entry.id, rows.filter(entry.match).length]));
  const names = Object.fromEntries(state.providers.map((entry) => [entry.id, entry.name]));

  const toggleOpen = (key: string) => {
    const next = new Set(open);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setOpen(next);
  };

  return (
    <Panel
      flush
      class="models-panel"
      title="Models"
      subtitle={
        <>
          Every model your providers can serve. Turning one off removes it from <code>/v1/models</code> and rejects requests for it.
        </>
      }
      actions={
        <label class="new-models">
          New models
          <select
            class="select"
            value={state.autoEnableNewModels ? "on" : "review"}
            onChange={(event) => {
              const on = (event.target as HTMLSelectElement).value === "on";
              void change(() => api.setAutoEnableNewModels(on), {
                success: on ? "New models now turn on as soon as a provider lists them" : "New models now stay off until you turn them on",
                failure: "Could not change how new models are handled",
              });
            }}
          >
            <option value="on">Turn on automatically</option>
            <option value="review">Wait for review</option>
          </select>
        </label>
      }
    >
      <div class="toolbar panel-toolbar">
        <div class="chips" role="group" aria-label="Filter models">
          {MODEL_FILTERS.filter((entry) => entry.id === "all" || counts[entry.id] > 0 || filter === entry.id).map((entry) => (
            <button
              key={entry.id}
              type="button"
              class={`filter-chip${filter === entry.id ? " is-active" : ""}`}
              aria-pressed={filter === entry.id}
              onClick={() => setQuery({ filter: entry.id === "all" ? null : entry.id })}
            >
              {entry.label}
              <span class="filter-count num">{counts[entry.id]}</span>
            </button>
          ))}
        </div>
        <div class="toolbar-right">
          <select class="select" aria-label="Filter by provider" value={provider} onChange={(event) => setQuery({ provider: (event.target as HTMLSelectElement).value || null })}>
            <option value="">All providers</option>
            {state.providers.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
          <span data-page-search>
            <SearchInput value={search} onInput={(value) => setQuery({ q: value || null })} placeholder="Model ID" label="Search models" shortcut="/" />
          </span>
        </div>
      </div>
      {visible.length === 0 ? (
        <EmptyState icon="search" title={rows.length === 0 ? "No models yet" : "No models match"}>
          {rows.length === 0 ? "Add an account so its provider can list the models it serves." : undefined}
        </EmptyState>
      ) : (
        <div class="table-scroll">
          <table class="table models-table">
            <thead>
              <tr>
                <th scope="col" aria-sort={sort === "name" ? "ascending" : "none"}>
                  <button type="button" class="th-sort" onClick={() => setQuery({ sort: "name" })}>
                    Model {sort === "name" && <Icon name="chevronDown" size={12} />}
                  </button>
                </th>
                <th scope="col">Served by</th>
                <th scope="col" class="hide-sm">
                  Context
                </th>
                <th scope="col" class="hide-sm">
                  Quota
                </th>
                <th scope="col" class="num-col" aria-sort={sort === "requests" ? "descending" : "none"}>
                  <button type="button" class="th-sort" onClick={() => setQuery({ sort: null })} title="Requests in the last hour">
                    Last hour {sort === "requests" && <Icon name="chevronDown" size={12} />}
                  </button>
                </th>
                <th scope="col">Enabled</th>
                <th scope="col">
                  <span class="sr-only">Providers</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <ModelRows
                  key={row.key}
                  row={row}
                  names={names}
                  open={open.has(row.key)}
                  onToggleOpen={() => toggleOpen(row.key)}
                  effortListed={row.effortRoute ? state.effortRoutes.some((entry) => entry.alias === row.effortRoute!.alias && entry.listed) : false}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function ServedBy({ row, names }: { row: ModelRow; names: Record<string, string> }): JSX.Element {
  return (
    <span class="served-by">
      {row.offerings.map((entry, index) => (
        <span key={entry.providerId} class="served-by-item">
          {index > 0 && <Icon name="chevronRight" size={12} class="served-by-sep" />}
          <span
            class={`provider-chip${isServed(entry) ? "" : " is-off"}${entry.routed && row.shared ? " is-routed" : ""}`}
            title={`${names[entry.providerId] ?? entry.providerId}${isServed(entry) ? "" : ` (${OFF_REASON[entry.offReason!].toLowerCase()})`}`}
          >
            <ProviderMark id={entry.providerId} size="sm" />
            {providerLabel(entry.providerId)}
          </span>
        </span>
      ))}
    </span>
  );
}

function ModelRows({
  row,
  names,
  open,
  onToggleOpen,
  effortListed = false,
}: {
  row: ModelRow;
  names: Record<string, string>;
  open: boolean;
  onToggleOpen: () => void;
  /** The effort-routed ID that uses this model is listed, which hides the model from /v1/models. */
  effortListed?: boolean;
}): JSX.Element {
  // Offerings whose provider is on; the row switch acts on those.
  const switchable = row.offerings.filter((entry) => entry.offReason !== "provider");
  const contexts = [...new Set(row.offerings.map((entry) => formatContextWindow(entry.contextWindow)))];
  const pools = [...new Set(row.offerings.map((entry) => quotaPoolLabel(entry.quotaPool)))];
  const routed = row.offerings.find((entry) => entry.routed);
  const only = row.offerings[0];

  const setRow = (on: boolean) =>
    change(() => api.setModelsEnabled(switchable.map(offeringKey), on), {
      success: `${row.id} turned ${on ? "on" : "off"}`,
      failure: `Could not turn ${row.id} ${on ? "on" : "off"}`,
    });

  let sub: string | null = null;
  if (row.shared) sub = routed ? `Requests go to ${names[routed.providerId] ?? routed.providerId}` : "No provider is serving it";
  else if (only.offReason === "provider") sub = `${names[only.providerId] ?? only.providerId} is off`;
  else if (only.source === "discovered" && only.offReason !== "review") sub = "Found by the provider at runtime";

  return (
    <>
      <tr class={`model-row${row.on ? "" : " is-off"}${open ? " is-open" : ""}`}>
        <th scope="row">
          <div class="model-name">
            <span class="model-id">{row.id}</span>
            {row.shared && <span class="tag tag-accent">Shared</span>}
            {row.waiting && <span class="tag tag-info">Waiting for review</span>}
            {row.effortRoute && <span class="tag tag-accent">Effort · {row.effortRoute.effort}</span>}
          </div>
          {sub && <div class="cell-sub">{sub}</div>}
          {row.effortRoute && (
            <div class="cell-sub">
              Called as{" "}
              <Link href={effortPath(row.effortRoute.alias)} class="effort-inline-link">
                {row.effortRoute.alias}
              </Link>
              {effortListed && (
                <>
                  {" "}
                  · hidden from <code>/v1/models</code>
                </>
              )}
            </div>
          )}
        </th>
        <td>
          <ServedBy row={row} names={names} />
        </td>
        <td class="hide-sm num">{contexts.join(" / ")}</td>
        <td class="hide-sm">{pools.join(" · ")}</td>
        <td class="num-col num">{row.requests > 0 ? row.requests.toLocaleString() : <span class="muted">—</span>}</td>
        <td class="cell-switch">
          <Switch
            label={row.shared ? `${row.offerings.filter(isServed).length} of ${row.offerings.length}` : ""}
            ariaLabel={`Serve ${row.id}`}
            checked={row.on}
            disabled={switchable.length === 0}
            onChange={setRow}
          />
        </td>
        <td class="cell-action">
          {row.shared && (
            <Button variant="ghost" size="sm" iconOnly icon={open ? "chevronDown" : "chevronRight"} aria-expanded={open} onClick={onToggleOpen}>
              {open ? "Hide providers" : "Show providers"}
            </Button>
          )}
        </td>
      </tr>
      {open &&
        row.offerings.map((entry, index) => (
          <tr key={entry.providerId} class={`model-subrow${isServed(entry) ? "" : " is-off"}`}>
            <th scope="row">
              <div class="model-subrow-provider">
                <span class="rank-num num">{index + 1}</span>
                <ProviderMark id={entry.providerId} size="sm" />
                <span>{names[entry.providerId] ?? entry.providerId}</span>
                {entry.routed && <span class="tag tag-accent">Gets requests</span>}
              </div>
            </th>
            <td class="muted">{isServed(entry) ? "Served" : OFF_REASON[entry.offReason!]}</td>
            <td class="hide-sm num">{formatContextWindow(entry.contextWindow)}</td>
            <td class="hide-sm">{quotaPoolLabel(entry.quotaPool)}</td>
            <td />
            <td class="cell-switch">
              <Switch
                label=""
                ariaLabel={`Serve ${row.id} from ${names[entry.providerId] ?? entry.providerId}`}
                checked={entry.modelSwitch === "on"}
                onChange={(on) =>
                  change(() => api.setModelsEnabled([offeringKey(entry)], on), {
                    success: `${names[entry.providerId] ?? entry.providerId} ${on ? "serves" : "no longer serves"} ${entry.id}`,
                    failure: `Could not change ${entry.id}`,
                  })
                }
              />
            </td>
            <td />
          </tr>
        ))}
    </>
  );
}

// ── Provider drawer ─────────────────────────────────────────────────────

const STATE_TEXT: Record<ProviderState, (summary: ProviderSummary) => string> = {
  off: (summary) => `${summary.provider.name} is turned off. Its accounts stay signed in and keep reporting quota, but no requests go to it.`,
  "not-connected": (summary) => `No account has a ${summary.provider.name} credential yet. Add one to start using its models.`,
  "needs-sign-in": (summary) =>
    `${summary.provider.name} rejected the credential for ${summary.rejected.map((account) => masker.value.name(account.email)).join(", ")}. Sign in again with Add account; the account's other providers keep working.`,
  unavailable: (summary) => `No account can serve ${summary.provider.name} right now. Check the accounts below.`,
  healthy: (summary) => `${summary.canServe} of ${pluralize(summary.accounts.length, "account")} can serve ${summary.provider.name}.`,
};

function ProviderDetail({
  summary,
  state,
  onClose,
}: {
  summary: ProviderSummary;
  state: ModelCatalogResponse;
  onClose: () => void;
}): JSX.Element {
  const { provider } = summary;
  const meta = PROVIDER_STATE[summary.state];
  const models = state.models.filter((entry) => entry.providerId === provider.id);
  const m = masker.value;
  const discovers = models.some((entry) => entry.source === "discovered");

  return (
    <article class="account-detail provider-detail" aria-label={`${provider.name} details`}>
      <header class="drawer-head">
        <div class="drawer-title provider-detail-title">
          <ProviderMark id={provider.id} size="lg" />
          <div>
            <h2>{provider.name}</h2>
            <div class="drawer-sub">
              <span>{authLabel(provider.credentialKind)}</span>
              <span aria-hidden="true">·</span>
              <span>#{summary.rank + 1} in provider order</span>
            </div>
          </div>
        </div>
        <Button variant="ghost" icon="x" iconOnly onClick={onClose}>
          Close
        </Button>
      </header>

      <section class={`detail-status tone-${meta.tone}`}>
        <div class="detail-status-line">
          <Pill tone={meta.tone}>{meta.label}</Pill>
        </div>
        <p>{STATE_TEXT[summary.state](summary)}</p>
        <div class="detail-actions">
          {(summary.state === "needs-sign-in" || summary.state === "not-connected") && (
            <Button variant="primary" icon="login" onClick={openAddAccount}>
              {summary.state === "needs-sign-in" ? "Sign in again" : "Add account"}
            </Button>
          )}
          {summary.state !== "not-connected" && (
            <Button icon="plus" onClick={openAddAccount}>
              Add account
            </Button>
          )}
          {discovers && (
            <AsyncButton
              icon="refresh"
              onClick={() => change(() => api.refreshCatalog(), { success: "Model lists refreshed", failure: "Could not refresh the model lists" })}
            >
              Refresh model list
            </AsyncButton>
          )}
        </div>
      </section>

      <section class="detail-section">
        <Switch
          label={`Route traffic to ${provider.name}`}
          checked={provider.enabled}
          onChange={(on) =>
            change(() => api.setProviderEnabled(provider.id, on), {
              success: on ? `${provider.name} is routing traffic again` : `${provider.name} turned off. Its accounts stay signed in.`,
              failure: `Could not turn ${provider.name} ${on ? "on" : "off"}`,
            })
          }
          description={`When off, no requests go to ${provider.name}. Accounts stay signed in and quota keeps updating. Models only ${provider.name} lists leave the model list; a model another provider also lists moves to that provider.`}
        />
      </section>

      <section class="detail-section">
        <div class="section-head">
          <h3>Accounts</h3>
          {summary.accounts.length > 0 && (
            <Link href={`${BASE}/accounts?provider=${encodeURIComponent(provider.id)}`} class="link-button">
              Open in Accounts
            </Link>
          )}
        </div>
        {summary.accounts.length === 0 ? (
          <p class="muted">No accounts yet.</p>
        ) : (
          <>
            <div class="panel panel-flush">
              <table class="table table-compact">
                <thead>
                  <tr>
                    <th scope="col">Account</th>
                    <th scope="col">Status</th>
                    <th scope="col" class="hide-sm">
                      Quota
                    </th>
                    <th scope="col">Use for {providerLabel(provider.id)}</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.accounts.map((account) => {
                    const off = isTurnedOffForAccount(account, provider.id);
                    const rejected = Boolean(account.invalidProviders?.[provider.id]);
                    const others = account.provider.split("+").filter((id) => id && id !== provider.id);
                    const quotas = providerQuotaRows(account, provider.id);
                    return (
                      <tr key={account.id ?? account.email} class={off ? "is-inactive" : undefined}>
                        <th scope="row">
                          <Link href={accountPath(account.email)} class="account-link">
                            {m.name(account.email)}
                          </Link>
                          {others.length > 0 && <div class="cell-sub">also {others.map(providerLabel).join(", ")}</div>}
                        </th>
                        <td>
                          {rejected ? <Pill tone="bad">Sign-in needed</Pill> : off ? <Pill tone="muted">Off for {providerLabel(provider.id)}</Pill> : <StatusPill status={account.status} />}
                        </td>
                        <td class="hide-sm">
                          {quotas.length === 0 ? (
                            <span class="muted">—</span>
                          ) : (
                            <div class="quota-mini">
                              {quotas.slice(0, 2).map((quota) => (
                                <div class="quota-mini-row" key={quota.modelKey}>
                                  <span class="truncate">{quota.displayName || quotaPoolLabel(quota.modelKey)}</span>
                                  <Meter value={quota.percentRemaining} label={`${quota.displayName} quota remaining`} size="sm" />
                                  <span class="num">{Math.round(quota.percentRemaining)}%</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </td>
                        <td class="cell-switch">
                          <Switch
                            label=""
                            ariaLabel={`Use ${m.name(account.email)} for ${provider.name}`}
                            checked={!off}
                            onChange={(on) =>
                              change(() => api.setAccountProviderEnabled(account.id ?? account.email, provider.id, on), {
                                success: `${provider.name} turned ${on ? "on" : "off"} for ${m.name(account.email)}`,
                                failure: `Could not change ${m.name(account.email)}`,
                              })
                            }
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p class="section-note">
              This switch only affects {provider.name}. To take a whole account out of service, disable it on the Accounts page.
              {summary.accounts.some((account) => !canServeProvider(account, provider.id, now.value, {
                quotaPools: models.map((entry) => entry.quotaPool),
                diagnostics: overview.value?.routingDiagnostics ?? {},
              }) && !isTurnedOffForAccount(account, provider.id)) &&
                " Accounts that are cooling down or disabled come back on their own or from the Accounts page."}
            </p>
          </>
        )}
      </section>

      <section class="detail-section">
        <div class="section-head">
          <h3>Models</h3>
          <span class="muted">
            {models.filter(isServed).length} of {models.length} on
          </span>
        </div>
        {models.length === 0 ? (
          <p class="muted">{provider.name} has not listed any models yet.</p>
        ) : (
          <div class="panel panel-flush">
            <table class="table table-compact">
              <tbody>
                {models.map((entry) => (
                  <tr key={entry.id} class={isServed(entry) ? undefined : "is-inactive"}>
                    <th scope="row">
                      <span class="model-id">{entry.id}</span>
                      {entry.modelSwitch === "review" && <span class="tag tag-info">Waiting for review</span>}
                      {entry.modelSwitch === "off" && <span class="tag">Off</span>}
                    </th>
                    <td class="muted num">{formatContextWindow(entry.contextWindow)}</td>
                    <td class="cell-switch">
                      <Switch
                        label=""
                        ariaLabel={`Serve ${entry.id} from ${provider.name}`}
                        checked={entry.modelSwitch === "on"}
                        onChange={(on) =>
                          change(() => api.setModelsEnabled([offeringKey(entry)], on), {
                            success: `${entry.id} turned ${on ? "on" : "off"}`,
                            failure: `Could not change ${entry.id}`,
                          })
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </article>
  );
}
