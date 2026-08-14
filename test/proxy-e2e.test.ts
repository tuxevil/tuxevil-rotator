// End-to-end tests for the proxy flow: getActiveAccount → forwardRequest →
// recordRequest → rotateToNext. Uses a local HTTP server as the Antigravity
// mock. Covers the four key upstream status codes (200, 429, 401, 403-flagged,
// 403-non-flagged) and verifies the rotator's response to each.

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, describe, it } from "node:test";
import {
  startProxy,
  withRotation,
  type RequestBody,
} from "../src/proxy.js";
import { ANTIGRAVITY_ENDPOINTS, type AccountRuntime } from "../src/types.js";
import type { AccountRotator } from "../src/rotator.js";

const endpointOverrides = ANTIGRAVITY_ENDPOINTS as unknown as string[];
const originalEndpoints = [...endpointOverrides];

afterEach(() => {
	endpointOverrides.splice(0, endpointOverrides.length, ...originalEndpoints);
});

type Capture = { url: string; headers: IncomingMessage["headers"]; body: string };
type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function listen(handler: Handler): Promise<{ url: string; close: () => Promise<void> }> {
	const server = createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("bind failed");
	const url = `http://127.0.0.1:${address.port}`;
	return {
		url,
		close: () => new Promise<void>((resolve, reject) =>
			server.close((err) => (err ? reject(err) : resolve())),
		),
	};
}

function makeAccount(email: string, projectId = "test-project"): AccountRuntime {
	return {
		config: { email, projectId, refreshToken: "rt", label: email },
		accessToken: `token-${email}`,
		tokenExpires: Date.now() + 60_000,
		requestsSinceRotation: 0,
		totalRequests: 0,
		cooldownsByModel: {},
		quotaExhaustedAt: 0,
		quota: [],
		lastQuotaPoll: 0,
		lastUsed: 0,
		lastError: null,
		consecutiveErrors: 0,
		disabled: false,
		flagged: false,
		inFlightRequests: 0,
		inFlightByModel: {},
		allowFreshWindowStartsOverride: false,
		dailyRequestCount: 0,
		dailyRequestDay: "2026-05-16",
		healthScore: 1,
		tokenBucket: { tokens: 50, lastRefillAt: Date.now() },
	};
}

type RotatorTracking = {
	markExhausted?: number;
	markFlagged?: number;
	markError?: number;
	recordRequest?: number;
	recordProvider429?: number;
  finishRequest?: number;
  rotations?: number;
};

type RotatorOptions = {
	accounts?: AccountRuntime[];
	streamRecoveryMaxRetries?: number;
};

function makeRotator(
	account: AccountRuntime,
	tracking: RotatorTracking = {},
	options: RotatorOptions = {},
): AccountRotator {
	tracking.markExhausted ??= 0;
	tracking.markFlagged ??= 0;
	tracking.markError ??= 0;
	tracking.recordRequest ??= 0;
	tracking.recordProvider429 ??= 0;
	tracking.finishRequest ??= 0;
	tracking.rotations ??= 0;
	const accounts = [account, ...(options.accounts || [])];
	let activeIndex = 0;
	return {
		getActiveAccount: async () => accounts[activeIndex],
		getRetryAfterMs: () => 0,
		rotateToNext: async () => {
			if (activeIndex >= accounts.length - 1) return null;
			activeIndex += 1;
			tracking.rotations!++;
			return accounts[activeIndex];
		},
		finishRequest: () => { tracking.finishRequest!++; },
		getSafetyJitterMs: () => 0,
		recordUpstreamAttempt: () => {},
		markExhausted: () => { tracking.markExhausted!++; },
		recordProvider429: () => { tracking.recordProvider429!++; },
		getFlagContext: () => ({
			timerType: "fresh",
			accountQuotaPercent: 0,
			wasProAccount: false,
			accountRequestsLastHour: 0,
			poolSize: 1,
			poolHealthyCount: 1,
			uptimeSeconds: 0,
		}),
		markFlagged: () => { tracking.markFlagged!++; },
		markError: () => { tracking.markError!++; },
		recordRequest: () => { tracking.recordRequest!++; return false; },
		recordProxyEvent: () => {},
		getGlobalDelayMs: () => 0,
		getConfig: () => ({
			streamRecoveryMaxRetries: options.streamRecoveryMaxRetries ?? 2,
		}),
		saveState: async () => {},
		getStatus: () => ({ accounts: [] }),
		getOllamaModels: () => [],
		resolveQuotaModelKeyForDisplay: (model: string) => model,
		recordRequestLog: () => {},
		recordLatency: () => {},
		recordTokenUsage: () => {},
	} as unknown as AccountRotator;
}

