import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveCliLogin, serveLoginLanding, handleCliLoginApi } from "../src/onboarding.js";
import { removeAccountFromConfig } from "../src/account-store.js";
import { getDefaultConfig } from "../src/config-defaults.js";
import type { AccountConfig, Config } from "../src/types.js";

function mockRes() {
	const state = { body: "", statusCode: 200, headers: {} as Record<string, string> };
	const res = {
		writeHead(code: number, headers?: Record<string, string>) {
			state.statusCode = code;
			if (headers) state.headers = headers;
		},
		end(chunk?: string) {
			if (chunk) state.body += chunk;
		},
	};
	return { res: res as any, state };
}

function mockReq(body: unknown): any {
	const json = JSON.stringify(body);
	const readable = new Readable({
		read() {
			this.push(json);
			this.push(null);
		},
	});
	(readable as any).headers = {};
	return readable;
}

function mockReqRaw(raw: string): any {
	const readable = new Readable({
		read() {
			this.push(raw);
			this.push(null);
		},
	});
	(readable as any).headers = {};
	return readable;
}

const dummyRotator = {} as any;

const originalOAuthEnv = {
	clientId: process.env.ANTIGRAVITY_CLIENT_ID,
	clientSecret: process.env.ANTIGRAVITY_CLIENT_SECRET,
	redirectUri: process.env.ANTIGRAVITY_REDIRECT_URI,
};
process.env.ANTIGRAVITY_CLIENT_ID = "test-client-id";
process.env.ANTIGRAVITY_CLIENT_SECRET = "test-client-secret";

process.env.ANTIGRAVITY_REDIRECT_URI = "https://example.test/callback";

after(() => {
  if (originalOAuthEnv.clientId === undefined) delete process.env.ANTIGRAVITY_CLIENT_ID;
  else process.env.ANTIGRAVITY_CLIENT_ID = originalOAuthEnv.clientId;
  if (originalOAuthEnv.clientSecret === undefined) delete process.env.ANTIGRAVITY_CLIENT_SECRET;
  else process.env.ANTIGRAVITY_CLIENT_SECRET = originalOAuthEnv.clientSecret;
  if (originalOAuthEnv.redirectUri === undefined) delete process.env.ANTIGRAVITY_REDIRECT_URI;
  else process.env.ANTIGRAVITY_REDIRECT_URI = originalOAuthEnv.redirectUri;
});

function extractSessionId(html: string): string {
	const sessionMatch = html.match(/name="session" value="([^"]+)"/);
	assert.ok(sessionMatch, "session hidden input not found in HTML");
	return sessionMatch[1];
}

function extractAuthUrl(html: string): string {
	const authMatch = html.match(/<a class="cta" href="([^"]+)"/);
	assert.ok(authMatch, "OAuth CTA link not found in HTML");
	return authMatch[1].replace(/&amp;/g, "&");
}

