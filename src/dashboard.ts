import { isUsageReadToken } from "./usage-limits-auth.js";
// Admin API handlers behind the web dashboard. The dashboard UI itself is the
// Preact app in src/web, served by dashboard-app.ts.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "./types.js";
import type { AccountRotator } from "./rotator.js";
import type { ModelCatalogResponse, SessionInfo } from "./dashboard-types.js";
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
import { getProviderOrder, isProviderTurnedOff, resolveModelRoute } from "./model-catalog.js";
import { describeEffortRoutes, effortRouteTargets, suggestEffortRoutes, type EffortRoutePlan } from "./effort-routing.js";
import { getProviderAdapter } from "./providers/registry.js";
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

// ── Models page: providers, provider order and model switches ─────────

export function buildModelCatalogResponse(rotator: AccountRotator): ModelCatalogResponse {
  const config = rotator.getConfig();
  const models = rotator.getModelCatalog();
  const routedTo = new Map<string, string | null>();
  for (const model of models) {
    const id = model.id.toLowerCase();
    if (routedTo.has(id)) continue;
    const route = resolveModelRoute(rotator, model.id);
    routedTo.set(id, route.kind === "provider" ? route.providerId : null);
  }
  const effortTargets = effortRouteTargets(config);
  const listed = config.effortRouting
    ? new Set(buildOpenAIModelCatalog(rotator).map((entry) => entry.id.toLowerCase()))
    : new Set<string>();
  return {
    ok: true,
    providers: getProviderOrder(rotator).map((id) => {
      const adapter = getProviderAdapter(id);
      return {
        id,
        name: adapter.displayName,
        credentialKind: adapter.credentialKind,
        enabled: !isProviderTurnedOff(config, id),
      };
    }),
    models: models.map((model) => ({
      providerId: model.providerId,
      id: model.id,
      contextWindow: model.contextWindow,
      quotaPool: model.quotaPool,
      source: model.source,
      offReason: model.offReason,
      modelSwitch: model.modelSwitch,
      routed: routedTo.get(model.id.toLowerCase()) === model.providerId,
      ...(model.providerId === "google-antigravity" && effortTargets.has(model.id.toLowerCase())
        ? { effortRoute: effortTargets.get(model.id.toLowerCase()) }
        : {}),
    })),
    autoEnableNewModels: config.autoEnableNewModels ?? true,
    effortRoutes: describeEffortRoutes(rotator, (alias) => listed.has(alias.toLowerCase())),
    effortSuggestions: suggestEffortRoutes(rotator),
  };
}

function sendCatalogJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readLimitedBody(req, 256 * 1024);
    const parsed: unknown = raw.length > 0 ? JSON.parse(raw.toString("utf-8")) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);

/** The method a known /api/catalog path takes, for 405 answers. */
function catalogMethodFor(rest: string[]): string | null {
  const toggle = rest.at(-1) === "on" || rest.at(-1) === "off";
  if (rest.length === 0) return "GET";
  if (rest.length === 1 && rest[0] === "refresh") return "POST";
  if (rest.length === 1 && rest[0] === "provider-order") return "PUT";
  if (toggle && ((rest[0] === "providers" && rest.length === 3) || (rest[0] === "models" && rest.length === 2) ||
    (rest[0] === "new-models" && rest.length === 2) || (rest[0] === "accounts" && rest.length === 4))) return "POST";
  if (rest[0] === "effort-routes" && rest.length === 1) return "POST";
  if (rest[0] === "effort-routes" && rest.length === 2) return "PUT, DELETE";
  return null;
}

/**
 * /api/catalog routes. Every change answers with the updated catalog.
 *
 *   GET  /api/catalog
 *   POST /api/catalog/refresh
 *   POST /api/catalog/providers/:id/on|off
 *   PUT  /api/catalog/provider-order          { "order": ["ollama", ...] }
 *   POST /api/catalog/models/on|off           { "models": ["ollama/gpt-oss:20b"] }
 *   POST /api/catalog/new-models/on|off
 *   POST /api/catalog/accounts/:accountId/:provider/on|off
 *        accountId is dashboard account.id; an unambiguous legacy email also works.
 *   POST   /api/catalog/effort-routes         { "alias", "defaultEffort", "targets": { "<level>": "<model>" } }
 *   PUT    /api/catalog/effort-routes/:alias  same body; "alias" renames the route
 *   DELETE /api/catalog/effort-routes/:alias
 *        A refused change answers { ok: false, error, fieldErrors? } (EffortRouteErrorResponse).
 */
