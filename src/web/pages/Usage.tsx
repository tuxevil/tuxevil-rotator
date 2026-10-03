// Usage: token volume by model, estimated savings, latency and the hourly
// activity heatmap. History is fetched per range instead of streamed.

import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ActivityResponse, UsageRange, UsageResponse } from "../../dashboard-types.js";
import { USAGE_RANGES } from "../../dashboard-types.js";
import { modelColor } from "../lib/colors.js";
import { formatCompact, formatCount, formatMs, formatUsd, pluralize } from "../lib/format.js";
import {
  aggregateBars,
  barTitle,
  buildHeatmap,
  computeSavings,
  formatAxisTokens,
  LEGACY_RANGES,
  modelTokenTotals,
  RANGE_SPECS,
  summarizeBars,
} from "../lib/usage.js";
import { api } from "../state/api.js";
import { query, setQuery } from "../state/router.js";
import { now, overview } from "../state/store.js";
import { readPref, writePref } from "../state/prefs.js";
import { Heatmap, TokenChart } from "../components/charts.js";
import { Button, EmptyState, PageHeader, Panel, Segmented, Spinner, Stat } from "../components/ui.js";
import { downloadUrl } from "./shared.js";

function isRange(value: string | null): value is UsageRange {
  return (USAGE_RANGES as readonly string[]).includes(value ?? "");
}

export function UsagePage(): JSX.Element {
  const param = query.value.get("range");
  const range: UsageRange = isRange(param) ? param : (() => {
    const saved = readPref("rotatorTokenRange", "24h");
    return isRange(saved) ? saved : (LEGACY_RANGES[saved] ?? "24h");
  })();
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const totalRequests = overview.value?.usage.totalRequests ?? 0;
  const lastFetch = useRef(0);
  // The range on screen; null once unmounted. A response is dropped only when
  // it no longer matches, not whenever new traffic re-runs the effect.
  const shown = useRef<UsageRange | null>(range);
  shown.current = range;
  useEffect(
    () => () => {
      shown.current = null;
    },
    [],
  );

  useEffect(() => {
    writePref("rotatorTokenRange", range);
    setUsage(null);
    lastFetch.current = 0;
  }, [range]);

  // Refetch when new traffic arrives, at most every 10 seconds.
  useEffect(() => {
    const wait = Math.max(0, 10_000 - (Date.now() - lastFetch.current));
    const timer = setTimeout(() => {
      lastFetch.current = Date.now();
      setLoading(true);
      api
        .usage(range)
        .then((data) => {
          if (shown.current === range) {
            setUsage(data);
            setError(null);
          }
        })
        .catch((err) => shown.current === range && setError(err instanceof Error ? err.message : String(err)))
        .finally(() => shown.current === range && setLoading(false));
    }, usage ? wait : 0);
    return () => clearTimeout(timer);
  }, [range, totalRequests]);

  return (
    <>
      <PageHeader
        title="Usage"
        description="Token volume by model and what it would have cost at paid API list prices."
        actions={
          <>
            <Button icon="download" onClick={() => downloadUrl("/api/dashboard/usage/export?format=csv")}>
              CSV
            </Button>
            <Button icon="download" onClick={() => downloadUrl("/api/dashboard/usage/export?format=json")}>
              JSON
            </Button>
          </>
        }
      />
      <TokenUsagePanel range={range} usage={usage} error={error} loading={loading} />
      <div class="grid-2 grid-2-wide">
        <LatencyPanel usage={usage} />
        <SavingsPanel usage={usage} />
      </div>
      <ActivityPanel />
    </>
  );
}