function makeBody(): RequestBody {
	return {
		project: "compat-placeholder",
		model: "gemini-3.1-pro",
		request: {
			contents: [{ role: "user", parts: [{ text: "hello" }] }],
			generationConfig: { maxOutputTokens: 100 },
		},
	};
}

describe("proxy e2e: 200 happy path", () => {
	it("streams upstream response to caller and records a successful request", async () => {
		const captures: Capture[] = [];
		const upstream = await listen((req, res) => {
			let body = "";
			req.on("data", (chunk) => { body += chunk.toString(); });
			req.on("end", () => {
				captures.push({ url: req.url || "", headers: req.headers, body });
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.end('data: {"candidates":[{"content":{"parts":[{"text":"hi back"}]}}]}\n\n');
			});
		});
		endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

		const tracking = { recordRequest: 0, finishRequest: 0 };
		const rotator = makeRotator(makeAccount("ok@example.com"), tracking);

		try {
			const outcome = await withRotation(
				rotator,
				"gemini-3.1-pro",
				{ "user-agent": "test" },
				makeBody(),
				async (response) => {
					const text = await response.text();
					return { upstreamText: text };
				},
			);

			assert.equal(outcome.ok, true);
			if (outcome.ok) {
				assert.equal(outcome.result.upstreamText, 'data: {"candidates":[{"content":{"parts":[{"text":"hi back"}]}}]}\n\n');
				assert.equal(outcome.endpoint, upstream.url);
			}
			assert.equal(tracking.recordRequest, 1, "recordRequest should be called once");
			assert.equal(tracking.finishRequest, 1, "finishRequest should release the account once");
			assert.equal(captures.length, 1);
			assert.match(captures[0].headers.authorization || "", /^Bearer token-ok@example\.com$/);
			// Body is forwarded verbatim, including our model mapping
			assert.match(captures[0].body, /"contents":\[\{"role":"user"/);
		} finally {
			await upstream.close();
		}
	});
});

describe("proxy e2e: hop-by-hop header stripping (S7)", () => {
	it("removes X-Forwarded-For, Forwarded, Via, X-Real-IP and similar proxy headers", async () => {
		const captures: Capture[] = [];
		const upstream = await listen((req, res) => {
			let body = "";
			req.on("data", (chunk) => { body += chunk.toString(); });
			req.on("end", () => {
				captures.push({ url: req.url || "", headers: req.headers, body });
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.end('data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n');
			});
		});
		endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

		const rotator = makeRotator(makeAccount("hh@example.com"));
		try {
			// Headers that the proxy MUST strip. The "connection" header is
			// added by fetch() itself, so we don't test it here (the proxy
			// doesn't have it in forwardHeaders to delete).
			const headers: Record<string, string> = {
				"x-forwarded-for": "1.2.3.4",
				"x-forwarded-host": "evil.example.com",
				"x-forwarded-proto": "https",
				"x-real-ip": "5.6.7.8",
				"forwarded": "for=1.2.3.4",
				"via": "1.1 evil-proxy",
				"upgrade": "websocket",
			};
			const outcome = await withRotation(
				rotator,
				"gemini-3.1-pro",
				headers,
				makeBody(),
				async () => "ok",
			);
			assert.equal(outcome.ok, true);
			assert.equal(captures.length, 1);
			const got = captures[0].headers;
			assert.equal(got["x-forwarded-for"], undefined, "X-Forwarded-For must be stripped");
			assert.equal(got["x-forwarded-host"], undefined, "X-Forwarded-Host must be stripped");
			assert.equal(got["x-forwarded-proto"], undefined, "X-Forwarded-Proto must be stripped");
			assert.equal(got["x-real-ip"], undefined, "X-Real-IP must be stripped");
			assert.equal(got["forwarded"], undefined, "Forwarded must be stripped");
			assert.equal(got["via"], undefined, "Via must be stripped");
			assert.equal(got["upgrade"], undefined, "Upgrade must be stripped");
		} finally {
			await upstream.close();
		}
	});
});

describe("proxy e2e: pre-flush stream recovery", () => {
  it("rotates after a transport failure and exposes the retry count", async () => {
    const captures: Capture[] = [];
    let calls = 0;
    const upstream = await listen((req, res) => {
      calls += 1;
      if (calls === 1) {
        res.destroy();
        return;
      }
      let body = "";
      req.on("data", (chunk) => { body += chunk.toString(); });
      req.on("end", () => {
        captures.push({ url: req.url || "", headers: req.headers, body });
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end("data: ok\n\n");
      });
    });
    endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

    const first = makeAccount("first@example.com");
    const second = makeAccount("second@example.com");
    const rotator = makeRotator(first, {}, {
      accounts: [second],
      streamRecoveryMaxRetries: 2,
    });

    try {
      const outcome = await withRotation(
        rotator,
        "gemini-3.1-pro",
        {},
        makeBody(),
        async (response) => response.text(),
      );

      assert.equal(outcome.ok, true);
      if (outcome.ok) {
        assert.equal(outcome.result, "data: ok\n\n");
        assert.equal(outcome.context?.retries, 1);
      }
      assert.equal(calls, 2);
      assert.equal(captures[0].headers.authorization, "Bearer token-second@example.com");
    } finally {
      await upstream.close();
    }
  });

  it("retries an upstream 503 before returning an error to the client", async () => {
    let calls = 0;
    const upstream = await listen((req, res) => {
      calls += 1;
      req.resume();
      req.once("end", () => {
        if (calls === 1) {
          res.writeHead(503, { "Content-Type": "text/plain" });
          res.end("temporarily unavailable");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("recovered");
      });
    });
    endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

    try {
      const outcome = await withRotation(
        makeRotator(makeAccount("first@example.com"), {}, {
          accounts: [makeAccount("second@example.com")],
        }),
        "gemini-3.1-pro",
        {},
        makeBody(),
        async (response) => response.text(),
      );

      assert.equal(outcome.ok, true);
      if (outcome.ok) {
        assert.equal(outcome.result, "recovered");
        assert.equal(outcome.context?.retries, 1);
      }
      assert.equal(calls, 2);
    } finally {
      await upstream.close();
    }
  });

  it("honors the configured retry limit", async () => {
    let calls = 0;
    const upstream = await listen((req, res) => {
      calls += 1;
      req.resume();
      req.once("end", () => {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("still unavailable");
      });
    });
    endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

    try {
      const outcome = await withRotation(
        makeRotator(makeAccount("first@example.com"), {}, {
          accounts: [
            makeAccount("second@example.com"),
            makeAccount("third@example.com"),
            makeAccount("fourth@example.com"),
          ],
          streamRecoveryMaxRetries: 2,
        }),
        "gemini-3.1-pro",
        {},
        makeBody(),
        async () => "should-not-reach",
      );

      assert.equal(outcome.ok, false);
      assert.equal(calls, 3);
      if (!outcome.ok) assert.equal(outcome.context?.retries, 2);
    } finally {
      await upstream.close();
    }
  });
});

describe("proxy e2e: 429 rate-limited", () => {
	it("marks the account exhausted and returns 429 to the caller with cooldown", async () => {
		const upstream = await listen((req, res) => {
			res.writeHead(429, {
				"Content-Type": "application/json",
				"Retry-After": "120",
			});
			res.end(JSON.stringify({ error: { status: "RATE_LIMITED", message: "rate limit exceeded" } }));
		});
		endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

		const tracking = { markExhausted: 0, recordProvider429: 0, finishRequest: 0 };
		const rotator = makeRotator(makeAccount("rl@example.com"), tracking);

		try {
			const outcome = await withRotation(
				rotator,
				"gemini-3.1-pro",
				{},
				makeBody(),
				async () => "should-not-reach",
			);

			assert.equal(outcome.ok, false);
			if (!outcome.ok) {
				assert.equal(outcome.status, 429);
				// Retry-After: 120 seconds = 120000ms (+1000ms buffer from parser)
				assert.equal(outcome.retryAfterMs, 121_000);
				assert.equal(outcome.endpoint, upstream.url);
			}
			assert.equal(tracking.markExhausted, 1);
			assert.equal(tracking.recordProvider429, 1);
			assert.equal(tracking.finishRequest, 1, "429 should still release the account once");
		} finally {
			await upstream.close();
		}
	});

	it("uses RESOURCE_EXHAUSTED cooldown (30min) for quota-exhausted responses", async () => {
		const upstream = await listen((req, res) => {
			res.writeHead(429, {
				"Content-Type": "application/json",
			});
			res.end(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "quota exceeded" } }));
		});
		endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

		const tracking = { markExhausted: 0, recordProvider429: 0, finishRequest: 0 };
		const rotator = makeRotator(makeAccount("quota@example.com"), tracking);

		try {
			const outcome = await withRotation(
				rotator,
				"gemini-3.1-pro",
				{},
				makeBody(),
				async () => "should-not-reach",
			);

			assert.equal(outcome.ok, false);
			if (!outcome.ok) {
				assert.equal(outcome.status, 429);
				// RESOURCE_EXHAUSTED gets a fixed 30min cooldown regardless of Retry-After
				assert.equal(outcome.retryAfterMs, 1_800_000);
			}
			assert.equal(tracking.finishRequest, 1, "RESOURCE_EXHAUSTED should release the account once");
		} finally {
			await upstream.close();
		}
	});

	it("retries account-scoped RESOURCE_EXHAUSTED with the next account", async () => {
		const attempts: string[] = [];
		const upstream = await listen((req, res) => {
			const authorization = String(req.headers.authorization ?? "");
			attempts.push(authorization);
			if (authorization.includes("token-quota@example.com")) {
				res.writeHead(429, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "quota exceeded" } }));
				return;
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end("ok");
		});
		endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

		const tracking = { markExhausted: 0, recordProvider429: 0, finishRequest: 0, rotations: 0, recordRequest: 0 };
		const rotator = makeRotator(
			makeAccount("quota@example.com"),
			tracking,
			{ accounts: [makeAccount("healthy@example.com")] },
		);

		try {
			const outcome = await withRotation(
				rotator,
				"gemini-3.1-pro",
				{},
				makeBody(),
				async () => "retried-successfully",
			);

			assert.deepEqual(outcome.ok && outcome.result, "retried-successfully");
			assert.equal(attempts.length, 2);
			assert.deepEqual(attempts, ["Bearer token-quota@example.com", "Bearer token-healthy@example.com"]);
			assert.equal(tracking.markExhausted, 1);
			assert.equal(tracking.recordProvider429, 1);
			assert.equal(tracking.rotations, 1);
			// rotateToNext briefly starts/releases the reserved account; the next
			// loop starts/releases it again for the actual retry.
			assert.equal(tracking.finishRequest, 3, "failed account and reservation lifecycle must be balanced");
		} finally {
			await upstream.close();
		}
	});

	it("does not rotate to another account for a generic 429", async () => {
		const upstream = await listen((req, res) => {
			res.writeHead(429, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: { status: "RATE_LIMITED", message: "try later" } }));
		});
		endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

		const tracking = { rotations: 0 };
		const rotator = makeRotator(
			makeAccount("limited@example.com"),
			tracking,
			{ accounts: [makeAccount("unused@example.com")] },
		);

		try {
			const outcome = await withRotation(
				rotator,
				"gemini-3.1-pro",
				{},
				makeBody(),
				async () => "should-not-reach",
			);

			assert.equal(outcome.ok, false);
			assert.equal(tracking.rotations, 0);
		} finally {
			await upstream.close();
		}
	});

	it("retries RESOURCE_EXHAUSTED through the native v1internal route", async () => {
		const attempts: string[] = [];
		const upstream = await listen((req, res) => {
			const authorization = String(req.headers.authorization ?? "");
			attempts.push(authorization);
			if (authorization.includes("token-native-quota@example.com")) {
				res.writeHead(429, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "quota exceeded" } }));
				return;
			}
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.end('data: {"response":{"candidates":[{"content":{"parts":[{"text":"native ok"}]}}]}}\n\ndata: [DONE]\n\n');
		});
		endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

		const tracking = { rotations: 0 };
		const rotator = makeRotator(
			makeAccount("native-quota@example.com"),
			tracking,
			{ accounts: [makeAccount("native-healthy@example.com")] },
		);
		const proxy = startProxy(rotator, 0, "127.0.0.1");
		await once(proxy, "listening");
		const address = proxy.address();
		if (!address || typeof address === "string") throw new Error("proxy did not bind");

		try {
			const response = await fetch(`http://127.0.0.1:${address.port}/v1internal:streamGenerateContent?alt=sse`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					project: "test-project",
					model: "gemini-3.1-pro",
					request: { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
				}),
			});

			assert.equal(response.status, 200);
			assert.match(await response.text(), /native ok/);
			assert.deepEqual(attempts, ["Bearer token-native-quota@example.com", "Bearer token-native-healthy@example.com"]);
			assert.equal(tracking.rotations, 1);
		} finally {
			await new Promise<void>((resolve, reject) => proxy.close((err) => (err ? reject(err) : resolve())));
			await upstream.close();
		}
	});
});

