// Overview: is routing working, how long will each model last, and what
// needs the operator. Model pools come first; accounts are one click away.

import type { JSX } from "preact";
import { useMemo, useState } from "preact/hooks";
import type { DashboardOverview } from "../../dashboard-types.js";
import { buildAttention, SEVERITY_ICON, SEVERITY_TONE, type AttentionAction, type AttentionItem } from "../lib/attention.js";
import { buildPools, type ModelPool } from "../lib/pools.js";
import { formatClock, formatCompact, formatCount, formatDuration, formatMs, pluralize } from "../lib/format.js";
import {
  canServe,
  isCooling,
  needsAttention,
  providerLabel,
  rejectionLabel,
  routingState,
  type Tone,
} from "../lib/status.js";
import { actions } from "../state/actions.js";
import { liveEvents, liveRequests, masker, now, overview } from "../state/store.js";
import { accountPath, BASE, navigate } from "../state/router.js";
import { Sparkline } from "../components/charts.js";
import { Icon } from "../components/icons.js";
import {
  AsyncButton,
  Button,
  Countdown,
  EmptyState,
  Link,
  Meter,
  PageHeader,
  Panel,
  Pill,
  RelativeTime,
  StatusPill,
  Switch,
  Tag,
} from "../components/ui.js";
import { openAddAccount } from "./shared.js";

export function OverviewPage(): JSX.Element {
  const data = overview.value!;
  const tickNow = now.value;
  const minuteNow = Math.floor(tickNow / 60_000);
  const pools = useMemo(() => buildPools(data, Date.now()), [data, minuteNow]);
  const attention = useMemo(
    () => buildAttention(data, Date.now(), masker.value.name),
    [data, masker.value, minuteNow],
  );

  return (
    <>
      <PageHeader
        title="Overview"
        description="Routing health, how long each model's quota will last, and what needs you."
        actions={
          <Button icon="plus" onClick={openAddAccount}>
            Add account
          </Button>
        }
      />
      <StatusHero data={data} attention={attention} />
      {attention.length > 0 && <AttentionPanel items={attention} />}
      <ModelsPanel pools={pools} />
      <div class="grid-2">
        <RecentProblems />
        <ControlsPanel data={data} />
      </div>
    </>
  );
}

