// Dashboard development server.
//
// Runs the real proxy routes (auth, /api/dashboard/*, the live stream, the
// esbuild bundle) against a simulated rotator with ~16 accounts and live
// traffic, so the dashboard can be built and checked without provider
// credentials. The PostgreSQL-backed routes (virtual keys, spend history,
// benchmark) are answered with fixtures.
//
//   npx tsx scripts/dashboard-dev.ts
//
// Env: MOCK_PORT (default 8899), MOCK_TOKEN (default "dev-token"; empty for
// no auth), MOCK_DB=0 to simulate a rotator without PostgreSQL,
// MOCK_SCENARIO=healthy|degraded|paused|empty|large (default degraded).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

process.env.TUXEVIL_ROTATOR_DASHBOARD_DEV ??= "1";
process.env.PI_ROTATOR_TELEMETRY = "off";
const PORT = Number(process.env.MOCK_PORT || process.env.PORT || 8899);
const TOKEN = process.env.MOCK_TOKEN ?? "dev-token";
const DB = process.env.MOCK_DB !== "0";
const SCENARIO = process.env.MOCK_SCENARIO || "degraded";
if (DB) process.env.DATABASE_URL = "postgres://mock@localhost/mock";
else delete process.env.DATABASE_URL;

const { setPersistedAdminToken } = await import("../src/admin-auth.js");
const { startProxy } = await import("../src/proxy.js");
setPersistedAdminToken(TOKEN || null);

