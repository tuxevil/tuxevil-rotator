// Data shaping and the live stream behind the dashboard (/api/dashboard/*).
//
// The rotator exposes one large StatusResponse. The dashboard splits it:
// a small overview snapshot, live request/event tails, and history fetched
// per view. The stream sends only what changed since the previous tick.

import type { ServerResponse } from "node:http";
import {
  getModelPricing,
  type StatusResponse,
  type TokenBucket,
  type TokenUsageData,
} from "./types.js";
import type {
  AccountsPatch,
  ActivityResponse,
  DashboardAccount,
  DashboardOverview,
  DashboardRoutingDiagnostics,
  DashboardSnapshot,
  DashboardStreamMessage,
  DashboardTokenBucket,
  LiveEvent,
  LiveRequest,
  ModelPrice,
  OverviewSection,
  TrafficMinute,
  UsageBucket,
  UsageRange,
  UsageResponse,
} from "./dashboard-types.js";
import { USAGE_RANGES } from "./dashboard-types.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Round countdown-derived timestamps so ms jitter does not look like change. */
function absoluteFrom(now: number, remainingMs: number): number | null {
  if (!(remainingMs > 0)) return null;
  return Math.round((now + remainingMs) / 1000) * 1000;
}

function tokenBucketAt(
  now: number,
  bucket: {
    enabled: boolean;
    tokens: number;
    capacity: number;
    nextRefillInMs: number;
  },
): DashboardTokenBucket {
  return {
    enabled: bucket.enabled,
    tokens: Math.round(bucket.tokens * 10) / 10,
    capacity: bucket.capacity,
    nextRefillAt: absoluteFrom(now, bucket.nextRefillInMs),
  };
}

/** Parse a rotator bucket period ("2026-04-28T12:05", "…T12", "2026-04-28") as UTC. */
export function periodStart(period: string): number {
  if (period.length === 16) return Date.parse(`${period}:00Z`);
  if (period.length === 13) return Date.parse(`${period}:00:00Z`);
  if (period.length === 10) return Date.parse(`${period}T00:00:00Z`);
  if (period.length === 7) return Date.parse(`${period}-01T00:00:00Z`);
  return NaN;
}

export function periodSpan(period: string): number {
  if (period.length === 16) return MINUTE;
  if (period.length === 13) return HOUR;
  if (period.length === 10) return DAY;
  return Infinity;
}

function trafficFor(
  tokenUsage: TokenUsageData | undefined,
  now: number,
): { traffic: TrafficMinute[]; byModel: Record<string, number> } {
  const firstMinute = Math.floor(now / MINUTE) * MINUTE - 59 * MINUTE;
  const traffic: TrafficMinute[] = Array.from({ length: 60 }, (_, i) => ({
    start: firstMinute + i * MINUTE,
    requests: 0,
    tokens: 0,
  }));
  const byModel: Record<string, number> = {};
  for (const bucket of tokenUsage?.minutes ?? []) {
    const start = periodStart(bucket.period);
    const index = Math.round((start - firstMinute) / MINUTE);
    if (!(index >= 0 && index < 60)) continue;
    traffic[index].requests += bucket.requests || 0;
    traffic[index].tokens +=
      (bucket.inputTokens || 0) + (bucket.outputTokens || 0);
    for (const [model, totals] of Object.entries(bucket.byModel || {})) {
      byModel[model] = (byModel[model] || 0) + (totals.requests || 0);
    }
  }
  return { traffic, byModel };
}

