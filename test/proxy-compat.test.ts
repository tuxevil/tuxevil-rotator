import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import { openAIToAntigravityBody, resetResponsesStoreForTests } from "../src/compat.js";
import {
	classifyUpstreamResponse,
	forwardRequest,
	providerAdapterForModel,
	startProxy,
	withRotation,
	type RequestBody,
} from "../src/proxy.js";
import {
	ANTIGRAVITY_ENDPOINTS,
	ANTIGRAVITY_VERSION,
	DEFAULT_ANTIGRAVITY_USER_AGENT,
	setEffortRoutingOverride,
	type AccountRuntime,
} from "../src/types.js";
import { stopVersionChecker } from "../src/version-check.js";
import { stopNotificationPoller } from "../src/notification-poller.js";
import type { AccountRotator } from "../src/rotator.js";
import { logger } from "../src/logger.js";
import { OPENCODE_ZEN_RESPONSES_URL } from "../src/providers/opencode-zen/catalog.js";

type Capture = {
	url: string;
	headers: IncomingMessage["headers"];
	body: string;
};

const endpointOverrides = ANTIGRAVITY_ENDPOINTS as unknown as string[];
const originalEndpoints = [...endpointOverrides];

afterEach(() => {
	endpointOverrides.splice(0, endpointOverrides.length, ...originalEndpoints);
});

it("builds the modern quota User-Agent from the configured Antigravity version", () => {
	assert.equal(
		DEFAULT_ANTIGRAVITY_USER_AGENT,
		`antigravity/ide/${ANTIGRAVITY_VERSION} (aidev_client; os_type=darwin; arch=arm64)`,
	);
});

async function listenServer(
	handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: ReturnType<typeof createServer>; url: string }> {
	const server = createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Server did not bind to a TCP port");
	}
	return {
		server,
		url: `http://127.0.0.1:${address.port}`,
	};
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.close((err) => (err ? reject(err) : resolve()));
	});
}

function createAccount(): AccountRuntime {
	return {
		config: {
			email: "test@example.com",
			projectId: "test-project",
			refreshToken: "refresh-token",
			label: "test-account",
		},
		accessToken: "access-token",
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
		tokenBucket: {
			tokens: 50,
			lastRefillAt: Date.now(),
		},
	};
}

function createRotatorStub(account: AccountRuntime): AccountRotator {
	return {
		getActiveAccount: async () => account,
		getRetryAfterMs: () => 0,
		rotateToNext: async () => null,
		finishRequest: () => {},
		getSafetyJitterMs: () => 0,
		recordUpstreamAttempt: () => {},
		markExhausted: () => {},
		recordProvider429: () => {},
		getFlagContext: () => ({
			timerType: "fresh",
			accountQuotaPercent: 0,
			wasProAccount: false,
			accountRequestsLastHour: 0,
			poolSize: 1,
			poolHealthyCount: 1,
			uptimeSeconds: 0,
		}),
		markFlagged: () => {},
		markError: () => {},
		recordRequest: () => false,
		recordProxyEvent: () => {},
		getGlobalDelayMs: () => 0,
	} as unknown as AccountRotator;
}

