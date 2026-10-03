import type { IncomingMessage, ServerResponse } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getCachedAdminToken, setCachedAdminToken } from "./db-store.js";

interface AdminAuthRequest {
  url?: string;
  method?: string;
  headers: IncomingMessage["headers"];
}

/** Dashboard session cookie, exchanged for the admin token on first visit. */
export const DASHBOARD_SESSION_COOKIE = "tuxevil_session";
export const DASHBOARD_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

let persistedToken: string | null = null;

/**
 * Set the persisted admin token at runtime. Called by index.ts after
 * ensureAdminToken resolves the effective token. Subsequent calls to
 * getConfiguredAdminToken() will return this token if no env var is set.
 */
export function setPersistedAdminToken(token: string | null): void {
  persistedToken = token && token.length > 0 ? token : null;
}

export function getConfiguredAdminToken(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const token =
    env.TUXEVIL_ROTATOR_ADMIN_TOKEN?.trim() ||
    env.PI_ROTATOR_ADMIN_TOKEN?.trim();
  if (token) return token;
  return persistedToken;
}

/**
 * Generate a cryptographically secure admin token (32 random bytes, hex).
 * 64 hex characters = 256 bits of entropy.
 */
export function generateAdminToken(): string {
  return randomBytes(32).toString("hex");
}

export function readPersistedAdminToken(): string | null {
  return getCachedAdminToken();
}

export async function writePersistedAdminToken(token: string): Promise<void> {
  await setCachedAdminToken(token);
}

export interface ResolvedAdminToken {
  token: string;
  source: "env" | "repository" | "generated";
  generated: boolean;
}

/**
 * Resolve the effective admin token, generating and persisting one if needed.
 * Priority: TUXEVIL_ROTATOR_ADMIN_TOKEN env var > repository > generate new.
 *
 * When a token is generated, it is persisted to the repository and returned.
 * The caller is responsible for printing it to the operator.
 */