export function buildOverview(
  status: StatusResponse,
  now: number,
  capabilities: { database: boolean },
): DashboardOverview {
  const accounts: DashboardAccount[] = (status.accounts || []).map(
    (account) => ({
      ...account,
      tokenBucket: tokenBucketAt(
        now,
        account.tokenBucket || {
          enabled: false,
          tokens: 0,
          capacity: 0,
          nextRefillInMs: 0,
        },
      ),
    }),
  );

  const routingDiagnostics: Record<string, DashboardRoutingDiagnostics> = {};
  for (const [key, diag] of Object.entries(status.routingDiagnostics || {})) {
    routingDiagnostics[key] = {
      ...diag,
      accounts: (diag.accounts || []).map((entry) => ({
        ...entry,
        tokenBucket: tokenBucketAt(now, entry.tokenBucket),
      })),
    };
  }

  const breakers = status.circuitBreakers || { model: {}, project: {} };
  const untilMap = (
    source: Record<string, { until: number }> | undefined,
  ): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(source || {})) {
      if (value.until > now) out[key] = value.until;
    }
    return out;
  };

  const health = status.routingHealth;
  const { nextRetryIn, ...healthRest } = health || {
    state: "stopped" as const,
    reason: "",
    nextRetryIn: 0,
    availableCount: 0,
    readyCount: 0,
    activeCount: 0,
    cooldownCount: 0,
    busyCount: 0,
    flaggedCount: 0,
    disabledCount: 0,
    errorCount: 0,
  };
  const { traffic, byModel } = trafficFor(status.tokenUsage, now);

  return {
    generatedAt: now,
    version: status.version,
    proxyPort: status.proxyPort,
    startedAt: Math.round((now - (status.uptime || 0)) / 1000) * 1000,
    requestsPerRotation: status.requestsPerRotation,
    maxConcurrentRequestsPerAccount: status.maxConcurrentRequestsPerAccount,
    totalRequestsAllAccounts: status.totalRequestsAllAccounts,
    activeAccounts: status.activeAccounts || {},
    accounts,
    protectivePause: {
      until:
        (status.protectivePauseRemaining || 0) > 0
          ? status.protectivePauseUntil
          : 0,
      reason: status.protectivePauseReason ?? null,
    },
    operatorControls: status.operatorControls || {
      allowFreshWindowStarts: true,
      autoWarmupEnabled: false,
    },
    security: status.security || {
      adminTokenConfigured: false,
      warning: null,
      bindHost: "0.0.0.0",
    },
    routingHealth: {
      ...healthRest,
      nextRetryAt: absoluteFrom(now, nextRetryIn),
    },
    routingDiagnostics,
    circuitBreakers: {
      model: untilMap(breakers.model),
      project: untilMap(breakers.project),
    },
    predictions: status.predictions || {},
    modelTierAccess: status.modelTierAccess ?? null,
    updateInfo: status.updateInfo ?? null,
    notifications: status.notifications ?? [],
    hostedOAuthConfigured: Boolean(status.hostedOAuthConfigured),
    capabilities,
    usage: {
      totalRequests: status.tokenUsage?.totalRequests ?? 0,
      totalInputTokens: status.tokenUsage?.totalInputTokens ?? 0,
      totalOutputTokens: status.tokenUsage?.totalOutputTokens ?? 0,
      savingsUsd: status.tokenUsage?.savings?.totalUsd ?? 0,
    },
    traffic,
    recentRequestsByModel: byModel,
  };
}

// ── Live hub ────────────────────────────────────────────────────────────

const REQUEST_RING = 200;
const EVENT_RING = 100;

function requestKey(entry: {
  timestamp: number;
  model: string;
  account: string;
  statusCode: number;
  totalMs: number;
}): string {
  return `${entry.timestamp}|${entry.model}|${entry.account}|${entry.statusCode}|${entry.totalMs}`;
}

function eventKey(entry: {
  timestamp: number;
  source: string;
  level: string;
  message: string;
}): string {
  return `${entry.timestamp}|${entry.source}|${entry.level}|${entry.message}`;
}

export interface DashboardLiveHubOptions {
  getStatus: () => StatusResponse;
  capabilities: () => { database: boolean };
  now?: () => number;
  /** Throttle for change-triggered pushes. */
  throttleMs?: number;
  /** Background tick while clients are connected. */
  tickMs?: number;
  heartbeatMs?: number;
}

/**
 * Keeps the last broadcast state and turns each new status into the smallest
 * set of stream messages: changed overview sections, changed accounts, and
 * requests/events not seen before.
 */