const M = 60_000;
const H = 60 * M;
let seed = 7;
const rand = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
const iso = (ms: number) => new Date(ms).toISOString();
const pad = (n: number) => String(n).padStart(2, "0");
const minuteKey = (t: number) => {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

type Quota = { modelKey: string; displayName: string; providerId: string; percentRemaining: number; resetTime: string | null; timerType: "fresh" | "5h" | "7d" | "monthly" };

const NAMES = ["Atlas", "Borealis", "Cobalt", "Delta", "Ember", "Fjord", "Granite", "Halcyon", "Iris", "Juniper", "Kestrel", "Lumen", "Meridian", "Nimbus", "Onyx", "Pioneer", "Quartz", "Raven", "Sierra", "Tundra"];
const PROVIDERS = ["google-antigravity", "google-antigravity", "google-antigravity", "ollama", "openai-codex", "google-antigravity", "opencode-zen", "google-antigravity+ollama"];
const TIERS = ["ultra", "pro", "pro", "plus", "free", "unknown"];

const count = SCENARIO === "empty" ? 0 : SCENARIO === "large" ? 40 : 16;
const now = () => Date.now();

function quotaFor(provider: string, i: number): Quota[] {
  const pct = () => 15 + Math.round(rand() * 85);
  const out: Quota[] = [];
  const ids = provider.split("+");
  if (ids.includes("google-antigravity")) {
    out.push(
      { modelKey: "claude", displayName: "Claude", providerId: "google-antigravity", percentRemaining: SCENARIO !== "healthy" && i % 5 === 0 ? 0 : pct(), resetTime: iso(now() + (1 + rand() * 4) * H), timerType: i % 4 === 1 ? "fresh" : "5h" },
      { modelKey: "gemini", displayName: "Gemini", providerId: "google-antigravity", percentRemaining: pct(), resetTime: iso(now() + rand() * 6 * 24 * H), timerType: "7d" },
    );
  }
  if (ids.includes("ollama")) {
    out.push(
      { modelKey: "session", displayName: "Session", providerId: "ollama", percentRemaining: pct(), resetTime: iso(now() + 3 * H), timerType: "5h" },
      { modelKey: "weekly", displayName: "Weekly", providerId: "ollama", percentRemaining: pct(), resetTime: iso(now() + 4 * 24 * H), timerType: "7d" },
    );
  }
  if (ids.includes("openai-codex")) {
    out.push({ modelKey: "openai-codex", displayName: "Codex", providerId: "openai-codex", percentRemaining: pct(), resetTime: iso(now() + 2 * H), timerType: "5h" });
  }
  if (ids.includes("opencode-zen")) {
    out.push({ modelKey: "opencode-zen", displayName: "OpenCode", providerId: "opencode-zen", percentRemaining: pct(), resetTime: null, timerType: "monthly" });
  }
  return out;
}

const STATUS_PLAN: Record<string, string[]> = {
  healthy: ["ready"],
  degraded: ["ready", "ready", "ready", "cooldown", "ready", "ready", "ready", "error", "ready", "ready", "disabled", "flagged", "ready", "ready", "ready", "ready"],
  paused: ["cooldown", "ready", "flagged", "ready"],
  large: ["ready", "ready", "ready", "ready", "cooldown", "ready", "error", "ready", "ready", "ready"],
  empty: ["ready"],
};

interface MockAccount {
  email: string;
  label: string;
  provider: string;
  status: string;
  tier: string;
  quota: Quota[];
  totalRequests: number;
  requestsSinceRotation: number;
  lastUsed: number;
  lastError: string | null;
  consecutiveErrors: number;
  cooldownsByModel: Record<string, number>;
  inFlightByModel: Record<string, number>;
  healthScore: number;
  allowFreshWindowStartsOverride: boolean;
  dailyRequestCount: number;
}

const accounts: MockAccount[] = Array.from({ length: count }, (_, i) => {
  const provider = PROVIDERS[i % PROVIDERS.length];
  const plan = STATUS_PLAN[SCENARIO] ?? STATUS_PLAN.degraded;
  const status = plan[i % plan.length];
  const name = NAMES[i % NAMES.length] + (i >= NAMES.length ? ` ${Math.floor(i / NAMES.length) + 1}` : "");
  return {
    email: `${name.toLowerCase().replace(/ /g, "")}@demo.example`,
    label: name,
    provider,
    status,
    tier: TIERS[i % TIERS.length],
    quota: quotaFor(provider, i),
    totalRequests: 40 + Math.round(rand() * 900),
    requestsSinceRotation: Math.round(rand() * 4),
    lastUsed: now() - Math.round(rand() * 3 * H),
    lastError:
      status === "error"
        ? "HTTP 429 RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'Generate Content API requests per minute' and limit 'GenerateContent request limit per minute for a region'"
        : status === "flagged"
          ? "Account requires verification before continuing (HTTP 403 VALIDATION_REQUIRED)"
          : status === "disabled"
            ? "invalid_grant: Token has been expired or revoked."
            : null,
    consecutiveErrors: status === "error" ? 3 : 0,
    cooldownsByModel: (status === "cooldown" ? { claude: now() + 14 * M } : {}) as Record<string, number>,
    inFlightByModel: {},
    healthScore: status === "error" ? 0.31 : 0.55 + rand() * 0.45,
    allowFreshWindowStartsOverride: i === 2,
    dailyRequestCount: Math.round(rand() * 200),
  };
});

const controls = { allowFreshWindowStarts: true, autoWarmupEnabled: false };
const startedAt = now() - (3 * 24 * H + 4 * H + 12 * M);
const breakers: Record<string, number> = SCENARIO === "degraded" ? { "openai-codex": now() + 26 * M } : {};
let pauseUntil = SCENARIO === "paused" ? now() + 5 * H + 12 * M : 0;
let config: Record<string, unknown> = {
  accounts: accounts.map((a) => ({ email: a.email, label: a.label, tier: a.tier, credentials: [{ provider: a.provider.split("+")[0], refreshToken: "1//mock-refresh-token" }] })),
  requestsPerRotation: 5,
  proxyPort: PORT,
  routingPolicy: "timer-first",
  rotateOnQuotaDrop: 0,
  quotaPollIntervalMs: 300_000,
  maxConcurrentRequestsPerAccount: 5,
};

const MODELS = ["claude-sonnet-4-6", "claude-opus-4-6-thinking", "gemini-3.1-pro-high", "gemini-3.6-flash-high", "gpt-oss-120b-medium", "glm-5.1", "gpt-5.6-terra", "big-pickle"];
const WEIGHTS = [0.28, 0.08, 0.2, 0.18, 0.08, 0.08, 0.06, 0.04];
type Bucket = { period: string; inputTokens: number; outputTokens: number; requests: number; byModel: Record<string, { inputTokens: number; outputTokens: number; requests: number }> };
const add = (b: Bucket, model: string, input: number, output: number, requests: number) => {
  const e = (b.byModel[model] ??= { inputTokens: 0, outputTokens: 0, requests: 0 });
  e.inputTokens += input;
  e.outputTokens += output;
  e.requests += requests;
  b.inputTokens += input;
  b.outputTokens += output;
  b.requests += requests;
};
const pickModel = () => {
  let x = rand();
  for (let i = 0; i < MODELS.length; i++) {
    x -= WEIGHTS[i];
    if (x <= 0) return MODELS[i];
  }
  return MODELS[0];
};
const rhythm = (t: number) => {
  const d = new Date(t);
  const h = d.getHours() + d.getMinutes() / 60;
  const daily = 0.15 + 0.85 * Math.max(0, Math.sin(((h - 7) / 16) * Math.PI));
  return daily * (d.getDay() === 0 || d.getDay() === 6 ? 0.45 : 1);
};
function fill(period: string, mean: number, scale = 1): Bucket {
  const b: Bucket = { period, inputTokens: 0, outputTokens: 0, requests: 0, byModel: {} };
  const n = count === 0 ? 0 : Math.max(0, Math.round(mean * (0.6 + rand() * 0.8)));
  for (let i = 0; i < n; i++) add(b, pickModel(), Math.round((6000 + rand() * rand() * 90000) * scale), Math.round((250 + rand() * 2200) * scale), scale);
  return b;
}
const minutes: Bucket[] = [];
for (let k = 12 * 60 - 1; k >= 1; k--) minutes.push(fill(minuteKey(now() - k * M), 6 * rhythm(now() - k * M)));
const hours: Bucket[] = [];
for (let k = 60 * 24 - 1; k >= 12; k--) hours.push(fill(minuteKey(now() - k * H).slice(0, 13), 6 * rhythm(now() - k * H), 60));

type LogEntry = { timestamp: number; model: string; account: string; statusCode: number; ttfbMs: number; totalMs: number; inputTokens: number; outputTokens: number };
const requestLog: LogEntry[] = [];
const events: Array<{ timestamp: number; source: "rotator" | "proxy"; level: "info" | "warn" | "error"; message: string }> = [];
function pushEvent(source: "rotator" | "proxy", level: "info" | "warn" | "error", message: string) {
  events.unshift({ timestamp: now(), source, level, message });
  events.length = Math.min(events.length, 40);
}

function servable(a: MockAccount) {
  return a.status === "ready" || a.status === "active";
}

function simulateRequest() {
  const candidates = accounts.filter(servable);
  if (candidates.length === 0 || pauseUntil > now()) return;
  const account = pick(candidates);
  const model = pickModel();
  const fail = rand() < 0.07;
  const statusCode = fail ? pick([429, 429, 500, 503]) : 200;
  const input = Math.round(6000 + rand() * rand() * 90000);
  const output = fail ? 0 : Math.round(250 + rand() * 2200);
  const ttfb = Math.round(300 + rand() * 1500);
  requestLog.unshift({ timestamp: now(), model, account: account.email, statusCode, ttfbMs: ttfb, totalMs: ttfb + Math.round(rand() * 9000), inputTokens: input, outputTokens: output });
  requestLog.length = Math.min(requestLog.length, 100);
  account.totalRequests += 1;
  account.requestsSinceRotation += 1;
  account.lastUsed = now();
  const key = minuteKey(now());
  let bucket = minutes[minutes.length - 1];
  if (!bucket || bucket.period !== key) {
    bucket = { period: key, inputTokens: 0, outputTokens: 0, requests: 0, byModel: {} };
    minutes.push(bucket);
  }
  add(bucket, model, input, output, 1);
  const pool = account.quota.find((q) => q.modelKey === (model.startsWith("claude") || model.startsWith("gpt-oss") ? "claude" : model.startsWith("gemini") ? "gemini" : ""));
  if (pool && pool.percentRemaining > 0 && rand() < 0.3) pool.percentRemaining -= 1;
  if (fail) pushEvent("proxy", statusCode === 429 ? "warn" : "error", `[${model}] ${statusCode} from upstream for ${account.email}`);
  else if (rand() < 0.15) pushEvent("rotator", "info", `[${model}] Rotated to ${account.email} (quota ${pool?.percentRemaining ?? 100}%)`);
}

function activeFor(account: MockAccount): string[] {
  const pools = new Set(account.quota.map((q) => q.modelKey));
  const served: string[] = [];
  for (const key of pools) {
    const holder = accounts.filter(servable).find((a) => a.quota.some((q) => q.modelKey === key && q.percentRemaining > 0));
    if (holder === account) served.push(key);
  }
  return served;
}

function getStatus() {
  const t = now();
  const statusOf = (a: MockAccount) => (a.status === "ready" && activeFor(a).length > 0 ? "active" : a.status);
  const accountStatuses = accounts.map((a) => ({
    email: a.email,
    label: a.label,
    provider: a.provider,
    status: statusOf(a),
    activeForModels: activeFor(a),
    requestsSinceRotation: a.requestsSinceRotation,
    totalRequests: a.totalRequests,
    dailyRequestCount: a.dailyRequestCount,
    dailyAccountStopRequests: 350,
    dailyProjectRequestCount: a.dailyRequestCount * 2,
    dailyProjectStopRequests: 1200,
    cooldownsByModel: a.cooldownsByModel,
    lastUsed: a.lastUsed,
    lastError: a.lastError,
    consecutiveErrors: a.consecutiveErrors,
    hasValidToken: a.status !== "disabled",
    quota: a.quota,
    inFlightRequests: Object.values(a.inFlightByModel).reduce((s, v) => s + v, 0),
    inFlightByModel: a.inFlightByModel,
    proDetected: false,
    tier: a.tier,
    healthScore: a.healthScore,
    tokenBucket: { enabled: false, tokens: 5, capacity: 5, nextRefillInMs: 0 },
    allowFreshWindowStartsOverride: a.allowFreshWindowStartsOverride,
    effectiveFreshWindowStartsAllowed: controls.allowFreshWindowStarts || a.allowFreshWindowStartsOverride,
  }));
  const pools = [...new Set(accounts.flatMap((a) => a.quota.map((q) => q.modelKey)))];
  const routingDiagnostics: Record<string, unknown> = {};
  const activeAccounts: Record<string, string> = {};
  for (const key of pools) {
    const entries = accounts
      .filter((a) => a.quota.some((q) => q.modelKey === key))
      .map((a) => {
        const q = a.quota.find((x) => x.modelKey === key)!;
        const rejectedReason =
          a.status === "disabled" ? "disabled" : a.status === "flagged" ? "flagged" : a.status === "cooldown" ? "cooldown" : breakers[key] > t ? "model-breaker" : q.percentRemaining <= 0 ? "quota-zero" : !controls.allowFreshWindowStarts && q.timerType === "fresh" && !a.allowFreshWindowStartsOverride ? "fresh-window-blocked" : null;
        return {
          email: a.email,
          label: a.label,
          status: statusOf(a),
          score: rejectedReason ? null : Math.round((q.percentRemaining / 10 + a.healthScore * 5) * 10) / 10,
          timerPriority: q.timerType === "5h" ? 1 : q.timerType === "7d" ? 2 : 3,
          quota: q.percentRemaining,
          tier: a.tier,
          healthScore: a.healthScore,
          healthBreakdown: { quotaComponent: q.percentRemaining / 100, errorPenalty: a.consecutiveErrors * 0.1, cooldownPenalty: a.status === "cooldown" ? 0.2 : 0, availabilityPenalty: 0, score: a.healthScore },
          distance: null,
          tokenBucket: { enabled: false, tokens: 5, capacity: 5, nextRefillInMs: 0 },
          rejectedReason,
          rejectedDetail: rejectedReason === "cooldown" ? "Retry window after a provider 429" : null,
        };
      });
    const eligible = entries.filter((e) => !e.rejectedReason).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const selected = pauseUntil > t ? null : eligible[0]?.email ?? null;
    // Like the rotator: the account currently serving the pool, which the
    // policy's pick may not be until the next rotation.
    const holder = accounts.find((a) => activeFor(a).includes(key));
    if (holder) activeAccounts[key] = holder.email;
    routingDiagnostics[key] = {
      modelKey: key,
      policy: config.routingPolicy,
      selectedEmail: selected,
      reason: selected ? `Selected by ${config.routingPolicy}` : pauseUntil > t ? "Protective pause is active" : breakers[key] > t ? "Model circuit breaker is open" : "Every candidate is out of quota or unavailable",
      availableCandidates: eligible.length,
      rejectedCandidates: entries.length - eligible.length,
      accounts: entries,
    };
  }
  const counts = (s: string) => accountStatuses.filter((a) => a.status === s).length;
  const available = counts("active") + counts("ready");
  const state = pauseUntil > t ? "paused" : available === 0 ? (counts("cooldown") > 0 ? "cooldown_wait" : "stopped") : "healthy";
  const totals = [...minutes, ...hours].reduce((acc, b) => ({ input: acc.input + b.inputTokens, output: acc.output + b.outputTokens, requests: acc.requests + b.requests }), { input: 0, output: 0, requests: 0 });
  return {
    version: "3.10.0",
    proxyPort: PORT,
    requestsPerRotation: config.requestsPerRotation,
    maxConcurrentRequestsPerAccount: config.maxConcurrentRequestsPerAccount,
    totalRequestsAllAccounts: accounts.reduce((s, a) => s + a.totalRequests, 0),
    uptime: t - startedAt,
    activeAccounts,
    accounts: accountStatuses,
    protectivePauseUntil: pauseUntil,
    protectivePauseRemaining: Math.max(0, pauseUntil - t),
    protectivePauseReason: pauseUntil > t ? "Provider returned 'account suspended' for a Google account; holding all traffic." : null,
    operatorControls: controls,
    security: { adminTokenConfigured: Boolean(TOKEN), warning: null, bindHost: "127.0.0.1" },
    routingDiagnostics,
    ollamaModels: ["glm-5.1", "gpt-oss:120b"],
    codexModels: ["gpt-5.6-terra"],
    modelTierAccess: SCENARIO === "degraded" ? { "gpt-oss:120b": "free", "gemma4:31b": "free", "glm-5.1": "subscription", "kimi-k3": "subscription" } : undefined,
    predictions: {},
    circuitBreakers: {
      model: Object.fromEntries(Object.entries(breakers).filter(([, u]) => u > t).map(([k, u]) => [k, { until: u, remainingMs: u - t }])),
      project: {},
    },
    routingHealth: {
      state,
      reason: state === "healthy" ? `${available} accounts can serve requests` : state === "paused" ? "Protective pause after a provider flag" : "No account can serve right now",
      nextRetryIn: state === "healthy" ? 0 : 14 * M,
      availableCount: available,
      readyCount: counts("ready"),
      activeCount: counts("active"),
      cooldownCount: counts("cooldown"),
      busyCount: 0,
      flaggedCount: counts("flagged"),
      disabledCount: counts("disabled"),
      errorCount: counts("error"),
    },
    recentEvents: events.slice(),
    requestLog: requestLog.slice(),
    tokenUsage: {
      minutes: minutes.slice(-720),
      hours,
      days: [],
      months: [],
      totalInputTokens: totals.input,
      totalOutputTokens: totals.output,
      totalRequests: totals.requests,
      tokensByModel: {},
      savings: { totalUsd: totals.input / 1e6 * 2.2 + totals.output / 1e6 * 11, byModel: {} },
    },
    latencyStats: Object.fromEntries(MODELS.slice(0, 6).map((m, i) => [m, { ttfb: { p50: 400 + i * 120, p95: 1800 + i * 900 }, total: { p50: 4200 + i * 600, p95: 14000 + i * 4000 }, count: 40 + i * 13 }])),
    updateInfo: { currentVersion: "3.10.0", latestVersion: "3.11.0", updateAvailable: SCENARIO === "degraded", checkedAt: t },
    notifications: [],
    hostedOAuthConfigured: false,
  };
}

let onChange: () => void = () => {};
const byEmail = (email: string) => accounts.find((a) => a.email === email);
const touch = () => onChange();

const rotator = {
  saveState: () => Promise.resolve(),
  getStatus,
  getTokenUsage: () => getStatus().tokenUsage,
  getLatencyStats: () => getStatus().latencyStats,
  getPublicConfig: () => structuredClone(config),
  replaceConfig: async (next: Record<string, unknown>) => {
    config = next;
    touch();
  },
  enableAccount: async (email: string) => {
    const a = byEmail(email);
    if (!a) return false;
    a.status = "ready";
    a.lastError = null;
    touch();
    return true;
  },
  disableAccount: async (email: string) => {
    const a = byEmail(email);
    if (!a) return false;
    a.status = "disabled";
    touch();
    return true;
  },
  quarantineAccount: async (email: string) => {
    const a = byEmail(email);
    if (!a) return false;
    a.status = "flagged";
    touch();
    return true;
  },
  restoreAccount: async (email: string) => {
    const a = byEmail(email);
    if (!a) return false;
    a.status = "ready";
    a.lastError = null;
    touch();
    return true;
  },
  removeAccount: async (email: string) => {
    const i = accounts.findIndex((a) => a.email === email);
    if (i < 0) return false;
    accounts.splice(i, 1);
    touch();
    return true;
  },
  setAccountTier: async (email: string, tier: string) => {
    const a = byEmail(email);
    if (!a) return false;
    a.tier = tier;
    touch();
    return true;
  },
  setAllowFreshWindowStarts: async (on: boolean) => {
    controls.allowFreshWindowStarts = on;
    touch();
    return true;
  },
  setAutoWarmup: async (on: boolean) => {
    controls.autoWarmupEnabled = on;
    touch();
    return true;
  },
  setAccountAllowFreshWindowStartsOverride: async (email: string, on: boolean) => {
    const a = byEmail(email);
    if (!a) return false;
    a.allowFreshWindowStartsOverride = on;
    touch();
    return true;
  },
  clearInFlightRequests: (email: string, modelKey?: string) => {
    const a = byEmail(email);
    if (!a) return false;
    if (modelKey) delete a.inFlightByModel[modelKey];
    else a.inFlightByModel = {};
    touch();
    return true;
  },
  clearModelBreaker: async (model: string) => {
    delete breakers[model];
    touch();
  },
  clearAllBreakers: async () => {
    for (const key of Object.keys(breakers)) delete breakers[key];
    pauseUntil = 0;
    touch();
  },
  kickstartTimerForAccount: async (email: string, modelKey: string) => {
    const q = byEmail(email)?.quota.find((x) => x.modelKey === modelKey);
    if (q) {
      q.timerType = "5h";
      q.resetTime = iso(now() + 5 * H);
    }
    touch();
    return { ok: true, results: [{ ok: true, upstreamModel: modelKey, status: 200 }] };
  },
  kickstartAllFreshTimers: async (email: string) => {
    const idle = byEmail(email)?.quota.filter((q) => q.timerType === "fresh") ?? [];
    for (const q of idle) {
      q.timerType = "5h";
      q.resetTime = iso(now() + 5 * H);
    }
    touch();
    return { ok: true, results: idle.map((q) => ({ ok: true, upstreamModel: q.modelKey, status: 200 })) };
  },
  recordProxyEvent: (message: string) => pushEvent("proxy", "info", message),
};

// ── Fixtures for PostgreSQL-backed routes ────────────────────────────────

const keys = ["cursor-laptop", "claude-code", "ci-runner", "open-webui"].map((alias, i) => ({
  tokenHash: `hash${i}${"0".repeat(56)}`,
  keyName: `rk-${"a1b2c3d4".slice(0, 4)}…${String(i).padStart(4, "0")}`,
  keyAlias: alias,
  userId: i === 0 ? "alex" : null,
  models: i === 2 ? ["gemini-3.6-flash-high", "gpt-oss-120b-medium"] : [],
  blocked: i === 3,
  lastActive: iso(now() - i * 3 * H),
  createdAt: iso(now() - 20 * 24 * H),
}));

const spendLogs = Array.from({ length: 63 }, (_, i) => {
  const model = pickModel();
  const ok = rand() > 0.08;
  const prompt = Math.round(6000 + rand() * 60000);
  const completion = ok ? Math.round(200 + rand() * 2000) : 0;
  const created = now() - i * 7 * M;
  return {
    requestId: `req_${(1000 + i).toString(36)}${Math.round(rand() * 1e6).toString(36)}`,
    apiKeyHash: keys[i % keys.length].tokenHash,
    keyAlias: keys[i % keys.length].keyAlias,
    keyName: keys[i % keys.length].keyName,
    model,
    accountEmail: pick(accounts)?.email ?? null,
    callType: pick(["openai", "anthropic", "responses", "native"]),
    status: ok ? "success" : "failure",
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: prompt + completion,
    cost: (prompt / 1e6) * 3 + (completion / 1e6) * 15,
    startTime: iso(created),
    endTime: iso(created + 4000),
    ttfbMs: Math.round(300 + rand() * 1200),
    durationMs: Math.round(2000 + rand() * 9000),
    requestMessages: { messages: [{ role: "user", content: "Summarize the attached diff and list risky changes." }], max_tokens: 2048 },
    responseContent: ok ? { role: "assistant", content: "The diff renames the session cookie and adds an origin check…" } : { error: "upstream 429" },
    metadata: { stream: true, effort: "medium" },
    requesterIp: "192.168.1.24",
    createdAt: iso(created),
  };
});

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
  } catch {
    return {};
  }
}

