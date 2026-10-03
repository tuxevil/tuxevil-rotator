// Requests: one place for traffic. "Live" is the in-memory tail streamed
// from the rotator (with rotator/proxy events interleaved); "History" is
// the persisted spend log in PostgreSQL with payloads and per-key totals.

import { Fragment, type ComponentChildren, type JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { SpendLog, VirtualKey } from "../../types.js";
import type { LiveEvent, LiveRequest } from "../../dashboard-types.js";
import { modelColor } from "../lib/colors.js";
import { formatClockSeconds, formatCompact, formatCount, formatDateTime, formatMs, formatUsd, pluralize } from "../lib/format.js";
import { localDayKey } from "../lib/usage.js";
import { api, type SpendByKeyRow, type SpendSummary } from "../state/api.js";
import { query, setQuery } from "../state/router.js";
import { liveEvents, liveRequests, masker, overview } from "../state/store.js";
import { readPref, writePref } from "../state/prefs.js";
import { toast } from "../state/actions.js";
import { Icon } from "../components/icons.js";
import {
  Button,
  EmptyState,
  PageHeader,
  Pill,
  SearchInput,
  Segmented,
  Spinner,
  Stat,
} from "../components/ui.js";
import { copyText } from "./shared.js";

type View = "live" | "history";

export function RequestsPage(): JSX.Element {
  const view: View = query.value.get("view") === "history" ? "history" : "live";
  return (
    <>
      <PageHeader
        title="Requests"
        description={
          view === "live"
            ? "The latest requests and rotator events, streamed as they happen."
            : "Stored request history with token counts, cost and payloads."
        }
        actions={
          <Segmented
            label="Request view"
            value={view}
            onChange={(next) => setQuery({ view: next === "live" ? null : next, status: null, q: null, page: null })}
            options={[
              { value: "live", label: "Live" },
              { value: "history", label: "History" },
            ]}
          />
        }
      />
      {view === "live" ? <LiveView /> : <HistoryView />}
    </>
  );
}

// ── Live ────────────────────────────────────────────────────────────────

type LiveRow = { kind: "request"; ts: number; id: string; request: LiveRequest } | { kind: "event"; ts: number; id: string; event: LiveEvent };

function LiveView(): JSX.Element {
  const params = query.value;
  const status = params.get("status") ?? "all";
  const search = params.get("q") ?? "";
  const [showEvents, setShowEvents] = useState(() => readPref("rotatorLiveEvents", "1") === "1");
  const [paused, setPaused] = useState<{ requests: LiveRequest[]; events: LiveEvent[] } | null>(null);
  const requests = paused?.requests ?? liveRequests.value;
  const events = paused?.events ?? liveEvents.value;
  const newestPaused = paused?.requests[0]?.id ?? 0;
  const pendingCount = paused ? liveRequests.value.filter((r) => r.id > newestPaused).length : 0;
  const m = masker.value;

  const rows = useMemo<LiveRow[]>(() => {
    const q = search.trim().toLowerCase();
    const reqRows: LiveRow[] = requests
      .filter((r) => (status === "errors" ? r.statusCode >= 400 : status === "ok" ? r.statusCode < 400 : true))
      .filter((r) => !q || `${r.model} ${m.name(r.account)} ${m.enabled ? "" : r.account} ${r.statusCode}`.toLowerCase().includes(q))
      .map((r) => ({ kind: "request", ts: r.timestamp, id: `r${r.id}`, request: r }));
    const eventRows: LiveRow[] = showEvents
      ? events
          .filter((e) => (status === "errors" ? e.level === "error" : status === "ok" ? false : true))
          .filter((e) => !q || m.text(e.message).toLowerCase().includes(q))
          .map((e) => ({ kind: "event", ts: e.timestamp, id: `e${e.id}`, event: e }))
      : [];
    return [...reqRows, ...eventRows].sort((a, b) => b.ts - a.ts);
  }, [requests, events, status, search, showEvents, m]);

  return (
    <>
      <div class="toolbar">
        <Segmented
          label="Filter by outcome"
          size="sm"
          value={status}
          onChange={(value) => setQuery({ status: value === "all" ? null : value })}
          options={[
            { value: "all", label: "All" },
            { value: "errors", label: "Errors" },
            { value: "ok", label: "Successful" },
          ]}
        />
        <div class="toolbar-right">
          <label class="checkbox">
            <input
              type="checkbox"
              checked={showEvents}
              onChange={(event) => {
                const next = (event.target as HTMLInputElement).checked;
                setShowEvents(next);
                writePref("rotatorLiveEvents", next ? "1" : "0");
              }}
            />
            Rotator events
          </label>
          <span data-page-search>
            <SearchInput value={search} onInput={(v) => setQuery({ q: v || null })} placeholder="Model, account, status" label="Search requests" shortcut="/" />
          </span>
          <Button
            icon={paused ? "play" : "pause"}
            onClick={() => setPaused(paused ? null : { requests: liveRequests.value, events: liveEvents.value })}
          >
            {paused ? `Resume${pendingCount > 0 ? ` (${pendingCount} new)` : ""}` : "Pause"}
          </Button>
        </div>
      </div>
      <div class="panel panel-flush">
        {rows.length === 0 ? (
          <EmptyState icon="requests" title={requests.length === 0 ? "No requests since the rotator started" : "Nothing matches these filters"}>
            {requests.length === 0 ? "Requests appear here as soon as a client sends one." : undefined}
          </EmptyState>
        ) : (
          <div class="table-scroll">
            <table class="table live-table">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Status</th>
                  <th scope="col">Model</th>
                  <th scope="col">Account</th>
                  <th scope="col" class="num-col hide-sm">First byte</th>
                  <th scope="col" class="num-col">Total</th>
                  <th scope="col" class="num-col hide-sm">Tokens in / out</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) =>
                  row.kind === "request" ? (
                    <tr key={row.id}>
                      <td class="num muted">{formatClockSeconds(row.ts)}</td>
                      <td>
                        <Pill tone={row.request.statusCode < 400 ? "ok" : row.request.statusCode === 429 ? "warn" : "bad"}>{row.request.statusCode}</Pill>
                      </td>
                      <td>
                        <span class="swatch" style={{ background: modelColor(row.request.model) }} /> {row.request.model}
                      </td>
                      <td>
                        <span class="truncate cell-name" title={m.name(row.request.account)}>
                          {m.name(row.request.account)}
                        </span>
                      </td>
                      <td class="num num-col hide-sm">{formatMs(row.request.ttfbMs)}</td>
                      <td class="num num-col">{formatMs(row.request.totalMs)}</td>
                      <td class="num num-col hide-sm">
                        {row.request.inputTokens || row.request.outputTokens
                          ? `${formatCompact(row.request.inputTokens)} / ${formatCompact(row.request.outputTokens)}`
                          : "—"}
                      </td>
                    </tr>
                  ) : (
                    <tr key={row.id} class={`event-row level-${row.event.level}`}>
                      <td class="num muted">{formatClockSeconds(row.ts)}</td>
                      <td>
                        <Pill tone={row.event.level === "error" ? "bad" : row.event.level === "warn" ? "warn" : "muted"} dot={false}>
                          {row.event.source === "proxy" ? "Proxy" : "Rotator"}
                        </Pill>
                      </td>
                      <td colSpan={5} class="event-message">
                        {m.text(row.event.message)}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p class="table-foot">
        The live tail keeps the last {liveRequests.value.length >= 200 ? 200 : pluralize(liveRequests.value.length, "request")} in memory.
        {overview.value?.capabilities.database ? " Older requests are in History." : " Configure PostgreSQL to keep a full history."}
      </p>
    </>
  );
}

// ── History ─────────────────────────────────────────────────────────────

const PAGE_SIZE = 25;

function HistoryView(): JSX.Element {
  if (!overview.value?.capabilities.database) {
    return (
      <div class="panel">
        <EmptyState icon="requests" title="Request history needs PostgreSQL">
          The live tail above is kept in memory only. Set <code>DATABASE_URL</code> to store every request with its tokens,
          cost and payloads, and to use virtual keys. See docs/deployment.md.
        </EmptyState>
      </div>
    );
  }
  return <HistoryBrowser />;
}

interface HistoryFilters {
  from: string;
  to: string;
  status: string;
  keys: string[];
  models: string[];
}

function HistoryBrowser(): JSX.Element {
  const params = query.value;
  const filters: HistoryFilters = {
    from: params.get("from") ?? localDayKey(Date.now()),
    to: params.get("to") ?? localDayKey(Date.now()),
    status: params.get("status") ?? "",
    keys: (params.get("keys") ?? "").split(",").filter(Boolean),
    models: (params.get("models") ?? "").split(",").filter(Boolean),
  };
  const page = Math.max(0, Number(params.get("page") ?? 0) || 0);
  const tab = params.get("tab") === "keys" ? "keys" : "requests";
  const [refreshSec, setRefreshSec] = useState(() => Number(readPref("rotatorAutoRefreshSec", "0")) || 0);
  const [result, setResult] = useState<{ logs: SpendLog[]; total: number; summary: SpendSummary } | null>(null);
  const [byKey, setByKey] = useState<SpendByKeyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const filterKey = JSON.stringify(filters);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const q = {
      keyHash: filters.keys.join(",") || undefined,
      model: filters.models.join(",") || undefined,
      status: filters.status || undefined,
      startDate: filters.from || undefined,
      endDate: filters.to || undefined,
    };
    Promise.all([api.spendLogs({ ...q, limit: PAGE_SIZE, offset: page * PAGE_SIZE }), api.spendByKey(q)])
      .then(([logs, keys]) => {
        if (cancelled) return;
        setResult(logs);
        setByKey(keys.byKey);
        setError(null);
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [filterKey, page, tick]);

  useEffect(() => {
    if (!refreshSec) return;
    const timer = setInterval(() => setTick((t) => t + 1), refreshSec * 1000);
    return () => clearInterval(timer);
  }, [refreshSec]);

  const set = (patch: Record<string, string | null>) => setQuery({ ...patch, page: null });
  const summary = result?.summary;
  const pages = Math.ceil((result?.total ?? 0) / PAGE_SIZE);

  return (
    <>
      <div class="toolbar toolbar-wrap">
        <div class="field-inline">
          <label>
            <span class="field-label">From</span>
            <input class="input" type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => set({ from: (e.target as HTMLInputElement).value || null })} />
          </label>
          <label>
            <span class="field-label">To</span>
            <input class="input" type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => set({ to: (e.target as HTMLInputElement).value || null })} />
          </label>
          <label>
            <span class="field-label">Outcome</span>
            <select class="select" value={filters.status} onChange={(e) => set({ status: (e.target as HTMLSelectElement).value || null })}>
              <option value="">All</option>
              <option value="success">Successful</option>
              <option value="failure">Failed</option>
            </select>
          </label>
          <KeyFilter selected={filters.keys} onChange={(keys) => set({ keys: keys.join(",") || null })} />
          <ModelFilter selected={filters.models} onChange={(models) => set({ models: models.join(",") || null })} />
        </div>
        <div class="toolbar-right">
          <label>
            <span class="sr-only">Auto refresh</span>
            <select
              class="select"
              value={String(refreshSec)}
              onChange={(e) => {
                const next = Number((e.target as HTMLSelectElement).value) || 0;
                setRefreshSec(next);
                writePref("rotatorAutoRefreshSec", String(next));
              }}
            >
              <option value="0">Auto-refresh off</option>
              <option value="10">Every 10s</option>
              <option value="30">Every 30s</option>
              <option value="60">Every minute</option>
            </select>
          </label>
          <Button icon="refresh" loading={loading} onClick={() => setTick((t) => t + 1)}>
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div class="callout tone-bad">
          <Icon name="critical" size={16} />
          <div>Could not load history: {error}</div>
        </div>
      )}

      <div class="stats stats-card">
        <Stat label="Requests" value={summary ? formatCount(summary.totalRequests) : "—"} />
        <Stat label="Prompt tokens" value={summary ? formatCompact(summary.promptTokens) : "—"} />
        <Stat label="Completion tokens" value={summary ? formatCompact(summary.completionTokens) : "—"} />
        <Stat label="List-price value" value={summary ? formatUsd(summary.totalCost) : "—"} sub="Served free through the rotator" tone="ok" />
        <Stat label="Avg duration" value={summary?.avgLatencyMs ? formatMs(summary.avgLatencyMs) : "—"} />
      </div>

      <div class="tabs" role="tablist" aria-label="History views">
        <button type="button" role="tab" aria-selected={tab === "requests"} class={tab === "requests" ? "is-active" : undefined} onClick={() => setQuery({ tab: null })}>
          Requests {result && <span class="tab-count num">{formatCount(result.total)}</span>}
        </button>
        <button type="button" role="tab" aria-selected={tab === "keys"} class={tab === "keys" ? "is-active" : undefined} onClick={() => setQuery({ tab: "keys" })}>
          By key {byKey && <span class="tab-count num">{byKey.length}</span>}
        </button>
      </div>

      {tab === "requests" ? (
        <div class="panel panel-flush">
          {!result ? (
            <div class="panel-loading">
              <Spinner />
            </div>
          ) : result.logs.length === 0 ? (
            <EmptyState icon="search" title="No requests in this window" />
          ) : (
            <HistoryTable logs={result.logs} />
          )}
          {pages > 1 && (
            <div class="pager">
              <span class="muted num">
                Page {page + 1} of {pages}
              </span>
              <Button size="sm" icon="chevronLeft" disabled={page === 0} onClick={() => setQuery({ page: page - 1 > 0 ? String(page - 1) : null })}>
                Previous
              </Button>
              <Button size="sm" disabled={page >= pages - 1} onClick={() => setQuery({ page: String(page + 1) })}>
                Next
              </Button>
            </div>
          )}
        </div>
      ) : (
        <ByKeyTable rows={byKey} />
      )}
    </>
  );
}

