import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DASHBOARD_SESSION_COOKIE,
  DASHBOARD_SESSION_TTL_MS,
  clearDashboardSessionCookie,
  createDashboardSession,
  dashboardSessionCookie,
  ensureAdminToken,
  generateAdminToken,
  getConfiguredAdminToken,
  getRequestAdminToken,
  isAdminAuthorized,
  isAdminTokenValid,
  isSameOriginRequest,
  readPersistedAdminToken,
  readRequestCookie,
  setPersistedAdminToken,
  verifyDashboardSession,
  writePersistedAdminToken,
} from "../src/admin-auth.js";
import { initDb, getCachedAdminToken } from "../src/db-store.js";

function req(
  url: string,
  headers: Record<string, string | string[] | undefined> = {},
) {
  return { url, headers };
}

describe("admin auth helpers", () => {
  beforeEach(() => {
    // Reset module-level state between tests so setPersistedAdminToken from
    // one test does not leak into another.
    setPersistedAdminToken(null);
  });

  it("treats missing configured token as legacy open access", () => {
    assert.equal(getConfiguredAdminToken({}), null);
    assert.equal(isAdminAuthorized(req("/api/status"), null), true);
  });

  it("trims configured token and ignores empty values", () => {
    assert.equal(
      getConfiguredAdminToken({ PI_ROTATOR_ADMIN_TOKEN: "  secret  " }),
      "secret",
    );
    assert.equal(
      getConfiguredAdminToken({ PI_ROTATOR_ADMIN_TOKEN: "   " }),
      null,
    );
  });

  it("accepts x-rotator-admin-token header", () => {
    const request = req("/api/status", { "x-rotator-admin-token": "secret" });
    assert.equal(getRequestAdminToken(request), "secret");
    assert.equal(isAdminAuthorized(request, "secret"), true);
  });

  it("accepts bearer authorization header", () => {
    const request = req("/api/status", { authorization: "Bearer secret" });
    assert.equal(getRequestAdminToken(request), "secret");
    assert.equal(isAdminAuthorized(request, "secret"), true);
  });

  it("accepts token query parameter for browser/SSE access", () => {
    const request = req("/api/events?token=secret");
    assert.equal(getRequestAdminToken(request), "secret");
    assert.equal(isAdminAuthorized(request, "secret"), true);
  });

  it("rejects wrong token when configured", () => {
    assert.equal(
      isAdminAuthorized(req("/api/status?token=wrong"), "secret"),
      false,
    );
  });

  it("returns persisted token after setPersistedAdminToken", () => {
    setPersistedAdminToken("persisted-secret");
    assert.equal(getConfiguredAdminToken({}), "persisted-secret");
  });

  it("env var takes priority over persisted token", () => {
    setPersistedAdminToken("persisted-secret");
    assert.equal(
      getConfiguredAdminToken({ PI_ROTATOR_ADMIN_TOKEN: "env-secret" }),
      "env-secret",
    );
  });

  it("setPersistedAdminToken(null) clears the persisted token", () => {
    setPersistedAdminToken("persisted-secret");
    setPersistedAdminToken(null);
    assert.equal(getConfiguredAdminToken({}), null);
  });
});

