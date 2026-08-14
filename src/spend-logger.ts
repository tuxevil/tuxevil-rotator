import randomBytes from "node:crypto";
import { MODEL_PRICING, type SpendLog, type DailySpend } from "./types.js";
import { isDbConfigured, queryDb } from "./db-store.js";
import { rotatorEnv } from "./env.js";

const FLUSH_INTERVAL_MS = 5_000;
const MAX_QUEUE_SIZE = 50;
const DEFAULT_KEY_HASH_LABEL = "unauthenticated";

const storeMessagesConfig =
  rotatorEnv("LOG_MESSAGES") !== "false" &&
  rotatorEnv("LOG_MESSAGES") !== "0";

const storeResponsesConfig =
  rotatorEnv("LOG_RESPONSES") !== "false" &&
  rotatorEnv("LOG_RESPONSES") !== "0";

let queue: SpendLog[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let isFlushing = false;

export function generateRequestId(): string {
  return `req_${Date.now().toString(36)}_${randomBytes.randomBytes(8).toString("hex")}`;
}

/**
 * Enqueue a request log for async DB persistence & aggregation.
 */
export function logSpend(
  log: Omit<SpendLog, "requestId" | "totalTokens"> & {
    requestId?: string;
    totalTokens?: number;
  },
): void {
  const pricing = MODEL_PRICING[log.model] || { inputPer1M: 0, outputPer1M: 0 };
  const promptTokens = Math.max(0, log.promptTokens || 0);
  const completionTokens = Math.max(0, log.completionTokens || 0);
  const promptCostUsd = (promptTokens / 1_000_000) * (pricing.inputPer1M || 0);
  const completionCostUsd = (completionTokens / 1_000_000) * (pricing.outputPer1M || 0);
  const totalCostUsd = promptCostUsd + completionCostUsd;

  const enrichedMetadata: Record<string, unknown> = {
    ...(log.metadata || {}),
    costBreakdown: {
      promptCostUsd,
      completionCostUsd,
      totalCostUsd,
      inputRatePer1M: pricing.inputPer1M || 0,
      outputRatePer1M: pricing.outputPer1M || 0,
    },
  };

  const fullLog: SpendLog = {
    requestId: log.requestId || generateRequestId(),
    apiKeyHash: log.apiKeyHash || null,
    model: log.model,
    accountEmail: log.accountEmail || null,
    callType: log.callType,
    status: log.status,
    promptTokens,
    completionTokens,
    totalTokens: Math.max(0, log.totalTokens || promptTokens + completionTokens),
    startTime: log.startTime,
    endTime: log.endTime,
    ttfbMs: log.ttfbMs ?? null,
    durationMs: Math.max(0, log.durationMs || 0),
    requestMessages: storeMessagesConfig ? sanitizePayload(log.requestMessages) : null,
    responseContent: storeResponsesConfig ? sanitizePayload(log.responseContent) : null,
    metadata: enrichedMetadata,
    requesterIp: log.requesterIp || null,
    createdAt: new Date().toISOString(),
  };

  queue.push(fullLog);

  if (queue.length >= MAX_QUEUE_SIZE) {
    void flushSpendLogs();
  } else {
    scheduleFlush();
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushSpendLogs();
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref();
}

function sanitizePayload(payload: unknown): unknown {
  if (!payload) return null;
  try {
    const cleaned = cleanValue(payload);
    const str = JSON.stringify(cleaned);
    if (str.length > 512 * 1024) {
      return {
        _truncated: true,
        originalLengthBytes: str.length,
        previewText: str.slice(0, 50000) + "\n... [payload truncated at 50,000 characters]",
      };
    }
    return cleaned;
  } catch {
    return null;
  }
}

function cleanValue(val: unknown, depth = 0): unknown {
  if (depth > 20) return "[Max Depth Reached]";
  if (typeof val === "string") {
    if (val.startsWith("data:") && val.includes(";base64,")) {
      const parts = val.split(";base64,");
      const b64Len = parts[1] ? parts[1].length : 0;
      return `${parts[0]};base64,[data truncated: ${Math.round((b64Len * 0.75) / 1024)}KB]`;
    }
    if (val.length > 2000 && !val.includes(" ") && /^[A-Za-z0-9+/=]+$/.test(val.slice(0, 100))) {
      return `[base64 data truncated: ${Math.round((val.length * 0.75) / 1024)}KB]`;
    }
    return val;
  }
  if (Array.isArray(val)) {
    return val.map((item) => cleanValue(item, depth + 1));
  }
  if (val && typeof val === "object") {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      obj[k] = cleanValue(v, depth + 1);
    }
    return obj;
  }
  return val;
}

/**
 * Flush accumulated spend logs to database.
 */
export async function flushSpendLogs(): Promise<void> {
  if (isFlushing || queue.length === 0 || !isDbConfigured()) return;
  isFlushing = true;

  const logsToFlush = queue;
  queue = [];

  try {
    for (const log of logsToFlush) {
      // 1. Insert detailed spend log
      await queryDb(
        `INSERT INTO rotator_spend_logs (
          request_id, api_key_hash, model, account_email, call_type, status,
          prompt_tokens, completion_tokens, total_tokens, start_time, end_time,
          ttfb_ms, duration_ms, request_messages, response_content, metadata,
          requester_ip, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
        ON CONFLICT (request_id) DO NOTHING`,
        [
          log.requestId,
          log.apiKeyHash,
          log.model,
          log.accountEmail,
          log.callType,
          log.status,
          log.promptTokens,
          log.completionTokens,
          log.totalTokens,
          log.startTime,
          log.endTime,
          log.ttfbMs,
          log.durationMs,
          log.requestMessages ? JSON.stringify(log.requestMessages) : null,
          log.responseContent ? JSON.stringify(log.responseContent) : null,
          JSON.stringify(log.metadata || {}),
          log.requesterIp,
          log.createdAt || new Date().toISOString(),
        ],
      );

      // 2. Upsert daily aggregation
      const dateStr = log.startTime.slice(0, 10); // YYYY-MM-DD
      const keyHashForDaily = log.apiKeyHash || DEFAULT_KEY_HASH_LABEL;
      const isSuccess = log.status === "success" ? 1 : 0;
      const isFail = log.status === "failure" ? 1 : 0;

      await queryDb(
        `INSERT INTO rotator_daily_spend (
          api_key_hash, model, date, prompt_tokens, completion_tokens,
          total_requests, successful_requests, failed_requests, total_duration_ms
        ) VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8)
        ON CONFLICT (api_key_hash, model, date) DO UPDATE SET
          prompt_tokens = rotator_daily_spend.prompt_tokens + EXCLUDED.prompt_tokens,
          completion_tokens = rotator_daily_spend.completion_tokens + EXCLUDED.completion_tokens,
          total_requests = rotator_daily_spend.total_requests + 1,
          successful_requests = rotator_daily_spend.successful_requests + EXCLUDED.successful_requests,
          failed_requests = rotator_daily_spend.failed_requests + EXCLUDED.failed_requests,
          total_duration_ms = rotator_daily_spend.total_duration_ms + EXCLUDED.total_duration_ms`,
        [
          keyHashForDaily,
          log.model,
          dateStr,
          log.promptTokens,
          log.completionTokens,
          isSuccess,
          isFail,
          log.durationMs,
        ],
      );
    }
  } catch (err) {
    console.error("Failed to flush spend logs to database:", err);
    // Put unfetched items back in queue if flush failed
    queue = [...logsToFlush, ...queue];
  } finally {
    isFlushing = false;
  }
}

export function calculateCost(model: string, promptTokens: number, completionTokens: number): number {
  let pricing = MODEL_PRICING[model];
  if (!pricing) {
    const lower = model.toLowerCase();
    if (lower.includes("opus")) {
      pricing = MODEL_PRICING["claude-opus-4-6-thinking"];
    } else if (lower.includes("sonnet")) {
      pricing = MODEL_PRICING["claude-sonnet-4-6"];
    } else if (lower.includes("3.7-flash")) {
      pricing = MODEL_PRICING["gemini-3.7-flash-tiered"];
    } else if (lower.includes("3.6-flash")) {
      pricing = MODEL_PRICING["gemini-3.6-flash-high"];
    } else if (lower.includes("3.5-flash")) {
      pricing = MODEL_PRICING["gemini-3.5-flash-high"];
    } else if (lower.includes("flash")) {
      pricing = MODEL_PRICING["gemini-3-flash"];
    } else if (lower.includes("pro")) {
      pricing = MODEL_PRICING["gemini-3.1-pro"];
    }
  }
  if (!pricing) return 0;
  const inputCost = (promptTokens / 1_000_000) * pricing.inputPer1M;
  const outputCost = (completionTokens / 1_000_000) * pricing.outputPer1M;
  return Number((inputCost + outputCost).toFixed(6));
}

// ── Dashboard Query API Functions ────────────────────────────────────

export interface SpendFilterOptions {
  apiKeyHash?: string | string[];
  model?: string | string[];
  status?: string;
  startDate?: string;
  endDate?: string;
}

export interface GetSpendLogsOptions extends SpendFilterOptions {
  limit?: number;
  offset?: number;
}

export interface SpendSummary {
  totalRequests: number;
  promptTokens: number;
  completionTokens: number;
  avgLatencyMs: number;
  totalCost: number;
}

function buildWhereClause(options: SpendFilterOptions = {}): {
  whereClause: string;
  params: unknown[];
} {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.apiKeyHash) {
    const rawKeys = Array.isArray(options.apiKeyHash)
      ? options.apiKeyHash
      : String(options.apiKeyHash).split(",").map((s) => s.trim()).filter(Boolean);

    if (rawKeys.length > 0) {
      const keyOrConditions: string[] = [];
      for (const kVal of rawKeys) {
        if (kVal === "unauthenticated") {
          keyOrConditions.push(`(l.api_key_hash = 'unauthenticated' OR l.api_key_hash IS NULL OR l.api_key_hash = '')`);
        } else {
          const safeKVal = kVal.replace(/[\\%_]/g, "\\$&");
          const searchVal = `%${safeKVal}%`;
          params.push(kVal, searchVal);
          const p1 = params.length - 1;
          const p2 = params.length;
          keyOrConditions.push(
            `(l.api_key_hash = $${p1} OR k.key_alias ILIKE $${p2} OR k.key_name ILIKE $${p2})`,
          );
        }
      }
      if (keyOrConditions.length > 0) {
        conditions.push(`(${keyOrConditions.join(" OR ")})`);
      }
    }
  }
  if (options.model) {
    const rawModels = Array.isArray(options.model)
      ? options.model
      : String(options.model).split(",").map((s) => s.trim()).filter(Boolean);

    if (rawModels.length > 0) {
      const modelConds: string[] = [];
      for (const m of rawModels) {
        const safeM = m.replace(/[\\%_]/g, "\\$&");
        params.push(`${safeM}%`);
        modelConds.push(`l.model ILIKE $${params.length}`);
      }
      conditions.push(`(${modelConds.join(" OR ")})`);
    }
  }
  if (options.status) {
    params.push(options.status);
    conditions.push(`l.status = $${params.length}`);
  }
  if (options.startDate) {
    params.push(options.startDate);
    conditions.push(`l.created_at >= $${params.length}::timestamptz`);
  }
  if (options.endDate) {
    params.push(options.endDate);
    conditions.push(`l.created_at <= ($${params.length}::date + INTERVAL '1 day')`);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return { whereClause, params };
}

export async function getSpendLogs(
  options: GetSpendLogsOptions = {},
): Promise<{ logs: SpendLog[]; total: number; summary: SpendSummary }> {
  const emptySummary: SpendSummary = {
    totalRequests: 0,
    promptTokens: 0,
    completionTokens: 0,
    avgLatencyMs: 0,
    totalCost: 0,
  };

  if (!isDbConfigured()) return { logs: [], total: 0, summary: emptySummary };

  const limit = Math.min(100, Math.max(1, options.limit || 50));
  const offset = Math.max(0, options.offset || 0);

  const { whereClause, params } = buildWhereClause(options);

  try {
    const aggRes = await queryDb<{
      count: string;
      prompt_tokens: string;
      completion_tokens: string;
      total_duration_ms: string;
      count_duration: string;
    }>(
      `SELECT 
         COUNT(*)::text as count,
         COALESCE(SUM(l.prompt_tokens), 0)::text as prompt_tokens,
         COALESCE(SUM(l.completion_tokens), 0)::text as completion_tokens,
         COALESCE(SUM(l.duration_ms), 0)::text as total_duration_ms,
         COUNT(l.duration_ms)::text as count_duration
       FROM rotator_spend_logs l
       LEFT JOIN rotator_virtual_keys k ON l.api_key_hash = k.token_hash
       ${whereClause}`,
      params,
    );

    const aggRow = aggRes.rows[0];
    const total = parseInt(aggRow?.count || "0", 10);
    const promptTokens = parseInt(aggRow?.prompt_tokens || "0", 10);
    const completionTokens = parseInt(aggRow?.completion_tokens || "0", 10);
    const totalDurationMs = parseInt(aggRow?.total_duration_ms || "0", 10);
    const countDuration = parseInt(aggRow?.count_duration || "0", 10);
    const avgLatencyMs = countDuration > 0 ? Math.round(totalDurationMs / countDuration) : 0;

    const byModelRes = await queryDb<{
      model: string;
      prompt_tokens: string;
      completion_tokens: string;
    }>(
      `SELECT 
         l.model,
         COALESCE(SUM(l.prompt_tokens), 0)::text as prompt_tokens,
         COALESCE(SUM(l.completion_tokens), 0)::text as completion_tokens
       FROM rotator_spend_logs l
       LEFT JOIN rotator_virtual_keys k ON l.api_key_hash = k.token_hash
       ${whereClause}
       GROUP BY l.model`,
      params,
    );

    let totalCost = 0;
    for (const mRow of byModelRes.rows) {
      const pTok = parseInt(mRow.prompt_tokens || "0", 10);
      const cTok = parseInt(mRow.completion_tokens || "0", 10);
      totalCost += calculateCost(mRow.model, pTok, cTok);
    }
    totalCost = Number(totalCost.toFixed(6));

    const summary: SpendSummary = {
      totalRequests: total,
      promptTokens,
      completionTokens,
      avgLatencyMs,
      totalCost,
    };

    const queryParams = [...params, limit, offset];
    const logsRes = await queryDb(
      `SELECT l.*, k.key_alias, k.key_name
       FROM rotator_spend_logs l
       LEFT JOIN rotator_virtual_keys k ON l.api_key_hash = k.token_hash
       ${whereClause}
       ORDER BY l.created_at DESC
       LIMIT $${queryParams.length - 1} OFFSET $${queryParams.length}`,
      queryParams,
    );

    const logs: SpendLog[] = logsRes.rows.map((row) => {
      const model = String(row.model);
      const promptTokens = Number(row.prompt_tokens || 0);
      const completionTokens = Number(row.completion_tokens || 0);
      return {
        requestId: String(row.request_id),
        apiKeyHash: row.api_key_hash ? String(row.api_key_hash) : null,
        keyAlias: row.key_alias ? String(row.key_alias) : null,
        keyName: row.key_name ? String(row.key_name) : null,
        model,
        accountEmail: row.account_email ? String(row.account_email) : null,
        callType: String(row.call_type),
        status: (row.status as "success" | "failure") || "success",
        promptTokens,
        completionTokens,
        totalTokens: Number(row.total_tokens || 0),
        cost: calculateCost(model, promptTokens, completionTokens),
        startTime: new Date(row.start_time as string | Date).toISOString(),
        endTime: new Date(row.end_time as string | Date).toISOString(),
        ttfbMs: row.ttfb_ms !== null ? Number(row.ttfb_ms) : null,
        durationMs: Number(row.duration_ms || 0),
        requestMessages: row.request_messages || null,
        responseContent: row.response_content || null,
        metadata:
          row.metadata && typeof row.metadata === "object"
            ? (row.metadata as Record<string, unknown>)
            : {},
        requesterIp: row.requester_ip ? String(row.requester_ip) : null,
        createdAt: new Date(row.created_at as string | Date).toISOString(),
      };
    });

    return { logs, total, summary };
  } catch (err) {
    console.error("Failed to query spend logs:", err);
    return { logs: [], total: 0, summary: emptySummary };
  }
}

export async function getDailySpendSummary(options: {
  apiKeyHash?: string;
  startDate?: string;
  endDate?: string;
}): Promise<DailySpend[]> {
  if (!isDbConfigured()) return [];

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.apiKeyHash) {
    params.push(options.apiKeyHash);
    conditions.push(`api_key_hash = $${params.length}`);
  }
  if (options.startDate) {
    params.push(options.startDate);
    conditions.push(`date >= $${params.length}::date`);
  }
  if (options.endDate) {
    params.push(options.endDate);
    conditions.push(`date <= $${params.length}::date`);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  try {
    const res = await queryDb(
      `SELECT * FROM rotator_daily_spend ${whereClause} ORDER BY date DESC, total_requests DESC`,
      params,
    );

    return res.rows.map((row) => ({
      apiKeyHash: row.api_key_hash ? String(row.api_key_hash) : null,
      model: String(row.model),
      date: new Date(row.date as string | Date).toISOString().slice(0, 10),
      promptTokens: Number(row.prompt_tokens || 0),
      completionTokens: Number(row.completion_tokens || 0),
      totalRequests: Number(row.total_requests || 0),
      successfulRequests: Number(row.successful_requests || 0),
      failedRequests: Number(row.failed_requests || 0),
      totalDurationMs: Number(row.total_duration_ms || 0),
    }));
  } catch (err) {
    console.error("Failed to get daily spend summary:", err);
    return [];
  }
}

// ── Spend by Key Aggregation ────────────────────────────────────────

export interface SpendByKey {
  apiKeyHash: string;
  keyAlias?: string | null;
  keyName?: string | null;
  totalRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalDurationMs: number;
  avgDurationMs: number;
  totalCost: number;
  firstSeen: string | null;
  lastSeen: string | null;
}

export async function getSpendByKey(
  options: SpendFilterOptions = {},
): Promise<SpendByKey[]> {
  if (!isDbConfigured()) return [];

  const { whereClause, params } = buildWhereClause(options);

  try {
    const res = await queryDb(
      `SELECT
        COALESCE(NULLIF(l.api_key_hash, ''), 'unauthenticated') as api_key_hash,
        k.key_alias,
        k.key_name,
        l.model,
        COUNT(*)::int as total_requests,
        COALESCE(SUM(l.prompt_tokens), 0)::bigint as total_prompt_tokens,
        COALESCE(SUM(l.completion_tokens), 0)::bigint as total_completion_tokens,
        COALESCE(SUM(l.duration_ms), 0)::bigint as total_duration_ms,
        MIN(l.created_at) as first_seen,
        MAX(l.created_at) as last_seen
      FROM rotator_spend_logs l
      LEFT JOIN rotator_virtual_keys k ON l.api_key_hash = k.token_hash
      ${whereClause}
      GROUP BY COALESCE(NULLIF(l.api_key_hash, ''), 'unauthenticated'), k.key_alias, k.key_name, l.model`,
      params,
    );

    const map = new Map<
      string,
      {
        apiKeyHash: string;
        keyAlias: string | null;
        keyName: string | null;
        totalRequests: number;
        totalPromptTokens: number;
        totalCompletionTokens: number;
        totalDurationMs: number;
        totalCost: number;
        firstSeen: string | null;
        lastSeen: string | null;
      }
    >();

    for (const row of res.rows) {
      const hash = String(row.api_key_hash);
      const prompt = Number(row.total_prompt_tokens || 0);
      const completion = Number(row.total_completion_tokens || 0);
      const cost = calculateCost(String(row.model), prompt, completion);

      const firstSeenIso = row.first_seen ? new Date(row.first_seen as string | Date).toISOString() : null;
      const lastSeenIso = row.last_seen ? new Date(row.last_seen as string | Date).toISOString() : null;

      const existing = map.get(hash) || {
        apiKeyHash: hash,
        keyAlias: row.key_alias ? String(row.key_alias) : null,
        keyName: row.key_name ? String(row.key_name) : null,
        totalRequests: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalDurationMs: 0,
        totalCost: 0,
        firstSeen: firstSeenIso,
        lastSeen: lastSeenIso,
      };

      existing.totalRequests += Number(row.total_requests || 0);
      existing.totalPromptTokens += prompt;
      existing.totalCompletionTokens += completion;
      existing.totalDurationMs += Number(row.total_duration_ms || 0);
      existing.totalCost += cost;

      if (firstSeenIso && (!existing.firstSeen || firstSeenIso < existing.firstSeen)) {
        existing.firstSeen = firstSeenIso;
      }
      if (lastSeenIso && (!existing.lastSeen || lastSeenIso > existing.lastSeen)) {
        existing.lastSeen = lastSeenIso;
      }

      map.set(hash, existing);
    }

    const resultList: SpendByKey[] = Array.from(map.values()).map((item) => {
      const avgDurationMs = item.totalRequests > 0 ? item.totalDurationMs / item.totalRequests : 0;
      return {
        apiKeyHash: item.apiKeyHash,
        keyAlias: item.keyAlias,
        keyName: item.keyName,
        totalRequests: item.totalRequests,
        totalPromptTokens: item.totalPromptTokens,
        totalCompletionTokens: item.totalCompletionTokens,
        totalDurationMs: item.totalDurationMs,
        avgDurationMs,
        totalCost: Number(item.totalCost.toFixed(6)),
        firstSeen: item.firstSeen,
        lastSeen: item.lastSeen,
      };
    });

    resultList.sort((a, b) => b.totalPromptTokens + b.totalCompletionTokens - (a.totalPromptTokens + a.totalCompletionTokens));
    return resultList;
  } catch (err) {
    console.error("Failed to get spend by key:", err);
    return [];
  }
}

// ── Retention Policy ─────────────────────────────────────────────────

const DEFAULT_LOG_RETENTION_DAYS = 30;
const DAILY_RETENTION_DAYS = 90;
const RETENTION_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

let retentionTimer: ReturnType<typeof setTimeout> | null = null;

function getLogRetentionDays(): number {
  const env = rotatorEnv("LOG_RETENTION_DAYS");
  if (env) {
    const n = parseInt(env, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return DEFAULT_LOG_RETENTION_DAYS;
}

async function runRetentionCleanup(): Promise<void> {
  if (!isDbConfigured()) return;

  const logDays = getLogRetentionDays();

  try {
    const logRes = await queryDb<{ deleted: string }>(
      `WITH deleted AS (
        DELETE FROM rotator_spend_logs WHERE created_at < NOW() - ($1 || ' days')::interval
        RETURNING request_id
      )
      SELECT COUNT(*)::text as deleted FROM deleted`,
      [String(logDays)],
    );
    const dailyRes = await queryDb<{ deleted: string }>(
      `WITH deleted AS (
        DELETE FROM rotator_daily_spend WHERE date < CURRENT_DATE - ($1 || ' days')::interval
        RETURNING id
      )
      SELECT COUNT(*)::text as deleted FROM deleted`,
      [String(DAILY_RETENTION_DAYS)],
    );

    const logDeleted = parseInt(logRes.rows[0]?.deleted || "0", 10);
    const dailyDeleted = parseInt(dailyRes.rows[0]?.deleted || "0", 10);

    if (logDeleted > 0 || dailyDeleted > 0) {
      console.log(
        `[retention] Cleaned ${logDeleted} spend logs (${logDays}d policy) and ${dailyDeleted} daily aggregates (${DAILY_RETENTION_DAYS}d policy)`,
      );
    }
  } catch (err) {
    console.error("Retention cleanup failed:", err);
  }
}

export function startRetentionCleanup(): void {
  void runRetentionCleanup();
  retentionTimer = setInterval(() => {
    void runRetentionCleanup();
  }, RETENTION_CHECK_INTERVAL_MS);
  retentionTimer.unref();
}

export function stopRetentionCleanup(): void {
  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimer = null;
  }
}
