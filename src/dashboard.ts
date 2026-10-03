// Admin API handlers behind the web dashboard. The dashboard UI itself is the
// Preact app in src/web, served by dashboard-app.ts.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "./types.js";
import type { AccountRotator } from "./rotator.js";
import type { SessionInfo } from "./dashboard-types.js";
import { readLimitedBody } from "./body-limit.js";
import {
  clearDashboardSessionCookie,
  createDashboardSession,
  dashboardSessionCookie,
  getConfiguredAdminToken,
  hasValidDashboardSession,
  isAdminAuthorized,
  isAdminTokenValid,
  isSecureRequest,
  revokeDashboardSession,
} from "./admin-auth.js";
import {
  buildActivity,
  buildUsage,
  isUsageRange,
  tokenUsageCsv,
  type DashboardLiveHub,
} from "./dashboard-live.js";
import { sendDashboardJson } from "./dashboard-app.js";
import {
  generateVirtualKey,
  listVirtualKeys,
  getVirtualKeyByHash,
  updateVirtualKey,
  deleteVirtualKey,
} from "./virtual-keys.js";
import { getSpendLogs, getDailySpendSummary, getSpendByKey } from "./spend-logger.js";
import { buildOpenAIModelCatalog } from "./compat.js";
import { logger } from "./logger.js";

const dashboardLogger = logger.child("dashboard");

export function serveStatusApi(
  res: ServerResponse,
  rotator: AccountRotator,
): void {
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(rotator.getStatus()));
}

export function serveConfigApi(
  res: ServerResponse,
  rotator: AccountRotator,
): void {
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(rotator.getPublicConfig()));
}

/**
 * Admin /api/models — returns the full provider model catalog grouped by
 * provider. Powers the "Allowed Models" checkboxes in the Generate/Edit
 * Virtual Key modal so the dashboard can show models from every active
 * provider (Google Antigravity, Ollama, OpenAI Codex, OpenCode Zen) instead
 * of the legacy hardcoded list.
 *
 * The shape mirrors /v1/models so the client can reuse metadata for tooltips.
 */
export function serveModelsApi(
  res: ServerResponse,
  rotator: AccountRotator,
): void {
  const catalog = buildOpenAIModelCatalog(rotator);
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(
    JSON.stringify({
      ok: true,
      count: catalog.length,
      data: catalog,
    }),
  );
}

export function serveConfigExportApi(
  res: ServerResponse,
  rotator: AccountRotator,
): void {
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Disposition":
      'attachment; filename="tuxevil-rotator-config.json"',
  });
  res.end(JSON.stringify(rotator.getPublicConfig(), null, 2));
}

export async function serveConfigImportApi(
  res: ServerResponse,
  rotator: AccountRotator,
  config: Config,
): Promise<void> {
  await rotator.replaceConfig(config);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({ ok: true, importedAccounts: config.accounts.length }),
  );
}

export async function serveEnableApi(
  res: ServerResponse,
  rotator: AccountRotator,
  email: string,
): Promise<void> {
  const ok = await rotator.enableAccount(email);
  res.writeHead(ok ? 200 : 409, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok, email }));
}

export async function serveDisableApi(
  res: ServerResponse,
  rotator: AccountRotator,
  email: string,
): Promise<void> {
  const ok = await rotator.disableAccount(email);
  res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok, email }));
}

export async function serveQuarantineApi(
  res: ServerResponse,
  rotator: AccountRotator,
  email: string,
): Promise<void> {
  const ok = await rotator.quarantineAccount(email);
  res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok, email }));
}

export async function serveRestoreApi(
  res: ServerResponse,
  rotator: AccountRotator,
  email: string,
): Promise<void> {
  const ok = await rotator.restoreAccount(email);
  res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok, email }));
}

export async function serveRemoveAccountApi(
  res: ServerResponse,
  rotator: AccountRotator,
  email: string,
): Promise<void> {
  const ok = await rotator.removeAccount(email);
  res.writeHead(ok ? 200 : 400, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok, email }));
}

export async function serveSetTierApi(
  res: ServerResponse,
  rotator: AccountRotator,
  email: string,
  tier: string,
): Promise<void> {
  const ok = await rotator.setAccountTier(email, tier);
  res.writeHead(ok ? 200 : 400, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok, email, tier }));
}

export async function serveFreshWindowStartsApi(
  res: ServerResponse,
  rotator: AccountRotator,
  enabled: boolean,
): Promise<void> {
  const changed = await rotator.setAllowFreshWindowStarts(enabled);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({ ok: true, changed, allowFreshWindowStarts: enabled }),
  );
}

export async function serveAccountFreshWindowStartsApi(
  res: ServerResponse,
  rotator: AccountRotator,
  email: string,
  enabled: boolean,
): Promise<void> {
  const ok = await rotator.setAccountAllowFreshWindowStartsOverride(email, enabled);
  res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({ ok, email, allowFreshWindowStartsOverride: enabled }),
  );
}