describe("admin token generation and persistence", () => {
  before(async () => {
    if (!process.env.TUXEVIL_ROTATOR_DIR) {
      process.env.TUXEVIL_ROTATOR_DIR = mkdtempSync(join(tmpdir(), "tuxevil-admin-auth-"));
    }
    await initDb();
  });

  beforeEach(async () => {
    setPersistedAdminToken(null);
    // Clear repository state for admin_token between tests
    await writePersistedAdminToken("");
  });

  it("generateAdminToken returns 64 hex chars (256 bits)", () => {
    const token = generateAdminToken();
    assert.equal(token.length, 64);
    assert.match(token, /^[0-9a-f]{64}$/);
  });

  it("two consecutive tokens are different", () => {
    const a = generateAdminToken();
    const b = generateAdminToken();
    assert.notEqual(a, b);
  });

  it("writePersistedAdminToken persists to the repository", async () => {
    await writePersistedAdminToken("abc123");
    const cached = getCachedAdminToken();
    assert.equal(cached, "abc123");
  });

  it("readPersistedAdminToken reads from the repository", async () => {
    await writePersistedAdminToken("my-secret-token");
    assert.equal(readPersistedAdminToken(), "my-secret-token");
  });

  it("readPersistedAdminToken returns null when no token is stored", () => {
    // After beforeEach clears it with empty string, getCachedAdminToken trims → null
    assert.equal(readPersistedAdminToken(), null);
  });

  it("ensureAdminToken returns env var when present", async () => {
    const result = await ensureAdminToken({ PI_ROTATOR_ADMIN_TOKEN: "envtok" });
    assert.equal(result.source, "env");
    assert.equal(result.token, "envtok");
    assert.equal(result.generated, false);
  });

  it("ensureAdminToken reads from repository when env is absent", async () => {
    await writePersistedAdminToken("repotok");
    const result = await ensureAdminToken({});
    assert.equal(result.source, "repository");
    assert.equal(result.token, "repotok");
    assert.equal(result.generated, false);
  });

  it("ensureAdminToken generates and persists a new token when neither is present", async () => {
    const result = await ensureAdminToken({});
    assert.equal(result.source, "generated");
    assert.equal(result.generated, true);
    assert.equal(result.token.length, 64);
    // Token should now be in the repository
    assert.equal(readPersistedAdminToken(), result.token);
  });

  it("ensureAdminToken is idempotent: second call returns same repository token", async () => {
    const first = await ensureAdminToken({});
    setPersistedAdminToken(null); // clear runtime cache so it goes to repository
    const second = await ensureAdminToken({});
    assert.equal(second.source, "repository");
    assert.equal(second.token, first.token);
    assert.equal(second.generated, false);
  });

  it("requireAdmin now blocks requests when only a persisted token is set", async () => {
    const resolved = await ensureAdminToken({});
    setPersistedAdminToken(resolved.token);
    assert.equal(isAdminAuthorized(req("/api/status")), false);
    assert.equal(
      isAdminAuthorized(
        req("/api/status", { "x-rotator-admin-token": resolved.token }),
      ),
      true,
    );
    setPersistedAdminToken(null);
  });

  it("admin auth helper behavior remains explicit for callback-shaped URLs", () => {
    // Route-level callback handling can intentionally bypass this helper, but
    // the low-level helper should still be path-agnostic.
    setPersistedAdminToken(null);
    assert.equal(isAdminAuthorized(req("/auth/antigravity/callback")), true);

    setPersistedAdminToken("secret-callback");
    assert.equal(isAdminAuthorized(req("/auth/antigravity/callback")), false);
    assert.equal(
      isAdminAuthorized(
        req("/auth/antigravity/callback", {
          "x-rotator-admin-token": "secret-callback",
        }),
      ),
      true,
    );
    assert.equal(
      isAdminAuthorized(
        req("/auth/antigravity/callback", {
          authorization: "Bearer secret-callback",
        }),
      ),
      true,
    );
  });

  it("logs a truncated preview of generated tokens, never the full value", () => {
    const truncate = (token: string): string =>
      token.length > 12 ? `${token.slice(0, 8)}…${token.slice(-4)}` : token;

    const fullToken = "abcdef0123456789fedcba9876543210";
    const preview = truncate(fullToken);
    assert.equal(preview, "abcdef01…3210");
    assert.ok(
      !preview.includes(fullToken),
      "preview must not contain the full token",
    );
    assert.ok(
      !preview.includes("23456789"),
      "middle of the token must not leak",
    );
    assert.ok(
      !preview.includes("fedcba9876"),
      "second half of the token must not leak",
    );
  });
});