function TokenUsagePanel({
  range,
  usage,
  error,
  loading,
}: {
  range: UsageRange;
  usage: UsageResponse | null;
  error: string | null;
  loading: boolean;
}): JSX.Element {
  const spec = RANGE_SPECS[range];
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [highlight, setHighlight] = useState<string | null>(null);
  const minute = Math.floor(now.value / 60_000);
  const nowMs = useMemo(() => Date.now(), [usage, minute]);

  const view = useMemo(() => {
    if (!usage) return null;
    const bars = aggregateBars(usage.buckets, spec, nowMs);
    const totals = modelTokenTotals(bars);
    const models = Object.keys(totals).sort((a, b) => totals[b] - totals[a] || a.localeCompare(b));
    const visible = models.filter((m) => !hidden.has(m));
    const summary = summarizeBars(bars, visible);
    const savings = computeSavings(bars, usage.pricing, new Set(visible));
    const allSavings = computeSavings(bars, usage.pricing);
    return { bars, totals, models, visible, summary, savings, allSavings };
  }, [usage, hidden, spec, nowMs]);

  const toggle = (model: string) => {
    const next = new Set(hidden);
    if (next.has(model)) next.delete(model);
    else next.add(model);
    setHidden(next);
    setHighlight(null);
  };

  return (
    <Panel
      title="Tokens"
      subtitle={`Tokens per ${spec.per}, ${spec.window}`}
      actions={
        <Segmented
          label="Time range"
          value={range}
          onChange={(value) => setQuery({ range: value })}
          options={USAGE_RANGES.map((r) => ({ value: r, label: r, title: `${RANGE_SPECS[r].window}, per ${RANGE_SPECS[r].per}` }))}
        />
      }
    >
      {error && !usage ? (
        <EmptyState icon="critical" title="Could not load usage">
          {error}
        </EmptyState>
      ) : !view ? (
        <div class="panel-loading">
          <Spinner />
        </div>
      ) : (
        <>
          <div class="stats">
            <Stat
              label="Tokens"
              value={formatAxisTokens(view.summary.inputTokens + view.summary.outputTokens)}
              sub={`${formatCompact(view.summary.inputTokens)} in · ${formatCompact(view.summary.outputTokens)} out`}
            />
            <Stat label="Requests" value={formatCount(view.summary.requests)} sub={spec.window} />
            <Stat
              label="Peak"
              value={view.summary.peak.bar ? formatAxisTokens(view.summary.peak.value) : "—"}
              sub={view.summary.peak.bar ? `per ${spec.per} · ${barTitle(view.summary.peak.bar, spec, nowMs)}` : "No traffic yet"}
            />
            <Stat label="Est. savings" value={formatUsd(view.savings.totalUsd)} sub="vs. paid API list prices" tone="ok" />
          </div>
          <TokenChart
            bars={view.bars}
            models={view.visible}
            range={spec}
            now={nowMs}
            highlight={highlight}
            ariaLabel={`Token usage, ${spec.window}: ${formatAxisTokens(view.summary.inputTokens + view.summary.outputTokens)} tokens across ${formatCount(view.summary.requests)} requests`}
          />
          <div class="legend" onPointerLeave={() => setHighlight(null)}>
            {view.models.length === 0 ? (
              <span class="muted">No traffic in the {spec.window}.</span>
            ) : (
              view.models.map((m) => {
                const off = hidden.has(m);
                return (
                  <button
                    key={m}
                    type="button"
                    class={`legend-item${off ? " is-off" : ""}`}
                    aria-pressed={!off}
                    title={off ? `Show ${m}` : `Hide ${m}`}
                    onClick={() => toggle(m)}
                    onPointerEnter={() => !off && setHighlight(m)}
                    onFocus={() => !off && setHighlight(m)}
                    onBlur={() => setHighlight(null)}
                  >
                    <span class="swatch" style={{ background: modelColor(m) }} />
                    <span class="legend-name">{m}</span>
                    <span class="legend-value num">{formatAxisTokens(view.totals[m])}</span>
                    {view.allSavings.byModel[m] > 0 && <span class="legend-savings num">{formatUsd(view.allSavings.byModel[m])}</span>}
                  </button>
                );
              })
            )}
          </div>
          <div class="usage-foot">
            {hidden.size > 0 && (
              <button type="button" class="link-button" onClick={() => setHidden(new Set())}>
                Show all {pluralize(view.models.length, "model")}
              </button>
            )}
            {usage && (
              <span class="muted">
                All time: {formatCompact(usage.allTime.inputTokens + usage.allTime.outputTokens)} tokens · {formatCount(usage.allTime.requests)} requests · {formatUsd(usage.allTime.savingsUsd)} saved
              </span>
            )}
            {loading && <Spinner />}
          </div>
        </>
      )}
    </Panel>
  );
}