function StatusHero({ data, attention }: { data: DashboardOverview; attention: AttentionItem[] }): JSX.Element {
  const state = routingState(data.routingHealth.state);
  const total = data.accounts.length;
  const serving = data.accounts.filter(canServe).length;
  const cooling = data.accounts.filter(isCooling).length;
  const issues = data.accounts.filter(needsAttention).length;
  const lastHour = data.traffic.reduce((sum, m) => sum + m.requests, 0);
  const lastHourTokens = data.traffic.reduce((sum, m) => sum + m.tokens, 0);
  const paused = data.protectivePause.until > now.value;
  const critical = attention.filter((i) => i.severity === "critical").length;
  const [hoverMinute, setHoverMinute] = useState<number | null>(null);
  const hovered = hoverMinute !== null ? data.traffic[hoverMinute] : undefined;

  if (total === 0) {
    return (
      <section class="hero tone-info" aria-label="Routing status">
        <div class="hero-top">
          <div class="hero-main">
            <span class="hero-eyebrow">Routing</span>
            <div class="hero-state">
              <span class="hero-dot" aria-hidden="true" />
              <h2>No accounts yet</h2>
            </div>
            <p class="hero-reason">
              Add a Google Antigravity, Ollama, OpenAI Codex or OpenCode Zen account and the rotator starts routing requests through it.
            </p>
            <div class="hero-cta">
              <Button variant="primary" icon="plus" onClick={openAddAccount}>
                Add account
              </Button>
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section class={`hero tone-${state.tone}`} aria-label="Routing status">
      <div class="hero-top">
        <div class="hero-main">
          <span class="hero-eyebrow">Routing</span>
          <div class="hero-state">
            <span class="hero-dot" aria-hidden="true" />
            <h2>{state.label}</h2>
          </div>
          <p class="hero-reason">{data.routingHealth.reason || state.description}</p>
        </div>
        <div class="hero-traffic">
          <div class="hero-traffic-head" aria-live="off">
            <span class="hero-traffic-label num">{hovered ? formatClock(hovered.start) : "Last hour"}</span>
            <span>
              <strong class="num">{formatCount(hovered ? hovered.requests : lastHour)}</strong>{" "}
              {hovered && hovered.requests === 1 ? "request" : "requests"}
            </span>
            <span class="muted num">{formatCompact(hovered ? hovered.tokens : lastHourTokens)} tokens</span>
          </div>
          <Sparkline
            values={data.traffic.map((m) => m.requests)}
            times={data.traffic.map((m) => m.start)}
            unit="requests"
            label={`Requests per minute over the last hour, ${formatCount(lastHour)} in total`}
            onHover={setHoverMinute}
          />
        </div>
      </div>
      <div class="hero-metrics">
        <Link href={`${BASE}/accounts?status=serving`} class="hero-metric">
          <span class="hero-metric-label">Can serve</span>
          <span class="hero-metric-value">
            {serving}
            <span class="hero-metric-of">/{total}</span>
          </span>
          <span class="hero-metric-sub">serving or ready</span>
        </Link>
        <Link href={`${BASE}/accounts?status=cooling`} class={`hero-metric${cooling === 0 ? " is-zero" : ""}`}>
          <span class="hero-metric-label">Cooling down</span>
          <span class="hero-metric-value">{cooling}</span>
          <span class="hero-metric-sub">back on their own</span>
        </Link>
        {issues > 0 || critical === 0 ? (
          <Link
            href={`${BASE}/accounts?status=attention`}
            class={`hero-metric${issues > 0 ? " tone-bad" : " is-zero"}`}
          >
            <span class="hero-metric-label">Need attention</span>
            <span class="hero-metric-value">{issues}</span>
            <span class="hero-metric-sub">{issues > 0 ? "accounts to check" : "every account is fine"}</span>
          </Link>
        ) : (
          <a href="#attention" class="hero-metric tone-bad">
            <span class="hero-metric-label">Critical</span>
            <span class="hero-metric-value">{critical}</span>
            <span class="hero-metric-sub">{critical === 1 ? "issue needs you" : "issues need you"}</span>
          </a>
        )}
        {paused ? (
          <div class="hero-metric tone-bad">
            <span class="hero-metric-label">Paused</span>
            <span class="hero-metric-value">
              <Countdown until={data.protectivePause.until} />
            </span>
            <span class="hero-metric-sub">protective pause</span>
          </div>
        ) : data.routingHealth.nextRetryAt && data.routingHealth.state !== "healthy" ? (
          <div class="hero-metric">
            <span class="hero-metric-label">Next retry</span>
            <span class="hero-metric-value">
              <Countdown until={data.routingHealth.nextRetryAt} />
            </span>
            <span class="hero-metric-sub">routing tries again</span>
          </div>
        ) : (
          <Link href={`${BASE}/requests`} class="hero-metric">
            <span class="hero-metric-label">Served</span>
            <span class="hero-metric-value">{formatCompact(data.totalRequestsAllAccounts)}</span>
            <span class="hero-metric-sub">requests served in total</span>
          </Link>
        )}
      </div>
    </section>
  );
}

function AttentionPanel({ items }: { items: AttentionItem[] }): JSX.Element {
  const [showNotes, setShowNotes] = useState(false);
  const urgent = items.filter((i) => i.severity !== "info");
  const notes = items.filter((i) => i.severity === "info");
  return (
    <Panel
      id="attention"
      title={urgent.length > 0 ? "Needs you" : "Notes"}
      subtitle={
        urgent.length > 0
          ? `${pluralize(urgent.length, "item")} to look at${notes.length ? `, plus ${pluralize(notes.length, "note")}` : ""}.`
          : "Nothing urgent. A few things worth knowing:"
      }
      flush
    >
      <ul class="attention-list">
        {(urgent.length > 0 ? urgent : notes).map((item) => (
          <AttentionRow key={item.id} item={item} />
        ))}
        {urgent.length > 0 && notes.length > 0 && (
          <>
            <li class="attention-toggle">
              <button type="button" class="link-button" aria-expanded={showNotes} onClick={() => setShowNotes(!showNotes)}>
                <Icon name={showNotes ? "chevronDown" : "chevronRight"} size={14} />
                {showNotes ? "Hide" : "Show"} {pluralize(notes.length, "note")}
              </button>
            </li>
            {showNotes && notes.map((item) => <AttentionRow key={item.id} item={item} />)}
          </>
        )}
      </ul>
    </Panel>
  );
}

function AttentionRow({ item }: { item: AttentionItem }): JSX.Element {
  return (
    <li class={`attention-item tone-${SEVERITY_TONE[item.severity]}`}>
      <span class="attention-icon">
        <Icon name={SEVERITY_ICON[item.severity]} size={18} />
      </span>
      <div class="attention-content">
        <div class="attention-title">
          <strong>{item.title}</strong>
          {item.until && item.until > now.value && (
            <span class="muted">
              · <Countdown until={item.until} /> left
            </span>
          )}
        </div>
        <p class="attention-detail">{masker.value.text(item.detail)}</p>
        {item.hint && <p class="attention-hint">{item.hint}</p>}
        {item.chips && item.chips.length > 0 && (
          <div class="chip-row">
            {item.chips.map((chip) => (
              <span key={chip.label} class={`chip tone-${chip.tone}`}>
                {chip.tone === "ok" && <Icon name="check" size={12} />}
                {chip.tone === "bad" && <Icon name="x" size={12} />}
                {chip.label}
              </span>
            ))}
          </div>
        )}
      </div>
      {item.actions.length > 0 && (
        <div class="attention-actions">
          {item.actions.map((action) => (
            <AttentionActionButton key={action.kind} action={action} />
          ))}
        </div>
      )}
    </li>
  );
}

function AttentionActionButton({ action }: { action: AttentionAction }): JSX.Element {
  switch (action.kind) {
    case "open-account":
      return (
        <Button size="sm" onClick={() => navigate(accountPath(action.email))}>
          Open
        </Button>
      );
    case "open-model":
      return (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => document.getElementById(`pool-${action.model}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
        >
          Inspect
        </Button>
      );
    case "enable":
      return (
        <AsyncButton size="sm" variant="primary" onClick={() => actions.enable(action.email)}>
          Re-enable
        </AsyncButton>
      );
    case "restore":
      return (
        <AsyncButton size="sm" variant="primary" onClick={() => actions.restore(action.email)}>
          Restore
        </AsyncButton>
      );
    case "disable":
      return (
        <AsyncButton size="sm" onClick={() => actions.disable(action.email)}>
          Disable
        </AsyncButton>
      );
    case "reset-breaker":
      return (
        <AsyncButton size="sm" variant="danger" onClick={() => actions.resetBreaker(action.model)}>
          {action.model ? "Reset breaker" : "Reset all"}
        </AsyncButton>
      );
  }
}

const POOL_STATE: Record<ModelPool["state"], { label: string; tone: Tone } | null> = {
  ok: null,
  low: { label: "Running low", tone: "warn" },
  empty: { label: "Empty", tone: "bad" },
  blocked: { label: "Blocked", tone: "bad" },
};

function estimateText(pool: ModelPool): { text: string; tone: Tone | null; title: string } {
  if (pool.burnPerHour <= 0 || pool.hoursLeft === null)
    return { text: "Idle", tone: null, title: "No requests for this pool in the last hour" };
  const hours = pool.hoursLeft;
  const label = hours >= 48 ? `${(hours / 24).toFixed(1)}d` : hours >= 1 ? `${hours.toFixed(1)}h` : `${Math.max(1, Math.round(hours * 60))}m`;
  return {
    text: `~${label}`,
    tone: hours < 1 ? "bad" : hours < 3 ? "warn" : null,
    title: `At ${pool.burnPerHour.toFixed(0)} requests/hour. Capacity is estimated from account tiers.`,
  };
}

function ModelsPanel({ pools }: { pools: ModelPool[] }): JSX.Element {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Panel
      title="Models"
      subtitle="Pooled quota per model across accounts that are in service, weighted by tier."
      flush
    >
      {pools.length === 0 ? (
        <EmptyState icon="accounts" title="No quota data yet">
          Model pools appear after the first quota poll of a connected account.
        </EmptyState>
      ) : (
        <div class="table-scroll">
          <table class="table pools-table">
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Remaining</th>
                <th scope="col">Serving</th>
                <th scope="col" class="hide-sm">Next up</th>
                <th scope="col">Next reset</th>
                <th scope="col" class="hide-sm">Lasts</th>
                <th scope="col">
                  <span class="sr-only">Details</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {pools.map((pool) => (
                <PoolRow key={pool.key} pool={pool} expanded={open === pool.key} onToggle={() => setOpen(open === pool.key ? null : pool.key)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function PoolRow({ pool, expanded, onToggle }: { pool: ModelPool; expanded: boolean; onToggle: () => void }): JSX.Element {
  const state = POOL_STATE[pool.state];
  const estimate = estimateText(pool);
  const name = masker.value.name;
  return (
    <>
      <tr id={`pool-${pool.key}`} class={`pool-row${expanded ? " is-open" : ""}`}>
        <th scope="row">
          <div class="pool-name">
            <span>{pool.name}</span>
            <Tag>{providerLabel(pool.provider)}</Tag>
          </div>
          {state && (
            <Pill tone={state.tone} title={pool.blockedReason ?? undefined}>
              {state.label}
            </Pill>
          )}
        </th>
        <td data-label="Remaining">
          <div class="pool-capacity">
            <Meter value={pool.capacity} label={`${pool.name} pooled quota remaining`} />
            <span class="num">{pool.capacity}%</span>
          </div>
          <div class="cell-sub">
            {pool.withQuota} of {pluralize(pool.members.length, "account")} with quota
          </div>
        </td>
        <td data-label="Serving">
          {pool.serving ? (
            <Link href={accountPath(pool.serving.email)} class="account-link">
              {name(pool.serving.email)}
            </Link>
          ) : pool.state === "blocked" ? (
            <span class="tone-text-bad" title={pool.blockedReason ?? undefined}>
              Nothing serving
            </span>
          ) : (
            <span class="muted" title="No account is serving this pool right now. The next request goes to the first account in Next up.">
              —
            </span>
          )}
          {pool.breakerUntil && (
            <div class="cell-sub tone-text-warn">
              <Icon name="zap" size={12} /> Breaker · <Countdown until={pool.breakerUntil} />
            </div>
          )}
        </td>
        <td class="hide-sm" data-label="Next up">
          {pool.nextUp.length === 0 ? (
            <span class="muted">—</span>
          ) : (
            pool.nextUp.map((a, i) => (
              <span key={a.email}>
                {i > 0 && ", "}
                <Link href={accountPath(a.email)} class="account-link subtle">
                  {name(a.email)}
                </Link>
              </span>
            ))
          )}
        </td>
        <td data-label="Next reset">
          <Countdown until={pool.nextResetAt} />
        </td>
        <td class={`hide-sm num${estimate.tone ? ` tone-text-${estimate.tone}` : ""}`} title={estimate.title} data-label="Lasts">
          {estimate.text}
        </td>
        <td class="cell-action">
          <Button size="sm" variant="ghost" icon={expanded ? "chevronDown" : "chevronRight"} iconOnly aria-expanded={expanded} onClick={onToggle}>
            {expanded ? "Hide routing decisions" : "Show routing decisions"}
          </Button>
        </td>
      </tr>
      {expanded && (
        <tr class="pool-detail">
          <td colSpan={7}>
            <RoutingDecisions pool={pool} />
          </td>
        </tr>
      )}
    </>
  );
}

function RoutingDecisions({ pool }: { pool: ModelPool }): JSX.Element {
  const diag = pool.diagnostics;
  if (!diag) return <p class="muted">No routing diagnostics for this pool yet.</p>;
  const name = masker.value.name;
  return (
    <div class="decisions">
      <p class="decisions-summary">
        <strong>{diag.policy}</strong> policy · {diag.availableCandidates} eligible · {diag.rejectedCandidates} rejected
        {diag.reason && <> · {masker.value.text(diag.reason)}</>}
      </p>
      <table class="table table-compact">
        <thead>
          <tr>
            <th scope="col">Account</th>
            <th scope="col">Status</th>
            <th scope="col">Quota</th>
            <th scope="col">Health</th>
            <th scope="col" class="hide-sm">Score</th>
            <th scope="col">Decision</th>
          </tr>
        </thead>
        <tbody>
          {diag.accounts.map((entry) => (
            <tr key={entry.email} class={entry.email === diag.selectedEmail ? "is-selected" : undefined}>
              <td>
                <Link href={accountPath(entry.email)} class="account-link">
                  {name(entry.email)}
                </Link>
              </td>
              <td>
                <StatusPill status={entry.status} />
              </td>
              <td class="num">{entry.quota === null ? "—" : `${entry.quota}%`}</td>
              <td class="num" title={`Quota ${Math.round(entry.healthBreakdown.quotaComponent * 100)}% · errors −${Math.round(entry.healthBreakdown.errorPenalty * 100)}% · cooldown −${Math.round(entry.healthBreakdown.cooldownPenalty * 100)}% · availability −${Math.round(entry.healthBreakdown.availabilityPenalty * 100)}%`}>
                {Math.round(entry.healthScore * 100)}%
              </td>
              <td class="num hide-sm">{entry.score === null ? "—" : entry.score.toFixed(1)}</td>
              <td>
                {entry.email === diag.selectedEmail ? (
                  <span class="tone-text-ok">Selected</span>
                ) : entry.rejectedReason ? (
                  <span class="muted" title={entry.rejectedDetail ?? undefined}>
                    {rejectionLabel(entry.rejectedReason)}
                  </span>
                ) : (
                  <span>Eligible</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RecentProblems(): JSX.Element {
  const requests = liveRequests.value.filter((r) => r.statusCode >= 400).slice(0, 6);
  const events = liveEvents.value.filter((e) => e.level === "error").slice(0, 6);
  const rows = [
    ...requests.map((r) => ({
      id: `r${r.id}`,
      ts: r.timestamp,
      title: `${r.statusCode} on ${r.model}`,
      detail: `${masker.value.name(r.account)} · ${formatMs(r.totalMs)}`,
    })),
    ...events.map((e) => ({
      id: `e${e.id}`,
      ts: e.timestamp,
      title: masker.value.text(e.message),
      detail: e.source === "proxy" ? "Proxy" : "Rotator",
    })),
  ]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 6);
  return (
    <Panel
      title="Recent problems"
      subtitle="Failed requests and error events since the rotator started."
      actions={
        <Link href={`${BASE}/requests?status=errors`} class="btn btn-ghost btn-sm">
          All requests <Icon name="chevronRight" size={14} />
        </Link>
      }
      flush
    >
      {rows.length === 0 ? (
        <EmptyState icon="checkCircle" title="No recent failures" />
      ) : (
        <ul class="problem-list">
          {rows.map((row) => (
            <li key={row.id}>
              <span class="problem-time">
                <RelativeTime ts={row.ts} />
              </span>
              <div>
                <div class="problem-title">{row.title}</div>
                <div class="cell-sub">{row.detail}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function ControlsPanel({ data }: { data: DashboardOverview }): JSX.Element {
  const controls = data.operatorControls;
  return (
    <Panel title="Controls" subtitle="Applied immediately to every account." actions={<Link href={`${BASE}/settings`} class="btn btn-ghost btn-sm">All settings <Icon name="chevronRight" size={14} /></Link>}>
      <div class="controls">
        <Switch
          label="Allow fresh windows"
          checked={controls.allowFreshWindowStarts}
          onChange={(on) => actions.setFreshWindows(on)}
          description={
            controls.allowFreshWindowStarts
              ? "The rotator may start an idle account's quota window when it is the best option."
              : "Idle windows are held back: running 5-hour and 7-day windows are used first and no new window starts."
          }
        />
        <Switch
          label="Auto-warmup"
          checked={controls.autoWarmupEnabled}
          onChange={(on) => actions.setAutoWarmup(on)}
          description={
            controls.autoWarmupEnabled
              ? "Accounts with the fresh-window override get a minimal request each quota poll to start their windows."
              : "Idle windows start only when you start them from an account."
          }
        />
        <div class="controls-meta">
          <span class="num">Up {formatDuration(now.value - data.startedAt)}</span>
          <span>Port {data.proxyPort}</span>
          <span>{formatCount(data.totalRequestsAllAccounts)} requests served</span>
        </div>
      </div>
    </Panel>
  );
}