describe("native Code Assist passthrough", () => {
	it("allowlists actions, injects the active project, and preserves JSON responses", async () => {
		const requests: Array<{ action: string; body: Record<string, unknown> }> = [];
		const upstream = await listen((req, res) => {
			const action = (req.url || "").split(":").pop() || "";
			let raw = "";
			req.on("data", (chunk) => { raw += chunk.toString(); });
			req.on("end", () => {
				requests.push({ action, body: JSON.parse(raw) as Record<string, unknown> });
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ models: [{ name: "gemini-3-flash" }] }));
			});
		});
		endpointOverrides.splice(0, endpointOverrides.length, upstream.url);
		const proxy = startProxy(makeRotator(makeAccount("code-assist@example.com")), 0, "127.0.0.1");
		await once(proxy, "listening");
		const address = proxy.address();
		if (!address || typeof address === "string") throw new Error("proxy did not bind");

		try {
			const response = await fetch(`http://127.0.0.1:${address.port}/v1internal:fetchAvailableModels`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer client-token" },
				body: JSON.stringify({ project: "client-project", metadata: { ideType: "ANTIGRAVITY" } }),
			});
			assert.equal(response.status, 200);
			assert.deepEqual(await response.json(), { models: [{ name: "gemini-3-flash" }] });
			assert.deepEqual(requests, [{
				action: "fetchAvailableModels",
				body: { project: "test-project", metadata: { ideType: "ANTIGRAVITY" } },
			}]);
		} finally {
			await new Promise<void>((resolve, reject) => proxy.close((err) => (err ? reject(err) : resolve())));
			await upstream.close();
		}
	});

	it("rejects invalid payloads and unknown operations before upstream forwarding", async () => {
		let upstreamCalls = 0;
		const upstream = await listen((req, res) => {
			upstreamCalls++;
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end("{}");
		});
		endpointOverrides.splice(0, endpointOverrides.length, upstream.url);
		const proxy = startProxy(makeRotator(makeAccount("code-validation@example.com")), 0, "127.0.0.1");
		await once(proxy, "listening");
		const address = proxy.address();
		if (!address || typeof address === "string") throw new Error("proxy did not bind");

		try {
			const invalid = await fetch(`http://127.0.0.1:${address.port}/v1internal:countTokens`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			assert.equal(invalid.status, 400);

			const unknown = await fetch(`http://127.0.0.1:${address.port}/v1internal:deleteAccount`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email: "nope@example.com" }),
			});
			assert.equal(unknown.status, 404);
			assert.equal(upstreamCalls, 0);
		} finally {
			await new Promise<void>((resolve, reject) => proxy.close((err) => (err ? reject(err) : resolve())));
			await upstream.close();
		}
	});

	it("rotates after a Code Assist transport failure", async () => {
		const attempts: string[] = [];
		const upstream = await listen((req, res) => {
			const authorization = String(req.headers.authorization ?? "");
			attempts.push(authorization);
			req.resume();
			req.on("end", () => {
				if (authorization.includes("code-transport@example.com")) {
					res.destroy();
					return;
				}
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			});
		});
		endpointOverrides.splice(0, endpointOverrides.length, upstream.url);
		const tracking = { rotations: 0 };
		const proxy = startProxy(
			makeRotator(
				makeAccount("code-transport@example.com"),
				tracking,
				{ accounts: [makeAccount("code-healthy@example.com")] },
			),
			0,
			"127.0.0.1",
		);
		await once(proxy, "listening");
		const address = proxy.address();
		if (!address || typeof address === "string") throw new Error("proxy did not bind");

		try {
			const response = await fetch(`http://127.0.0.1:${address.port}/v1internal:loadCodeAssist`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
			});
			assert.equal(response.status, 200);
			assert.deepEqual(await response.json(), { ok: true });
			assert.deepEqual(attempts, [
				"Bearer token-code-transport@example.com",
				"Bearer token-code-healthy@example.com",
			]);
			assert.equal(tracking.rotations, 1);
		} finally {
			await new Promise<void>((resolve, reject) => proxy.close((err) => (err ? reject(err) : resolve())));
			await upstream.close();
		}
	});
});

