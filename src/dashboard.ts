// Web dashboard for monitoring account rotation status

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "./types.js";
import type { AccountRotator } from "./rotator.js";
import { readLimitedBody } from "./body-limit.js";
import {
  generateVirtualKey,
  listVirtualKeys,
  getVirtualKeyByHash,
  updateVirtualKey,
  deleteVirtualKey,
} from "./virtual-keys.js";
import { getSpendLogs, getDailySpendSummary, getSpendByKey } from "./spend-logger.js";
import { logger } from "./logger.js";

const dashboardLogger = logger.child("dashboard");

const __dirname = dirname(fileURLToPath(import.meta.url));

// Static assets are read once at startup and served via dedicated routes.
const DASHBOARD_CSS = readFileSync(
  join(__dirname, "static", "dashboard.css"),
  "utf-8",
);
const DASHBOARD_JS = readFileSync(
  join(__dirname, "static", "dashboard.js"),
  "utf-8",
);
const DASHBOARD_KEYS_JS = readFileSync(
  join(__dirname, "static", "dashboard-keys.js"),
  "utf-8",
);
const DASHBOARD_LOGS_JS = readFileSync(
  join(__dirname, "static", "dashboard-logs.js"),
  "utf-8",
);

export function serveDashboard(res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(DASHBOARD_HTML);
}

export function serveStaticCss(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/css; charset=utf-8",
    "Cache-Control": "public, max-age=3600",
  });
  res.end(DASHBOARD_CSS);
}

export function serveStaticJs(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "public, max-age=3600",
  });
  res.end(DASHBOARD_JS);
}

export function serveStaticKeysJs(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "public, max-age=3600",
  });
  res.end(DASHBOARD_KEYS_JS);
}

export function serveStaticLogsJs(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "public, max-age=3600",
  });
  res.end(DASHBOARD_LOGS_JS);
}

export function serveDashboardKeys(res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(DASHBOARD_KEYS_HTML);
}

export function serveDashboardLogs(res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(DASHBOARD_LOGS_HTML);
}

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
  res.end(JSON.stringify(rotator.getConfig()));
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
  res.end(JSON.stringify(rotator.getConfig(), null, 2));
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
    }).catch((err) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(err) }));
    });
  } else {
    rotator.kickstartAllFreshTimers(email).then((result) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    }).catch((err) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(err), results: [] }));
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