describe("serveCliLogin", () => {
	it("serves a complete HTML document", () => {
		const { res, state } = mockRes();
		serveCliLogin(res);
		assert.match(state.body, /<!DOCTYPE html>/);
		assert.equal(state.statusCode, 200);
	});

	it("contains a form with id pasteForm", () => {
		const { res, state } = mockRes();
		serveCliLogin(res);
		assert.match(state.body, /<form id="pasteForm"/);
	});

	it("includes a session hidden input", () => {
		const { res, state } = mockRes();
		serveCliLogin(res);
		assert.match(state.body, /<input type="hidden" name="session" value="[^"]+"/);
	});

	it("includes a Sign in with Google link", () => {
		const { res, state } = mockRes();
		serveCliLogin(res);
		assert.match(state.body, /Sign in with Google/);
	});

	it("contains the authUrl in the CTA link", () => {
		const { res, state } = mockRes();
		serveCliLogin(res);
		// The CTA link should contain an href pointing to the OAuth URL
		assert.match(state.body, /<a class="cta" href="[^"]+"/);
	});

	it("includes an OpenAI Codex OAuth panel", () => {
		const { res, state } = mockRes();
		serveCliLogin(res);
		assert.match(state.body, /id="panel-codex"/);
		assert.match(state.body, /Sign in with OpenAI Codex/);
		assert.match(state.body, /id="codexPasteForm"/);
	});

	it("includes an OpenCode Zen panel", () => {
		const { res, state } = mockRes();
		serveCliLogin(res);
		assert.match(state.body, /id="panel-zen"/);
		assert.match(state.body, /OpenCode Zen API key/);
		assert.match(state.body, /id="zenForm"/);
	});

	it("includes a TypeSafe Jev configuration panel", () => {
		const { res, state } = mockRes();
		serveCliLogin(res);
		assert.match(state.body, /id="panel-typesafe"/);
		assert.match(state.body, /TypeSafe API key/);
		assert.match(state.body, /id="typesafeForm"/);
	});

	it("shows configured status without rendering the TypeSafe API key", () => {
		const { res, state } = mockRes();
		const config: Config = {
			...getDefaultConfig(),
			typesafeRouting: {
				enabled: true,
				apiKey: "secret-typesafe-key",
				model: "jev-preview",
			},
		};
		serveCliLogin(res, { getConfig: () => config });
		assert.match(state.body, /A Jev key is already configured/);
		assert.match(state.body, /value="jev-preview"/);
		assert.doesNotMatch(state.body, /secret-typesafe-key/);
	});

	it("uses independent values for the browser session and OAuth state", () => {
		const { res, state } = mockRes();
		serveCliLogin(res);
		const sessionId = extractSessionId(state.body);
		const authUrl = extractAuthUrl(state.body);
		const oauthState = new URL(authUrl).searchParams.get("state");
		assert.ok(oauthState);
		assert.notEqual(oauthState, sessionId);
	});

	it("includes a textarea for pasting the redirect URL", () => {
		const { res, state } = mockRes();
		serveCliLogin(res);
		assert.match(state.body, /<textarea name="redirectUrl"/);
	});
});