export async function ensureAdminToken(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedAdminToken> {
  const envToken =
    env.TUXEVIL_ROTATOR_ADMIN_TOKEN?.trim() ||
    env.PI_ROTATOR_ADMIN_TOKEN?.trim();
  if (envToken) {
    return { token: envToken, source: "env", generated: false };
  }

  const existing = readPersistedAdminToken();
  if (existing) {
    return { token: existing, source: "repository", generated: false };
  }

  const newToken = generateAdminToken();
  try {
    await writePersistedAdminToken(newToken);
  } catch {
    // If we cannot persist (e.g. DB down, read-only fs), still return the
    // token for this session. The next restart will simply generate again.
  }
  return { token: newToken, source: "generated", generated: true };
}

export function getRequestAdminToken(req: AdminAuthRequest): string | null {
  const headerToken = req.headers["x-rotator-admin-token"];
  if (typeof headerToken === "string" && headerToken) return headerToken;
  if (Array.isArray(headerToken) && headerToken[0]) return headerToken[0];

  const authorization = req.headers.authorization;
  if (
    typeof authorization === "string" &&
    authorization.toLowerCase().startsWith("bearer ")
  ) {
    return authorization.slice("bearer ".length).trim();
  }

  try {
    const requestUrl = new URL(req.url || "/", "http://localhost");
    return requestUrl.searchParams.get("token");
  } catch {
    return null;
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sessionSignature(token: string, expiresAt: number): string {
  return createHmac("sha256", token)
    .update(`tuxevil-dashboard-session:${expiresAt}`)
    .digest("base64url");
}

/**
 * Session value is `<expiresAt>.<hmac>` keyed by the admin token, so the
 * cookie never carries the token itself and rotating the token signs every
 * session out.
 */
export function createDashboardSession(
  token: string,
  now: number = Date.now(),
): { value: string; expiresAt: number } {
  const expiresAt = now + DASHBOARD_SESSION_TTL_MS;
  return { value: `${expiresAt}.${sessionSignature(token, expiresAt)}`, expiresAt };
}

export function verifyDashboardSession(
  value: string | null | undefined,
  token: string,
  now: number = Date.now(),
): boolean {
  if (!value) return false;
  const dot = value.indexOf(".");
  if (dot <= 0) return false;
  const expiresAt = Number(value.slice(0, dot));
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
  return safeEqual(value.slice(dot + 1), sessionSignature(token, expiresAt));
}

export function readRequestCookie(
  req: AdminAuthRequest,
  name: string,
): string | null {
  const header = req.headers.cookie;
  const raw = Array.isArray(header) ? header.join("; ") : header;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function firstHeader(req: AdminAuthRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function isSecureRequest(req: IncomingMessage): boolean {
  const proto = firstHeader(req, "x-forwarded-proto");
  if (proto) return proto.split(",")[0].trim().toLowerCase() === "https";
  return Boolean((req.socket as { encrypted?: boolean } | undefined)?.encrypted);
}

/**
 * Cookie-authenticated writes must come from the dashboard itself. Browsers
 * set Sec-Fetch-Site and Origin; page scripts cannot forge either.
 */
export function isSameOriginRequest(req: AdminAuthRequest): boolean {
  const site = firstHeader(req, "sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = firstHeader(req, "origin");
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  return [firstHeader(req, "host"), firstHeader(req, "x-forwarded-host")]
    .filter(Boolean)
    .some((host) => host!.split(",")[0].trim() === originHost);
}

/** Sessions signed out before they expire. In memory, so a restart forgets them. */
const revokedSessions = new Map<string, number>();

/** Sign-out: stop honouring the request's session cookie, not just clear it. */
export function revokeDashboardSession(
  req: AdminAuthRequest,
  now: number = Date.now(),
): void {
  const value = readRequestCookie(req, DASHBOARD_SESSION_COOKIE);
  const token = getConfiguredAdminToken();
  if (!value || !token || !verifyDashboardSession(value, token, now)) return;
  for (const [session, expiresAt] of revokedSessions) {
    if (expiresAt <= now) revokedSessions.delete(session);
  }
  revokedSessions.set(value, Number(value.slice(0, value.indexOf("."))));
}

export function hasValidDashboardSession(
  req: AdminAuthRequest,
  expectedToken: string | null = getConfiguredAdminToken(),
): boolean {
  if (!expectedToken) return false;
  const value = readRequestCookie(req, DASHBOARD_SESSION_COOKIE);
  if (value && revokedSessions.has(value)) return false;
  return verifyDashboardSession(value, expectedToken);
}

export function isAdminTokenValid(
  candidate: string | null | undefined,
  expectedToken: string | null = getConfiguredAdminToken(),
): boolean {
  if (!expectedToken) return true;
  return typeof candidate === "string" && safeEqual(candidate, expectedToken);
}

export function isAdminAuthorized(
  req: AdminAuthRequest,
  expectedToken: string | null = getConfiguredAdminToken(),
): boolean {
  if (!expectedToken) return true;
  if (isAdminTokenValid(getRequestAdminToken(req), expectedToken)) return true;
  if (!hasValidDashboardSession(req, expectedToken)) return false;
  const method = (req.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return true;
  return isSameOriginRequest(req);
}

export function dashboardSessionCookie(
  value: string,
  opts: { secure: boolean; maxAgeMs?: number },
): string {
  const maxAge = Math.floor((opts.maxAgeMs ?? DASHBOARD_SESSION_TTL_MS) / 1000);
  return [
    `${DASHBOARD_SESSION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
    ...(opts.secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearDashboardSessionCookie(secure: boolean): string {
  return dashboardSessionCookie("", { secure, maxAgeMs: 0 });
}

export function requireAdmin(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  if (isAdminAuthorized(req)) return true;
  // A live session that fails the same-origin check is refused, not signed
  // out: 401 would send the dashboard back to its login screen.
  if (hasValidDashboardSession(req)) {
    res.writeHead(403, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(
      JSON.stringify({
        error:
          "Blocked: the request did not come from the dashboard's own origin. Behind a reverse proxy, forward the Host or X-Forwarded-Host header.",
      }),
    );
    return false;
  }
  res.writeHead(401, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "WWW-Authenticate": "Bearer",
  });
  res.end(JSON.stringify({ error: "Unauthorized" }));
  return false;
}