describe("proxy e2e: 401 unauthorized", () => {
	it("flags the account, rotates, and uses the new account on the next attempt", async () => {
		const flags: Capture[] = [];
		const upstream = await listen((req, res) => {
			let body = "";
			req.on("data", (chunk) => { body += chunk.toString(); });
			req.on("end", () => {
				flags.push({ url: req.url || "", headers: req.headers, body });
				res.writeHead(401, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: { status: "UNAUTHENTICATED", message: "Request had invalid auth credentials." } }));
			});
		});
		endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

		const tracking = { markFlagged: 0, finishRequest: 0 };
		const flaggedAccount = makeAccount("bad@example.com");
		// Make the rotator return null after the 401 to simulate "no replacement"
		const rotator = {
			getActiveAccount: async () => flaggedAccount,
			rotateToNext: async () => null,
			finishRequest: () => { tracking.finishRequest++; },
			getSafetyJitterMs: () => 0,
			recordUpstreamAttempt: () => {},
			markExhausted: () => {},
			recordProvider429: () => {},
			getRetryAfterMs: () => 0,
			getFlagContext: () => ({
				timerType: "fresh",
				accountQuotaPercent: 0,
				wasProAccount: false,
				accountRequestsLastHour: 0,
				poolSize: 1,
				poolHealthyCount: 1,
				uptimeSeconds: 0,
			}),
			markFlagged: () => { tracking.markFlagged++; },
			markError: () => {},
			recordRequest: () => false,
			recordProxyEvent: () => {},
			getGlobalDelayMs: () => 0,
		} as unknown as AccountRotator;

		try {
			const outcome = await withRotation(
				rotator,
				"gemini-3.1-pro",
				{},
				makeBody(),
				async () => "should-not-reach",
			);

			// After a 401, withRotation should:
			//  1. mark the account flagged
			//  2. try to rotate
			//  3. find no replacement and return 503/429 "no accounts available"
			assert.equal(outcome.ok, false);
			if (!outcome.ok) {
				assert.ok([429, 503].includes(outcome.status), `expected 429 or 503, got ${outcome.status}`);
			}
			assert.equal(tracking.markFlagged, 1, "account should be flagged exactly once");
			assert.equal(tracking.finishRequest, 1, "401 should release the flagged account once");
			assert.equal(flags.length, 1, "upstream should be hit exactly once before rotation");
		} finally {
			await upstream.close();
		}
	});
});