describe("handleCliLoginApi", () => {
	it("persists TypeSafe configuration without returning the API key", async () => {
		let saved: Config | undefined;
		const current = getDefaultConfig();
		const rotator = {
			async addOrUpdateAccount() {},
			getConfig: () => current,
			async replaceConfig(config: Config) {
				saved = config;
			},
		};
		const req = mockReq({
			provider: "typesafe",
			apiKey: "fake-typesafe-key",
			model: "jev-preview",
			enabled: true,
		});
		const { res, state } = mockRes();
		await handleCliLoginApi(req, res, rotator as any);
		assert.equal(state.statusCode, 200, state.body);
		const result = JSON.parse(state.body) as Record<string, unknown>;
		assert.equal(result.ok, true);
		assert.equal(result.model, "jev-preview");
		assert.equal(saved?.typesafeRouting?.apiKey, "fake-typesafe-key");
		assert.doesNotMatch(state.body, /fake-typesafe-key/);
	});

	it("keeps an existing TypeSafe API key when the dashboard leaves it blank", async () => {
		const existing: Config = {
			...getDefaultConfig(),
			typesafeRouting: {
				enabled: true,
				apiKey: "existing-typesafe-key",
				model: "jev-latest",
			},
		};
		let saved: Config | undefined;
		const rotator = {
			async addOrUpdateAccount() {},
			getConfig: () => existing,
			async replaceConfig(config: Config) {
				saved = config;
			},
		};
		const req = mockReq({
			provider: "typesafe",
			model: "jev-preview",
			enabled: false,
		});
		const { res, state } = mockRes();
		await handleCliLoginApi(req, res, rotator as any);
		assert.equal(state.statusCode, 200, state.body);
		assert.equal(saved?.typesafeRouting?.apiKey, "existing-typesafe-key");
		assert.equal(saved?.typesafeRouting?.enabled, false);
		assert.doesNotMatch(state.body, /existing-typesafe-key/);
	});

	it("returns 400 for invalid JSON body", async () => {
		const req = mockReqRaw("not json{{{");
		const { res, state } = mockRes();
		await handleCliLoginApi(req, res, dummyRotator);
		assert.equal(state.statusCode, 400);
		const parsed = JSON.parse(state.body);
		assert.equal(parsed.ok, false);
		assert.match(parsed.error, /Invalid JSON body/);
	});

	it("returns 400 for missing session", async () => {
		const req = mockReq({ redirectUrl: "http://localhost/callback?code=abc" });
		const { res, state } = mockRes();
		await handleCliLoginApi(req, res, dummyRotator);
		assert.equal(state.statusCode, 400);
		const parsed = JSON.parse(state.body);
		assert.equal(parsed.ok, false);
		assert.match(parsed.error, /Missing session or redirectUrl/);
	});

	it("returns 400 for missing redirectUrl", async () => {
		const req = mockReq({ session: "some-session-id" });
		const { res, state } = mockRes();
		await handleCliLoginApi(req, res, dummyRotator);
		assert.equal(state.statusCode, 400);
		const parsed = JSON.parse(state.body);
		assert.equal(parsed.ok, false);
		assert.match(parsed.error, /Missing session or redirectUrl/);
	});

	it("returns 400 for expired/invalid session", async () => {
		const req = mockReq({
			session: "nonexistent-session-id",
			redirectUrl: "http://localhost/callback?code=abc",
		});
		const { res, state } = mockRes();
		await handleCliLoginApi(req, res, dummyRotator);
		assert.equal(state.statusCode, 400);
		const parsed = JSON.parse(state.body);
		assert.equal(parsed.ok, false);
		assert.match(parsed.error, /Session expired or invalid/);
	});

	it("returns 400 when no authorization code found in the URL", async () => {
		// First, create a real session via serveCliLogin
		const { res: loginRes, state: loginState } = mockRes();
		serveCliLogin(loginRes);
		const sessionId = extractSessionId(loginState.body);

		// Use a URL with no code parameter
		const req = mockReq({
			session: sessionId,
			redirectUrl: "http://localhost:51121/oauth-callback?state=abc",
		});
		const { res, state } = mockRes();
		await handleCliLoginApi(req, res, dummyRotator);
		assert.equal(state.statusCode, 400);
		const parsed = JSON.parse(state.body);
		assert.equal(parsed.ok, false);
		assert.match(parsed.error, /No authorization code found/);
	});

	it("returns 400 for an unparseable redirect URL", async () => {
		// Create a valid session first
		const { res: loginRes, state: loginState } = mockRes();
		serveCliLogin(loginRes);
		const sessionId = extractSessionId(loginState.body);

		const req = mockReq({
			session: sessionId,
			redirectUrl: "not a valid url at all",
		});
		const { res, state } = mockRes();
		await handleCliLoginApi(req, res, dummyRotator);
		assert.equal(state.statusCode, 400);
		const parsed = JSON.parse(state.body);
		assert.equal(parsed.ok, false);
		assert.match(parsed.error, /Could not parse the URL/);
	});

	it("returns 400 when the redirect URL has the wrong OAuth state", async () => {
		const { res: loginRes, state: loginState } = mockRes();
		serveCliLogin(loginRes);
		const sessionId = extractSessionId(loginState.body);

		const req = mockReq({
			session: sessionId,
			redirectUrl:
				"http://localhost:51121/oauth-callback?code=abc&state=wrong-state",
		});
		const { res, state } = mockRes();
		await handleCliLoginApi(req, res, dummyRotator);
		assert.equal(state.statusCode, 400);
		const parsed = JSON.parse(state.body);
		assert.equal(parsed.ok, false);
		assert.match(parsed.error, /State mismatch/);
	});
});