export class DashboardLiveHub {
  private readonly clients = new Set<ServerResponse>();
  private overview: DashboardOverview | null = null;
  private sectionJson = new Map<OverviewSection, string>();
  private accountJson = new Map<string, string>();
  private accountOrder: string[] = [];
  private requests: LiveRequest[] = [];
  private events: LiveEvent[] = [];
  private seenRequests = new Set<string>();
  private seenEvents = new Set<string>();
  private nextId = 1;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly options: DashboardLiveHubOptions) {
    this.now = options.now ?? Date.now;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Advance the baseline (pushing diffs to connected clients) and return it. */
  snapshot(): DashboardSnapshot {
    this.broadcast(this.collect());
    return {
      overview: this.overview!,
      requests: this.requests.slice(),
      events: this.events.slice(),
    };
  }

  /** Compute stream messages for the current rotator state. */
  collect(): DashboardStreamMessage[] {
    const status = this.options.getStatus();
    const next = buildOverview(status, this.now(), this.options.capabilities());
    const messages: DashboardStreamMessage[] = [];
    const first = this.overview === null;

    const sections: Partial<Pick<DashboardOverview, OverviewSection>> = {};
    let sectionChanged = false;
    for (const key of Object.keys(next) as Array<keyof DashboardOverview>) {
      // generatedAt changes every tick and carries no information of its own.
      if (key === "accounts" || key === "generatedAt") continue;
      const json = JSON.stringify(next[key]);
      if (this.sectionJson.get(key) !== json) {
        this.sectionJson.set(key, json);
        (sections as Record<string, unknown>)[key] = next[key];
        sectionChanged = true;
      }
    }
    if (sectionChanged && !first) {
      messages.push({
        type: "overview",
        data: { ...sections, generatedAt: next.generatedAt },
      });
    }

    const patch: AccountsPatch = { upsert: [], remove: [] };
    const seen = new Set<string>();
    for (const account of next.accounts) {
      seen.add(account.email);
      const json = JSON.stringify(account);
      if (this.accountJson.get(account.email) !== json) {
        this.accountJson.set(account.email, json);
        patch.upsert.push(account);
      }
    }
    for (const email of this.accountJson.keys()) {
      if (!seen.has(email)) {
        this.accountJson.delete(email);
        patch.remove.push(email);
      }
    }
    const order = next.accounts.map((a) => a.email);
    if (order.join("\n") !== this.accountOrder.join("\n")) {
      this.accountOrder = order;
      patch.order = order;
    }
    if (
      !first &&
      (patch.upsert.length > 0 || patch.remove.length > 0 || patch.order)
    ) {
      messages.push({ type: "accounts", data: patch });
    }

    this.overview = next;

    const freshRequests = this.absorbRequests(status);
    if (freshRequests.length > 0 && !first) {
      messages.push({ type: "requests", data: freshRequests });
    }
    const freshEvents = this.absorbEvents(status);
    if (freshEvents.length > 0 && !first) {
      messages.push({ type: "events", data: freshEvents });
    }
    return messages;
  }

  private absorbRequests(status: StatusResponse): LiveRequest[] {
    const log = status.requestLog || [];
    const fresh: LiveRequest[] = [];
    // requestLog is newest first; assign ids oldest first.
    for (let i = log.length - 1; i >= 0; i--) {
      const key = requestKey(log[i]);
      if (this.seenRequests.has(key)) continue;
      this.seenRequests.add(key);
      fresh.unshift({ ...log[i], id: this.nextId++ });
    }
    if (fresh.length > 0) {
      this.requests = fresh.concat(this.requests).slice(0, REQUEST_RING);
      if (this.seenRequests.size > REQUEST_RING * 2) {
        this.seenRequests = new Set(log.map(requestKey));
      }
    }
    return fresh;
  }

  private absorbEvents(status: StatusResponse): LiveEvent[] {
    const recent = status.recentEvents || [];
    const fresh: LiveEvent[] = [];
    for (let i = recent.length - 1; i >= 0; i--) {
      const key = eventKey(recent[i]);
      if (this.seenEvents.has(key)) continue;
      this.seenEvents.add(key);
      fresh.unshift({ ...recent[i], id: this.nextId++ });
    }
    if (fresh.length > 0) {
      this.events = fresh.concat(this.events).slice(0, EVENT_RING);
      if (this.seenEvents.size > EVENT_RING * 2) {
        this.seenEvents = new Set(recent.map(eventKey));
      }
    }
    return fresh;
  }

  addClient(res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");
    const snapshot = this.snapshot();
    this.clients.add(res);
    this.write(res, { type: "snapshot", data: snapshot });
    res.on("close", () => {
      this.clients.delete(res);
      if (this.clients.size === 0) this.stopTimers();
    });
    this.startTimers();
  }

  /** Called when rotator state changes; pushes at most once per throttle. */
  schedule(): void {
    if (this.clients.size === 0 || this.throttleTimer) return;
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null;
      this.tick();
    }, this.options.throttleMs ?? 1000);
    this.throttleTimer.unref?.();
  }

  tick(): void {
    if (this.clients.size === 0) return;
    this.broadcast(this.collect());
  }

  close(): void {
    this.stopTimers();
    if (this.throttleTimer) clearTimeout(this.throttleTimer);
    this.throttleTimer = null;
    for (const client of this.clients) {
      try {
        client.end();
      } catch {
        // already closed
      }
    }
    this.clients.clear();
  }

  private broadcast(messages: DashboardStreamMessage[]): void {
    for (const message of messages) {
      for (const client of this.clients) this.write(client, message);
    }
  }

  private write(res: ServerResponse, message: DashboardStreamMessage): void {
    try {
      res.write(`event: ${message.type}\ndata: ${JSON.stringify(message.data)}\n\n`);
    } catch {
      this.clients.delete(res);
    }
  }

  private startTimers(): void {
    if (!this.tickTimer) {
      this.tickTimer = setInterval(() => this.tick(), this.options.tickMs ?? 5000);
      this.tickTimer.unref?.();
    }
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        for (const client of this.clients) {
          try {
            client.write(": ping\n\n");
          } catch {
            this.clients.delete(client);
          }
        }
      }, this.options.heartbeatMs ?? 25_000);
      this.heartbeatTimer.unref?.();
    }
  }

  private stopTimers(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.tickTimer = null;
    this.heartbeatTimer = null;
  }
}

