// Accounts: a card grid, or a dense sortable list. Filters, search, sort and
// the view live in the URL (the view is also remembered); clicking a card or
// row opens the account drawer at /dashboard/accounts/:email.

import type { JSX } from "preact";
import { memo } from "preact/compat";
import { useMemo } from "preact/hooks";
import type { DashboardAccount } from "../../dashboard-types.js";
import type { ModelQuota } from "../../types.js";
import {
  ACCOUNT_FILTERS,
  isAccountFilter,
  isAccountSortKey,
  matchesQuery,
  sortAccounts,
  type AccountFilter,
  type AccountSortKey,
} from "../lib/accounts.js";
import { formatCount, formatDuration, pluralize } from "../lib/format.js";
import {
  accountStatus,
  isKickstartable,
  isOutOfService,
  providerIds,
  providerLabel,
  providerRank,
  quotaProvider,
  tierLabel,
  TIMER_LABELS,
} from "../lib/status.js";
import { actions } from "../state/actions.js";
import { accounts, masked, masker, now, overview } from "../state/store.js";
import { readPref, writePref } from "../state/prefs.js";
import { accountPath, navigate, query, route, setQuery } from "../state/router.js";
import { Icon } from "../components/icons.js";
import { Menu, type MenuItem } from "../components/overlays.js";
import {
  AsyncButton,
  Button,
  Countdown,
  EmptyState,
  Link,
  Meter,
  PageHeader,
  RelativeTime,
  SearchInput,
  Segmented,
  StatusPill,
} from "../components/ui.js";
import { openAddAccount } from "./shared.js";

const COLUMNS: Array<{ key: AccountSortKey; label: string; class?: string; defaultDir: 1 | -1 }> = [
  { key: "name", label: "Account", defaultDir: 1 },
  { key: "status", label: "Status", defaultDir: 1 },
  { key: "quota", label: "Quota", defaultDir: -1 },
  { key: "health", label: "Health", class: "hide-md", defaultDir: -1 },
  { key: "requests", label: "Requests", class: "hide-md", defaultDir: -1 },
  { key: "lastUsed", label: "Last used", class: "hide-sm", defaultDir: -1 },
];

type AccountsView = "cards" | "list";

const CARD_QUOTAS = 4;

