import type { IncomingMessage, ServerResponse } from "node:http";
import { getConfiguredAdminToken } from "./admin-auth.js";
import { addAccountToConfig } from "./account-store.js";
import { PayloadTooLargeError, readLimitedBody } from "./body-limit.js";
import {
  buildAuthUrl,
  discoverProject,
  exchangeAuthorizationCode,
  generatePkce,
  generateState,
  getOAuthClientConfig,
  getUserEmail,
  isHostedOAuthConfigured,
} from "./providers/google-antigravity/oauth.js";
import {
  defaultAccountEmail,
  validateApiKey,
} from "./providers/ollama/api-key-validation.js";
import {
  validateApiKey as validateZenApiKey,
} from "./providers/opencode-zen/login.js";
import {
  defaultAccountEmail as zenDefaultAccountEmail,
  OPENCODE_ZEN_PROVIDER_ID,
} from "./providers/opencode-zen/credentials.js";
import {
  codexOAuthErrorMessage,
  createCodexAuthorizationFlow,
  exchangeCodexAuthorizationCode,
  getCodexOAuthConfig,
  parseCodexIdentity,
  type CodexOAuthConfig,
} from "./providers/openai-codex/oauth.js";
import type { AccountConfig } from "./types.js";

interface AccountSink {
  addOrUpdateAccount(account: AccountConfig): Promise<void>;
}

interface PendingSession {
  verifier: string;
  createdAt: number;
}

const pendingSessions = new Map<string, PendingSession>();
const SESSION_TTL_MS = 15 * 60 * 1000;
const SESSION_PRUNE_INTERVAL_MS = 5 * 60 * 1000;
const MAX_CLI_LOGIN_BODY_BYTES = 64 * 1024;

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function prunePendingSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [state, session] of pendingSessions.entries()) {
    if (session.createdAt < cutoff) {
      pendingSessions.delete(state);
    }
  }
}

// Background reaper. Without this, a long-lived proxy that never sees
// /auth/antigravity/start or /callback would accumulate stale sessions
// (each is a 96-byte PKCE verifier + timestamp). The interval is unref'd
// so it does not block process exit.
let pruneTimer: ReturnType<typeof setInterval> | null = null;
function startPendingSessionReaper(): void {
  if (pruneTimer) return;
  pruneTimer = setInterval(
    () => prunePendingSessions(),
    SESSION_PRUNE_INTERVAL_MS,
  );
  if (pruneTimer.unref) pruneTimer.unref();
}
export function stopPendingSessionReaper(): void {
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
}
startPendingSessionReaper();

