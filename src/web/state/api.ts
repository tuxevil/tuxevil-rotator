// Typed client for the admin API. Auth rides on the HttpOnly session cookie,
// so no token is ever handled in page JavaScript.

import type { AccountTier, Config, SpendLog, VirtualKey } from "../../types.js";
import type {
  ActivityResponse,
  DashboardSnapshot,
  SessionInfo,
  UsageRange,
  UsageResponse,
} from "../../dashboard-types.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown = null,
  ) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};

export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

function messageFrom(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (Array.isArray(record.errors) && record.errors.length > 0) return record.errors.join("; ");
  if (typeof record.error === "string") return record.error;
  if (typeof record.message === "string") return record.message;
  return null;
}

interface RequestOptions {
  /** Return bodies with `ok: false` instead of throwing (partial results). */
  allowNotOk?: boolean;
  /** Do not treat 401 as a signed-out session. */
  ignoreUnauthorized?: boolean;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "The rotator is not reachable.");
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (res.status === 401 && !options.ignoreUnauthorized) {
    onUnauthorized();
    throw new ApiError(401, "Your session ended. Sign in again.", data);
  }
  const notOk = data !== null && typeof data === "object" && (data as { ok?: unknown }).ok === false;
  if (!res.ok || (notOk && !options.allowNotOk)) {
    throw new ApiError(res.status, messageFrom(data) || `Request failed (HTTP ${res.status})`, data);
  }
  return data as T;
}

const enc = encodeURIComponent;

export interface KickstartResult {
  ok: boolean;
  error?: string;
  results?: Array<{ ok: boolean; upstreamModel?: string; status?: number }>;
}

export interface ModelCatalogEntry {
  id: string;
  owned_by?: string;
}

export interface SpendSummary {
  totalRequests: number;
  promptTokens: number;
  completionTokens: number;
  avgLatencyMs: number;
  totalCost: number;
}

export interface SpendByKeyRow {
  apiKeyHash: string;
  keyAlias?: string | null;
  keyName?: string | null;
  totalRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  avgDurationMs: number;
  totalCost: number;
  lastSeen: string | null;
}