export function serveClearInFlightApi(
  res: ServerResponse,
  rotator: AccountRotator,
  email: string,
  modelKey?: string,
): void {
  const ok = rotator.clearInFlightRequests(email, modelKey);
  res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok, email, modelKey }));
}

export async function serveClearBreakerApi(
  res: ServerResponse,
  rotator: AccountRotator,
  modelKey?: string,
): Promise<void> {
  if (modelKey) {
    await rotator.clearModelBreaker(modelKey);
  } else {
    await rotator.clearAllBreakers();
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

export function serveKickstartApi(
  res: ServerResponse,
  rotator: AccountRotator,
  email: string,
  modelKey?: string,
): void {
  if (modelKey) {
    rotator.kickstartTimerForAccount(email, modelKey).then((result) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    }).catch(() => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Kickstart failed" }));
    });
  } else {
    rotator.kickstartAllFreshTimers(email).then((result) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    }).catch(() => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Kickstart failed", results: [] }));
    });
  }
}

export async function serveAutoWarmupApi(
  res: ServerResponse,
  rotator: AccountRotator,
  enabled: boolean,
): Promise<void> {
  const changed = await rotator.setAutoWarmup(enabled);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, changed, autoWarmupEnabled: enabled }));
}

// ── Virtual Keys & Spend Logging REST API ────────────────────────────

export async function serveGenerateVirtualKeyApi(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const rawBody = await readLimitedBody(req);
    const parsed = rawBody.length > 0 ? JSON.parse(rawBody.toString("utf-8")) : {};
    if (!parsed.alias || typeof parsed.alias !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Field 'alias' is required" }));
      return;
    }
    const created = await generateVirtualKey({
      alias: parsed.alias,
      userId: parsed.userId,
      models: parsed.models,
      metadata: parsed.metadata,
      createdBy: parsed.createdBy || "admin",
    });
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, ...created }));
  } catch (err) {
    dashboardLogger.error(`Failed to generate virtual key: ${err}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Internal server error" }));
  }
}

export async function serveListVirtualKeysApi(
  res: ServerResponse,
): Promise<void> {
  try {
    const keys = await listVirtualKeys();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, keys }));
  } catch (err) {
    dashboardLogger.error(`Failed to list virtual keys: ${err}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Internal server error" }));
  }
}

export async function serveGetVirtualKeyApi(
  res: ServerResponse,
  tokenHash: string,
): Promise<void> {
  try {
    const key = await getVirtualKeyByHash(tokenHash);
    if (!key) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Virtual key not found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, key }));
  } catch (err) {
    dashboardLogger.error(`Failed to get virtual key: ${err}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Internal server error" }));
  }
}

export async function serveUpdateVirtualKeyApi(
  req: IncomingMessage,
  res: ServerResponse,
  tokenHash: string,
): Promise<void> {
  try {
    const rawBody = await readLimitedBody(req);
    const updates = rawBody.length > 0 ? JSON.parse(rawBody.toString("utf-8")) : {};
    const updated = await updateVirtualKey(tokenHash, updates);
    if (!updated) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Virtual key not found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, key: updated }));
  } catch (err) {
    dashboardLogger.error(`Failed to update virtual key: ${err}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Internal server error" }));
  }
}

export async function serveDeleteVirtualKeyApi(
  res: ServerResponse,
  tokenHash: string,
): Promise<void> {
  try {
    const deleted = await deleteVirtualKey(tokenHash);
    if (!deleted) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Virtual key not found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, message: "Virtual key deleted" }));
  } catch (err) {
    dashboardLogger.error(`Failed to delete virtual key: ${err}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Internal server error" }));
  }
}

export async function serveGetSpendLogsApi(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const keyHash = url.searchParams.get("keyHash") || undefined;
    const model = url.searchParams.get("model") || undefined;
    const status = url.searchParams.get("status") || undefined;
    const startDate = url.searchParams.get("startDate") || undefined;
    const endDate = url.searchParams.get("endDate") || undefined;
    const limit = url.searchParams.has("limit")
      ? parseInt(url.searchParams.get("limit")!, 10)
      : 50;
    const offset = url.searchParams.has("offset")
      ? parseInt(url.searchParams.get("offset")!, 10)
      : 0;

    const result = await getSpendLogs({
      apiKeyHash: keyHash,
      model,
      status,
      startDate,
      endDate,
      limit,
      offset,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, ...result }));
  } catch (err) {
    dashboardLogger.error(`Failed to get spend logs: ${err}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Internal server error" }));
  }
}