function renderPage(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500&display=swap');
  :root {
    --bg: #f4efe6;
    --ink: #1f2a1f;
    --muted: #5b6659;
    --card: rgba(255,255,255,0.8);
    --line: rgba(31,42,31,0.12);
    --accent: #1e6b52;
    --accent-2: #d99058;
    --warn: #9a4b3f;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    font-family: 'Space Grotesk', system-ui, sans-serif;
    color: var(--ink);
    background:
      radial-gradient(circle at top left, rgba(217,144,88,0.28), transparent 32%),
      radial-gradient(circle at bottom right, rgba(30,107,82,0.22), transparent 28%),
      linear-gradient(160deg, #f7f1e8, #efe5d6 52%, #e9ddcb);
    display: grid;
    place-items: center;
    padding: 24px;
  }
  .card {
    width: min(760px, 100%);
    background: var(--card);
    backdrop-filter: blur(14px);
    border: 1px solid var(--line);
    border-radius: 24px;
    padding: 28px;
    box-shadow: 0 20px 80px rgba(31, 42, 31, 0.08);
  }
  h1 {
    margin: 0 0 10px;
    font-size: clamp(32px, 6vw, 56px);
    line-height: 0.96;
    letter-spacing: -0.04em;
  }
  p, li {
    font-size: 16px;
    line-height: 1.6;
    color: var(--muted);
  }
  .mono {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 13px;
    color: var(--ink);
    background: rgba(31,42,31,0.05);
    border: 1px solid rgba(31,42,31,0.08);
    border-radius: 12px;
    padding: 12px 14px;
    overflow-wrap: anywhere;
  }
  .cta {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-top: 18px;
    padding: 14px 20px;
    border-radius: 999px;
    background: var(--accent);
    color: white;
    text-decoration: none;
    font-weight: 700;
    box-shadow: 0 12px 30px rgba(30,107,82,0.22);
  }
  .cta:hover { background: #185843; }
  .note {
    margin-top: 18px;
    padding: 14px 16px;
    border-left: 4px solid var(--accent-2);
    background: rgba(217,144,88,0.12);
    border-radius: 12px;
  }
  .error {
    border-left-color: var(--warn);
    background: rgba(154,75,63,0.12);
  }
  ul {
    padding-left: 18px;
    margin: 16px 0 0;
  }
  .field {
    width: 100%;
    margin-top: 12px;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 13px;
    padding: 12px 14px;
    border-radius: 12px;
    border: 1px solid var(--line);
    background: rgba(31,42,31,0.03);
  }
  label {
    display: block;
    margin-top: 14px;
    font-size: 14px;
    font-weight: 600;
    color: var(--ink);
  }
  .tabs {
    display: flex;
    gap: 8px;
    margin: 20px 0 4px;
    flex-wrap: wrap;
  }
  .tab {
    padding: 10px 16px;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: rgba(31,42,31,0.04);
    color: var(--muted);
    font-family: inherit;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
  }
  .tab.active {
    background: var(--accent);
    border-color: var(--accent);
    color: white;
  }
  .panel { display: none; }
  .panel.active { display: block; }
</style>
</head>
<body>
  <main class="card">
    ${body}
  </main>
</body>
</html>`;
}

export function serveLoginLanding(res: ServerResponse): void {
  const hostedReady = isHostedOAuthConfigured();
  const oauth = hostedReady ? getOAuthClientConfig() : null;
  // The start route is admin-gated, so carry the token through — the page
  // itself is only reachable with a valid token anyway.
  const adminToken = getConfiguredAdminToken();
  const startHref = adminToken
    ? `/auth/antigravity/start?token=${encodeURIComponent(adminToken)}`
    : "/auth/antigravity/start";
  const message = hostedReady
    ? `<p>This page starts the Antigravity sign-in flow and returns here automatically so the account can be added to this rotator.</p>
<p class="mono">Configured callback: ${escapeHtml(oauth?.redirectUri)}</p>
<div class="note">Signing in here grants this server a refresh token for the selected Google account. That allows the rotator to keep using that account until access is revoked.</div>
<a class="cta" href="${startHref}">Continue With Google</a>`
    : `<p>This server is not yet configured for hosted OAuth.</p>
<p class="mono">Set ANTIGRAVITY_REDIRECT_URI, and usually ANTIGRAVITY_CLIENT_ID plus ANTIGRAVITY_CLIENT_SECRET, to a public callback URL registered with the OAuth client.</p>
<div class="note error">The current redirect is still loopback-only, so the transparent public callback cannot complete yet.</div>`;

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(
    renderPage("Antigravity Login", `<h1>Connect Your Account</h1>${message}`),
  );
}

export function startHostedLogin(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  if (!isHostedOAuthConfigured()) {
    res.writeHead(409, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      renderPage(
        "Hosted OAuth Not Configured",
        "<h1>Hosted Login Isn’t Ready</h1><p>This server still uses a loopback redirect URI. Configure a public redirect before sharing this page.</p>",
      ),
    );
    return;
  }

  prunePendingSessions();
  const { verifier, challenge } = generatePkce();
  const state = generateState();
  pendingSessions.set(state, { verifier, createdAt: Date.now() });

  const authUrl = buildAuthUrl(state, challenge);
  res.writeHead(302, { Location: authUrl });
  res.end();
}

// ── Web-based CLI login (/login-cli) ──────────────────────────────────────────
// Replicates the CLI login flow in the browser: shows the Google OAuth URL,
// user signs in and pastes the redirect URL back, server exchanges the code.

interface CliLoginSession {
  provider: "google-antigravity" | "openai-codex";
  verifier: string;
  challenge: string;
  oauthState: string;
  authUrl: string;
  createdAt: number;
  codexConfig?: CodexOAuthConfig;
}

const cliLoginSessions = new Map<string, CliLoginSession>();

function pruneCliSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of cliLoginSessions.entries()) {
    if (session.createdAt < cutoff) {
      cliLoginSessions.delete(id);
    }
  }
}

export function serveCliLogin(res: ServerResponse): void {
  pruneCliSessions();
  const { verifier, challenge } = generatePkce();
  const oauthState = generateState();
  let authUrl: string | null = null;
  let sessionId: string | null = null;
  try {
    authUrl = buildAuthUrl(oauthState, challenge);
    sessionId = generateState();
    cliLoginSessions.set(sessionId, {
      provider: "google-antigravity",
      verifier,
      challenge,
      oauthState,
      authUrl,
      createdAt: Date.now(),
    });
  } catch {
    // Google is optional for this provider-aware page. Codex and Ollama stay
    // available when Antigravity OAuth is not configured.
  }

  let codexAuthUrl: string | null = null;
  let codexSessionId: string | null = null;
  try {
    const codexConfig = getCodexOAuthConfig();
    const codexFlow = createCodexAuthorizationFlow(codexConfig);
    codexSessionId = generateState();
    codexAuthUrl = codexFlow.url;
    cliLoginSessions.set(codexSessionId, {
      provider: "openai-codex",
      verifier: codexFlow.verifier,
      challenge: "",
      oauthState: codexFlow.state,
      authUrl: codexFlow.url,
      createdAt: Date.now(),
      codexConfig,
    });
  } catch {
    // Keep Google/Ollama login usable if an operator supplied malformed Codex
    // OAuth environment overrides.
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(
    renderPage(
      "Add Account",
      `<h1>Add Account</h1>
<p>This page works like the CLI login. Pick a provider below and follow the steps to add an account to the rotator.</p>

<div class="tabs">
  <button class="tab active" data-panel="panel-google">Google (Antigravity)</button>
  <button class="tab" data-panel="panel-codex">OpenAI Codex</button>
  <button class="tab" data-panel="panel-ollama">Ollama Cloud</button>
  <button class="tab" data-panel="panel-zen">OpenCode Zen</button>
</div>

<div class="panel active" id="panel-google">
${authUrl && sessionId ? `<h3 style="margin:24px 0 8px;font-size:18px;">Step 1 &mdash; Sign in with Google</h3>
<p>Click the button below to open the Google sign-in page in a new tab:</p>
<a class="cta" href="${escapeHtml(authUrl)}" target="_blank" rel="noopener" style="font-size:16px;">
  Sign in with Google &nearr;
</a>

<h3 style="margin:24px 0 8px;font-size:18px;">Step 2 &mdash; Paste the redirect URL</h3>
<p>After signing in, Google will redirect to <code>localhost</code> (which will fail — that's expected). Copy the <strong>full URL</strong> from your browser's address bar and paste it here:</p>
<form id="pasteForm" style="margin-top:12px;">
  <input type="hidden" name="session" value="${escapeHtml(sessionId)}" />
  <textarea name="redirectUrl" rows="4" placeholder="Paste the redirect URL here (starts with http://localhost:51121/oauth-callback?...)" style="
    width:100%;font-family:'IBM Plex Mono',monospace;font-size:13px;
    padding:12px 14px;border-radius:12px;border:1px solid rgba(31,42,31,0.15);
    background:rgba(31,42,31,0.03);resize:vertical;
  "></textarea>
  <button type="submit" class="cta" style="cursor:pointer;border:none;font-family:inherit;font-size:16px;margin-top:12px;">
    Connect Account
  </button>
</form>` : `<div class="note error">Google OAuth is not configured for this server. Set ANTIGRAVITY_CLIENT_ID, ANTIGRAVITY_CLIENT_SECRET and ANTIGRAVITY_REDIRECT_URI to enable it.</div>`}
</div>

<div class="panel" id="panel-codex">
${codexAuthUrl && codexSessionId ? `<h3 style="margin:24px 0 8px;font-size:18px;">Step 1 &mdash; Sign in with ChatGPT</h3>
<p>Open the OpenAI sign-in page in a new tab. Codex OAuth will return to the loopback URL configured for the Codex CLI.</p>
<a class="cta" href="${escapeHtml(codexAuthUrl)}" target="_blank" rel="noopener" style="font-size:16px;">
  Sign in with OpenAI Codex &nearr;
</a>

<h3 style="margin:24px 0 8px;font-size:18px;">Step 2 &mdash; Paste the callback URL</h3>
<p>Copy the complete URL from the browser address bar, even if the loopback page does not load, and paste it here:</p>
<form id="codexPasteForm" style="margin-top:12px;">
  <input type="hidden" name="session" value="${escapeHtml(codexSessionId)}" />
  <textarea name="redirectUrl" rows="4" placeholder="Paste the Codex callback URL (http://localhost:1455/auth/callback?... )" style="
    width:100%;font-family:'IBM Plex Mono',monospace;font-size:13px;
    padding:12px 14px;border-radius:12px;border:1px solid rgba(31,42,31,0.15);
    background:rgba(31,42,31,0.03);resize:vertical;
  "></textarea>
  <button type="submit" class="cta" style="cursor:pointer;border:none;font-family:inherit;font-size:16px;margin-top:12px;">
    Connect Codex Account
  </button>
</form>` : `<div class="note error">Codex OAuth is not available because its configuration is invalid. Check the CODEX_OAUTH_* environment variables and reload this page.</div>`}
</div>

<div class="panel" id="panel-ollama">
<p>Paste an Ollama Cloud API key to add the account to this rotator. The key is validated against ollama.com before saving.</p>
<p class="mono">Create a key at https://ollama.com/settings/keys</p>
<form id="keyForm" style="margin-top:12px;">
  <label for="email">Account identifier (email or label)</label>
  <input id="email" name="email" class="field" placeholder="me@example.com (optional)" autocomplete="off" />
  <label for="apiKey">Ollama API key</label>
  <input id="apiKey" name="apiKey" class="field" type="password" placeholder="ollama-..." autocomplete="off" required />
  <button type="submit" class="cta" style="cursor:pointer;border:none;font-family:inherit;font-size:16px;margin-top:12px;">
    Connect Account
  </button>
</form>
</div>

<div class="panel" id="panel-zen">
<p>Paste an OpenCode Zen API key to add the account to this rotator. The key is validated against opencode.ai/zen before saving.</p>
<p class="mono">Create a key at https://opencode.ai/zen</p>
<form id="zenForm" style="margin-top:12px;">
  <label for="zenEmail">Account identifier (email or label)</label>
  <input id="zenEmail" name="email" class="field" placeholder="me@example.com (optional)" autocomplete="off" />
  <label for="zenApiKey">OpenCode Zen API key</label>
  <input id="zenApiKey" name="apiKey" class="field" type="password" placeholder="sk-..." autocomplete="off" required />
  <button type="submit" class="cta" style="cursor:pointer;border:none;font-family:inherit;font-size:16px;margin-top:12px;">
    Connect Account
  </button>
</form>
</div>

<div id="result" style="margin-top:18px;"></div>

<script>
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === tab.dataset.panel));
  });
});