export function AccountsPage(): JSX.Element {
  const all = accounts.value;
  const params = query.value;
  const viewParam = params.get("view") ?? readPref("rotatorAccountsView", "cards");
  const view: AccountsView = viewParam === "list" ? "list" : "cards";
  const filterParam = params.get("status");
  const filter: AccountFilter = isAccountFilter(filterParam) ? filterParam : "all";
  const search = params.get("q") ?? "";
  const provider = params.get("provider") ?? "";
  const sortParam = params.get("sort");
  const sortKey: AccountSortKey = isAccountSortKey(sortParam) ? sortParam : "status";
  const dir: 1 | -1 = params.get("dir") === "desc" ? -1 : params.get("dir") === "asc" ? 1 : (COLUMNS.find((c) => c.key === sortKey)?.defaultDir ?? 1);
  const name = masker.value.name;

  const providers = useMemo(() => {
    const ids = new Set<string>();
    for (const a of all) for (const id of providerIds(a)) ids.add(id);
    return [...ids].sort((a, b) => providerRank(a) - providerRank(b));
  }, [all]);

  const visible = useMemo(() => {
    const match = ACCOUNT_FILTERS.find((f) => f.id === filter)!.match;
    const filtered = all.filter(
      (a) =>
        match(a) &&
        (!provider || providerIds(a).includes(provider)) &&
        matchesQuery(a, search, name(a.email), masked.value),
    );
    return sortAccounts(filtered, sortKey, dir, name);
  }, [all, filter, search, provider, sortKey, dir, masker.value]);

  const counts = ACCOUNT_FILTERS.map((f) => ({ ...f, count: all.filter(f.match).length }));
  const setSort = (key: AccountSortKey) => {
    const column = COLUMNS.find((c) => c.key === key)!;
    const nextDir = key === sortKey ? (dir === 1 ? -1 : 1) : column.defaultDir;
    setQuery({ sort: key, dir: nextDir === 1 ? "asc" : "desc" });
  };
  const selected = route.value.account;
  const setView = (next: AccountsView) => {
    writePref("rotatorAccountsView", next === "cards" ? null : next);
    setQuery({ view: next === "cards" ? null : next });
  };
  const maxConcurrent = overview.value?.maxConcurrentRequestsPerAccount ?? 5;

  return (
    <>
      <PageHeader
        title="Accounts"
        description={summary(all)}
        actions={
          <Button icon="plus" variant="primary" onClick={openAddAccount}>
            Add account
          </Button>
        }
      />
      <div class="toolbar">
        <div class="chips" role="group" aria-label="Filter by status">
          {counts.map((f) => (
            <button
              key={f.id}
              type="button"
              class={`filter-chip${filter === f.id ? " is-active" : ""}${f.id === "attention" && f.count > 0 ? " has-issues" : ""}`}
              aria-pressed={filter === f.id}
              onClick={() => setQuery({ status: f.id === "all" ? null : f.id })}
            >
              {f.label}
              <span class="filter-count num">{f.count}</span>
            </button>
          ))}
        </div>
        <div class="toolbar-right">
          {providers.length > 1 && (
            <select
              class="select"
              aria-label="Filter by provider"
              value={provider}
              onChange={(event) => setQuery({ provider: (event.target as HTMLSelectElement).value || null })}
            >
              <option value="">All providers</option>
              {providers.map((id) => (
                <option key={id} value={id}>
                  {providerLabel(id)}
                </option>
              ))}
            </select>
          )}
          {view === "cards" && (
            <span class="sort-control">
              <select
                class="select"
                aria-label="Sort accounts"
                value={sortKey}
                onChange={(event) => {
                  const key = (event.target as HTMLSelectElement).value as AccountSortKey;
                  const column = COLUMNS.find((c) => c.key === key)!;
                  setQuery({ sort: key, dir: column.defaultDir === 1 ? "asc" : "desc" });
                }}
              >
                {COLUMNS.map((column) => (
                  <option key={column.key} value={column.key}>
                    Sort by {column.label.toLowerCase()}
                  </option>
                ))}
              </select>
              <Button
                icon={dir === 1 ? "sortAsc" : "sortDesc"}
                iconOnly
                title={dir === 1 ? "Ascending" : "Descending"}
                onClick={() => setQuery({ sort: sortKey, dir: dir === 1 ? "desc" : "asc" })}
              >
                {dir === 1 ? "Sort descending" : "Sort ascending"}
              </Button>
            </span>
          )}
          <span data-page-search>
            <SearchInput value={search} onInput={(v) => setQuery({ q: v || null })} placeholder="Search accounts" label="Search accounts" shortcut="/" />
          </span>
          <Segmented
            label="Accounts view"
            class="segmented-icons"
            value={view}
            onChange={setView}
            options={[
              {
                value: "cards",
                title: "Cards",
                label: (
                  <>
                    <Icon name="layoutGrid" size={15} />
                    <span class="sr-only">Cards</span>
                  </>
                ),
              },
              {
                value: "list",
                title: "List",
                label: (
                  <>
                    <Icon name="rows" size={15} />
                    <span class="sr-only">List</span>
                  </>
                ),
              },
            ]}
          />
        </div>
      </div>

      {view === "cards" && visible.length > 0 ? (
        <div class="account-grid">
          {visible.map((account) => (
            <AccountCard
              key={account.email}
              account={account}
              displayName={name(account.email)}
              displayEmail={masker.value.email(account.email)}
              selected={selected === account.email}
              maxConcurrent={maxConcurrent}
            />
          ))}
        </div>
      ) : (
      <div class="panel panel-flush">
        {all.length === 0 ? (
          <EmptyState icon="accounts" title="No accounts yet" action={<Button icon="plus" variant="primary" onClick={openAddAccount}>Add account</Button>}>
            Sign in with a Google Antigravity, Ollama, Codex or OpenCode Zen account to start routing.
          </EmptyState>
        ) : visible.length === 0 ? (
          <EmptyState icon="search" title="No accounts match" action={<Button onClick={() => setQuery({ status: null, q: null, provider: null })}>Clear filters</Button>} />
        ) : (
          <div class="table-scroll">
            <table class="table accounts-table">
              <thead>
                <tr>
                  {COLUMNS.map((column) => (
                    <th
                      key={column.key}
                      scope="col"
                      class={column.class}
                      aria-sort={sortKey === column.key ? (dir === 1 ? "ascending" : "descending") : "none"}
                    >
                      <button type="button" class="th-sort" onClick={() => setSort(column.key)}>
                        {column.label}
                        <Icon name={sortKey === column.key ? (dir === 1 ? "sortAsc" : "sortDesc") : "sortNone"} size={12} />
                      </button>
                    </th>
                  ))}
                  <th scope="col">
                    <span class="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((account) => (
                  <AccountRow
                    key={account.email}
                    account={account}
                    displayName={name(account.email)}
                    displayEmail={masker.value.email(account.email)}
                    selected={selected === account.email}
                    maxConcurrent={maxConcurrent}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      )}
      {visible.length > 0 && visible.length !== all.length && (
        <p class="table-foot">
          Showing {visible.length} of {pluralize(all.length, "account")}.
        </p>
      )}
    </>
  );
}

function summary(all: DashboardAccount[]): string {
  if (all.length === 0) return "No accounts configured yet.";
  const parts = ACCOUNT_FILTERS.slice(1)
    .map((f) => ({ label: f.label.toLowerCase(), count: all.filter(f.match).length }))
    .filter((p) => p.count > 0)
    .map((p) => `${p.count} ${p.label}`);
  return [pluralize(all.length, "account"), ...parts].join(" · ");
}

export function accountMenuItems(account: DashboardAccount, options: { includeOpen?: boolean } = {}): MenuItem[] {
  const items: MenuItem[] = [];
  if (options.includeOpen) items.push({ label: "Open details", icon: "chevronRight", onSelect: () => navigate(accountPath(account.email)) });
  if (account.status === "disabled") items.push({ label: "Re-enable", icon: "play", onSelect: () => void actions.enable(account.email) });
  if (account.status === "flagged") items.push({ label: "Restore to rotation", icon: "play", onSelect: () => void actions.restore(account.email) });
  if (account.status !== "disabled") items.push({ label: "Disable", icon: "pause", onSelect: () => void actions.disable(account.email) });
  if (account.status !== "flagged") items.push({ label: "Quarantine", icon: "shield", onSelect: () => void actions.quarantine(account.email) });
  items.push(
    {
      label: account.allowFreshWindowStartsOverride ? "Follow global fresh-window policy" : "Always allow fresh windows",
      icon: "timer",
      onSelect: () => void actions.setFreshOverride(account.email, !account.allowFreshWindowStartsOverride),
    },
    "separator",
    { label: "Remove account…", icon: "trash", danger: true, onSelect: () => void actions.remove(account.email) },
  );
  return items;
}

const AccountRow = memo(function AccountRow({
  account,
  displayName,
  displayEmail,
  selected,
  maxConcurrent,
}: {
  account: DashboardAccount;
  displayName: string;
  displayEmail: string;
  selected: boolean;
  maxConcurrent: number;
}): JSX.Element {
  const href = accountPath(account.email);
  const pools = [...(account.quota || [])].sort((a, b) => providerRank(quotaProvider(a)) - providerRank(quotaProvider(b)));
  const inactive = isOutOfService(account);
  const health = Math.round((account.healthScore || 0) * 100);
  return (
    <tr
      class={`account-row${inactive ? " is-inactive" : ""}${selected ? " is-selected" : ""}`}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("a, button, .menu")) return;
        navigate(href);
      }}
    >
      <th scope="row">
        <Link href={href} class="account-name">
          {displayName}
        </Link>
        <div class="cell-sub">
          {displayEmail !== displayName && <span class="truncate">{displayEmail}</span>}
          <span class="cell-tags">
            {providerIds(account).map((id) => (
              <span key={id} class="tag">
                {providerLabel(id)}
              </span>
            ))}
          </span>
        </div>
      </th>
      <td>
        <StatusPill status={account.status} />
        <StatusDetail account={account} maxConcurrent={maxConcurrent} />
      </td>
      <td>
        {pools.length === 0 ? (
          <span class="muted">No data yet</span>
        ) : (
          <div class="mini-pools">
            {pools.slice(0, 3).map((q) => (
              <div key={q.modelKey} class="mini-pool" title={`${q.displayName}: ${q.percentRemaining}% left`}>
                <span class="mini-pool-name">{q.displayName}</span>
                <Meter value={q.percentRemaining} label={`${q.displayName} quota`} size="sm" />
                <span class="num">{q.percentRemaining}%</span>
              </div>
            ))}
            {pools.length > 3 && <span class="cell-sub">+{pools.length - 3} more</span>}
          </div>
        )}
      </td>
      <td class={`hide-md num${health < 35 ? " tone-text-bad" : health < 60 ? " tone-text-warn" : ""}`}>{health}%</td>
      <td class="hide-md">
        <span class="num">{formatCount(account.totalRequests)}</span>
        <div class="cell-sub num">{account.requestsSinceRotation} this rotation</div>
      </td>
      <td class="hide-sm">
        <RelativeTime ts={account.lastUsed} />
      </td>
      <td class="cell-action">
        <Menu label={`Actions for ${displayName}`} items={accountMenuItems(account)} />
      </td>
    </tr>
  );
});