export interface SpendQuery {
  keyHash?: string;
  model?: string;
  status?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export const api = {
  session: () => request<SessionInfo>("GET", "/api/session", undefined, { ignoreUnauthorized: true }),
  signIn: (token: string) =>
    request<{ ok: true }>("POST", "/api/session", { token }, { ignoreUnauthorized: true }),
  signOut: () => request<{ ok: true }>("DELETE", "/api/session"),

  snapshot: () => request<DashboardSnapshot>("GET", "/api/dashboard/snapshot"),
  usage: (range: UsageRange) => request<UsageResponse>("GET", `/api/dashboard/usage?range=${range}`),
  activity: () => request<ActivityResponse>("GET", "/api/dashboard/activity"),

  enable: (email: string) => request("POST", `/api/enable/${enc(email)}`),
  disable: (email: string) => request("POST", `/api/disable/${enc(email)}`),
  quarantine: (email: string) => request("POST", `/api/quarantine/${enc(email)}`),
  restore: (email: string) => request("POST", `/api/restore/${enc(email)}`),
  remove: (email: string) => request("POST", `/api/remove-account/${enc(email)}`),
  setTier: (email: string, tier: AccountTier) =>
    request("POST", `/api/set-tier/${enc(email)}/${enc(tier)}`),
  setAccountFreshOverride: (email: string, on: boolean) =>
    request("POST", `/api/account-fresh-window-starts/${enc(email)}/${on ? "on" : "off"}`),
  kickstart: (email: string, modelKey?: string) =>
    request<KickstartResult>(
      "POST",
      modelKey ? `/api/kickstart/${enc(email)}/${enc(modelKey)}` : `/api/kickstart/${enc(email)}`,
      undefined,
      { allowNotOk: true },
    ),
  clearInFlight: (email: string, modelKey: string) =>
    request("POST", `/api/clear-inflight/${enc(email)}/${enc(modelKey)}`),
  clearBreaker: (model?: string) =>
    request("POST", `/api/clear-breaker/${model ? enc(model) : "all"}`),
  setFreshWindows: (on: boolean) =>
    request("POST", `/api/settings/fresh-window-starts/${on ? "on" : "off"}`),
  setAutoWarmup: (on: boolean) => request("POST", `/api/settings/auto-warmup/${on ? "on" : "off"}`),
  selfUpdate: () =>
    request<{ ok: boolean; to?: string; message?: string }>("POST", "/api/self-update", undefined, {
      allowNotOk: true,
    }),

  config: () => request<Config>("GET", "/api/config"),
  saveConfig: (config: unknown) => request<{ ok: true }>("PUT", "/api/config", config),
  importConfig: (config: unknown) =>
    request<{ ok: true; importedAccounts: number }>("POST", "/api/config/import", config),

  keys: () => request<{ ok: true; keys: VirtualKey[] }>("GET", "/api/keys"),
  generateKey: (input: { alias: string; userId: string | null; models: string[] }) =>
    request<{ ok: true; rawKey: string }>("POST", "/api/keys/generate", input),
  updateKey: (hash: string, patch: { models?: string[]; blocked?: boolean }) =>
    request<{ ok: true; key: VirtualKey }>("PUT", `/api/keys/${enc(hash)}`, patch),
  deleteKey: (hash: string) => request("DELETE", `/api/keys/${enc(hash)}`),
  models: () => request<{ ok: true; data: ModelCatalogEntry[] }>("GET", "/api/models"),

  spendLogs: (q: SpendQuery) =>
    request<{ ok: true; logs: SpendLog[]; total: number; summary: SpendSummary }>(
      "GET",
      `/api/spend/logs${query({ ...q })}`,
    ),
  spendByKey: (q: SpendQuery) =>
    request<{ ok: true; byKey: SpendByKeyRow[] }>(
      "GET",
      `/api/spend/by-key${query({
        apiKeyHash: q.keyHash,
        model: q.model,
        status: q.status,
        startDate: q.startDate,
        endDate: q.endDate,
      })}`,
    ),
};

export type BenchmarkEvent =
  | { type: "start"; total: number; model?: string }
  | { type: "progress"; completed: number; total: number; result: BenchmarkResult }
  | { type: "complete"; summary: BenchmarkSummary; results: BenchmarkResult[] }
  | { type: "error"; error: string };

/** Mirrors BenchmarkResult in src/proxy.ts. */
export interface BenchmarkResult {
  account: string;
  status: "success" | "failed" | "skipped";
  latencyMs: number | null;
  ttfbMs: number | null;
  outputTokens: number | null;
  tokensPerSecond: number | null;
  error?: string;
}

/** Mirrors BenchmarkSummary in src/proxy.ts. */
export interface BenchmarkSummary {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  successRate: number;
  averageLatencyMs: number | null;
  averageTtfbMs: number | null;
  averageTokensPerSecond: number | null;
}

/** Streams benchmark progress (server-sent events over a POST response). */
export async function runBenchmark(onEvent: (event: BenchmarkEvent) => void): Promise<void> {
  const res = await fetch("/api/benchmark", { method: "POST", credentials: "same-origin" });
  if (res.status === 401) {
    onUnauthorized();
    throw new ApiError(401, "Your session ended. Sign in again.");
  }
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      message = messageFrom(await res.json()) || message;
    } catch {
      // keep HTTP status
    }
    throw new ApiError(res.status, message);
  }
  if (!res.body) throw new ApiError(0, "Benchmark stream unavailable");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const consume = (text: string) => {
    buffer += text;
    const chunks = buffer.split(/\r?\n\r?\n/);
    buffer = chunks.pop() || "";
    for (const chunk of chunks) {
      const data = chunk
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data) continue;
      try {
        onEvent(JSON.parse(data) as BenchmarkEvent);
      } catch {
        // ignore malformed frames
      }
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    consume(decoder.decode(value, { stream: true }));
  }
  consume(decoder.decode());
}