function showResult(html) {
  document.getElementById('result').innerHTML = html;
}

const googleForm = document.getElementById('pasteForm');
if (googleForm) googleForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector('button[type=submit]');
  const resultDiv = document.getElementById('result');
  const redirectUrl = form.redirectUrl.value.trim();
  const session = form.session.value;
  if (!redirectUrl) { showResult('<div class="note error">Please paste the redirect URL.</div>'); return; }
  btn.disabled = true;
  btn.textContent = 'Connecting...';
  showResult('<div class="note">Exchanging code for tokens...</div>');
  try {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    const res = await fetch('/api/cli-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Rotator-Admin-Token': token } : {}) },
      body: JSON.stringify({ provider: 'google-antigravity', session, redirectUrl }),
    });
    const data = await res.json();
    if (data.ok) {
      showResult('<div class="note" style="border-left-color:var(--accent);background:rgba(30,107,82,0.12);">' +
        '<strong id="loginResultEmail"></strong> ' + (data.isNew ? 'added' : 'updated') + ' successfully.<br>' +
        'Project: <span id="loginResultProject" class="mono" style="padding:2px 6px;"></span>' +
        '</div>');
      document.getElementById('loginResultEmail').textContent = data.email || '';
      document.getElementById('loginResultProject').textContent = data.projectId || '';
    } else {
      var errorDiv = document.createElement('div');
      errorDiv.className = 'note error';
      errorDiv.textContent = data.error || 'Unknown error';
      resultDiv.innerHTML = '';
      resultDiv.appendChild(errorDiv);
    }
  } catch (err) {
    var errDiv = document.createElement('div');
    errDiv.className = 'note error';
    errDiv.textContent = 'Request failed: ' + err.message;
    resultDiv.innerHTML = '';
    resultDiv.appendChild(errDiv);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect Account';
  }
});

