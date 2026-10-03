// Account drawer: everything about one account and every action on it.

import type { JSX } from "preact";
import type { AccountTier, ModelQuota } from "../../types.js";
import type { DashboardAccount, DashboardOverview } from "../../dashboard-types.js";
import { formatCount } from "../lib/format.js";
import {
  ACCOUNT_TIERS,
  accountStatus,
  errorHint,
  isKickstartable,
  isOutOfService,
  providerIds,
  providerLabel,
  providerRank,
  quotaProvider,
  rejectionLabel,
  tierLabel,
  TIMER_LABELS,
} from "../lib/status.js";
import { actions } from "../state/actions.js";
import { masker, now, overview } from "../state/store.js";
import { Icon } from "../components/icons.js";
import { Menu } from "../components/overlays.js";
import {
  AsyncButton,
  Button,
  Countdown,
  KeyValue,
  Meter,
  Pill,
  ProviderTags,
  RelativeTime,
  StatusPill,
} from "../components/ui.js";
import { accountMenuItems } from "./Accounts.js";

export function AccountDetail({ email, onClose }: { email: string; onClose: () => void }): JSX.Element {
  const data = overview.value!;
  const account = data.accounts.find((a) => a.email === email);
  if (!account) {
    return (
      <div class="drawer-empty">
        <div class="drawer-head">
          <h2>Account not found</h2>
          <Button variant="ghost" icon="x" iconOnly onClick={onClose}>
            Close
          </Button>
        </div>
        <p class="muted">It may have been removed.</p>
      </div>
    );
  }
  const name = masker.value.name(account.email);
  const meta = accountStatus(account.status);
  const inactive = isOutOfService(account);
  const canKickstart = !inactive && (account.quota || []).some(isKickstartable);

  return (
    <article class="account-detail" aria-label={`${name} details`}>
      <header class="drawer-head">
        <div class="drawer-title">
          <h2>{name}</h2>
          <div class="drawer-sub">
            {masker.value.email(account.email) !== name && <span>{masker.value.email(account.email)}</span>}
            <ProviderTags ids={providerIds(account)} />
          </div>
        </div>
        <Button variant="ghost" icon="x" iconOnly onClick={onClose}>
          Close
        </Button>
      </header>

      <section class={`detail-status tone-${meta.tone}`}>
        <div class="detail-status-line">
          <StatusPill status={account.status} />
          {account.activeForModels.length > 0 && <span class="muted">for {account.activeForModels.join(", ")}</span>}
        </div>
        <p>{meta.description}</p>
        <div class="detail-actions">
          {account.status === "disabled" && (
            <AsyncButton variant="primary" icon="play" onClick={() => actions.enable(account.email)}>
              Re-enable
            </AsyncButton>
          )}
          {account.status === "flagged" && (
            <AsyncButton variant="primary" icon="play" onClick={() => actions.restore(account.email)}>
              Restore to rotation
            </AsyncButton>
          )}
          {canKickstart && (
            <AsyncButton icon="timer" onClick={() => actions.kickstartAll(account.email)}>
              Start idle windows
            </AsyncButton>
          )}
          <TierSelect account={account} />
          <Menu label="More actions" text="More" icon="more" size="md" items={accountMenuItems(account)} />
        </div>
      </section>

      {account.lastError && <ErrorBlock message={account.lastError} />}

      <ProviderProblems account={account} />

      <section class="detail-section">
        <h3>Quota</h3>
        {(account.quota || []).length === 0 ? (
          <p class="muted">No quota reported yet. It appears after the next quota poll.</p>
        ) : (
          <ul class="quota-list">
            {[...account.quota]
              .sort((a, b) => providerRank(quotaProvider(a)) - providerRank(quotaProvider(b)))
              .map((q) => (
                <QuotaRow key={q.modelKey} account={account} quota={q} inactive={inactive} />
              ))}
          </ul>
        )}
      </section>

      <RoutingSection account={account} data={data} />

      <section class="detail-section">
        <h3>Limits and activity</h3>
        <KeyValue
          items={[
            ["Requests", <span class="num">{formatCount(account.totalRequests)} total · {account.requestsSinceRotation} this rotation</span>],
            ["Last used", <RelativeTime ts={account.lastUsed} />],
            [
              "Daily account budget",
              <BudgetMeter used={account.dailyRequestCount} limit={account.dailyAccountStopRequests} label="Daily account requests" />,
            ],
            [
              "Daily project budget",
              <BudgetMeter used={account.dailyProjectRequestCount} limit={account.dailyProjectStopRequests} label="Daily project requests" />,
            ],
            [
              "In flight",
              <span class="num">
                {account.inFlightRequests} of {data.maxConcurrentRequestsPerAccount}
              </span>,
            ],
            ...(account.tokenBucket.enabled
              ? ([
                  [
                    "Token bucket",
                    <span class="num">
                      {account.tokenBucket.tokens.toFixed(1)} of {account.tokenBucket.capacity}
                      {account.tokenBucket.nextRefillAt && (
                        <span class="muted">
                          {" "}
                          · refill in <Countdown until={account.tokenBucket.nextRefillAt} />
                        </span>
                      )}
                    </span>,
                  ],
                ] as Array<[string, JSX.Element]>)
              : []),
            [
              "Fresh windows",
              account.allowFreshWindowStartsOverride
                ? "Always allowed (account override)"
                : account.effectiveFreshWindowStartsAllowed
                  ? "Allowed by the global policy"
                  : "Blocked by the global policy",
            ],
            ["Access token", account.hasValidToken ? "Valid" : "Expired; refreshed on the next request"],
            ["Health", <span class="num">{Math.round((account.healthScore || 0) * 100)}%</span>],
          ]}
        />
      </section>
    </article>
  );
}