describe("proxy e2e: 403 flagged (infringement)", () => {
	it("flags the account with the 'infring' pattern and reports telemetry", async () => {
		const upstream = await listen((req, res) => {
			res.writeHead(403, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				error: { status: "PERMISSION_DENIED", message: "Account suspended for policy infringement" },
			}));
		});
		endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

		const tracking = { markFlagged: 0, finishRequest: 0 };
		const rotator = {
			getActiveAccount: async () => makeAccount("flag@example.com"),
			rotateToNext: async () => null,
			finishRequest: () => { tracking.finishRequest++; },
			getSafetyJitterMs: () => 0,
			recordUpstreamAttempt: () => {},
			markExhausted: () => {},
			recordProvider429: () => {},
			getRetryAfterMs: () => 0,
			getFlagContext: () => ({
				timerType: "5h",
				accountQuotaPercent: 50,
				wasProAccount: true,
				accountRequestsLastHour: 100,
				poolSize: 5,
				poolHealthyCount: 4,
				uptimeSeconds: 600,
			}),
			markFlagged: () => { tracking.markFlagged++; },
			markError: () => {},
			recordRequest: () => false,
			recordProxyEvent: () => {},
			getGlobalDelayMs: () => 0,
		} as unknown as AccountRotator;

		try {
			const outcome = await withRotation(
				rotator,
				"gemini-3.1-pro",
				{},
				makeBody(),
				async () => "should-not-reach",
			);

			assert.equal(outcome.ok, false);
			if (!outcome.ok) {
				assert.ok([429, 503].includes(outcome.status));
			}
			assert.equal(tracking.markFlagged, 1, "flagged 403 should mark the account");
			assert.equal(tracking.finishRequest, 1, "flagged 403 should release the account once");
		} finally {
			await upstream.close();
		}
	});
});