document.getElementById('keyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector('button[type=submit]');
  const apiKey = form.apiKey.value.trim();
  const email = form.email.value.trim();
  if (!apiKey) { showResult('<div class="note error">Please paste an API key.</div>'); return; }
  btn.disabled = true;
  btn.textContent = 'Validating...';
  showResult('<div class="note">Checking the key against ollama.com...</div>');
  try {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    const res = await fetch('/api/cli-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Rotator-Admin-Token': token } : {}) },
      body: JSON.stringify({ provider: 'ollama', email, apiKey }),
    });
    const data = await res.json();
    if (data.ok) {
      showResult('<div class="note" style="border-left-color:var(--accent);background:rgba(30,107,82,0.12);">' +
        '<strong>' + (data.email || '') + '</strong> ' + (data.isNew ? 'added' : 'updated') + ' successfully. The rotator will start using it on the next poll.</div>');
    } else {
      var keyErrDiv = document.createElement('div');
      keyErrDiv.className = 'note error';
      keyErrDiv.textContent = data.error || 'Unknown error';
      document.getElementById('result').innerHTML = '';
      document.getElementById('result').appendChild(keyErrDiv);
    }
  } catch (err) {
    var keyErr2 = document.createElement('div');
    keyErr2.className = 'note error';
    keyErr2.textContent = 'Request failed: ' + err.message;
    document.getElementById('result').innerHTML = '';
    document.getElementById('result').appendChild(keyErr2);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect Account';
  }
});