describe("proxy compat integration", () => {
	it("does not select Codex for a non-Codex model in a contaminated catalog", () => {
		const provider = providerAdapterForModel(
			createAccount(),
			"claude-sonnet-4-6",
			{
				getCodexModels: () => ["claude-sonnet-4-6"],
			} as unknown as AccountRotator,
		);

		assert.notEqual(provider.id, "openai-codex");
	});

	it("selects Codex for an explicitly requested paid-only Codex model", () => {
		const provider = providerAdapterForModel(
			createAccount(),
			"gpt-5.6-sol",
			{
				getCodexModels: () => ["gpt-5.6-terra", "gpt-5.6-luna"],
			} as unknown as AccountRotator,
		);

		assert.equal(provider.id, "openai-codex");
	});

	it("selects Google for Claude when Codex is the primary credential", () => {
		const account = createAccount();
		account.config.credentials = [
			{ provider: "openai-codex", refreshToken: "codex-refresh" },
			{ provider: "google-antigravity", refreshToken: "google-refresh", projectId: "google-project" },
		];

		const provider = providerAdapterForModel(account, "claude-sonnet-4-6");

		assert.equal(provider.id, "google-antigravity");
	});

	it("cascades daily 404 to prod and preserves the compat payload", async () => {
		const capturesDaily: Capture[] = [];
		const capturesProd: Capture[] = [];

		const daily = await listenServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => { body += chunk.toString(); });
			req.on("end", () => {
				capturesDaily.push({ url: req.url || "", headers: req.headers, body });
				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } }));
			});
		});
		const prod = await listenServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => { body += chunk.toString(); });
			req.on("end", () => {
				capturesProd.push({ url: req.url || "", headers: req.headers, body });
				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } }));
			});
		});

		endpointOverrides.splice(0, endpointOverrides.length, daily.url, prod.url);

		const body = openAIToAntigravityBody({
			model: "claude-sonnet-4-6",
			messages: [
				{ role: "system", content: "be terse" },
				{ role: "user", content: "ping" },
			],
		});

		try {
			const outcome = await withRotation(
				createRotatorStub(createAccount()),
				body.model,
				{ "user-agent": "OpenAI/1.0.0" },
				body,
				async () => "unexpected-success",
			);

			assert.equal(outcome.ok, false);
			if (!outcome.ok) {
				assert.equal(outcome.status, 404);
				assert.equal(outcome.endpoint, prod.url);
				assert.match(outcome.errorText, /NOT_FOUND/);
			}

			assert.equal(capturesDaily.length, 1);
			assert.equal(capturesProd.length, 1);
			assert.match(capturesDaily[0].url, /v1internal:streamGenerateContent\?alt=sse/);
			assert.match(capturesDaily[0].body, /"systemInstruction"/);
			assert.match(capturesDaily[0].body, /"contents":\[\{"role":"user","parts":\[\{"text":"ping"\}\]\}\]/);
			assert.match(capturesDaily[0].body, /"userAgent":"antigravity"/);
			assert.equal(capturesDaily[0].headers.authorization, "Bearer access-token");
			assert.equal(capturesDaily[0].headers["user-agent"], DEFAULT_ANTIGRAVITY_USER_AGENT);
			assert.equal(capturesDaily[0].headers["x-goog-api-client"], "google-cloud-sdk vscode_cloudshelleditor/0.1");
			assert.equal(capturesDaily[0].headers["client-metadata"], "{\"ideType\":\"ANTIGRAVITY\",\"platform\":\"MACOS\",\"pluginType\":\"GEMINI\"}");
		} finally {
			await closeServer(daily.server);
			await closeServer(prod.server);
		}
	});

	it("stops at the daily endpoint when it succeeds", async () => {
		const capturesDaily: Capture[] = [];
		const capturesProd: Capture[] = [];

		const daily = await listenServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => { body += chunk.toString(); });
			req.on("end", () => {
				capturesDaily.push({ url: req.url || "", headers: req.headers, body });
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.end('data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}}\n\n');
			});
		});
		const prod = await listenServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => { body += chunk.toString(); });
			req.on("end", () => {
				capturesProd.push({ url: req.url || "", headers: req.headers, body });
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "should not reach prod" }));
			});
		});

		endpointOverrides.splice(0, endpointOverrides.length, daily.url, prod.url);

		const account = createAccount();
		const body = openAIToAntigravityBody({
			model: "gemini-3-flash",
			messages: [{ role: "user", content: "ping" }],
		});

		try {
			const forwarded = await forwardRequest(account, {
				...body,
				displayModel: "auto",
				selectionMode: "typesafe",
				selectionConfidence: 0.9,
				selectionReason: "typesafe-selected",
			}, { "user-agent": "OpenAI/1.0.0" });
			assert.equal(forwarded.endpoint, daily.url);
			assert.doesNotMatch(capturesDaily[0].body, /selectionReason/);

			const outcome = await withRotation(
				createRotatorStub(account),
				body.model,
				{ "user-agent": "OpenAI/1.0.0" },
				body as RequestBody,
				async (response) => response.text(),
			);

			assert.equal(outcome.ok, true);
			if (outcome.ok) {
				assert.equal(outcome.endpoint, daily.url);
				assert.match(outcome.result, /"text":"ok"/);
			}
			assert.equal(capturesDaily.length >= 1, true);
			assert.equal(capturesProd.length, 0);
		} finally {
			await closeServer(daily.server);
			await closeServer(prod.server);
		}
	});

	it("does not expose internal exception details from the compat proxy", async () => {
		const upstream = await listenServer((_req, res) => {
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.end("data: {}\n\n");
		});
		endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

		try {
			const body = openAIToAntigravityBody({
				model: "gemini-3-flash",
				messages: [{ role: "user", content: "ping" }],
			});
			const outcome = await withRotation(
				createRotatorStub(createAccount()),
				body.model,
				{},
				body,
				async () => {
					throw new Error("internal file path /srv/secrets/config.json");
				},
			);

			assert.equal(outcome.ok, false);
			if (!outcome.ok) {
				assert.equal(outcome.errorText, "Upstream request failed");
				assert.doesNotMatch(outcome.errorText, /config\.json/);
			}
		} finally {
			await closeServer(upstream.server);
		}
	});
});