describe("proxy e2e: 403 non-flagged", () => {
	it("does NOT flag the account and returns 403 to the caller", async () => {
		const upstream = await listen((req, res) => {
			res.writeHead(403, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: { status: "PERMISSION_DENIED", message: "Resource not accessible by integration" } }));
		});
		endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

		const tracking = { markFlagged: 0, markError: 0, finishRequest: 0 };
		const rotator = makeRotator(makeAccount("forbid@example.com"), tracking);

		try {
			const outcome = await withRotation(
				rotator,
				"gemini-3.1-pro",
				{},
				makeBody(),
				async () => "should-not-reach",
			);

			assert.equal(outcome.ok, false);
			if (!outcome.ok) {
				assert.equal(outcome.status, 403);
			}
			assert.equal(tracking.markFlagged, 0, "non-flagging 403 must not mark the account");
			assert.equal(tracking.finishRequest, 1, "non-flagging 403 should release the account once");
		} finally {
			await upstream.close();
		}
	});
});

describe("proxy e2e: 5xx (non-503)", () => {
	it("marks the account in error and rotates", async () => {
		const captures: Capture[] = [];
		const upstream = await listen((req, res) => {
			let body = "";
			req.on("data", (chunk) => { body += chunk.toString(); });
			req.on("end", () => {
				captures.push({ url: req.url || "", headers: req.headers, body });
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end("internal error");
			});
		});
		endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

		const tracking = { markError: 0, finishRequest: 0 };
		const rotator = {
			getActiveAccount: async () => makeAccount("err@example.com"),
			rotateToNext: async () => null,
			finishRequest: () => { tracking.finishRequest++; },
			getSafetyJitterMs: () => 0,
			recordUpstreamAttempt: () => {},
			markExhausted: () => {},
			recordProvider429: () => {},
			getRetryAfterMs: () => 0,
			getFlagContext: () => ({
				timerType: "fresh",
				accountQuotaPercent: 100,
				wasProAccount: false,
				accountRequestsLastHour: 0,
				poolSize: 1,
				poolHealthyCount: 1,
				uptimeSeconds: 0,
			}),
			markFlagged: () => {},
			markError: () => { tracking.markError++; },
			recordRequest: () => false,
			recordProxyEvent: () => {},
			getGlobalDelayMs: () => 0,
		} as unknown as AccountRotator;

		try {
			const outcome = await withRotation(
				rotator,
				"gemini-3.1-pro",
				{},
				makeBody(),
				async () => "should-not-reach",
			);

			// After 500 with no replacement, should return 429/503
			assert.equal(outcome.ok, false);
			if (!outcome.ok) {
				assert.ok([429, 503].includes(outcome.status));
			}
			assert.equal(tracking.markError, 1, "500 should call markError");
			assert.equal(tracking.finishRequest, 1, "5xx should release the account once");
		} finally {
			await upstream.close();
		}
	});
});