function keyDisplay(row: { keyAlias?: string | null; keyName?: string | null; apiKeyHash?: string | null }): string {
  return row.keyAlias || row.keyName || (row.apiKeyHash && row.apiKeyHash !== "unauthenticated" ? `${row.apiKeyHash.slice(0, 10)}…` : "No key");
}

function HistoryTable({ logs }: { logs: SpendLog[] }): JSX.Element {
  const [open, setOpen] = useState<string | null>(null);
  const m = masker.value;
  return (
    <div class="table-scroll">
      <table class="table history-table">
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Key</th>
            <th scope="col">Model</th>
            <th scope="col">Status</th>
            <th scope="col" class="num-col">Tokens in / out</th>
            <th scope="col" class="num-col hide-sm">Value</th>
            <th scope="col" class="num-col hide-sm">Duration</th>
            <th scope="col">
              <span class="sr-only">Details</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {logs.map((log) => {
            const expanded = open === log.requestId;
            return (
              <Fragment key={log.requestId}>
                <tr class={`history-row${expanded ? " is-open" : ""}`} onClick={() => setOpen(expanded ? null : log.requestId)}>
                  <td class="num muted" title={log.createdAt ? new Date(log.createdAt).toLocaleString() : undefined}>
                    {log.createdAt ? formatDateTime(Date.parse(log.createdAt)) : "—"}
                  </td>
                  <td>
                    <span class="truncate cell-name" title={m.key(keyDisplay(log))}>
                      {m.key(keyDisplay(log))}
                    </span>
                  </td>
                  <td>
                    <span class="swatch" style={{ background: modelColor(log.model) }} /> {log.model}
                  </td>
                  <td>
                    <Pill tone={log.status === "success" ? "ok" : "bad"}>{log.status === "success" ? "OK" : "Failed"}</Pill>
                  </td>
                  <td class="num num-col">
                    {formatCount(log.promptTokens)} / {formatCount(log.completionTokens)}
                  </td>
                  <td class="num num-col hide-sm">{formatUsd(log.cost)}</td>
                  <td class="num num-col hide-sm">{formatMs(log.durationMs)}</td>
                  <td class="cell-action">
                    <Button
                      size="sm"
                      variant="ghost"
                      iconOnly
                      icon={expanded ? "chevronDown" : "chevronRight"}
                      aria-expanded={expanded}
                      onClick={(event) => {
                        event.stopPropagation();
                        setOpen(expanded ? null : log.requestId);
                      }}
                    >
                      {expanded ? "Hide details" : "Show details"}
                    </Button>
                  </td>
                </tr>
                {expanded && (
                  <tr class="history-detail">
                    <td colSpan={8}>
                      <RequestInspector log={log} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RequestInspector({ log }: { log: SpendLog }): JSX.Element {
  const [tab, setTab] = useState<"request" | "response" | "metadata">("request");
  const m = masker.value;
  const payload = tab === "request" ? log.requestMessages : tab === "response" ? log.responseContent : log.metadata;
  const text = payload === undefined || payload === null ? "" : typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return (
    <div class="inspector">
      <div class="inspector-meta">
        <span>
          Request <code>{log.requestId}</code>
        </span>
        <span>Account {m.name(log.accountEmail || "") || "unknown"}</span>
        <span>Call type {log.callType || "native"}</span>
        <span>First byte {formatMs(log.ttfbMs ?? null)}</span>
        {log.requesterIp && <span>IP {m.ip(log.requesterIp)}</span>}
      </div>
      <div class="tabs tabs-sm" role="tablist" aria-label="Payload">
        {(["request", "response", "metadata"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} class={tab === t ? "is-active" : undefined} onClick={() => setTab(t)}>
            {t === "request" ? "Request" : t === "response" ? "Response" : "Metadata"}
          </button>
        ))}
        <span class="tabs-spacer" />
        <Button
          size="sm"
          variant="ghost"
          icon="copy"
          disabled={!text}
          onClick={async () => toast((await copyText(text)) ? "Copied to the clipboard" : "Copy failed", "info")}
        >
          Copy
        </Button>
      </div>
      {text ? <pre class="code">{m.enabled ? m.text(text) : text}</pre> : <p class="muted">Nothing recorded.</p>}
    </div>
  );
}

function ByKeyTable({ rows }: { rows: SpendByKeyRow[] | null }): JSX.Element {
  const m = masker.value;
  if (!rows)
    return (
      <div class="panel panel-loading">
        <Spinner />
      </div>
    );
  if (rows.length === 0)
    return (
      <div class="panel">
        <EmptyState icon="keys" title="No requests in this window" />
      </div>
    );
  return (
    <div class="panel panel-flush">
      <div class="table-scroll">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Key</th>
              <th scope="col" class="num-col">Requests</th>
              <th scope="col" class="num-col">Prompt</th>
              <th scope="col" class="num-col">Completion</th>
              <th scope="col" class="num-col hide-sm">Value</th>
              <th scope="col" class="num-col hide-sm">Avg duration</th>
              <th scope="col" class="hide-sm">Last request</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.apiKeyHash}>
                <td>{m.key(keyDisplay(row))}</td>
                <td class="num num-col">{formatCount(row.totalRequests)}</td>
                <td class="num num-col">{formatCompact(row.totalPromptTokens)}</td>
                <td class="num num-col">{formatCompact(row.totalCompletionTokens)}</td>
                <td class="num num-col hide-sm">{formatUsd(row.totalCost)}</td>
                <td class="num num-col hide-sm">{formatMs(row.avgDurationMs)}</td>
                <td class="hide-sm muted">{row.lastSeen ? new Date(row.lastSeen).toLocaleString() : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Multi-select filters ────────────────────────────────────────────────

function KeyFilter({ selected, onChange }: { selected: string[]; onChange: (values: string[]) => void }): JSX.Element {
  const [keys, setKeys] = useState<VirtualKey[] | null>(null);
  useEffect(() => {
    api.keys().then((r) => setKeys(r.keys), () => setKeys([]));
  }, []);
  const m = masker.value;
  const options = [
    { value: "unauthenticated", label: "No key" },
    ...(keys ?? []).map((k) => ({ value: k.tokenHash, label: m.key(k.keyAlias || k.keyName) })),
  ];
  return <MultiSelect label="Keys" allLabel="All keys" options={options} selected={selected} onChange={onChange} />;
}

function ModelFilter({ selected, onChange }: { selected: string[]; onChange: (values: string[]) => void }): JSX.Element {
  const [models, setModels] = useState<string[]>([]);
  useEffect(() => {
    api.models().then(
      (r) => setModels([...new Set(r.data.map((m) => m.id))].sort()),
      () => setModels([]),
    );
  }, []);
  return <MultiSelect label="Models" allLabel="All models" options={models.map((m) => ({ value: m, label: m }))} selected={selected} onChange={onChange} />;
}

function MultiSelect({
  label,
  allLabel,
  options,
  selected,
  onChange,
}: {
  label: string;
  allLabel: string;
  options: Array<{ value: string; label: string }>;
  selected: string[];
  onChange: (values: string[]) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const summary: ComponentChildren =
    selected.length === 0
      ? allLabel
      : selected.length === 1
        ? options.find((o) => o.value === selected[0])?.label ?? selected[0]
        : `${selected.length} selected`;
  const visible = options.filter((o) => !filter || o.label.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div class="multiselect" ref={ref}>
      <span class="field-label">{label}</span>
      <button type="button" class="select multiselect-trigger" aria-expanded={open} aria-haspopup="listbox" onClick={() => setOpen(!open)}>
        <span class="truncate">{summary}</span>
      </button>
      {open && (
        <div class="multiselect-pop" role="listbox" aria-multiselectable="true" aria-label={label}>
          <input class="input input-sm" placeholder={`Filter ${label.toLowerCase()}`} value={filter} autofocus onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
          <div class="multiselect-options">
            {visible.length === 0 && <div class="muted multiselect-empty">No matches</div>}
            {visible.map((option) => {
              const checked = selected.includes(option.value);
              return (
                <label key={option.value} class="multiselect-option">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onChange(checked ? selected.filter((v) => v !== option.value) : [...selected, option.value])}
                  />
                  <span class="truncate">{option.label}</span>
                </label>
              );
            })}
          </div>
          {selected.length > 0 && (
            <button type="button" class="link-button" onClick={() => onChange([])}>
              Clear selection
            </button>
          )}
        </div>
      )}
    </div>
  );
}