describe("dashboard session cookie", () => {
  const now = Date.UTC(2026, 9, 3, 12, 0, 0);

  function withSession(
    token: string,
    extra: Record<string, string> = {},
    method = "GET",
  ) {
    const { value } = createDashboardSession(token);
    return {
      url: "/api/status",
      method,
      headers: {
        cookie: `theme=dark; ${DASHBOARD_SESSION_COOKIE}=${encodeURIComponent(value)}`,
        ...extra,
      },
    };
  }

  it("signs sessions with the admin token and expires them", () => {
    const session = createDashboardSession("secret", now);
    assert.equal(session.expiresAt, now + DASHBOARD_SESSION_TTL_MS);
    assert.ok(!session.value.includes("secret"), "the cookie never contains the token");
    assert.equal(verifyDashboardSession(session.value, "secret", now + 1000), true);
    assert.equal(verifyDashboardSession(session.value, "rotated", now + 1000), false);
    assert.equal(verifyDashboardSession(session.value, "secret", session.expiresAt + 1), false);
    const [expires, signature] = session.value.split(".");
    assert.equal(verifyDashboardSession(`${Number(expires) + 1}.${signature}`, "secret", now), false);
    assert.equal(verifyDashboardSession(`${expires}.${signature.slice(1)}x`, "secret", now), false);
    assert.equal(verifyDashboardSession("garbage", "secret", now), false);
    assert.equal(verifyDashboardSession(null, "secret", now), false);
  });

  it("reads cookies by exact name", () => {
    const req = { headers: { cookie: "a=1; tuxevil_session_x=2; tuxevil_session=abc%2Edef" } };
    assert.equal(readRequestCookie(req, DASHBOARD_SESSION_COOKIE), "abc.def");
    assert.equal(readRequestCookie(req, "missing"), null);
  });

  it("authorizes reads with a valid session cookie", () => {
    assert.equal(isAdminAuthorized(withSession("secret"), "secret"), true);
    assert.equal(isAdminAuthorized(withSession("other"), "secret"), false);
  });

  it("requires same-origin writes when only the cookie authenticates", () => {
    assert.equal(isAdminAuthorized(withSession("secret", {}, "POST"), "secret"), false);
    assert.equal(
      isAdminAuthorized(withSession("secret", { "sec-fetch-site": "same-origin" }, "POST"), "secret"),
      true,
    );
    assert.equal(
      isAdminAuthorized(withSession("secret", { "sec-fetch-site": "same-site" }, "POST"), "secret"),
      false,
      "another port on the same host is same-site but not same-origin",
    );
    assert.equal(
      isAdminAuthorized(
        withSession("secret", { origin: "http://localhost:51200", host: "localhost:51200" }, "PUT"),
        "secret",
      ),
      true,
    );
    assert.equal(
      isAdminAuthorized(
        withSession("secret", { origin: "http://evil.example", host: "localhost:51200" }, "DELETE"),
        "secret",
      ),
      false,
    );
    assert.equal(
      isAdminAuthorized(
        withSession("secret", { origin: "https://rotator.example", host: "127.0.0.1:51200", "x-forwarded-host": "rotator.example" }, "POST"),
        "secret",
      ),
      true,
      "reverse proxies that rewrite Host still match the forwarded host",
    );
  });

  it("keeps header and query tokens working without an origin", () => {
    const req = { url: "/api/enable/x", method: "POST", headers: { "x-rotator-admin-token": "secret" } };
    assert.equal(isAdminAuthorized(req, "secret"), true);
    assert.equal(isAdminAuthorized({ url: "/api/enable/x?token=secret", method: "POST", headers: {} }, "secret"), true);
  });

  it("compares tokens without accepting near misses", () => {
    assert.equal(isAdminTokenValid("secret", "secret"), true);
    assert.equal(isAdminTokenValid("secret ", "secret"), false);
    assert.equal(isAdminTokenValid("", "secret"), false);
    assert.equal(isAdminTokenValid(null, "secret"), false);
    assert.equal(isAdminTokenValid(null, null), true, "no configured token means open access");
  });

  it("detects same-origin requests", () => {
    assert.equal(isSameOriginRequest({ headers: { "sec-fetch-site": "same-origin" } }), true);
    assert.equal(isSameOriginRequest({ headers: { "sec-fetch-site": "cross-site", origin: "http://a", host: "a" } }), false);
    assert.equal(isSameOriginRequest({ headers: { origin: "not a url", host: "a" } }), false);
    assert.equal(isSameOriginRequest({ headers: {} }), false);
  });

  it("builds an HttpOnly, SameSite=Strict cookie", () => {
    const cookie = dashboardSessionCookie("v", { secure: true });
    assert.match(cookie, /^tuxevil_session=v; /);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\//);
    assert.match(cookie, /Secure/);
    assert.doesNotMatch(dashboardSessionCookie("v", { secure: false }), /Secure/);
    assert.match(clearDashboardSessionCookie(false), /Max-Age=0/);
  });
});