function TierSelect({ account }: { account: DashboardAccount }): JSX.Element {
  return (
    <label class="inline-select">
      <span class="sr-only">Tier</span>
      <select
        class="select"
        value={ACCOUNT_TIERS.includes(account.tier) ? account.tier : "unknown"}
        title="Account tier, used by tier-first and hybrid routing"
        onChange={(event) => void actions.setTier(account.email, (event.target as HTMLSelectElement).value as AccountTier)}
      >
        {ACCOUNT_TIERS.map((tier) => (
          <option key={tier} value={tier}>
            {tierLabel(tier)}
          </option>
        ))}
      </select>
    </label>
  );
}

function ErrorBlock({ message }: { message: string }): JSX.Element {
  const hint = errorHint(message);
  return (
    <section class="callout tone-bad">
      <Icon name="critical" size={16} />
      <div>
        <strong>Last error</strong>
        <p class="mono-text">{masker.value.text(message)}</p>
        {hint && <p class="callout-hint">{hint}</p>}
      </div>
    </section>
  );
}

function ProviderProblems({ account }: { account: DashboardAccount }): JSX.Element | null {
  const invalid = Object.entries(account.invalidProviders || {});
  const cooldowns = Object.entries(account.providerCooldowns || {}).filter(([, until]) => until > now.value);
  const modelCooldowns = Object.entries(account.cooldownsByModel || {}).filter(([, until]) => until > now.value);
  if (invalid.length === 0 && cooldowns.length === 0 && modelCooldowns.length === 0) return null;
  return (
    <section class="callout tone-warn">
      <Icon name="clock" size={16} />
      <div class="callout-list">
        {modelCooldowns.map(([model, until]) => (
          <div key={`m-${model}`}>
            <strong>{model === "__default__" ? "All models" : model}</strong> cooling down for <Countdown until={until} />
          </div>
        ))}
        {cooldowns.map(([provider, until]) => (
          <div key={`p-${provider}`}>
            <strong>{providerLabel(provider)}</strong> paused for <Countdown until={until} />
          </div>
        ))}
        {invalid.map(([provider, reason]) => (
          <div key={`i-${provider}`}>
            <strong>{providerLabel(provider)}</strong> credential rejected: {masker.value.text(reason)}
          </div>
        ))}
      </div>
    </section>
  );
}