export async function serveCatalogApi(
  req: IncomingMessage,
  res: ServerResponse,
  rotator: AccountRotator,
  method: string,
  pathname: string,
): Promise<void> {
  const rest = pathname.slice("/api/catalog".length).split("/").filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  const toggle = rest.at(-1) === "on" ? true : rest.at(-1) === "off" ? false : null;
  const done = () => sendCatalogJson(res, 200, buildModelCatalogResponse(rotator));
  const fail = (status: number, error: string) => sendCatalogJson(res, status, { ok: false, error });

  try {
    if (method === "GET" && rest.length === 0) return done();

    if (method === "POST" && rest.length === 1 && rest[0] === "refresh") {
      await rotator.refreshModelCatalogs();
      return done();
    }

    if (method === "POST" && rest[0] === "providers" && rest.length === 3 && toggle !== null) {
      if (!(await rotator.setProviderEnabled(rest[1], toggle))) return fail(404, `Unknown provider "${rest[1]}"`);
      return done();
    }

    if (method === "PUT" && rest.length === 1 && rest[0] === "provider-order") {
      const body = await readJsonObject(req);
      if (!body || !isStringList(body.order)) return fail(400, 'Send { "order": ["<provider id>", ...] }');
      if (!(await rotator.setProviderOrder(body.order))) return fail(400, "The order names an unknown provider");
      return done();
    }

    if (method === "POST" && rest[0] === "models" && rest.length === 2 && toggle !== null) {
      const body = await readJsonObject(req);
      if (!body || !isStringList(body.models) || body.models.length === 0) {
        return fail(400, 'Send { "models": ["<provider>/<model>", ...] }');
      }
      if (!(await rotator.setModelsEnabled(body.models, toggle))) {
        return fail(400, 'Each model must be "<provider>/<model>" with a known provider');
      }
      return done();
    }

    if (method === "POST" && rest[0] === "new-models" && rest.length === 2 && toggle !== null) {
      await rotator.setAutoEnableNewModels(toggle);
      return done();
    }

    if (rest[0] === "effort-routes") {
      const answer = (plan: EffortRoutePlan) =>
        plan.ok
          ? done()
          : sendCatalogJson(res, plan.status, {
            ok: false,
            error: plan.error,
            ...(plan.fieldErrors ? { fieldErrors: plan.fieldErrors } : {}),
          });
      if (method === "POST" && rest.length === 1) {
        const body = await readJsonObject(req);
        return answer(await rotator.saveEffortRoute(null, body));
      }
      if (method === "PUT" && rest.length === 2) {
        const body = await readJsonObject(req);
        return answer(await rotator.saveEffortRoute(rest[1], body));
      }
      if (method === "DELETE" && rest.length === 2) {
        return answer(await rotator.deleteEffortRoute(rest[1]));
      }
    }

    if (method === "POST" && rest[0] === "accounts" && rest.length === 4 && toggle !== null) {
      if (!(await rotator.setAccountProviderEnabled(rest[1], rest[2], toggle))) {
        return fail(404, `No unique account with a ${rest[2]} credential matches ${rest[1]}`);
      }
      return done();
    }

    const allowed = catalogMethodFor(rest);
    if (allowed) {
      res.setHeader("Allow", allowed);
      return fail(405, `Use ${allowed} for this path`);
    }
    return fail(404, "Not found");
  } catch (err) {
    dashboardLogger.error(`Catalog request failed: ${err}`);
    return fail(500, "Internal server error");
  }
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
  if (typeof candidate === "string" && isUsageReadToken(candidate.trim())) {
    sendDashboardJson(req, res, 401, { ok: false, error: "That admin token was not accepted." });
    return;
  }
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

export async function serveDeleteSessionApi(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    await revokeDashboardSession(req);
  } catch (err) {
    dashboardLogger.error(`Failed to persist dashboard session revocation: ${err}`);
    sendDashboardJson(req, res, 503, {
      ok: false,
      error: "Could not persist the sign-out. Please try again.",
    });
    return;
  }
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