describe("CLI login OpenAI Codex provider", () => {
	const originalFetch = globalThis.fetch;
	const recordingRotator = {
		lastEntry: undefined as AccountConfig | undefined,
		async addOrUpdateAccount(entry: AccountConfig) {
			this.lastEntry = entry;
		},
	};
	let email = "";

	before(async () => {
		if (!process.env.TUXEVIL_ROTATOR_DIR) {
			process.env.TUXEVIL_ROTATOR_DIR = mkdtempSync(join(tmpdir(), "tuxevil-onboarding-"));
		}
		const { initDb } = await import("../src/db-store.js");
		await initDb();
	});

	after(async () => {
		globalThis.fetch = originalFetch;
		if (email) await removeAccountFromConfig(email);
	});

	it("exchanges the browser callback server-side and stores only the refresh credential", async () => {
		const { res: loginRes, state: loginState } = mockRes();
		serveCliLogin(loginRes);
		const sessionMatch = loginState.body.match(/<form id="codexPasteForm"[\s\S]*?name="session" value="([^"]+)"/);
		assert.ok(sessionMatch);
		const authMatch = loginState.body.match(/<a class="cta" href="([^"]+)"[^>]*>\s*Sign in with OpenAI Codex/);
		assert.ok(authMatch);
		const oauthState = new URL(authMatch[1].replace(/&amp;/g, "&")).searchParams.get("state");
		assert.ok(oauthState);

		email = `codex-web-${Date.now()}@example.com`;
		const payload = Buffer.from(JSON.stringify({
			email,
			"https://api.openai.com/auth": { chatgpt_account_id: "acct-web-1" },
		})).toString("base64url");
		globalThis.fetch = (async () => new Response(JSON.stringify({
			access_token: "access-secret",
			refresh_token: "refresh-secret",
			id_token: `header.${payload}.signature`,
		}), { status: 200 })) as typeof fetch;

		const req = mockReq({
			provider: "openai-codex",
			session: sessionMatch[1],
			redirectUrl: `http://127.0.0.1:1455/auth/callback?code=browser-code&state=${oauthState}`,
		});
		const { res, state } = mockRes();
		await handleCliLoginApi(req, res, recordingRotator);
		assert.equal(state.statusCode, 200, state.body);
		const result = JSON.parse(state.body) as Record<string, unknown>;
		assert.equal(result.ok, true);
		assert.equal(result.provider, "openai-codex");
		assert.doesNotMatch(state.body, /access-secret|refresh-secret|browser-code/);
		assert.equal(recordingRotator.lastEntry?.credentials?.[0]?.provider, "openai-codex");
		assert.equal(recordingRotator.lastEntry?.credentials?.[0]?.refreshToken, "refresh-secret");
		assert.equal(recordingRotator.lastEntry?.credentials?.[0]?.providerAccountId, "acct-web-1");
	});
});

describe("serveLoginLanding", () => {
	it("escapes operator-controlled redirect URIs before rendering HTML", () => {
		process.env.ANTIGRAVITY_REDIRECT_URI = "https://example.test/<img src=x onerror=alert(1)>";
		const { res, state } = mockRes();
		serveLoginLanding(res);
		assert.doesNotMatch(state.body, /<img src=x onerror=alert\(1\)>/);
		assert.match(state.body, /&lt;img src=x onerror=alert\(1\)&gt;/);
		process.env.ANTIGRAVITY_REDIRECT_URI = "https://example.test/callback";
	});

	it("carries the admin token on the Continue With Google link", () => {
		const prevToken = process.env.PI_ROTATOR_ADMIN_TOKEN;
		process.env.PI_ROTATOR_ADMIN_TOKEN = "secret-token-123";
		try {
			const { res, state } = mockRes();
			serveLoginLanding(res);
			assert.match(state.body, /href="\/auth\/antigravity\/start\?token=secret-token-123"/);
		} finally {
			if (prevToken === undefined) {
				delete process.env.PI_ROTATOR_ADMIN_TOKEN;
			} else {
				process.env.PI_ROTATOR_ADMIN_TOKEN = prevToken;
			}
		}
	});
});