function QuotaRow({ account, quota, inactive }: { account: DashboardAccount; quota: ModelQuota; inactive: boolean }): JSX.Element {
  const inFlight = (account.inFlightByModel || {})[quota.modelKey] || 0;
  const resetAt = quota.resetTime ? Date.parse(quota.resetTime) : null;
  // Predictions are keyed by account email; show the forecast on the pool that runs out first.
  const soonest = overview.value?.predictions[account.email]?.soonest;
  const forecast = soonest?.pool === quota.modelKey ? soonest : null;
  return (
    <li class="quota-item">
      <div class="quota-head">
        <span class="quota-name">{quota.displayName}</span>
        <span class="num quota-pct">{quota.percentRemaining}%</span>
      </div>
      <Meter value={quota.percentRemaining} label={`${quota.displayName} quota remaining`} />
      <div class="quota-meta">
        <span>{TIMER_LABELS[quota.timerType] ?? quota.timerType}</span>
        {quota.timerType !== "fresh" && resetAt && resetAt > now.value && (
          <span>
            resets in <Countdown until={resetAt} />
          </span>
        )}
        {inFlight > 0 && <span class="num">{inFlight} in flight</span>}
        {forecast?.exhaustedAtMs && forecast.exhaustedAtMs > now.value && (
          <span class="tone-text-warn">
            {forecast.pool} pool runs out in <Countdown until={forecast.exhaustedAtMs} />
          </span>
        )}
        <span class="quota-actions">
          {inFlight > 0 && (
            <AsyncButton size="sm" variant="ghost" onClick={() => actions.clearInFlight(account.email, quota.modelKey, quota.displayName)}>
              Clear in-flight
            </AsyncButton>
          )}
          {!inactive && inFlight === 0 && isKickstartable(quota) && (
            <AsyncButton size="sm" icon="play" onClick={() => actions.kickstart(account.email, quota.modelKey, quota.displayName)}>
              Start window
            </AsyncButton>
          )}
        </span>
      </div>
    </li>
  );
}

function RoutingSection({ account, data }: { account: DashboardAccount; data: DashboardOverview }): JSX.Element | null {
  const entries = Object.values(data.routingDiagnostics)
    .map((diag) => ({ diag, entry: diag.accounts.find((a) => a.email === account.email) }))
    .filter((x): x is { diag: (typeof x)["diag"]; entry: NonNullable<(typeof x)["entry"]> } => Boolean(x.entry))
    .sort((a, b) => a.diag.modelKey.localeCompare(b.diag.modelKey));
  if (entries.length === 0) return null;
  const breakdown = entries[0].entry.healthBreakdown;
  return (
    <section class="detail-section">
      <h3>Routing</h3>
      <table class="table table-compact">
        <thead>
          <tr>
            <th scope="col">Model</th>
            <th scope="col">Decision</th>
            <th scope="col" class="num-col">Score</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(({ diag, entry }) => (
            <tr key={diag.modelKey}>
              <td>{diag.modelKey}</td>
              <td>
                {diag.selectedEmail === account.email ? (
                  <Pill tone="ok">Selected</Pill>
                ) : entry.rejectedReason ? (
                  <span class="muted" title={entry.rejectedDetail ?? undefined}>
                    {rejectionLabel(entry.rejectedReason)}
                    {entry.rejectedDetail && entry.rejectedDetail !== entry.rejectedReason && (
                      <span class="cell-sub">{masker.value.text(entry.rejectedDetail)}</span>
                    )}
                  </span>
                ) : (
                  "Eligible"
                )}
              </td>
              <td class="num num-col">{entry.score === null ? "—" : entry.score.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div class="health-breakdown">
        <span class="muted">Health score</span>
        <span>quota {Math.round(breakdown.quotaComponent * 100)}%</span>
        <span>− errors {Math.round(breakdown.errorPenalty * 100)}%</span>
        <span>− cooldown {Math.round(breakdown.cooldownPenalty * 100)}%</span>
        <span>− availability {Math.round(breakdown.availabilityPenalty * 100)}%</span>
        <strong>= {Math.round(breakdown.score * 100)}%</strong>
      </div>
    </section>
  );
}

function BudgetMeter({ used, limit, label }: { used: number; limit: number; label: string }): JSX.Element {
  if (!(limit > 0)) return <span class="num">{formatCount(used)}</span>;
  const pct = Math.min(100, (used / limit) * 100);
  return (
    <span class="budget">
      <Meter value={100 - pct} label={`${label} remaining`} tone={pct >= 100 ? "bad" : pct >= 80 ? "warn" : "neutral"} size="sm" />
      <span class="num">
        {formatCount(used)} / {formatCount(limit)}
      </span>
    </span>
  );
}