export async function serveGetSpendSummaryApi(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const keyHash = url.searchParams.get("keyHash") || undefined;
    const startDate = url.searchParams.get("startDate") || undefined;
    const endDate = url.searchParams.get("endDate") || undefined;

    const summary = await getDailySpendSummary({
      apiKeyHash: keyHash,
      startDate,
      endDate,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, summary }));
  } catch (err) {
    dashboardLogger.error(`Failed to get spend summary: ${err}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Internal server error" }));
  }
}

export async function serveGetSpendByKeyApi(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const apiKeyHash = url.searchParams.get("apiKeyHash") || undefined;
    const model = url.searchParams.get("model") || undefined;
    const status = url.searchParams.get("status") || undefined;
    const startDate = url.searchParams.get("startDate") || undefined;
    const endDate = url.searchParams.get("endDate") || undefined;

    const byKey = await getSpendByKey({ apiKeyHash, model, status, startDate, endDate });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, byKey }));
  } catch (err) {
    dashboardLogger.error(`Failed to get spend by key: ${err}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Internal server error" }));
  }
}

// ── Dashboard session (cookie exchanged for the admin token) ─────────────

export function serveSessionInfoApi(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const token = getConfiguredAdminToken();
  const info: SessionInfo = {
    authRequired: Boolean(token),
    authenticated: !token || isAdminAuthorized(req, token),
  };
  sendDashboardJson(req, res, 200, info);
}

/** Exchange `{ token }` for an HttpOnly session cookie. */
export async function serveCreateSessionApi(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let candidate: unknown;
  try {
    const raw = await readLimitedBody(req, 4096);
    candidate = raw.length > 0 ? JSON.parse(raw.toString("utf-8"))?.token : null;
  } catch {
    candidate = null;
  }
  const token = getConfiguredAdminToken();
  if (!token) {
    sendDashboardJson(req, res, 200, { ok: true, authRequired: false });
    return;
  }
  if (typeof candidate !== "string" || !isAdminTokenValid(candidate.trim(), token)) {
    sendDashboardJson(req, res, 401, { ok: false, error: "That admin token was not accepted." });
    return;
  }
  const session = createDashboardSession(token);
  res.setHeader(
    "Set-Cookie",
    dashboardSessionCookie(session.value, { secure: isSecureRequest(req) }),
  );
  sendDashboardJson(req, res, 200, { ok: true, expiresAt: session.expiresAt });
}

export function serveDeleteSessionApi(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  revokeDashboardSession(req);
  res.setHeader("Set-Cookie", clearDashboardSessionCookie(isSecureRequest(req)));
  sendDashboardJson(req, res, 200, { ok: true });
}

/**
 * `/dashboard?token=…` links (printed by the CLI) trade the token for a
 * session cookie and redirect to the same URL without it, so the token
 * does not linger in history, bookmarks or Referer headers.
 */
export function redirectDashboardTokenLink(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const url = new URL(req.url || "/", "http://localhost");
  const candidate = url.searchParams.get("token");
  if (candidate === null) return false;
  url.searchParams.delete("token");
  const token = getConfiguredAdminToken();
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (token && isAdminTokenValid(candidate, token)) {
    const session = createDashboardSession(token);
    headers["Set-Cookie"] = dashboardSessionCookie(session.value, {
      secure: isSecureRequest(req),
    });
  } else if (token && !hasValidDashboardSession(req, token)) {
    url.searchParams.set("auth", "invalid");
  }
  headers.Location = url.pathname + url.search;
  res.writeHead(302, headers);
  res.end();
  return true;
}

// ── Dashboard data (/api/dashboard/*) ────────────────────────────────────

export function serveDashboardSnapshotApi(
  req: IncomingMessage,
  res: ServerResponse,
  hub: DashboardLiveHub,
): void {
  sendDashboardJson(req, res, 200, hub.snapshot());
}

export function serveDashboardUsageApi(
  req: IncomingMessage,
  res: ServerResponse,
  rotator: AccountRotator,
): void {
  const url = new URL(req.url || "/", "http://localhost");
  const range = url.searchParams.get("range") || "1h";
  if (!isUsageRange(range)) {
    sendDashboardJson(req, res, 400, { ok: false, error: "Unknown range" });
    return;
  }
  sendDashboardJson(
    req,
    res,
    200,
    buildUsage(
      rotator.getTokenUsage(),
      rotator.getLatencyStats(),
      range,
      Date.now(),
    ),
  );
}

export function serveDashboardActivityApi(
  req: IncomingMessage,
  res: ServerResponse,
  rotator: AccountRotator,
): void {
  sendDashboardJson(
    req,
    res,
    200,
    buildActivity(rotator.getTokenUsage(), Date.now()),
  );
}

export function serveDashboardUsageExportApi(
  req: IncomingMessage,
  res: ServerResponse,
  rotator: AccountRotator,
): void {
  const url = new URL(req.url || "/", "http://localhost");
  const format = url.searchParams.get("format") === "csv" ? "csv" : "json";
  const usage = rotator.getTokenUsage();
  const body =
    format === "csv" ? tokenUsageCsv(usage) : JSON.stringify(usage, null, 2);
  res.writeHead(200, {
    "Content-Type":
      format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
    "Content-Disposition": `attachment; filename="rotator-token-usage.${format}"`,
    "Cache-Control": "no-store",
  });
  res.end(body);
}