describe("classifyUpstreamResponse", () => {
	const fakeAccount = { config: { email: "a@b.com" } } as unknown as AccountRuntime;
	const fakeModelKey = "fake-model";

	function response(status: number, bodyText = ""): Response {
		return new Response(bodyText, { status, headers: { "content-type": "text/plain" } });
	}

	it("uses the complete Antigravity RESOURCE_EXHAUSTED reset duration", async () => {
		const action = await classifyUpstreamResponse(
			response(429, `{"error":{"status":"RESOURCE_EXHAUSTED","message":"quota exceeded. Resets in 1h20m14s"}}`),
			"https://api.example.com",
			fakeAccount,
			"gemini-3.1-pro",
			fakeModelKey,
			"google-antigravity",
		);
		assert.equal(action.kind, "rate-limited");
		if (action.kind === "rate-limited") {
			assert.equal(action.providerResourceExhausted, true);
			assert.equal(action.cooldownMs, 4_815_000);
			assert.match(action.errorText, /quota exceeded/);
		}
	});

	it("uses the 30 minute Antigravity fallback without a parseable reset", async () => {
		const action = await classifyUpstreamResponse(
			response(429, `{"error":{"status":"RESOURCE_EXHAUSTED","message":"quota exceeded"}}`),
			"https://api.example.com",
			fakeAccount,
			"gemini-3.1-pro",
			fakeModelKey,
			"google-antigravity",
		);
		assert.equal(action.kind, "rate-limited");
		if (action.kind === "rate-limited") {
			assert.equal(action.providerResourceExhausted, true);
			assert.equal(action.cooldownMs, 1_800_000);
		}
	});

	it("uses the Codex reset duration from usage_limit_reached", async () => {
		const action = await classifyUpstreamResponse(
			response(429, `{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_in_seconds":2447511}}`),
			"https://api.example.com",
			fakeAccount,
			"gpt-5.6-luna",
			"openai-codex:gpt-5.6-luna",
			"openai-codex",
		);
		assert.equal(action.kind, "rate-limited");
		if (action.kind === "rate-limited") {
			assert.equal(action.providerResourceExhausted, true);
			assert.equal(action.cooldownMs, 2_447_512_000);
		}
	});

	it("keeps RESOURCE_EXHAUSTED reset-duration semantics scoped to Antigravity", async () => {
		const action = await classifyUpstreamResponse(
			response(429, `{"error":{"status":"RESOURCE_EXHAUSTED","message":"Resets in 1h20m14s"}}`),
			"https://api.example.com",
			fakeAccount,
			"gpt-oss:20b",
			"session",
			"ollama",
		);
		assert.equal(action.kind, "rate-limited");
		if (action.kind === "rate-limited") {
			assert.equal(action.cooldownMs, 1_800_000);
		}
	});

	it("classifies plain 429 as rate-limited (not resource-exhausted)", async () => {
		const action = await classifyUpstreamResponse(
			response(429, "rate_limit_exceeded"),
			"https://api.example.com",
			fakeAccount,
			"claude-sonnet",
			fakeModelKey,
		);
		assert.equal(action.kind, "rate-limited");
		if (action.kind === "rate-limited") {
			assert.equal(action.providerResourceExhausted, false);
		}
	});

	it("classifies 401 as flagged-401", async () => {
		const action = await classifyUpstreamResponse(
			response(401, "unauthorized"),
			"https://api.example.com",
			fakeAccount,
			"gemini",
			fakeModelKey,
		);
		assert.equal(action.kind, "flagged-401");
	});

	it("classifies 403 with flag pattern as flagged-403", async () => {
		const action = await classifyUpstreamResponse(
			response(403, "Your account has been suspended for policy violation"),
			"https://api.example.com",
			fakeAccount,
			"gemini",
			fakeModelKey,
		);
		assert.equal(action.kind, "flagged-403");
	});

	it("classifies 403 without flag pattern as forbidden (not flagged)", async () => {
		const action = await classifyUpstreamResponse(
			response(403, "permission denied for this resource"),
			"https://api.example.com",
			fakeAccount,
			"gemini",
			fakeModelKey,
		);
		assert.equal(action.kind, "forbidden");
	});

	it("classifies 404 as not-found", async () => {
		const action = await classifyUpstreamResponse(
			response(404, "not here"),
			"https://api.example.com",
			fakeAccount,
			"gemini",
			fakeModelKey,
		);
		assert.equal(action.kind, "not-found");
	});

	it("classifies 400 as bad-request", async () => {
		const action = await classifyUpstreamResponse(
			response(400, "bad input"),
			"https://api.example.com",
			fakeAccount,
			"gemini",
			fakeModelKey,
		);
		assert.equal(action.kind, "bad-request");
	});

	it("classifies 503 as server-error-503", async () => {
		const action = await classifyUpstreamResponse(
			response(503, "service unavailable"),
			"https://api.example.com",
			fakeAccount,
			"gemini",
			fakeModelKey,
		);
		assert.equal(action.kind, "server-error-503");
	});

	it("classifies other 5xx as rotate-on-5xx", async () => {
		const action = await classifyUpstreamResponse(
			response(502, "bad gateway"),
			"https://api.example.com",
			fakeAccount,
			"gemini",
			fakeModelKey,
		);
		assert.equal(action.kind, "rotate-on-5xx");
		if (action.kind === "rotate-on-5xx") {
			assert.equal(action.httpStatus, 502);
		}
	});

	it("classifies 2xx as success", async () => {
		const action = await classifyUpstreamResponse(
			response(200, "ok"),
			"https://api.example.com",
			fakeAccount,
			"gemini",
			fakeModelKey,
		);
		assert.equal(action.kind, "success");
	});
});