const codexForm = document.getElementById('codexPasteForm');
if (codexForm) codexForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector('button[type=submit]');
  const redirectUrl = form.redirectUrl.value.trim();
  const session = form.session.value;
  if (!redirectUrl) { showResult('<div class="note error">Please paste the Codex callback URL.</div>'); return; }
  btn.disabled = true;
  btn.textContent = 'Connecting...';
  showResult('<div class="note">Exchanging the Codex authorization code securely...</div>');
  try {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    const res = await fetch('/api/cli-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Rotator-Admin-Token': token } : {}) },
      body: JSON.stringify({ provider: 'openai-codex', session, redirectUrl }),
    });
    const data = await res.json();
    if (data.ok) {
      showResult('<div class="note" style="border-left-color:var(--accent);background:rgba(30,107,82,0.12);"><strong id="codexLoginResultEmail"></strong> ' + (data.isNew ? 'added' : 'updated') + ' successfully. The isolated Codex pool is ready.</div>');
      document.getElementById('codexLoginResultEmail').textContent = data.email || '';
    } else {
      const errorDiv = document.createElement('div');
      errorDiv.className = 'note error';
      errorDiv.textContent = data.error || 'Unknown error';
      document.getElementById('result').innerHTML = '';
      document.getElementById('result').appendChild(errorDiv);
    }
  } catch (err) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'note error';
    errorDiv.textContent = 'Request failed: ' + err.message;
    document.getElementById('result').innerHTML = '';
    document.getElementById('result').appendChild(errorDiv);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect Codex Account';
  }
});