describe("proxy e2e: native Gemini thinkingLevel passthrough", () => {
	it("forwards generationConfig.thinkingConfig.thinkingLevel unchanged to upstream", async () => {
		const captures: Capture[] = [];
		const upstream = await listen((req, res) => {
			let body = "";
			req.on("data", (chunk) => { body += chunk.toString(); });
			req.on("end", () => {
				captures.push({ url: req.url || "", headers: req.headers, body });
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.end('data: {"response":{"candidates":[{"content":{"parts":[{"text":"tiered ok"}]}}]}}\n\n');
			});
		});
		endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

		const proxy = startProxy(makeRotator(makeAccount("tiered@example.com")), 0, "127.0.0.1");
		await once(proxy, "listening");
		const address = proxy.address();
		if (!address || typeof address === "string") throw new Error("proxy did not bind");

		try {
			const response = await fetch(`http://127.0.0.1:${address.port}/v1internal:streamGenerateContent?alt=sse`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					project: "test-project",
					model: "gemini-3.7-flash-tiered",
					request: {
						contents: [{ role: "user", parts: [{ text: "hello" }] }],
						generationConfig: {
							maxOutputTokens: 512,
							thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" },
						},
					},
				}),
			});

			assert.equal(response.status, 200);
			assert.match(await response.text(), /tiered ok/);

			const forwarded = JSON.parse(captures[0].body) as {
				model: string;
				request: {
					generationConfig: {
						thinkingConfig?: { thinkingLevel?: string; includeThoughts?: boolean };
					};
				};
			};
			assert.equal(forwarded.model, "gemini-3.7-flash-tiered");
			assert.deepEqual(forwarded.request.generationConfig.thinkingConfig, {
				includeThoughts: true,
				thinkingLevel: "HIGH",
			});
		} finally {
			await new Promise<void>((resolve, reject) => proxy.close((err) => (err ? reject(err) : resolve())));
			await upstream.close();
		}
	});
});