function renderAppShell(opts: {
  title: string;
  activeTab: "accounts" | "keys" | "logs";
  contentHtml: string;
  scriptSrc: string;
}): string {
  const pageTitle = opts.title === "Tuxevil Rotator" ? opts.title : (opts.title + " — Tuxevil Rotator");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${pageTitle}</title>
<link rel="stylesheet" href="/static/dashboard.css">
</head>
<body class="${opts.activeTab}-page">

<div class="update-banner" id="updateBanner">
  <span class="update-badge" id="updateBadgeLabel">NEW</span>
  <div class="update-message" id="updateMessage"></div>
  <div class="update-banner-actions" id="updateActions"></div>
</div>

<div class="notif-container" id="notifContainer"></div>

<div class="header">
  <div class="header-main">
    <div class="header-title-row">
      <div class="header-brand-group">
        <h1>Tuxevil Rotator</h1>
        <span class="header-version" id="headerVersion">v--</span>
        <button id="maskBtn" class="mask-btn" onclick="toggleMask()">PII: Visible</button>
      </div>

      <nav class="header-nav-bar" id="appNav">
        <a class="header-nav-tab ${opts.activeTab === "accounts" ? "active" : ""}" id="navAccounts" href="/dashboard">
          <svg viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          Accounts
        </a>
        <a class="header-nav-tab ${opts.activeTab === "keys" ? "active" : ""}" id="navKeys" href="/dashboard/keys">
          <svg viewBox="0 0 24 24"><path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
          Virtual Keys
        </a>
        <a class="header-nav-tab ${opts.activeTab === "logs" ? "active" : ""}" id="navLogs" href="/dashboard/logs">
          <svg viewBox="0 0 24 24"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>
          Spend Logs
        </a>
      </nav>
    </div>
    <div class="header-stats">
      Uptime: <span id="uptime">--</span> |
      Port: <span id="port">--</span> |
      Rotation: <span id="rotation">--</span> reqs |
      Updated: <span id="lastRefresh">--</span> |
      Requests: <span id="totalRequests">0</span>
    </div>
  </div>
  <div class="header-actions">
    <button class="header-icon-btn attention" id="attentionBtn" onclick="openModal('attentionModal')" title="Attention Needed" aria-label="Open attention needed">
      <svg viewBox="0 0 24 24"><path d="M12 8v5"/><path d="M12 17.5h.01"/><path d="M10.3 3.8 2.9 17a2 2 0 0 0 1.75 3h14.7A2 2 0 0 0 21.1 17L13.7 3.8a2 2 0 0 0-3.4 0Z"/></svg>
      <span class="header-icon-badge attention" id="attentionBadge" style="display:none">0</span>
    </button>

    <button class="header-icon-btn heart-beat" id="kofiBtn" onclick="openModal('donationModal')" title="Support the Project" aria-label="Support the project">
      <svg viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
    </button>

    <a class="header-icon-btn website-btn" id="websiteBtn" href="https://tuxevil.com" target="_blank" title="tuxevil.com" aria-label="Visit tuxevil.com">
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
    </a>
  </div>
</div>

<script>
(function(){
  var urlParams = new URLSearchParams(window.location.search);
  var t = urlParams.get("token") || localStorage.getItem("rotatorAdminToken");
  var mask = urlParams.has("mask");
  if (t || mask) {
    ["navAccounts", "navKeys", "navLogs"].forEach(function(id) {
      var el = document.getElementById(id);
      if (el && el.getAttribute("href")) {
        var base = el.getAttribute("href").split("?")[0];
        var params = new URLSearchParams();
        if (t) params.set("token", t);
        if (mask) params.set("mask", "1");
        el.href = base + "?" + params.toString();
      }
    });
  }
})();
</script>

${opts.contentHtml}

<div class="modal" id="attentionModal" onclick="closeModal(event, 'attentionModal')">
  <div class="modal-card" onclick="event.stopPropagation()">
    <div class="modal-header">
      <strong>Attention Needed</strong>
      <button class="modal-close" onclick="closeModal(null, 'attentionModal')" aria-label="Close attention modal">×</button>
    </div>
    <div id="attentionPanel"></div>
  </div>
</div>

<div class="modal" id="donationModal" onclick="closeModal(event, 'donationModal')">
  <div class="modal-card" onclick="event.stopPropagation()" style="max-width: 500px;">
    <div class="modal-header">
      <strong>Support the Project</strong>
      <button class="modal-close" onclick="closeModal(null, 'donationModal')" aria-label="Close support modal">x</button>
    </div>
    <div style="padding: 16px; font-size: 0.95rem; line-height: 1.5; color: var(--text);">
      <p style="margin-bottom:12px;">If this tool has helped you save money on AI API costs, consider supporting its continued development.</p>
      <div style="display:flex;flex-direction:column;gap:16px;margin-bottom:20px;">
        <a href="https://ko-fi.com/tuxevil" target="_blank" style="display:inline-flex;flex-direction:column;align-items:center;background-color:#FF5E5B;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;transition:opacity 0.2s;width:100%;box-sizing:border-box;text-align:center;" onmouseover="this.style.opacity='0.9'" onmouseout="this.style.opacity='1'">
          <span style="font-weight:bold;font-size:1.1rem;">Support on Ko-fi</span>
          <span style="font-size:0.85rem;margin-top:4px;opacity:0.85;">ko-fi.com/tuxevil</span>
        </a>
        <div style="width:100%; padding:14px; border: 1px solid var(--border); border-radius: 8px; background: rgba(255,255,255,0.02); box-sizing: border-box;">
          <p style="margin-bottom:10px;font-weight:bold;color:var(--accent);font-size:0.95rem;">Free ways to support</p>
          <ul style="margin-left:18px; font-size:0.85rem; color:var(--text-dim); line-height:1.7; list-style:none; padding:0;">
            <li style="margin-bottom:6px;margin-left:0;">&#11088; <a href="https://github.com/tuxevil/tuxevil-rotator" target="_blank" style="color:var(--accent);text-decoration:underline;">Star the project on GitHub</a> — helps with visibility</li>
            <li style="margin-bottom:6px;margin-left:0;">&#128027; <a href="https://github.com/tuxevil/tuxevil-rotator/issues" target="_blank" style="color:var(--accent);text-decoration:underline;">Report bugs & contribute</a> — open issues or submit PRs</li>
            <li style="margin-bottom:0;margin-left:0;">&#128227; Share the project with colleagues or communities who might find it useful</li>
          </ul>
        </div>
      </div>
      <div style="text-align: center;">
        <button class="btn-secondary" onclick="hideDonationModalPermanently()">Dismiss</button>
      </div>
    </div>
  </div>
</div>

<footer class="app-footer">
  <div class="app-footer-inner">
    <span class="app-footer-brand">Tuxevil Rotator</span>
    <span class="app-footer-sep"></span>
    <a href="https://tuxevil.com" target="_blank">tuxevil.com</a>
    <span class="app-footer-sep"></span>
    <a href="https://github.com/tuxevil/tuxevil-rotator" target="_blank">GitHub</a>
  </div>
</footer>

<script src="${opts.scriptSrc}"></script>
</body>
</html>`;
}

const DASHBOARD_HTML = renderAppShell({
  title: "Tuxevil Rotator",
  activeTab: "accounts",
  scriptSrc: "/static/dashboard.js",
contentHtml: `
<div class="accounts-dashboard">
<div class="dashboard-intro">
  <div>
    <div class="dashboard-kicker">Operations / Account fleet</div>
    <h2>Keep the fleet moving.</h2>
    <p>Scan routing health, quota windows and account actions from one focused control room.</p>
  </div>
  <div class="dashboard-intro-actions">
    <span class="dashboard-live-chip"><span class="dashboard-live-dot"></span>Live polling</span>
    <button class="btn-secondary dashboard-refresh-btn" onclick="refresh()">Refresh now</button>
  </div>
</div>

<div class="view-toggle-bar">
  <button class="view-tab active" id="viewTabGrid" onclick="switchView('grid')">⊞ Grid</button>
  <button class="view-tab" id="viewTabList" onclick="switchView('list')">☰ List</button>
</div>

<div class="routing-panel state-stopped" id="routingHealth"></div>

<div class="routing-panel" id="autoRoutingPanel" style="margin-top:12px;display:none"></div>

<div class="routing-panel" id="tokenUsagePanel" style="margin-top:12px">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px">
    <strong style="min-width:max-content">Token Usage</strong>
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
      <div id="tokenTotals" style="font-family:JetBrains Mono,monospace;font-size:0.85rem;color:var(--text-dim);margin-right:12px"></div>
      <button class="btn-secondary btn-sm" onclick="exportData('csv')" title="Export CSV" style="padding:2px 6px">CSV</button>
      <button class="btn-secondary btn-sm" onclick="exportData('json')" title="Export JSON" style="padding:2px 6px;margin-right:8px">JSON</button>
      <div style="width:1px;height:16px;background:var(--border);margin-right:8px"></div>
      <button class="btn-secondary btn-sm" onclick="setTokenView('1h')" id="tbtn-1h">1h</button>
      <button class="btn-secondary btn-sm" onclick="setTokenView('2h')" id="tbtn-2h">2h</button>
      <button class="btn-secondary btn-sm" onclick="setTokenView('4h')" id="tbtn-4h">4h</button>
      <button class="btn-secondary btn-sm" onclick="setTokenView('8h')" id="tbtn-8h">8h</button>
      <button class="btn-secondary btn-sm" onclick="setTokenView('12h')" id="tbtn-12h">12h</button>
      <button class="btn-secondary btn-sm" onclick="setTokenView('1d')" id="tbtn-1d">1d</button>
      <button class="btn-secondary btn-sm" onclick="setTokenView('7d')" id="tbtn-7d">7d</button>
      <button class="btn-secondary btn-sm" onclick="setTokenView('1m')" id="tbtn-1m">1m</button>
    </div>
  </div>
  <div id="tokenChart" style="width:100%;overflow-x:auto"></div>
  <div id="tokenLegend" style="margin-top:8px;display:flex;gap:16px;flex-wrap:wrap;font-size:0.8rem"></div>
</div>

<div class="routing-panel" id="latencyPanel" style="margin-top:12px;display:none">
  <strong>Latency (last 200 requests)</strong>
  <div id="latencyGrid" style="margin-top:8px"></div>
</div>

<div class="routing-panel" id="forecastPanel" style="margin-top:12px;display:none">
  <strong>Quota Forecast</strong>
  <div id="forecastGrid" style="margin-top:8px"></div>
</div>

<div class="routing-panel" id="benchmarkPanel" style="margin-top:12px">
  <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
    <div>
      <strong>Account Benchmark</strong>
      <div id="benchmarkStatus" style="color:var(--text-dim);font-size:0.8rem;margin-top:4px">Measure active account performance without persisting results.</div>
    </div>
    <button class="btn-secondary" id="benchmarkBtn" onclick="runBenchmark()">Benchmark Active Accounts</button>
  </div>
  <div id="benchmarkResults" style="margin-top:12px;overflow-x:auto"></div>
</div>

<div class="accounts-grid" id="accounts"></div>

<div class="list-panel" id="listPanel" style="display:none">
  <div class="list-toolbar">
    <span class="list-toolbar-label">Installations</span>
    <input class="list-search" id="listSearch" placeholder="Search…" oninput="renderListView()" />
    <button class="list-sort-btn" id="lsort-requests" onclick="setListSort('requests')">Requests ↕</button>
    <button class="list-sort-btn" id="lsort-quota" onclick="setListSort('quota')">Quota ↕</button>
    <button class="list-sort-btn" id="lsort-tokens" onclick="setListSort('tokens')">Tokens ↕</button>
    <button class="list-sort-btn" id="lsort-status" onclick="setListSort('status')">Status ↕</button>
  </div>
  <div id="listTableWrap"></div>
</div>

<div class="routing-panel" id="heatmapPanel" style="margin-top:12px;display:none">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
    <strong>Activity Heatmap (last 60d)</strong>
    <span style="color:var(--text-dim);font-size:0.75rem">rows: hour · cols: day</span>
  </div>
  <div id="heatmapGrid"></div>
</div>

<div class="routing-panel" id="requestLogPanel" style="margin-top:12px;display:none">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
    <strong>Request Log</strong>
    <div style="display:flex;gap:6px">
      <input id="logFilterModel" placeholder="model" style="background:var(--card-bg);border:1px solid var(--border);color:var(--text);padding:2px 6px;border-radius:4px;font-size:0.75rem;width:100px" />
      <input id="logFilterAccount" placeholder="account" style="background:var(--card-bg);border:1px solid var(--border);color:var(--text);padding:2px 6px;border-radius:4px;font-size:0.75rem;width:100px" />
      <input id="logFilterStatus" placeholder="status" style="background:var(--card-bg);border:1px solid var(--border);color:var(--text);padding:2px 6px;border-radius:4px;font-size:0.75rem;width:60px" />
    </div>
  </div>
  <div id="requestLogGrid" style="max-height:320px;overflow-y:auto"></div>
</div>

<div class="events-panel" id="recentEventsPanel" style="display:none"></div>

</div>

<div class="modal" id="configEditorModal" onclick="closeModal(event, 'configEditorModal')">
  <div class="modal-card" onclick="event.stopPropagation()" style="max-width: 960px; width: min(960px, 92vw);">
    <div class="modal-header">
      <strong>Config Editor</strong>
      <button class="modal-close" onclick="closeModal(null, 'configEditorModal')" aria-label="Close config editor modal">×</button>
    </div>
    <div style="padding:16px;">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
        <div id="configEditorStatus" style="font-size:12px;color:var(--text-dim)"></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn-secondary" onclick="loadConfigEditor()">Reload</button>
          <button class="btn-secondary" onclick="saveConfigEditor()">Save</button>
          <button class="btn-secondary" onclick="exportConfig()">Export</button>
          <button class="btn-secondary" onclick="importConfigPrompt()">Import</button>
          <button class="btn-secondary" onclick="window.location.href='/login' + (ADMIN_TOKEN ? ('?token=' + encodeURIComponent(ADMIN_TOKEN)) : '')">Hosted Login</button>
        </div>
      </div>
      <textarea id="configEditor" spellcheck="false" style="width:100%;min-height:420px;background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:12px;font-family:'JetBrains Mono', monospace;font-size:12px;line-height:1.5"></textarea>
      <div style="margin-top:8px;font-size:12px;color:var(--text-dim)">routingPolicy: timer-first, tier-first, quota-first, hybrid, sequential-quota o sticky-quota. Las políticas quota-aware evitan la rotación por contador; sticky-quota vuelve a la cuenta preferida después de un cooldown.</div>
    </div>
  </div>
</div>

<div class="modal" id="routingInspectorModal" onclick="closeModal(event, 'routingInspectorModal')">
  <div class="modal-card" onclick="event.stopPropagation()" style="max-width: 1100px; width: min(1100px, 94vw);">
    <div class="modal-header">
      <strong>Routing Inspector</strong>
      <button class="modal-close" onclick="closeModal(null, 'routingInspectorModal')" aria-label="Close routing inspector modal">×</button>
    </div>
    <div id="routingInspectorPanel" style="padding:16px;"></div>
  </div>
</div>
`,
});

const DASHBOARD_KEYS_HTML = renderAppShell({
  title: "Virtual Keys",
  activeTab: "keys",
  scriptSrc: "/static/dashboard-keys.js",
  contentHtml: `
<div class="keys-workspace">
<div class="workspace-intro">
  <div>
    <div class="workspace-kicker">Access / Credentials</div>
    <h2>Virtual Keys &amp; Access Control</h2>
    <p>Manage API credentials, agent assignments, and per-model authorization rules from one operator workspace.</p>
  </div>
  <div class="workspace-intro-actions">
    <span class="workspace-live-chip"><span class="workspace-live-dot"></span>Registry live</span>
    <button class="btn-modal-submit workspace-primary-action" onclick="showGenerateModal()" style="display:inline-flex;align-items:center;gap:8px">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
      Generate Virtual Key
    </button>
  </div>
</div>

<div class="stats-summary-grid keys-stats">
  <div class="summary-card">
    <div class="summary-card-header">
      <span>Total Credentials</span>
      <div class="summary-card-icon">
        <svg viewBox="0 0 24 24"><path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
      </div>
    </div>
    <div class="summary-card-value" id="statTotalKeys">0</div>
    <div class="summary-card-sub">Registered virtual keys</div>
  </div>

  <div class="summary-card">
    <div class="summary-card-header">
      <span>Active Keys</span>
      <div class="summary-card-icon" style="background:rgba(52,211,153,0.1);color:var(--green)">
        <svg viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
      </div>
    </div>
    <div class="summary-card-value" id="statActiveKeys" style="color:var(--green)">0</div>
    <div class="summary-card-sub">Authorized for requests</div>
  </div>

  <div class="summary-card">
    <div class="summary-card-header">
      <span>Blocked Keys</span>
      <div class="summary-card-icon" style="background:rgba(248,113,113,0.1);color:var(--red)">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
      </div>
    </div>
    <div class="summary-card-value" id="statBlockedKeys" style="color:var(--red)">0</div>
    <div class="summary-card-sub">Revoked access</div>
  </div>

  <div class="summary-card">
    <div class="summary-card-header">
      <span>Supported Models</span>
      <div class="summary-card-icon" style="background:rgba(96,165,250,0.1);color:var(--blue)">
        <svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
      </div>
    </div>
    <div class="summary-card-value" id="statAvailableModels">12</div>
    <div class="summary-card-sub">Gemini, Claude, GPT-OSS</div>
  </div>
</div>

<div class="list-panel keys-list-panel">
  <div class="list-toolbar keys-list-toolbar">
    <span class="list-toolbar-label">Virtual Keys</span>
    <div class="filter-input-group" style="width:260px">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
      <input id="keySearchInput" placeholder="Search alias, key name, user..." oninput="renderKeys()">
    </div>
    <div class="filter-input-group" style="width:140px">
      <select id="keyStatusFilter" onchange="renderKeys()">
        <option value="all">All Statuses</option>
        <option value="active">Active Only</option>
        <option value="blocked">Blocked Only</option>
      </select>
    </div>
  </div>

  <div style="overflow-x:auto">
    <table class="compact-table">
      <thead>
        <tr>
          <th>Key Alias &amp; Name</th>
          <th>User ID</th>
          <th>Allowed Models</th>
          <th>Status</th>
          <th>Last Active</th>
          <th style="width:110px;text-align:right">Actions</th>
        </tr>
      </thead>
      <tbody id="keysTbody"></tbody>
    </table>
  </div>
</div>
</div>

<div id="keyModal" class="modal" onclick="if(event.target===this) hideModal()">
  <div class="modal-card" onclick="event.stopPropagation()" style="max-width:640px;display:flex;flex-direction:column;max-height:90vh;overflow:hidden">
    <div class="modal-header">
      <div class="modal-title-group">
        <div class="modal-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"></path></svg>
        </div>
        <div>
          <h3 id="modalTitle" class="modal-title">Generate Virtual Key</h3>
          <p id="modalSubtitle" class="modal-subtitle">Configure key access and model restrictions</p>
        </div>
      </div>
      <button class="modal-close-btn" onclick="hideModal()" type="button" aria-label="Close">&times;</button>
    </div>

    <div class="modal-body" style="overflow-y:auto;flex:1">
      <div class="form-grid">
        <div class="form-group">
          <label class="form-label" for="keyFormAlias">Key Alias <span class="req">*</span></label>
          <input id="keyFormAlias" class="form-input" placeholder="e.g. cursor-agent" autofocus>
        </div>
        <div class="form-group">
          <label class="form-label" for="keyFormUserId">User ID <span class="opt">(optional)</span></label>
          <input id="keyFormUserId" class="form-input" placeholder="e.g. seba">
        </div>
      </div>

      <div id="modelCheckboxes" class="models-section">
        <div class="models-header">
          <div>
            <span class="form-label">Allowed Models</span>
            <span class="models-badge" id="modelsCountBadge">All models allowed</span>
          </div>
          <div class="models-actions">
            <button class="pill-btn" onclick="selectAllModels()" type="button">Select All</button>
            <button class="pill-btn" onclick="selectNoModels()" type="button">Clear All</button>
          </div>
        </div>

        <div class="model-grid">
          <div class="model-category">
            <div class="cat-title">Gemini 3.1 Pro</div>
            <div class="cat-grid">
              <label class="model-card"><input type="checkbox" value="gemini-3.1-pro-low" class="modelCb" onchange="updateModelsCountBadge()"><span class="model-name">gemini-3.1-pro-low</span></label>
              <label class="model-card"><input type="checkbox" value="gemini-3.1-pro-high" class="modelCb" onchange="updateModelsCountBadge()"><span class="model-name">gemini-3.1-pro-high</span></label>
            </div>
          </div>
          <div class="model-category">
            <div class="cat-title">Gemini 3.5 Flash</div>
            <div class="cat-grid">
              <label class="model-card"><input type="checkbox" value="gemini-3.5-flash-medium" class="modelCb" onchange="updateModelsCountBadge()"><span class="model-name">gemini-3.5-flash-medium</span></label>
              <label class="model-card"><input type="checkbox" value="gemini-3.5-flash-high" class="modelCb" onchange="updateModelsCountBadge()"><span class="model-name">gemini-3.5-flash-high</span></label>
              <label class="model-card"><input type="checkbox" value="gemini-3-flash" class="modelCb" onchange="updateModelsCountBadge()"><span class="model-name">gemini-3-flash</span></label>
            </div>
          </div>
          <div class="model-category">
            <div class="cat-title">Gemini 3.6 Flash</div>
            <div class="cat-grid">
              <label class="model-card"><input type="checkbox" value="gemini-3.6-flash-low" class="modelCb" onchange="updateModelsCountBadge()"><span class="model-name">gemini-3.6-flash-low</span></label>
              <label class="model-card"><input type="checkbox" value="gemini-3.6-flash-medium" class="modelCb" onchange="updateModelsCountBadge()"><span class="model-name">gemini-3.6-flash-medium</span></label>
              <label class="model-card"><input type="checkbox" value="gemini-3.6-flash-high" class="modelCb" onchange="updateModelsCountBadge()"><span class="model-name">gemini-3.6-flash-high</span></label>
              <label class="model-card"><input type="checkbox" value="gemini-3.6-flash-tiered" class="modelCb" onchange="updateModelsCountBadge()"><span class="model-name">gemini-3.6-flash-tiered</span></label>
            </div>
          </div>
          <div class="model-category">
            <div class="cat-title">Claude</div>
            <div class="cat-grid">
              <label class="model-card"><input type="checkbox" value="claude-sonnet-4-6" class="modelCb" onchange="updateModelsCountBadge()"><span class="model-name">claude-sonnet-4-6</span></label>
              <label class="model-card"><input type="checkbox" value="claude-opus-4-6-thinking" class="modelCb" onchange="updateModelsCountBadge()"><span class="model-name">claude-opus-4-6-thinking</span></label>
            </div>
          </div>
          <div class="model-category">
            <div class="cat-title">GPT-OSS</div>
            <div class="cat-grid">
              <label class="model-card"><input type="checkbox" value="gpt-oss-120b-medium" class="modelCb" onchange="updateModelsCountBadge()"><span class="model-name">gpt-oss-120b-medium</span></label>
            </div>
          </div>
        </div>
      </div>

      <div id="keyFormError" class="modal-error"></div>

      <div id="generatedKeyResult" class="generated-key-box" style="display:none">
        <div class="key-warn-header">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
          Save this key now — it won't be shown again!
        </div>
        <div class="raw" id="generatedRawKey"></div>
        <button id="copyKeyBtn" class="btn-secondary" onclick="copyRawKey()" style="margin-top:8px" type="button">Copy Key</button>
      </div>
    </div>

    <div class="modal-footer">
      <button class="btn-modal-cancel" onclick="hideModal()" type="button">Cancel</button>
      <button class="btn-modal-submit" onclick="submitKeyForm()" id="submitKeyBtn" type="button">Generate Key</button>
    </div>
  </div>
</div>
`,
});

const DASHBOARD_LOGS_HTML = renderAppShell({
  title: "Spend Logs",
  activeTab: "logs",
  scriptSrc: "/static/dashboard-logs.js",
  contentHtml: `
<div class="logs-workspace">
<div class="workspace-intro">
  <div>
    <div class="workspace-kicker">Observability / Spend telemetry</div>
    <h2>Spend Logs &amp; Usage Analytics</h2>
    <p>Trace request cost, token flow, latency, and payload context through a focused audit console.</p>
  </div>
  <div class="workspace-intro-actions">
    <span class="workspace-live-chip"><span class="workspace-live-dot"></span>Live audit</span>
    <button class="btn-secondary workspace-refresh-action" onclick="loadLogs(0)">Refresh logs</button>
  </div>
</div>

<div class="stats-summary-grid logs-stats">
  <div class="summary-card">
    <div class="summary-card-header">
      <span>Total Requests</span>
      <div class="summary-card-icon">
        <svg viewBox="0 0 24 24"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>
      </div>
    </div>
    <div class="summary-card-value" id="statLogRequests">0</div>
    <div class="summary-card-sub" id="statLogRequestsSub">Logged requests</div>
  </div>

  <div class="summary-card">
    <div class="summary-card-header">
      <span>Prompt Tokens</span>
      <div class="summary-card-icon" style="background:rgba(124,92,252,0.1);color:var(--accent)">
        <svg viewBox="0 0 24 24"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>
      </div>
    </div>
    <div class="summary-card-value" id="statLogPromptTokens">0</div>
    <div class="summary-card-sub">Input tokens processed</div>
  </div>

  <div class="summary-card">
    <div class="summary-card-header">
      <span>Completion Tokens</span>
      <div class="summary-card-icon" style="background:rgba(52,211,153,0.1);color:var(--green)">
        <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
      </div>
    </div>
    <div class="summary-card-value" id="statLogCompletionTokens" style="color:var(--green)">0</div>
    <div class="summary-card-sub">Output tokens generated</div>
  </div>

  <div class="summary-card">
    <div class="summary-card-header">
      <span>Est. Cost</span>
      <div class="summary-card-icon" style="background:rgba(59,130,246,0.1);color:#3b82f6">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
      </div>
    </div>
    <div class="summary-card-value" id="statLogCost" style="color:#3b82f6">$0.000000</div>
    <div class="summary-card-sub">Estimated USD cost</div>
  </div>

  <div class="summary-card">
    <div class="summary-card-header">
      <span>Avg Latency</span>
      <div class="summary-card-icon" style="background:rgba(251,191,36,0.1);color:var(--yellow)">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      </div>
    </div>
    <div class="summary-card-value" id="statLogAvgLatency" style="color:var(--yellow)">--</div>
    <div class="summary-card-sub">Average round-trip duration</div>
  </div>
</div>

<div id="byKeySummary" class="logs-by-key-summary"></div>

<div class="filter-panel logs-filter-panel">
  <div class="logs-filter-heading">
    <div>
      <span class="logs-filter-kicker">Query console</span>
      <strong>Filter request history</strong>
    </div>
    <span>Use filters to narrow the audit window, then expand any row for payload context.</span>
  </div>
  <div class="multiselect-container" id="keyMultiselectContainer">
    <div class="multiselect-trigger" id="keyMultiselectTrigger" onclick="toggleMultiselect(event, 'key')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
      <span class="multiselect-label" id="keyMultiselectLabel">All Keys</span>
      <svg class="multiselect-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
    </div>
    <div class="multiselect-menu" id="keyMultiselectMenu" style="display:none">
      <div class="multiselect-header">
        <input type="text" class="multiselect-search" id="keySearchInput" placeholder="Search keys..." onclick="event.stopPropagation()" oninput="filterMultiselectOptions('key')">
        <div class="multiselect-actions">
          <button type="button" class="multiselect-action-btn" onclick="selectAllMultiselect('key')">Select All</button>
          <button type="button" class="multiselect-action-btn" onclick="clearMultiselect('key')">Clear</button>
        </div>
      </div>
      <div class="multiselect-options" id="keyMultiselectOptions">
        <div style="padding:8px;color:var(--text-dim);font-size:12px;text-align:center">Loading keys...</div>
      </div>
    </div>
  </div>

  <div class="multiselect-container" id="modelMultiselectContainer">
    <div class="multiselect-trigger" id="modelMultiselectTrigger" onclick="toggleMultiselect(event, 'model')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
      <span class="multiselect-label" id="modelMultiselectLabel">All Models</span>
      <svg class="multiselect-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
    </div>
    <div class="multiselect-menu" id="modelMultiselectMenu" style="display:none">
      <div class="multiselect-header">
        <input type="text" class="multiselect-search" id="modelSearchInput" placeholder="Search models..." onclick="event.stopPropagation()" oninput="filterMultiselectOptions('model')">
        <div class="multiselect-actions">
          <button type="button" class="multiselect-action-btn" onclick="selectAllMultiselect('model')">Select All</button>
          <button type="button" class="multiselect-action-btn" onclick="clearMultiselect('model')">Clear</button>
        </div>
      </div>
      <div class="multiselect-options" id="modelMultiselectOptions">
        <div style="padding:8px;color:var(--text-dim);font-size:12px;text-align:center">Loading models...</div>
      </div>
    </div>
  </div>

  <div class="filter-input-group" style="width:150px">
    <select id="filterStatus">
      <option value="">All Statuses</option>
      <option value="success">Success (200)</option>
      <option value="failure">Failure / Error</option>
    </select>
  </div>

  <div class="filter-input-group" style="width:150px">
    <input id="filterStartDate" type="date" title="From Date">
  </div>

  <div class="filter-input-group" style="width:150px">
    <input id="filterEndDate" type="date" title="To Date">
  </div>

  <button class="pill-btn" onclick="applyFilters()" style="background:var(--accent);color:#fff;border:none;padding:7px 14px;font-weight:600;cursor:pointer">Apply</button>
  <button class="pill-btn" onclick="resetFilters()" style="padding:7px 12px;cursor:pointer">Reset</button>

  <div class="filter-input-group" style="width:160px;margin-left:auto">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;color:var(--text-dim)"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
    <select id="autoRefreshSelect" onchange="changeAutoRefresh(this.value)" title="Auto Refresh">
      <option value="0">Auto-refresh: Off</option>
      <option value="5">Auto-refresh: 5s</option>
      <option value="10">Auto-refresh: 10s</option>
      <option value="30">Auto-refresh: 30s</option>
      <option value="60">Auto-refresh: 60s</option>
    </select>
  </div>

  <div class="col-picker-container" style="position:relative">
    <button class="pill-btn" onclick="toggleColumnPicker(event)" type="button" style="display:inline-flex;align-items:center;gap:6px;padding:7px 12px;cursor:pointer">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="M15 3v18"/></svg>
      <span>Columns</span>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
    </button>
    <div id="colPickerMenu" class="col-picker-menu" style="display:none" onclick="event.stopPropagation()">
      <div class="col-picker-header">
        <span>Visible Columns</span>
        <button type="button" class="col-picker-reset" onclick="resetColumns()">Reset</button>
      </div>
      <div class="col-picker-list">
        <label class="col-picker-item"><input type="checkbox" data-col="time" checked onchange="toggleColumn('time')"> Time</label>
        <label class="col-picker-item"><input type="checkbox" data-col="key" checked onchange="toggleColumn('key')"> Key / Agent</label>
        <label class="col-picker-item"><input type="checkbox" data-col="model" checked onchange="toggleColumn('model')"> Model</label>
        <label class="col-picker-item"><input type="checkbox" data-col="type" checked onchange="toggleColumn('type')"> Call Type</label>
        <label class="col-picker-item"><input type="checkbox" data-col="status" checked onchange="toggleColumn('status')"> Status</label>
        <label class="col-picker-item"><input type="checkbox" data-col="tokens" checked onchange="toggleColumn('tokens')"> Tokens (In / Out)</label>
        <label class="col-picker-item"><input type="checkbox" data-col="cost" checked onchange="toggleColumn('cost')"> Est. Cost</label>
        <label class="col-picker-item"><input type="checkbox" data-col="duration" checked onchange="toggleColumn('duration')"> Duration</label>
        <label class="col-picker-item"><input type="checkbox" data-col="ttfb" checked onchange="toggleColumn('ttfb')"> TTFB</label>
        <label class="col-picker-item"><input type="checkbox" data-col="ip" checked onchange="toggleColumn('ip')"> IP Address</label>
      </div>
    </div>
  </div>
</div>

<div class="list-panel logs-list-panel">
  <div style="overflow-x:auto">
    <table id="logsTable" class="compact-table">
      <thead>
        <tr>
          <th class="col-time">Time</th>
          <th class="col-key">Key / Agent</th>
          <th class="col-model">Model</th>
          <th class="col-type">Call Type</th>
          <th class="col-status">Status</th>
          <th class="col-tokens">Tokens (In / Out)</th>
          <th class="col-cost">Est. Cost</th>
          <th class="col-duration">Duration</th>
          <th class="col-ttfb">TTFB</th>
          <th class="col-ip">IP</th>
        </tr>
      </thead>
      <tbody id="logsBody"></tbody>
    </table>
  </div>
</div>

<div id="pagination" class="logs-pagination" style="margin-top:16px;display:flex;justify-content:center;align-items:center;gap:8px;font-size:0.85rem"></div>
</div>
`,
});