const zenForm = document.getElementById('zenForm');
if (zenForm) zenForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector('button[type=submit]');
  const apiKey = form.apiKey.value.trim();
  const email = form.email.value.trim();
  if (!apiKey) { showResult('<div class="note error">Please paste an API key.</div>'); return; }
  btn.disabled = true;
  btn.textContent = 'Validating...';
  showResult('<div class="note">Checking the key against opencode.ai/zen...</div>');
  try {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    const res = await fetch('/api/cli-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Rotator-Admin-Token': token } : {}) },
      body: JSON.stringify({ provider: 'opencode-zen', email, apiKey }),
    });
    const data = await res.json();
    if (data.ok) {
      showResult('<div class="note" style="border-left-color:var(--accent);background:rgba(30,107,82,0.12);">' +
        '<strong>' + (data.email || '') + '</strong> ' + (data.isNew ? 'added' : 'updated') + ' successfully. The rotator will start using OpenCode Zen on the next poll.</div>');
    } else {
      var zenErrDiv = document.createElement('div');
      zenErrDiv.className = 'note error';
      zenErrDiv.textContent = data.error || 'Unknown error';
      document.getElementById('result').innerHTML = '';
      document.getElementById('result').appendChild(zenErrDiv);
    }
  } catch (err) {
    var zenErr2 = document.createElement('div');
    zenErr2.className = 'note error';
    zenErr2.textContent = 'Request failed: ' + err.message;
    document.getElementById('result').innerHTML = '';
    document.getElementById('result').appendChild(zenErr2);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect Account';
  }
});
</script>
`,
    ),
  );
}

export async function handleCliLoginApi(
  req: IncomingMessage,
  res: ServerResponse,
  rotator: AccountSink,
): Promise<void> {
  let body: {
    provider?: string;
    session?: string;
    redirectUrl?: string;
    email?: string;
    apiKey?: string;
  };
  try {
    const raw = await readLimitedBody(req, MAX_CLI_LOGIN_BODY_BYTES);
    const parsed: unknown = JSON.parse(raw.toString("utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Request body must be an object");
    }
    body = parsed as {
      provider?: string;
      session?: string;
      redirectUrl?: string;
      email?: string;
      apiKey?: string;
    };
  } catch (err) {
    res.writeHead(err instanceof PayloadTooLargeError ? 413 : 400, {
      "Content-Type": "application/json",
    });
    res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
    return;
  }

  const provider = body.provider || "google-antigravity";

  if (provider === "ollama") {
    await handleOllamaCliLogin(body, res, rotator);
    return;
  }

  if (provider === "openai-codex") {
    await handleCodexCliLogin(body, res, rotator);
    return;
  }

  if (provider === "opencode-zen") {
    await handleZenCliLogin(body, res, rotator);
    return;
  }

  if (provider !== "google-antigravity") {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: `Unknown provider "${provider}"` }));
    return;
  }

  const { session: sessionId, redirectUrl } = body;
  if (
    typeof sessionId !== "string" ||
    typeof redirectUrl !== "string" ||
    sessionId.length === 0 ||
    redirectUrl.length === 0 ||
    sessionId.length > 256 ||
    redirectUrl.length > 8 * 1024
  ) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ ok: false, error: "Missing session or redirectUrl" }),
    );
    return;
  }

  pruneCliSessions();
  const session = cliLoginSessions.get(sessionId);
  if (!session) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: false,
        error: "Session expired or invalid. Reload the page and try again.",
      }),
    );
    return;
  }
  if (session.provider !== "google-antigravity") {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Session does not belong to Google login" }));
    return;
  }

  // Parse the redirect URL to extract code
  let code: string | undefined;
  let state: string | null;
  try {
    const url = new URL(redirectUrl.trim());
    code = url.searchParams.get("code") ?? undefined;
    state = url.searchParams.get("state");
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: false,
        error:
          "Could not parse the URL. Make sure you pasted the full redirect URL.",
      }),
    );
    return;
  }

  if (!code) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: false,
        error: "No authorization code found in the URL.",
      }),
    );
    return;
  }
  if (state !== session.oauthState) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: false,
        error: "State mismatch - reload the login page and try again.",
      }),
    );
    return;
  }

  cliLoginSessions.delete(sessionId);

  try {
    const tokenData = await exchangeAuthorizationCode(code, session.verifier);
    const email = await getUserEmail(tokenData.accessToken);
    const project = await discoverProject(tokenData.accessToken);
    const label = email ? email.split("@")[0] : "Account";
    const entry = {
      email: email || "unknown@gmail.com",
      refreshToken: tokenData.refreshToken,
      projectId: project.projectId,
      projectSource: project.source,
      label,
    };

    const { isNew } = await addAccountToConfig(entry);
    await rotator.addOrUpdateAccount(entry);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        email: entry.email,
        isNew,
        projectId: project.projectId,
      }),
    );
  } catch {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: false,
        error: "Unable to complete login. Please try again.",
      }),
    );
  }
}

async function handleCodexCliLogin(
  body: { session?: string; redirectUrl?: string },
  res: ServerResponse,
  rotator: AccountSink,
): Promise<void> {
  const sessionId = body.session;
  const redirectUrl = body.redirectUrl;
  if (
    typeof sessionId !== "string" ||
    typeof redirectUrl !== "string" ||
    sessionId.length === 0 ||
    redirectUrl.length === 0 ||
    sessionId.length > 256 ||
    redirectUrl.length > 8 * 1024
  ) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Missing session or redirectUrl" }));
    return;
  }

  pruneCliSessions();
  const session = cliLoginSessions.get(sessionId);
  if (!session || session.provider !== "openai-codex" || !session.codexConfig) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: false,
      error: "Session expired or invalid. Reload the page and try again.",
    }));
    return;
  }

  let code: string | undefined;
  let state: string | null;
  try {
    const url = new URL(redirectUrl.trim());
    code = url.searchParams.get("code") ?? undefined;
    state = url.searchParams.get("state");
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: false,
      error: "Could not parse the URL. Paste the complete Codex callback URL.",
    }));
    return;
  }

  if (!code) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "No authorization code found in the URL." }));
    return;
  }
  if (state !== session.oauthState) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: false,
      error: "State mismatch - reload the login page and try again.",
    }));
    return;
  }

  // Consume the one-time browser session before exchanging the authorization
  // code. A retry must start a new PKCE flow.
  cliLoginSessions.delete(sessionId);

  try {
    const tokens = await exchangeCodexAuthorizationCode(
      code,
      session.verifier,
      session.codexConfig,
    );
    const identity = parseCodexIdentity(tokens.accessToken, tokens.idToken);
    const email = identity.email ??
      (identity.providerAccountId ? `${identity.providerAccountId}@codex.local` : undefined);
    if (!email) throw new Error("Codex OAuth did not return an account identity");

    const entry: AccountConfig = {
      email,
      label: email.split("@")[0],
      provider: "openai-codex",
      credentials: [{
        provider: "openai-codex",
        refreshToken: tokens.refreshToken,
        ...(identity.providerAccountId ? { providerAccountId: identity.providerAccountId } : {}),
      }],
    };
    const { isNew } = await addAccountToConfig(entry);
    await rotator.addOrUpdateAccount(entry);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, email: entry.email, isNew, provider: "openai-codex" }));
  } catch (error) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: false,
      error: error instanceof Error && error.message.startsWith("Codex OAuth")
        ? codexOAuthErrorMessage(error)
        : "Unable to complete Codex login. Please reload and try again.",
    }));
  }
}

const MAX_ACCOUNT_EMAIL_LENGTH = 320;
const MAX_ACCOUNT_LABEL_LENGTH = 200;

async function handleOllamaCliLogin(
  body: { email?: string; apiKey?: string },
  res: ServerResponse,
  rotator: AccountSink,
): Promise<void> {
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";

  if (!apiKey) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Missing apiKey" }));
    return;
  }
  if (apiKey.length > 4096) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "API key too long" }));
    return;
  }
  if (email.length > MAX_ACCOUNT_EMAIL_LENGTH) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Account identifier too long" }));
    return;
  }

  const validation = await validateApiKey(apiKey);
  if (!validation.ok) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: false,
        error: `Key rejected (${validation.status}): ${validation.error}`,
      }),
    );
    return;
  }

  const entry: AccountConfig = {
    email: email || defaultAccountEmail(apiKey),
    credentials: [{ provider: "ollama", apiKey }],
    label: email || defaultAccountEmail(apiKey).split("@")[0],
  };
  if (typeof entry.label !== "string" || entry.label.length > MAX_ACCOUNT_LABEL_LENGTH) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Account label too long" }));
    return;
  }

  const { isNew } = await addAccountToConfig(entry);
  await rotator.addOrUpdateAccount(entry);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, email: entry.email, isNew }));
}

async function handleZenCliLogin(
  body: { email?: string; apiKey?: string },
  res: ServerResponse,
  rotator: AccountSink,
): Promise<void> {
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";

  if (!apiKey) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Missing apiKey" }));
    return;
  }
  if (apiKey.length > 4096) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "API key too long" }));
    return;
  }
  if (email.length > MAX_ACCOUNT_EMAIL_LENGTH) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Account identifier too long" }));
    return;
  }

  const validation = await validateZenApiKey(apiKey);
  if (!validation.ok) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: false,
        error: `Key rejected (${validation.status}): ${validation.error}`,
      }),
    );
    return;
  }

  const derivedEmail = email || zenDefaultAccountEmail(apiKey);
  const entry: AccountConfig = {
    email: derivedEmail,
    credentials: [
      {
        provider: OPENCODE_ZEN_PROVIDER_ID,
        apiKey,
      },
    ],
    label: email || derivedEmail.split("@")[0],
  };

  const { isNew } = await addAccountToConfig(entry);
  await rotator.addOrUpdateAccount(entry);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, email: entry.email, isNew, provider: OPENCODE_ZEN_PROVIDER_ID }));
}

export async function handleHostedCallback(
  req: IncomingMessage,
  res: ServerResponse,
  rotator: AccountSink,
): Promise<void> {
  const requestUrl = new URL(req.url || "/", "http://localhost");
  const code = requestUrl.searchParams.get("code");
  const state = requestUrl.searchParams.get("state");
  const error = requestUrl.searchParams.get("error");

  if (error) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      renderPage(
        "Sign-In Cancelled",
        `<h1>Sign-In Cancelled</h1><p>Google returned: ${escapeHtml(error)}</p>`,
      ),
    );
    return;
  }

  if (!code || !state) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      renderPage(
        "Missing Parameters",
        "<h1>Missing Parameters</h1><p>The callback did not include a valid code and state.</p>",
      ),
    );
    return;
  }

  prunePendingSessions();
  const session = pendingSessions.get(state);
  if (!session) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      renderPage(
        "Session Expired",
        "<h1>Session Expired</h1><p>This sign-in session is no longer valid. Start again from the login page.</p>",
      ),
    );
    return;
  }
  pendingSessions.delete(state);

  try {
    const tokenData = await exchangeAuthorizationCode(code, session.verifier);
    const email = await getUserEmail(tokenData.accessToken);
    const project = await discoverProject(tokenData.accessToken);
    const label = email ? email.split("@")[0] : "Account";
    const entry = {
      email: email || "unknown@gmail.com",
      refreshToken: tokenData.refreshToken,
      projectId: project.projectId,
      projectSource: project.source,
      label,
    };

    const { isNew } = await addAccountToConfig(entry);
    await rotator.addOrUpdateAccount(entry);

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      renderPage(
        "Account Connected",
        `<h1>Account Connected</h1>
<p><strong>${escapeHtml(entry.email)}</strong> was ${isNew ? "added" : "updated"} successfully.</p>
<p>Project: <span class="mono">${escapeHtml(project.projectId)}</span> via ${escapeHtml(project.source)}.</p>
<p>The rotator can start using this account immediately.</p>
<div class="note">If you ever want to stop sharing access, revoke this app's access from the Google account security settings.</div>`,
      ),
    );
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      renderPage(
        "Sign-In Failed",
        `<h1>Sign-In Failed</h1><p>${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`,
      ),
    );
  }
}