const { isAdminAuthorized } = await import("../src/admin-auth.js");

async function mockRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url || "/", "http://localhost");
  const path = url.pathname;
  const method = req.method || "GET";
  const isMocked = path === "/api/models" || path.startsWith("/api/keys") || path.startsWith("/api/spend/") || path === "/api/benchmark";
  if (!isMocked) return false;
  if (!isAdminAuthorized(req)) {
    json(res, 401, { error: "Unauthorized" });
    return true;
  }
  if (path === "/api/models") {
    json(res, 200, { ok: true, data: [...MODELS, "gemini-3.8-flash-low", "kimi-k3", "gpt-oss:20b"].map((id) => ({ id, owned_by: id.startsWith("glm") || id.includes(":") || id.startsWith("kimi") ? "ollama" : id.startsWith("gpt-5") ? "openai-codex" : id === "big-pickle" ? "opencode-zen" : "tuxevil-rotator" })) });
    return true;
  }
  if (path === "/api/benchmark" && method === "POST") {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const targets = accounts.filter(servable).slice(0, 6);
    const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    send({ type: "start", total: targets.length, model: "gemini-3.6-flash" });
    const results: unknown[] = [];
    for (const [i, a] of targets.entries()) {
      await new Promise((r) => setTimeout(r, 350));
      const ok = rand() > 0.15;
      const result = { account: a.email, status: ok ? "success" : "failed", latencyMs: ok ? 800 + rand() * 1500 : null, ttfbMs: ok ? 300 + rand() * 500 : null, outputTokens: ok ? 32 : null, tokensPerSecond: ok ? 20 + rand() * 40 : null, ...(ok ? {} : { error: "HTTP 429 from upstream" }) };
      results.push(result);
      send({ type: "progress", completed: i + 1, total: targets.length, result });
    }
    send({ type: "complete", results, summary: { total: targets.length, succeeded: results.filter((r) => (r as { status: string }).status === "success").length, failed: results.filter((r) => (r as { status: string }).status !== "success").length, skipped: 0, successRate: 85, averageLatencyMs: 1500, averageTtfbMs: 520, averageTokensPerSecond: 31 } });
    res.end();
    return true;
  }
  if (path === "/api/keys" && method === "GET") {
    json(res, 200, { ok: true, keys });
    return true;
  }
  if (path === "/api/keys/generate" && method === "POST") {
    const body = await readBody(req);
    const key = { tokenHash: `hash${keys.length}${"0".repeat(56)}`, keyName: `rk-new…${keys.length}`, keyAlias: String(body.alias), userId: (body.userId as string) ?? null, models: (body.models as string[]) ?? [], blocked: false, lastActive: null, createdAt: iso(now()) };
    keys.push(key as never);
    json(res, 201, { ok: true, rawKey: `rk-${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`, key });
    return true;
  }
  if (path.startsWith("/api/keys/")) {
    const hash = decodeURIComponent(path.slice("/api/keys/".length));
    const index = keys.findIndex((k) => k.tokenHash === hash);
    if (index < 0) {
      json(res, 404, { ok: false, error: "Virtual key not found" });
      return true;
    }
    if (method === "PUT") {
      Object.assign(keys[index], await readBody(req));
      json(res, 200, { ok: true, key: keys[index] });
    } else if (method === "DELETE") {
      keys.splice(index, 1);
      json(res, 200, { ok: true });
    } else json(res, 200, { ok: true, key: keys[index] });
    return true;
  }
  if (path === "/api/spend/logs") {
    const status = url.searchParams.get("status");
    const filtered = spendLogs.filter((l) => !status || l.status === status);
    const limit = Number(url.searchParams.get("limit") || 25);
    const offset = Number(url.searchParams.get("offset") || 0);
    const sum = (k: "promptTokens" | "completionTokens" | "cost" | "durationMs") => filtered.reduce((s, l) => s + (l[k] as number), 0);
    json(res, 200, { ok: true, logs: filtered.slice(offset, offset + limit), total: filtered.length, summary: { totalRequests: filtered.length, promptTokens: sum("promptTokens"), completionTokens: sum("completionTokens"), avgLatencyMs: Math.round(sum("durationMs") / Math.max(1, filtered.length)), totalCost: sum("cost") } });
    return true;
  }
  if (path === "/api/spend/by-key") {
    json(res, 200, {
      ok: true,
      byKey: keys.map((k) => {
        const logs = spendLogs.filter((l) => l.apiKeyHash === k.tokenHash);
        return { apiKeyHash: k.tokenHash, keyAlias: k.keyAlias, keyName: k.keyName, totalRequests: logs.length, totalPromptTokens: logs.reduce((s, l) => s + l.promptTokens, 0), totalCompletionTokens: logs.reduce((s, l) => s + l.completionTokens, 0), totalDurationMs: 0, avgDurationMs: 5400, totalCost: logs.reduce((s, l) => s + l.cost, 0), firstSeen: logs.at(-1)?.createdAt ?? null, lastSeen: logs[0]?.createdAt ?? null };
      }),
    });
    return true;
  }
  return false;
}

const proxy = startProxy(rotator as never, 0, "127.0.0.1");
await once(proxy, "listening");
const proxyPort = (proxy.address() as AddressInfo).port;
const proxyHandler = proxy.listeners("request")[0] as (req: IncomingMessage, res: ServerResponse) => void;
onChange = () => void rotator.saveState();

// Forward everything else to the real proxy handler in-process.
const server = createServer((req, res) => {
  void mockRoute(req, res).then((handled) => {
    if (!handled) proxyHandler(req, res);
  });
});
server.listen(PORT, "127.0.0.1", () => {
  const link = `http://localhost:${PORT}/dashboard${TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ""}`;
  console.log(`\nDashboard dev server (${SCENARIO}${DB ? "" : ", no database"}): ${link}\n(internal proxy on :${proxyPort})\n`);
});

if (count > 0) {
  setInterval(() => {
    const burst = Math.round(rand() * 3 * Math.max(0.3, rhythm(now())));
    for (let i = 0; i < burst; i++) simulateRequest();
    if (burst > 0) onChange();
  }, 2000);
}