const MONOGRAM_HUES = [250, 205, 160, 32, 340, 280, 190, 12];

function monogram(name: string): { text: string; hue: number } {
  const words = name.trim().split(/[\s._@-]+/).filter(Boolean);
  const text =
    words.length > 1 ? `${words[0][0]}${words[1][0]}` : (words[0] ?? "?").slice(0, 1);
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return { text: text.toUpperCase(), hue: MONOGRAM_HUES[hash % MONOGRAM_HUES.length] };
}

const AccountCard = memo(function AccountCard({
  account,
  displayName,
  displayEmail,
  selected,
  maxConcurrent,
}: {
  account: DashboardAccount;
  displayName: string;
  displayEmail: string;
  selected: boolean;
  maxConcurrent: number;
}): JSX.Element {
  const href = accountPath(account.email);
  const meta = accountStatus(account.status);
  const pools = [...(account.quota || [])].sort((a, b) => providerRank(quotaProvider(a)) - providerRank(quotaProvider(b)));
  const inactive = isOutOfService(account);
  const health = Math.round((account.healthScore || 0) * 100);
  const mark = monogram(displayName);
  const hasTier = account.tier && account.tier !== "unknown";
  return (
    <article
      class={`account-card tone-${meta.tone}${account.status === "active" ? " is-serving" : ""}${inactive ? " is-inactive" : ""}${selected ? " is-selected" : ""}`}
      aria-label={`${displayName}, ${meta.label}`}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("a, button, .menu, .popover")) return;
        navigate(href);
      }}
    >
      <header class="account-card-head">
        <span class="monogram" style={{ "--hue": String(mark.hue) }} aria-hidden="true">
          {mark.text}
        </span>
        <div class="account-card-titles">
          <Link href={href} class="account-card-name">
            {displayName}
          </Link>
          <span class="account-card-sub">{displayEmail !== displayName ? displayEmail : providerIds(account).map(providerLabel).join(" · ")}</span>
        </div>
        <span class="account-card-aside">
          <StatusPill status={account.status} />
          <Menu label={`Actions for ${displayName}`} items={accountMenuItems(account, { includeOpen: true })} />
        </span>
      </header>

      <div class="account-card-tags">
        {providerIds(account).map((id) => (
          <span key={id} class="tag">
            {providerLabel(id)}
          </span>
        ))}
        {hasTier && <span class="tag tag-tier">{tierLabel(account.tier)}</span>}
        {account.allowFreshWindowStartsOverride && (
          <span class="tag" title="Fresh windows always allowed for this account">
            Fresh windows on
          </span>
        )}
      </div>

      <CardStatus account={account} maxConcurrent={maxConcurrent} />

      {pools.length === 0 ? (
        <p class="card-quotas-empty">No quota reported yet.</p>
      ) : (
        <ul class="card-quotas">
          {pools.slice(0, CARD_QUOTAS).map((quota) => (
            <CardQuota key={quota.modelKey} account={account} quota={quota} inactive={inactive} />
          ))}
          {pools.length > CARD_QUOTAS && (
            <li class="card-quotas-more">
              <Link href={href}>+{pools.length - CARD_QUOTAS} more</Link>
            </li>
          )}
        </ul>
      )}

      <dl class="card-stats">
        <div>
          <dt>Requests</dt>
          <dd class="num" title={`${account.requestsSinceRotation} this rotation`}>
            {formatCount(account.totalRequests)}
          </dd>
        </div>
        <div>
          <dt>Health</dt>
          <dd class={`num${health < 35 ? " tone-text-bad" : health < 60 ? " tone-text-warn" : ""}`}>{health}%</dd>
        </div>
        <div>
          <dt>Last used</dt>
          <dd>
            <RelativeTime ts={account.lastUsed} />
          </dd>
        </div>
      </dl>
    </article>
  );
});