function LatencyPanel({ usage }: { usage: UsageResponse | null }): JSX.Element {
  const rows = usage ? Object.entries(usage.latency).sort(([a], [b]) => a.localeCompare(b)) : [];
  return (
    <Panel title="Latency" subtitle="Last 200 requests per model." flush>
      {!usage ? (
        <div class="panel-loading">
          <Spinner />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState icon="clock" title="No requests measured yet" />
      ) : (
        <div class="table-scroll">
          <table class="table table-compact">
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col" class="num-col">First byte p50</th>
                <th scope="col" class="num-col">p95</th>
                <th scope="col" class="num-col">Total p50</th>
                <th scope="col" class="num-col">p95</th>
                <th scope="col" class="num-col hide-sm">Samples</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([model, s]) => (
                <tr key={model}>
                  <td>
                    <span class="swatch" style={{ background: modelColor(model) }} /> {model}
                  </td>
                  <td class="num num-col">{formatMs(s.ttfb.p50)}</td>
                  <td class={`num num-col${s.ttfb.p95 > 10_000 ? " tone-text-warn" : ""}`}>{formatMs(s.ttfb.p95)}</td>
                  <td class="num num-col">{formatMs(s.total.p50)}</td>
                  <td class={`num num-col${s.total.p95 > 30_000 ? " tone-text-warn" : ""}`}>{formatMs(s.total.p95)}</td>
                  <td class="num num-col hide-sm muted">{formatCount(s.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function SavingsPanel({ usage }: { usage: UsageResponse | null }): JSX.Element {
  // Same bars as the chart, so the margin the server adds for alignment is not counted.
  const bars = useMemo(() => (usage ? aggregateBars(usage.buckets, RANGE_SPECS[usage.range], Date.now()) : []), [usage]);
  const rows = useMemo(() => {
    if (!usage) return [];
    const savings = computeSavings(bars, usage.pricing);
    return Object.entries(savings.byModel)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
  }, [usage, bars]);
  const unpriced = useMemo(() => {
    if (!usage) return [];
    const models = new Set<string>();
    for (const bar of bars) for (const m of Object.keys(bar.byModel)) if (!usage.pricing[m]) models.add(m);
    return [...models];
  }, [usage, bars]);
  return (
    <Panel title="Savings by model" subtitle={usage ? `In the ${RANGE_SPECS[usage.range].window}, at paid API list prices.` : undefined} flush>
      {!usage ? (
        <div class="panel-loading">
          <Spinner />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState icon="usage" title="No priced traffic in this range" />
      ) : (
        <ul class="bar-list">
          {rows.map(([model, usd]) => (
            <li key={model}>
              <span class="bar-list-label">
                <span class="swatch" style={{ background: modelColor(model) }} />
                {model}
              </span>
              <span class="bar-list-track">
                <span class="bar-list-fill" style={{ width: `${Math.max(2, (usd / rows[0][1]) * 100)}%` }} />
              </span>
              <span class="num">{formatUsd(usd)}</span>
            </li>
          ))}
        </ul>
      )}
      {unpriced.length > 0 && <p class="panel-note">No list price for {unpriced.join(", ")}; not counted.</p>}
    </Panel>
  );
}

function ActivityPanel(): JSX.Element {
  const [activity, setActivity] = useState<ActivityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.activity().then(setActivity, (err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);
  const heatmap = useMemo(() => (activity ? buildHeatmap(activity.hours, activity.generatedAt) : null), [activity]);
  return (
    <Panel title="Activity" subtitle="Requests per hour over the last 60 days, in your local time.">
      {error ? (
        <EmptyState icon="critical" title="Could not load activity">
          {error}
        </EmptyState>
      ) : !heatmap ? (
        <div class="panel-loading">
          <Spinner />
        </div>
      ) : (
        <Heatmap days={heatmap.days} cells={heatmap.cells} max={heatmap.max} />
      )}
    </Panel>
  );
}