// ── Usage history ───────────────────────────────────────────────────────

interface RangeWindow {
  windowMs: number;
  /** Largest bucket span that still fits inside one chart bar. */
  maxSpan: number;
  /** Roll minute buckets into UTC hours to keep long ranges small. */
  rollMinutes: boolean;
}

// Margins cover aligning bars to the viewer's local clock.
const RANGE_WINDOWS: Record<UsageRange, RangeWindow> = {
  "1h": { windowMs: HOUR + 2 * MINUTE, maxSpan: MINUTE, rollMinutes: false },
  "6h": { windowMs: 6 * HOUR + 10 * MINUTE, maxSpan: MINUTE, rollMinutes: false },
  "24h": { windowMs: 25 * HOUR, maxSpan: HOUR, rollMinutes: false },
  "7d": { windowMs: 8 * DAY, maxSpan: DAY, rollMinutes: true },
  "30d": { windowMs: 31 * DAY, maxSpan: DAY, rollMinutes: true },
};

export function isUsageRange(value: unknown): value is UsageRange {
  return (USAGE_RANGES as readonly unknown[]).includes(value);
}

function toUsageBucket(bucket: TokenBucket): UsageBucket | null {
  const start = periodStart(bucket.period);
  const span = periodSpan(bucket.period);
  if (!Number.isFinite(start) || !Number.isFinite(span)) return null;
  const byModel: UsageBucket["byModel"] = {};
  for (const [model, totals] of Object.entries(bucket.byModel || {})) {
    byModel[model] = {
      inputTokens: totals.inputTokens || 0,
      outputTokens: totals.outputTokens || 0,
      requests: totals.requests || 0,
    };
  }
  return {
    start,
    span,
    inputTokens: bucket.inputTokens || 0,
    outputTokens: bucket.outputTokens || 0,
    requests: bucket.requests || 0,
    byModel,
  };
}

function addInto(target: UsageBucket, source: UsageBucket): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.requests += source.requests;
  for (const [model, totals] of Object.entries(source.byModel)) {
    const dst = (target.byModel[model] ??= {
      inputTokens: 0,
      outputTokens: 0,
      requests: 0,
    });
    dst.inputTokens += totals.inputTokens;
    dst.outputTokens += totals.outputTokens;
    dst.requests += totals.requests;
  }
}