/** What the account is doing now, with the fix when it is out of service. */
function CardStatus({ account, maxConcurrent }: { account: DashboardAccount; maxConcurrent: number }): JSX.Element | null {
  const problem = (account.status === "error" || account.status === "flagged") && account.lastError;
  const action =
    account.status === "flagged" ? (
      <AsyncButton size="sm" variant="primary" icon="play" onClick={() => actions.restore(account.email)}>
        Restore
      </AsyncButton>
    ) : account.status === "disabled" ? (
      <AsyncButton size="sm" variant="primary" icon="play" onClick={() => actions.enable(account.email)}>
        Re-enable
      </AsyncButton>
    ) : null;
  if (problem || action) {
    return (
      <div class={`card-status${problem ? " is-problem" : ""}`}>
        {problem && (
          <p class="card-status-text" title={masker.value.text(account.lastError ?? "")}>
            {masker.value.text(account.lastError ?? "")}
          </p>
        )}
        {!problem && <p class="card-status-text">{accountStatus(account.status).description}</p>}
        {action}
      </div>
    );
  }
  const detail = StatusDetail({ account, maxConcurrent });
  return detail ? <div class="card-status">{detail}</div> : null;
}

function CardQuota({ account, quota, inactive }: { account: DashboardAccount; quota: ModelQuota; inactive: boolean }): JSX.Element {
  const resetAt = quota.resetTime ? Date.parse(quota.resetTime) : null;
  const inFlight = (account.inFlightByModel || {})[quota.modelKey] || 0;
  const idle = quota.timerType === "fresh";
  let when: JSX.Element;
  if (idle && !inactive && inFlight === 0 && isKickstartable(quota)) {
    when = (
      <AsyncButton
        size="sm"
        variant="ghost"
        icon="play"
        class="card-start"
        title={`Start the ${quota.displayName} window`}
        onClick={() => actions.kickstart(account.email, quota.modelKey, quota.displayName)}
      >
        Start
      </AsyncButton>
    );
  } else if (idle) {
    when = <span>Idle</span>;
  } else if (resetAt && resetAt > now.value) {
    when = <Countdown until={resetAt} />;
  } else {
    when = <span>—</span>;
  }
  return (
    <li class="card-quota" title={`${quota.displayName}: ${quota.percentRemaining}% left · ${TIMER_LABELS[quota.timerType] ?? quota.timerType}`}>
      <span class="card-quota-name">{quota.displayName}</span>
      <Meter value={quota.percentRemaining} label={`${quota.displayName} quota`} />
      <span class="card-quota-pct num">{quota.percentRemaining}%</span>
      <span class="card-quota-when">{when}</span>
    </li>
  );
}

function StatusDetail({ account, maxConcurrent }: { account: DashboardAccount; maxConcurrent: number }): JSX.Element | null {
  if (account.status === "active" && account.activeForModels.length > 0)
    return <div class="cell-sub truncate">Serving {account.activeForModels.join(", ")}</div>;
  if (account.status === "cooldown" || account.status === "exhausted") {
    const until = Math.max(0, ...Object.values(account.cooldownsByModel || {}));
    const remaining = until - now.value;
    if (remaining > 0) return <div class="cell-sub num">Back in {formatDuration(remaining)}</div>;
  }
  if ((account.status === "error" || account.status === "flagged") && account.lastError)
    return (
      <div class="cell-sub truncate" title={masker.value.text(account.lastError)}>
        {masker.value.text(account.lastError)}
      </div>
    );
  if (account.inFlightRequests > 0)
    return (
      <div class="cell-sub num">
        {account.inFlightRequests}/{maxConcurrent} in flight
      </div>
    );
  return null;
}