describe("effort-based routing endpoint e2e", () => {
	type Tracking = {
		requestLogs: Array<{ model: string; statusCode: number }>;
		latencies: Array<{ model: string | undefined; totalMs: number }>;
		tokenUsage: Array<{ model: string | undefined; inputTokens: number; outputTokens: number }>;
	};

	function createE2eRotator(
		account: AccountRuntime,
		tracking: Tracking,
		resolveObservedModelKey: (model: string) => string = (model) => model,
	): AccountRotator {
		return {
			getActiveAccount: async () => account,
			getRetryAfterMs: () => 0,
			rotateToNext: async () => null,
			finishRequest: () => {},
			getSafetyJitterMs: () => 0,
			recordUpstreamAttempt: () => {},
			markExhausted: () => {},
			recordProvider429: () => {},
			getFlagContext: () => ({
				timerType: "fresh",
				accountQuotaPercent: 0,
				wasProAccount: false,
				accountRequestsLastHour: 0,
				poolSize: 1,
				poolHealthyCount: 1,
				uptimeSeconds: 0,
			}),
			markFlagged: () => {},
			markError: () => {},
			recordRequest: () => false,
			recordProxyEvent: () => {},
			getGlobalDelayMs: () => 0,
			recordLatency: (model: string | undefined, ttfbMs: number, totalMs: number) => {
				tracking.latencies.push({ model, totalMs });
			},
			recordRequestLog: (entry: { model: string; statusCode: number }) => {
				tracking.requestLogs.push(entry);
			},
			recordTokenUsage: (model: string | undefined, inputTokens: number, outputTokens: number) => {
				tracking.tokenUsage.push({ model, inputTokens, outputTokens });
			},
			resolveQuotaModelKeyForDisplay: (m: string) => m,
			resolveObservedModelKey,
			saveState: () => {},
			getStatus: () => ({ accounts: [] }),
		} as unknown as AccountRotator;
	}

	afterEach(() => {
		setEffortRoutingOverride(null);
		resetResponsesStoreForTests();
		stopVersionChecker();
		stopNotificationPoller();
	});

	it("warns for live Ollama collisions without changing provider precedence", () => {
		const collisions = [
			{
				kind: "alias",
				model: "live-ollama-alias",
				rules: {
					"live-ollama-alias": {
						defaultEffort: "medium",
						targets: { medium: "gemini-3.8-flash-medium" },
					},
				},
			},
			{
				kind: "target",
				model: "live-ollama-target",
				rules: {
					"gemini-3.8-flash": {
						defaultEffort: "medium",
						targets: { medium: "live-ollama-target" },
					},
				},
			},
		] as const;
		const originalLog = logger.log;
		const warnings: string[] = [];
		logger.log = (level, scope, message) => {
			if (level === "warn" && scope === "proxy") warnings.push(String(message));
		};

		try {
			for (const collision of collisions) {
				setEffortRoutingOverride(collision.rules);
				const provider = providerAdapterForModel(
					createAccount(),
					collision.model,
					{ getOllamaModels: () => [collision.model] },
				);

				assert.equal(provider.id, "ollama", `${collision.kind} collision changed provider precedence`);
				assert.ok(
					warnings.some(
						(message) =>
							message.includes(collision.model) &&
							/effort.?routing/i.test(message) &&
							/ollama/i.test(message),
					),
					`missing dynamic Ollama warning for configured ${collision.kind}`,
				);
			}
		} finally {
			logger.log = originalLog;
		}
	});

	it("/v1/chat/completions routes aliases and preserves exact dynamic target identity in accounting", async () => {
		setEffortRoutingOverride({
			"gemini-3.8-flash": {
				defaultEffort: "medium",
				targets: {
					low: "gemini-3.8-flash-low",
					medium: "gemini-3.8-flash-medium",
					high: "gemini-dynamic-preview",
				},
			},
		});

		const upstreamCaptures: Capture[] = [];
		const upstream = await listenServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => { body += chunk.toString(); });
			req.on("end", () => {
				upstreamCaptures.push({ url: req.url || "", headers: req.headers, body });
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.end([
					'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"pong"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":4}}}',
					"",
				].join("\n"));
			});
		});

		endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

		const tracking: Tracking = { requestLogs: [], latencies: [], tokenUsage: [] };
		const rotator = createE2eRotator(
			createAccount(),
			tracking,
			(model) => model === "gemini-dynamic-preview" ? "Gemini-Dynamic-Preview" : model,
		);
		const proxy = startProxy(rotator, 0, "127.0.0.1");
		await once(proxy, "listening");
		const port = (proxy.address() as AddressInfo).port;

		try {
			const highRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gemini-3.8-flash",
					reasoning_effort: "high",
					messages: [{ role: "user", content: "ping" }],
				}),
			});
			assert.equal(highRes.status, 200);
			assert.equal(highRes.headers.get("x-rotator-model"), "gemini-3.8-flash");
			const highJson = (await highRes.json()) as { model: string };
			assert.equal(highJson.model, "gemini-3.8-flash");

			assert.equal(upstreamCaptures.length, 1);
			const highUpstreamBody = JSON.parse(upstreamCaptures[0].body);
			assert.equal(highUpstreamBody.model, "gemini-dynamic-preview");

			const lowRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gemini-3.8-flash",
					reasoning_effort: "low",
					messages: [{ role: "user", content: "ping" }],
				}),
			});
			assert.equal(lowRes.status, 200);
			assert.equal(lowRes.headers.get("x-rotator-model"), "gemini-3.8-flash");

			assert.equal(upstreamCaptures.length, 2);
			const lowUpstreamBody = JSON.parse(upstreamCaptures[1].body);
			assert.equal(lowUpstreamBody.model, "gemini-3.8-flash-low");

			const defaultRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gemini-3.8-flash",
					messages: [{ role: "user", content: "ping" }],
				}),
			});
			assert.equal(defaultRes.status, 200);
			assert.equal(defaultRes.headers.get("x-rotator-model"), "gemini-3.8-flash");

			assert.equal(upstreamCaptures.length, 3);
			const defaultUpstreamBody = JSON.parse(upstreamCaptures[2].body);
			assert.equal(defaultUpstreamBody.model, "gemini-3.8-flash-medium");

			assert.deepEqual(
				tracking.requestLogs.map((e) => e.model),
				["Gemini-Dynamic-Preview", "gemini-3.8-flash-low", "gemini-3.8-flash-medium"],
			);
			assert.deepEqual(
				tracking.latencies.map((e) => e.model),
				["Gemini-Dynamic-Preview", "gemini-3.8-flash-low", "gemini-3.8-flash-medium"],
			);
			assert.deepEqual(
				tracking.tokenUsage.map((e) => e.model),
				["Gemini-Dynamic-Preview", "gemini-3.8-flash-low", "gemini-3.8-flash-medium"],
			);
		} finally {
			proxy.closeAllConnections?.();
			await closeServer(proxy);
			await closeServer(upstream.server);
		}
	});

	it("/v1/responses routes reasoning.effort and echoes raw alias", async () => {
		setEffortRoutingOverride({
			"gemini-3.8-flash": {
				defaultEffort: "medium",
				targets: {
					high: "gemini-3.8-flash-high",
				},
			},
		});

		const upstreamCaptures: Capture[] = [];
		const upstream = await listenServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => { body += chunk.toString(); });
			req.on("end", () => {
				upstreamCaptures.push({ url: req.url || "", headers: req.headers, body });
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.end([
					'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"pong"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3}}}',
					"",
				].join("\n"));
			});
		});

		endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

		const tracking: Tracking = { requestLogs: [], latencies: [], tokenUsage: [] };
		const rotator = createE2eRotator(createAccount(), tracking);
		const proxy = startProxy(rotator, 0, "127.0.0.1");
		await once(proxy, "listening");
		const port = (proxy.address() as AddressInfo).port;

		try {
			const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gemini-3.8-flash",
					reasoning: { effort: "high" },
					input: "ping",
				}),
			});
			assert.equal(res.status, 200);
			const json = (await res.json()) as { model: string };
			assert.equal(json.model, "gemini-3.8-flash");

			assert.equal(upstreamCaptures.length, 1);
			const upstreamBody = JSON.parse(upstreamCaptures[0].body);
			assert.equal(upstreamBody.model, "gemini-3.8-flash-high");
		} finally {
			proxy.closeAllConnections?.();
			await closeServer(proxy);
			await closeServer(upstream.server);
		}
	});

	it("/v1/messages bare alias routes to default target", async () => {
		setEffortRoutingOverride({
			"gemini-3.8-flash": {
				defaultEffort: "medium",
				targets: {
					medium: "gemini-3.8-flash-medium",
				},
			},
		});

		const upstreamCaptures: Capture[] = [];
		const upstream = await listenServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => { body += chunk.toString(); });
			req.on("end", () => {
				upstreamCaptures.push({ url: req.url || "", headers: req.headers, body });
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.end([
					'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"pong"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3}}}',
					"",
				].join("\n"));
			});
		});

		endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

		const tracking: Tracking = { requestLogs: [], latencies: [], tokenUsage: [] };
		const rotator = createE2eRotator(createAccount(), tracking);
		const proxy = startProxy(rotator, 0, "127.0.0.1");
		await once(proxy, "listening");
		const port = (proxy.address() as AddressInfo).port;

		try {
			const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gemini-3.8-flash",
					max_tokens: 100,
					messages: [{ role: "user", content: "ping" }],
				}),
			});
			assert.equal(res.status, 200);
			const json = (await res.json()) as { model: string };
			assert.equal(json.model, "gemini-3.8-flash");

			assert.equal(upstreamCaptures.length, 1);
			const upstreamBody = JSON.parse(upstreamCaptures[0].body);
			assert.equal(upstreamBody.model, "gemini-3.8-flash-medium");
		} finally {
			proxy.closeAllConnections?.();
			await closeServer(proxy);
			await closeServer(upstream.server);
		}
	});

	it("streaming echo preserves the alias across Chat, Responses, and Anthropic events", async () => {
		setEffortRoutingOverride({
			"gemini-3.8-flash": {
				defaultEffort: "medium",
				targets: {
					high: "gemini-3.8-flash-high",
					medium: "gemini-3.8-flash-medium",
				},
			},
		});

		const upstreamBodies: Array<Record<string, unknown>> = [];
		const upstream = await listenServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => { body += chunk.toString(); });
			req.on("end", () => {
				upstreamBodies.push(JSON.parse(body));
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.end([
					'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"chunk1"}]}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3}}}',
					"",
				].join("\n"));
			});
		});

		endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

		const tracking: Tracking = { requestLogs: [], latencies: [], tokenUsage: [] };
		const rotator = createE2eRotator(createAccount(), tracking);
		const proxy = startProxy(rotator, 0, "127.0.0.1");
		await once(proxy, "listening");
		const port = (proxy.address() as AddressInfo).port;

		try {
			const surfaces = [
				{
					name: "Chat",
					path: "/v1/chat/completions",
					request: {
						model: "gemini-3.8-flash",
						reasoning_effort: "high",
						stream: true,
						messages: [{ role: "user", content: "ping" }],
					},
					event: /chat\.completion\.chunk/,
					target: "gemini-3.8-flash-high",
				},
				{
					name: "Responses",
					path: "/v1/responses",
					request: {
						model: "gemini-3.8-flash",
						reasoning: { effort: "high" },
						stream: true,
						input: "ping",
					},
					event: /response\.created/,
					target: "gemini-3.8-flash-high",
				},
				{
					name: "Anthropic",
					path: "/v1/messages",
					request: {
						model: "gemini-3.8-flash",
						max_tokens: 100,
						stream: true,
						messages: [{ role: "user", content: "ping" }],
					},
					event: /event: message_start/,
					target: "gemini-3.8-flash-medium",
				},
			] as const;

			for (const [index, surface] of surfaces.entries()) {
				const res = await fetch(`http://127.0.0.1:${port}${surface.path}`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(surface.request),
				});
				assert.equal(res.status, 200, `${surface.name} streaming status`);
				assert.equal(res.headers.get("x-rotator-model"), "gemini-3.8-flash");
				const text = await res.text();
				assert.match(text, surface.event);
				assert.ok(
					text.includes('"model":"gemini-3.8-flash"'),
					`${surface.name} event did not echo the raw alias`,
				);
				assert.equal(upstreamBodies[index].model, surface.target);
			}
		} finally {
			proxy.closeAllConnections?.();
			await closeServer(proxy);
			await closeServer(upstream.server);
		}
	});

	it("routes Muse Spark through OpenCode Responses for local Responses clients", async () => {
		const account = createAccount();
		account.config.credentials = [
			{ provider: "opencode-zen", apiKey: "zen-secret" },
		];
		const tracking: Tracking = { requestLogs: [], latencies: [], tokenUsage: [] };
		const upstreamBodies: Array<Record<string, unknown>> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input, init) => {
			if (String(input) !== OPENCODE_ZEN_RESPONSES_URL) {
				return originalFetch(input, init);
			}
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			upstreamBodies.push(body);
			const headers = new Headers(init?.headers);
			assert.ok(headers.get("x-opencode-session"));
			assert.ok(headers.get("x-opencode-request"));
			if (body.stream === true) {
				return new Response([
					"event: response.output_text.delta\n",
					'data: {"type":"response.output_text.delta","delta":"streamed"}\n\n',
					"event: response.completed\n",
					'data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":1}}}\n\n',
				].join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
			}
			return new Response(JSON.stringify({
				id: "resp_upstream",
				object: "response",
				status: "completed",
				output: [{ type: "message", content: [{ type: "output_text", text: "non-streamed" }] }],
				output_text: "non-streamed",
				usage: { input_tokens: 3, output_tokens: 2 },
			}), { status: 200, headers: { "content-type": "application/json" } });
		}) as typeof fetch;

		const rotator = createE2eRotator(account, tracking);
		const proxy = startProxy(rotator, 0, "127.0.0.1");
		await once(proxy, "listening");
		const port = (proxy.address() as AddressInfo).port;
		try {
			const nonStream = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "muse-spark-1.3-contributor-free",
					input: "Hello",
					store: false,
				}),
			});
			assert.equal(nonStream.status, 200);
			const nonStreamJson = await nonStream.json() as {
				object: string;
				output_text: string;
				id: string;
			};
			assert.equal(nonStreamJson.object, "response");
			assert.equal(nonStreamJson.output_text, "non-streamed");
			assert.match(nonStreamJson.id, /^resp_/);

			const stream = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "muse-spark-1.3-contributor-free",
					input: "Hello",
					stream: true,
					store: false,
				}),
			});
			assert.equal(stream.status, 200);
			const streamText = await stream.text();
			assert.match(streamText, /response\.created/);
			assert.match(streamText, /response\.output_text\.delta/);
			assert.match(streamText, /"delta":"streamed"/);
			assert.match(streamText, /response\.completed/);
			assert.equal(upstreamBodies.length, 2);
			assert.deepEqual(upstreamBodies.map((body) => body.input), [
				[{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
				[{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
			]);
		} finally {
			globalThis.fetch = originalFetch;
			proxy.closeAllConnections?.();
			await closeServer(proxy);
		}
	});

	it("native catalog exposes concrete targets that generateContent forwards unchanged", async () => {
		setEffortRoutingOverride({
			"gemini-3.8-flash": {
				defaultEffort: "medium",
				targets: {
					medium: "gemini-3.8-flash-medium",
				},
			},
		});

		const upstreamCaptures: Capture[] = [];
		const upstream = await listenServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => { body += chunk.toString(); });
			req.on("end", () => {
				upstreamCaptures.push({ url: req.url || "", headers: req.headers, body });
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.end([
					'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"pong"}]},"finishReason":"STOP"}]}}',
					"",
				].join("\n"));
			});
		});

		endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

		const tracking: Tracking = { requestLogs: [], latencies: [], tokenUsage: [] };
		const rotator = createE2eRotator(createAccount(), tracking);
		const proxy = startProxy(rotator, 0, "127.0.0.1");
		await once(proxy, "listening");
		const port = (proxy.address() as AddressInfo).port;

		try {
			const catalogResponse = await fetch(`http://127.0.0.1:${port}/v1beta/models`);
			assert.equal(catalogResponse.status, 200);
			const catalog = await catalogResponse.json();
			assert.ok(Array.isArray(catalog.models));
			assert.ok(!catalog.models.some(
				(model: { name: string }) => model.name === "models/gemini-3.8-flash",
			));
			const target = catalog.models.find(
				(model: { name: string }) => model.name === "models/gemini-3.8-flash-medium",
			);
			assert.ok(target);
			const res = await fetch(
				`http://127.0.0.1:${port}/v1beta/${target.name}:generateContent`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						contents: [{ role: "user", parts: [{ text: "ping" }] }],
					}),
				},
			);
			assert.equal(res.status, 200);

			assert.equal(upstreamCaptures.length, 1);
			const upstreamBody = JSON.parse(upstreamCaptures[0].body);
			assert.equal(upstreamBody.model, "gemini-3.8-flash-medium");
		} finally {
			proxy.closeAllConnections?.();
			await closeServer(proxy);
			await closeServer(upstream.server);
		}
	});

	it("native /v1internal/* does not resolve aliases", async () => {
		setEffortRoutingOverride({
			"gemini-3.8-flash": {
				defaultEffort: "medium",
				targets: {
					medium: "gemini-3.8-flash-medium",
				},
			},
		});

		const upstreamCaptures: Capture[] = [];
		const upstream = await listenServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => { body += chunk.toString(); });
			req.on("end", () => {
				upstreamCaptures.push({ url: req.url || "", headers: req.headers, body });
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.end([
					'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"pong"}]},"finishReason":"STOP"}]}}',
					"",
				].join("\n"));
			});
		});

		endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

		const tracking: Tracking = { requestLogs: [], latencies: [], tokenUsage: [] };
		const rotator = createE2eRotator(createAccount(), tracking);
		const proxy = startProxy(rotator, 0, "127.0.0.1");
		await once(proxy, "listening");
		const port = (proxy.address() as AddressInfo).port;

		try {
			const res = await fetch(
				`http://127.0.0.1:${port}/v1internal:streamGenerateContent?alt=sse`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						project: "test-project",
						model: "gemini-3.8-flash",
						request: { contents: [{ role: "user", parts: [{ text: "ping" }] }] },
					}),
				},
			);
			assert.equal(res.status, 200);

			assert.equal(upstreamCaptures.length, 1);
			const upstreamBody = JSON.parse(upstreamCaptures[0].body);
			assert.equal(upstreamBody.model, "gemini-3.8-flash");
		} finally {
			setEffortRoutingOverride(null);
			proxy.closeAllConnections?.();
			await closeServer(proxy);
			await closeServer(upstream.server);
		}
	});
});