export function buildUsage(
  tokenUsage: TokenUsageData | undefined,
  latency: StatusResponse["latencyStats"] | undefined,
  range: UsageRange,
  now: number,
): UsageResponse {
  const window = RANGE_WINDOWS[range];
  const from = now - window.windowMs;
  const sources = [
    ...(tokenUsage?.minutes ?? []),
    ...(tokenUsage?.hours ?? []),
    ...(tokenUsage?.days ?? []),
  ];
  const rolled = new Map<number, UsageBucket>();
  const buckets: UsageBucket[] = [];
  for (const raw of sources) {
    const bucket = toUsageBucket(raw);
    if (!bucket || bucket.span > window.maxSpan) continue;
    if (bucket.start + bucket.span <= from || bucket.start > now) continue;
    if (window.rollMinutes && bucket.span === MINUTE) {
      const hourStart = Math.floor(bucket.start / HOUR) * HOUR;
      let hour = rolled.get(hourStart);
      if (!hour) {
        hour = {
          start: hourStart,
          span: HOUR,
          inputTokens: 0,
          outputTokens: 0,
          requests: 0,
          byModel: {},
        };
        rolled.set(hourStart, hour);
        buckets.push(hour);
      }
      addInto(hour, bucket);
      continue;
    }
    buckets.push(bucket);
  }
  buckets.sort((a, b) => a.start - b.start || a.span - b.span);

  const pricing: Record<string, ModelPrice> = {};
  for (const bucket of buckets) {
    for (const model of Object.keys(bucket.byModel)) {
      if (model in pricing) continue;
      const price = getModelPricing(model);
      if (price) {
        pricing[model] = {
          inputPer1M: price.inputPer1M,
          outputPer1M: price.outputPer1M,
        };
      }
    }
  }

  return {
    range,
    generatedAt: now,
    buckets,
    pricing,
    allTime: {
      inputTokens: tokenUsage?.totalInputTokens ?? 0,
      outputTokens: tokenUsage?.totalOutputTokens ?? 0,
      requests: tokenUsage?.totalRequests ?? 0,
      savingsUsd: tokenUsage?.savings?.totalUsd ?? 0,
    },
    latency: latency ?? {},
  };
}

export function buildActivity(
  tokenUsage: TokenUsageData | undefined,
  now: number,
): ActivityResponse {
  // 60 local days plus an alignment margin; the rotator keeps hour buckets
  // this long (KEEP_HOURS_MS in rotator.ts).
  const from = now - 61 * DAY;
  const hours = new Map<number, number>();
  for (const raw of [...(tokenUsage?.minutes ?? []), ...(tokenUsage?.hours ?? [])]) {
    const start = periodStart(raw.period);
    if (!Number.isFinite(start) || start < from || start > now) continue;
    if (!(raw.requests > 0)) continue;
    const hour = Math.floor(start / HOUR) * HOUR;
    hours.set(hour, (hours.get(hour) || 0) + raw.requests);
  }
  return {
    generatedAt: now,
    hours: [...hours.entries()].sort((a, b) => a[0] - b[0]),
  };
}

export function tokenUsageCsv(tokenUsage: TokenUsageData | undefined): string {
  const lines = ["Tier,Period,Model,InputTokens,OutputTokens,Requests"];
  for (const tier of ["months", "days", "hours", "minutes"] as const) {
    for (const bucket of tokenUsage?.[tier] ?? []) {
      for (const [model, totals] of Object.entries(bucket.byModel || {})) {
        // A leading = + - @ would run as a formula in a spreadsheet.
        const text = /^[=+\-@\t\r]/.test(model) ? `'${model}` : model;
        const safeModel = /[",\r\n]/.test(text)
          ? `"${text.replace(/"/g, '""')}"`
          : text;
        lines.push(
          [
            tier,
            bucket.period,
            safeModel,
            totals.inputTokens,
            totals.outputTokens,
            totals.requests,
          ].join(","),
        );
      }
    }
  }
  return lines.join("\n") + "\n";
}