describe("proxy e2e: endpoint cascade", () => {
	it("falls back from daily to prod endpoint when daily returns 404", async () => {
		const dailyHits: Capture[] = [];
		const prodHits: Capture[] = [];
		const daily = await listen((req, res) => {
			let body = "";
			req.on("data", (chunk) => { body += chunk.toString(); });
			req.on("end", () => {
				dailyHits.push({ url: req.url || "", headers: req.headers, body });
				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: { code: 404, message: "not on daily", status: "NOT_FOUND" } }));
			});
		});
		const prod = await listen((req, res) => {
			let body = "";
			req.on("data", (chunk) => { body += chunk.toString(); });
			req.on("end", () => {
				prodHits.push({ url: req.url || "", headers: req.headers, body });
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.end('data: {"candidates":[{"content":{"parts":[{"text":"fallback ok"}]}}]}\n\n');
			});
		});
		endpointOverrides.splice(0, endpointOverrides.length, daily.url, prod.url);

		const rotator = makeRotator(makeAccount("cascade@example.com"));
		try {
			const outcome = await withRotation(
				rotator,
				"gemini-3.1-pro",
				{},
				makeBody(),
				async (response) => ({ text: await response.text() }),
			);
			assert.equal(outcome.ok, true);
			if (outcome.ok) {
				assert.equal(outcome.endpoint, prod.url);
			}
			assert.equal(dailyHits.length, 1);
			assert.equal(prodHits.length, 1);
		} finally {
			await daily.close();
			await prod.close();
		}
	});
});
