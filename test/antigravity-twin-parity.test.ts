import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { afterEach, describe, it } from "node:test";
import { forwardCodeAssistRequest, validateCodeAssistPayload } from "../src/providers/google-antigravity/code-assist.js";
import { forwardRequest, getBenchmarkSpec } from "../src/providers/google-antigravity/forward.js";
import { getProviderAdapter } from "../src/providers/registry.js";
import {
	computeAntigravityRequestId,
	computeAntigravitySessionId,
	composeAntigravitySystemInstruction,
	openAIToAntigravityBody,
	wrapAntigravityUserRequest,
} from "../src/providers/google-antigravity/translators.js";
import {
	ANTIGRAVITY_CONTINUATION_RETRY_CONFIG,
	ANTIGRAVITY_RETRY_CONFIG,
	calculateBackoffMs,
	calculateContinuationBackoffMs,
	ANTIGRAVITY_HEADERS_TIMEOUT_MS,
	DEFAULT_HEADERS_TIMEOUT_MS,
	DEFAULT_RETRY_STATUSES,
	fetchWithRetry,
	runWithAntigravityApiRetry,
} from "../src/fetch-with-retry.js";
import { classifyUpstreamResponse, type RequestBody } from "../src/proxy.js";
import {
	ANTIGRAVITY_HARD_BILLING_REASONS,
	ANTIGRAVITY_TRANSIENT_OVERLOAD_MARKERS,
	classifyRateLimitReason,
	isAntigravityRetryableError,
	MAX_ANTIGRAVITY_CONTINUATION_DELAY_MS,
	MAX_ANTIGRAVITY_RETRY_DELAY_MS,
} from "../src/rate-limit-parser.js";
import { STREAM_IDLE_TIMEOUT_MS } from "../src/stream-guards.js";
import { DEFAULT_MODEL_SPECS } from "../src/compat/model-specs.js";
import { ANTIGRAVITY_CONTEXT_WINDOWS } from "../src/providers/google-antigravity/catalog.js";
import {
	ANTIGRAVITY_CLIENT_METADATA,
	ANTIGRAVITY_ENDPOINTS,
	ANTIGRAVITY_IDENTITY_PROMPT,
	ANTIGRAVITY_BUILD_CL,
	ANTIGRAVITY_VERSION,
	MODEL_PRICING,
	DEFAULT_ANTIGRAVITY_USER_AGENT,
	resolveAntigravityProtoPlatform,
	type AccountRuntime,
} from "../src/types.js";

const endpointOverrides = ANTIGRAVITY_ENDPOINTS as unknown as string[];
const originalEndpoints = [...endpointOverrides];

interface CapturedHttpRequest {
	url: string;
	headers: IncomingHttpHeaders;
	body: string;
}

function createTwinAccount(): AccountRuntime {
	return {
		accessToken: "twin-access-token",
		config: {
			email: "twin@example.com",
			projectId: "twin-project-123",
			credentials: [
				{
					provider: "google-antigravity",
					projectId: "twin-project-123",
					refreshToken: "twin-refresh-token",
				},
			],
		},
	} as unknown as AccountRuntime;
}

async function startCaptureServer(
	handler: (captured: CapturedHttpRequest) => {
		status?: number;
		headers?: Record<string, string>;
		body?: string;
	},
): Promise<{ server: Server; url: string; captures: CapturedHttpRequest[] }> {
	const captures: CapturedHttpRequest[] = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk.toString();
		});
		req.on("end", () => {
			const entry: CapturedHttpRequest = {
				url: req.url || "",
				headers: req.headers,
				body,
			};
			captures.push(entry);
			const reply = handler(entry);
			res.writeHead(reply.status ?? 200, reply.headers ?? { "Content-Type": "application/json" });
			res.end(reply.body ?? "{}");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Expected ephemeral TCP port");
	}
	return { server, url: `http://127.0.0.1:${address.port}`, captures };
}

async function stopServer(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.close((err) => (err ? reject(err) : resolve()));
	});
}

afterEach(() => {
	endpointOverrides.splice(0, endpointOverrides.length, ...originalEndpoints);
});

describe("Antigravity IDE/CLI twin parity", () => {
	it("matches User-Agent, version, and ProtoJSON platform metadata", () => {
		if (!process.env.TUXEVIL_ROTATOR_ANTIGRAVITY_VERSION && !process.env.ANTIGRAVITY_VERSION && !process.env.PI_AI_ANTIGRAVITY_VERSION) {
			assert.equal(ANTIGRAVITY_VERSION, "2.35.2");
		}
		if (!process.env.TUXEVIL_ROTATOR_ANTIGRAVITY_BUILD_CL && !process.env.ANTIGRAVITY_BUILD_CL) {
			assert.equal(ANTIGRAVITY_BUILD_CL, "1029311855");
		}
		assert.match(
			DEFAULT_ANTIGRAVITY_USER_AGENT,
			/^antigravity\/hub\/[^ ]+ \(os_type=(darwin|linux|windows); arch=.+; aidev_client; cl=[^;)]+\)$/,
		);
		assert.equal(resolveAntigravityProtoPlatform("darwin", "arm64"), "DARWIN_ARM64");
		assert.equal(resolveAntigravityProtoPlatform("darwin", "x64"), "DARWIN_AMD64");
		assert.equal(resolveAntigravityProtoPlatform("win32", "x64"), "WINDOWS_AMD64");
		assert.equal(resolveAntigravityProtoPlatform("linux", "x64"), "LINUX_AMD64");
		assert.equal(resolveAntigravityProtoPlatform("linux", "arm64"), "LINUX_ARM64");
		assert.deepEqual(ANTIGRAVITY_CLIENT_METADATA, {
			ideType: "ANTIGRAVITY",
			ideVersion: ANTIGRAVITY_VERSION,
			platform: resolveAntigravityProtoPlatform(),
			pluginType: "GEMINI",
			ideName: "antigravity",
		});
	});

	it("matches FNV-1a signed sessionId, agent requestId, and prompt composition", () => {
		assert.equal(computeAntigravitySessionId(""), "-3750763034362895579");
		assert.equal(computeAntigravitySessionId("a"), "-5808556873153909620");
		assert.equal(computeAntigravitySessionId("foobar"), "-8821353812377114648");
		assert.equal(computeAntigravitySessionId("seed-alpha"), computeAntigravitySessionId("seed-alpha"));
		assert.notEqual(computeAntigravitySessionId("seed-alpha"), computeAntigravitySessionId("seed-beta"));
		assert.match(computeAntigravityRequestId("agent"), /^agent\/[0-9a-f-]{36}$/);

		assert.equal(wrapAntigravityUserRequest("fix build"), "<USER_REQUEST>\nfix build\n</USER_REQUEST>");
		assert.equal(
			wrapAntigravityUserRequest("<USER_REQUEST>\nfix build\n</USER_REQUEST>"),
			"<USER_REQUEST>\nfix build\n</USER_REQUEST>",
		);

		assert.equal(composeAntigravitySystemInstruction("", "default-identity"), ANTIGRAVITY_IDENTITY_PROMPT);
		assert.equal(composeAntigravitySystemInstruction("Custom prompt", "default-identity"), "Custom prompt");
		assert.equal(
			composeAntigravitySystemInstruction("Custom prompt", "prepend"),
			`${ANTIGRAVITY_IDENTITY_PROMPT}\n\nCustom prompt`,
		);
		assert.equal(
			composeAntigravitySystemInstruction(`${ANTIGRAVITY_IDENTITY_PROMPT}\n\nCustom prompt`, "twin"),
			`${ANTIGRAVITY_IDENTITY_PROMPT}\n\nCustom prompt`,
		);
		assert.equal(composeAntigravitySystemInstruction("", "passthrough"), null);
	});

	it("preserves systemInstruction for Gemini thinking models, uses camelCase Claude thinkingConfig, and stamps tracking IDs", () => {
		const geminiBody = openAIToAntigravityBody({
			model: "gemini-3.8-flash-high",
			messages: [
				{ role: "system", content: "Follow project rules." },
				{ role: "user", content: "Hello" },
				{ role: "assistant", content: "Partial" },
			],
		});
		const geminiRequest = geminiBody.request as {
			sessionId?: string;
			systemInstruction?: { role?: string; parts?: Array<{ text?: string }> };
			contents?: Array<{ role: string; parts: Array<{ text?: string }> }>;
		};
		assert.match(String(geminiBody.requestId), /^agent\/[0-9a-f-]{36}$/);
		assert.match(String(geminiBody.userPromptId), /^[0-9a-f-]{36}$/);
		assert.match(String(geminiRequest.sessionId), /^-?\d+$/);
		assert.equal("role" in (geminiRequest.systemInstruction ?? {}), false);
		assert.deepEqual(geminiRequest.systemInstruction, {
			parts: [{ text: `${ANTIGRAVITY_IDENTITY_PROMPT}\n\nFollow project rules.` }],
		});
		assert.deepEqual(geminiRequest.contents, [
			{ role: "user", parts: [{ text: "<USER_REQUEST>\nHello\n</USER_REQUEST>" }] },
			{ role: "model", parts: [{ text: "Partial" }] },
			{ role: "user", parts: [{ text: "Continue" }] },
		]);

		const claudeBody = openAIToAntigravityBody({
			model: "claude-sonnet-4-6-thinking",
			reasoning_effort: "medium",
			messages: [{ role: "user", content: "Explain" }],
		});
		const claudeGen = (claudeBody.request as { generationConfig?: { thinkingConfig?: Record<string, unknown> } })
			.generationConfig;
		assert.equal(claudeGen?.thinkingConfig?.includeThoughts, true);
		assert.equal(typeof claudeGen?.thinkingConfig?.thinkingBudget, "number");
		assert.equal("include_thoughts" in (claudeGen?.thinkingConfig ?? {}), false);
		assert.equal("thinking_budget" in (claudeGen?.thinkingConfig ?? {}), false);
	});

	it("sends twin CCPA headers without X-Goog-Api-Client, Client-Metadata, or Accept spoofing", async () => {
		const { server, url, captures } = await startCaptureServer(() => ({
			status: 200,
			headers: { "Content-Type": "text/event-stream" },
			body: 'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}}\n\n',
		}));
		endpointOverrides.splice(0, endpointOverrides.length, url);

		try {
			const callerRequest = {
				contents: [{ role: "user", parts: [{ text: "ping" }] }],
			};
			const rawBody: RequestBody = {
				project: "ignored",
				model: "gemini-3-flash",
				request: callerRequest,
			};
			await forwardRequest(
				createTwinAccount(),
				rawBody,
				{
					accept: "application/json",
					"x-goog-api-client": "spoofed-client",
					"client-metadata": "spoofed-meta",
					"anthropic-beta": "interleaved-thinking-2025-05-14",
					"anthropic-version": "2023-06-01",
					"openai-beta": "assistants=v2",
					"x-stainless-lang": "js",
					"x-api-key": "sk-leak",
					"x-title": "OpenCode",
					"http-referer": "https://localhost:3000",
					cookie: "session=secret",
					"x-skip-safety-jitter": "true",
					"x-live-request": "true",
					"x-goog-request-reason": "code_assist_agent",
					"x-goog-user-project": "billing-proj",
				},
				undefined,
				{ apiRetry: false },
			);

			assert.equal(captures.length, 1);
			const headers = captures[0].headers;
			assert.equal(headers.authorization, "Bearer twin-access-token");
			assert.equal(headers["content-type"], "application/json");
			assert.equal(headers["user-agent"], DEFAULT_ANTIGRAVITY_USER_AGENT);
			assert.equal(headers["x-goog-request-reason"], "code_assist_agent");
			assert.equal(headers["x-goog-user-project"], "billing-proj");
			assert.equal(headers["x-goog-api-client"], undefined);
			assert.equal(headers["client-metadata"], undefined);
			assert.equal(headers["anthropic-beta"], undefined);
			assert.equal(headers["anthropic-version"], undefined);
			assert.equal(headers["openai-beta"], undefined);
			assert.equal(headers["x-stainless-lang"], undefined);
			assert.equal(headers["x-api-key"], undefined);
			assert.equal(headers["x-title"], undefined);
			assert.equal(headers["http-referer"], undefined);
			assert.equal(headers.cookie, undefined);
			assert.equal(headers["x-skip-safety-jitter"], undefined);
			assert.equal(headers["x-live-request"], undefined);
			assert.notEqual(headers.accept, "text/event-stream");
			assert.notEqual(headers.accept, "application/json");

			const wireBody = JSON.parse(captures[0].body) as Record<string, unknown>;
			assert.match(String(wireBody.requestId), /^agent\/[0-9a-f-]{36}$/);
			assert.match(String(wireBody.userPromptId), /^[0-9a-f-]{36}$/);
			assert.equal(wireBody.userAgent, "antigravity");
			assert.equal(wireBody.requestType, "agent");
			const wireReq = wireBody.request as {
				sessionId?: string;
				systemInstruction?: { role?: string; parts?: Array<{ text?: string }> };
				contents?: Array<{ role?: string; parts?: Array<{ text?: string }> }>;
			};
			assert.match(String(wireReq.sessionId), /^-?\d+$/);
			assert.equal("role" in (wireReq.systemInstruction ?? {}), false);
			assert.deepEqual(wireReq.systemInstruction, {
				parts: [{ text: ANTIGRAVITY_IDENTITY_PROMPT }],
			});
			assert.deepEqual(wireReq.contents, [
				{ role: "user", parts: [{ text: "<USER_REQUEST>\nping\n</USER_REQUEST>" }] },
			]);
			assert.deepEqual(rawBody.request, callerRequest);
		} finally {
			await stopServer(server);
		}
	});

	it("normalizes Code Assist onboardUser payloads to camelCase ProtoJSON and strips non-twin headers", async () => {
		const { server, url, captures } = await startCaptureServer(() => ({
			status: 200,
			body: JSON.stringify({ done: true }),
		}));
		endpointOverrides.splice(0, endpointOverrides.length, url);

		try {
			assert.doesNotThrow(() => validateCodeAssistPayload("onboardUser", { tierId: "standard-tier" }));
			assert.doesNotThrow(() => validateCodeAssistPayload("onboardUser", { tier_id: "legacy-tier" }));

			await forwardCodeAssistRequest(
				createTwinAccount(),
				"onboardUser",
				{
					tier_id: "standard-tier",
					cloudaicompanion_project: "twin-project-123",
					metadata: { ide_type: "ANTIGRAVITY" },
				},
				{
					accept: "text/event-stream",
					"x-goog-api-client": "legacy",
					"client-metadata": "legacy",
					"anthropic-beta": "interleaved-thinking-2025-05-14",
				},
			);

			assert.equal(captures.length, 1);
			assert.equal(captures[0].url, "/v1internal:onboardUser");
			assert.equal(captures[0].headers["x-goog-api-client"], undefined);
			assert.equal(captures[0].headers["client-metadata"], undefined);
			assert.equal(captures[0].headers["anthropic-beta"], undefined);
			assert.notEqual(captures[0].headers.accept, "text/event-stream");

			const payload = JSON.parse(captures[0].body) as Record<string, unknown>;
			assert.equal(payload.tierId, "standard-tier");
			assert.equal("tier_id" in payload, false);
			assert.equal(payload.cloudaicompanionProject, "twin-project-123");
			assert.equal("cloudaicompanion_project" in payload, false);
			assert.deepEqual(payload.metadata, ANTIGRAVITY_CLIENT_METADATA);
		} finally {
			await stopServer(server);
		}
	});

	it("matches Antigravity retry config constants, backoff curves, and continuation jitter", () => {
		assert.equal(ANTIGRAVITY_HEADERS_TIMEOUT_MS, 600_000);
		assert.equal(DEFAULT_HEADERS_TIMEOUT_MS, 120_000);
		assert.equal(STREAM_IDLE_TIMEOUT_MS, 600_000);
		assert.deepEqual([...DEFAULT_RETRY_STATUSES], [408, 429, 502, 503, 504]);
		assert.equal(MAX_ANTIGRAVITY_RETRY_DELAY_MS, 240_000);
		assert.equal(MAX_ANTIGRAVITY_CONTINUATION_DELAY_MS, 60_000);
		assert.deepEqual(ANTIGRAVITY_RETRY_CONFIG, {
			maxRetries: 8,
			initialSleepDurationMs: 4_000,
			maxSleepDurationMs: 240_000,
			exponentialMultiplier: 2,
			jitterRange: 0.4,
		});
		assert.deepEqual(ANTIGRAVITY_CONTINUATION_RETRY_CONFIG, {
			baseDelayMs: 100,
			maxDelayMs: 5_000,
			maxRetries: 3,
			maxContinuations: 32,
			maxResumeDelayMs: 60_000,
		});

		// timeutil.backoff downward jitter with 4000ms base, 2x multiplier, 0.4 jitter, 240s max
		assert.equal(calculateBackoffMs(0, 4_000, 240_000, () => 0), 4_000);
		assert.equal(calculateBackoffMs(0, 4_000, 240_000, () => 1), 4_000); // floored at initialSleepDurationMs
		assert.equal(calculateBackoffMs(1, 4_000, 240_000, () => 0), 8_000);
		assert.equal(calculateBackoffMs(1, 4_000, 240_000, () => 1), 4_800);
		assert.equal(calculateBackoffMs(6, 4_000, 240_000, () => 0), 240_000);
		assert.equal(calculateBackoffMs(6, 4_000, 240_000, () => 1), 144_000);

		// core.backoff additive jitter over server retry delay
		assert.equal(calculateBackoffMs(0, 4_000, 240_000, () => 0.5, 2, 0.4, 25_000), 25_800);

		// continuation.sleepForMidStreamRetry [0.5, 1.0)
		assert.equal(calculateContinuationBackoffMs(1, () => 0), 50);
		assert.equal(calculateContinuationBackoffMs(1, () => 1), 100);
		assert.equal(calculateContinuationBackoffMs(2, () => 1), 200);
		assert.equal(calculateContinuationBackoffMs(10, () => 0), 2_500);
		assert.equal(calculateContinuationBackoffMs(10, () => 1), 5_000);
		assert.equal(calculateContinuationBackoffMs(1, () => 0, 1_200), 1_200);
	});

	it("classifies hard billing/quota stops vs retryable overload and 240s/60s delay ceilings", () => {
		assert.equal(isAntigravityRetryableError({ status: 408, errorText: "Request timeout" }), true);
		assert.equal(isAntigravityRetryableError({ status: 429, errorText: '{"error":{"retryDelay":"5s"}}' }), true);
		assert.equal(isAntigravityRetryableError({ status: 502, errorText: "Bad Gateway" }), true);
		assert.equal(isAntigravityRetryableError({ status: 503, errorText: "PREFILL_QUEUE_OVERLOADED" }), true);
		assert.equal(isAntigravityRetryableError({ status: 504, errorText: "Gateway timeout" }), true);
		assert.equal(isAntigravityRetryableError({ errorText: ANTIGRAVITY_TRANSIENT_OVERLOAD_MARKERS[0] }), true);

		assert.equal(isAntigravityRetryableError({ status: 500, errorText: "Internal server error" }), false);
		assert.equal(isAntigravityRetryableError({ status: 402, errorText: "Payment required" }), false);
		assert.equal(
			isAntigravityRetryableError({ status: 429, errorText: "quota exceeded per day" }),
			false,
		);
		assert.equal(
			isAntigravityRetryableError({
				status: 429,
				errorText: '{"error":{"message":"Quota exceeded","details":[{"reason":"QUOTA_EXHAUSTED"}]}}',
			}),
			false,
		);
		assert.equal(
			isAntigravityRetryableError({
				status: 503,
				errorText: '{"error":{"message":"Capacity","details":[{"reason":"MODEL_CAPACITY_EXHAUSTED"}]}}',
			}),
			false,
		);
		for (const reason of ANTIGRAVITY_HARD_BILLING_REASONS) {
			assert.equal(
				isAntigravityRetryableError({
					status: 429,
					errorText: JSON.stringify({ error: { details: [{ reason }] } }),
				}),
				false,
				`Expected ${reason} to be non-retryable`,
			);
		}

		// Delay ceiling: 240s initial / 60s mid-stream
		assert.equal(
			isAntigravityRetryableError({ status: 429, errorText: '{"error":{"retryDelay":"241s"}}' }),
			false,
		);
		assert.equal(
			isAntigravityRetryableError({ status: 429, errorText: '{"error":{"retryDelay":"90s"}}' }),
			true,
		);
		assert.equal(
			isAntigravityRetryableError({ status: 429, errorText: '{"error":{"retryDelay":"90s"}}', isMidStream: true }),
			false,
		);

		assert.equal(classifyRateLimitReason("Payment required", 402), "quota-exhausted");
		assert.equal(
			classifyRateLimitReason(
				JSON.stringify({ error: { details: [{ reason: "USER_SPEND_CAP_EXCEEDED" }] } }),
				429,
			),
			"quota-exhausted",
		);
		assert.equal(classifyRateLimitReason("Gateway timeout", 504), "server-error");
		assert.equal(classifyRateLimitReason("Request timeout", 408), "server-error");
	});

	it("runs 9 attempts (maxRetries=8) in runWithAntigravityApiRetry and fast-fails hard stops in fetchWithRetry", async () => {
		const recordedSleeps: number[] = [];
		let attempts = 0;
		const ok = await runWithAntigravityApiRetry({
			random: () => 0,
			sleepImpl: async (ms) => {
				recordedSleeps.push(ms);
			},
			classifyError: () => ({ retryable: true }),
			fn: async (attempt) => {
				attempts++;
				if (attempt < 8) {
					throw Object.assign(new Error("429 temporary"), { status: 429 });
				}
				return "recovered-on-attempt-9";
			},
		});
		assert.equal(ok, "recovered-on-attempt-9");
		assert.equal(attempts, 9);
		assert.deepEqual(recordedSleeps, [4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 240_000, 240_000]);

		let status500Calls = 0;
		const status500 = await fetchWithRetry("https://example.test", {
			retries: 3,
			sleepImpl: async () => {},
			fetchImpl: async () => {
				status500Calls++;
				return new Response("internal", { status: 500 });
			},
		});
		assert.equal(status500Calls, 1);
		assert.equal(status500.status, 500);

		let hard429Calls = 0;
		const hard429 = await fetchWithRetry("https://example.test", {
			retries: 3,
			sleepImpl: async () => {},
			fetchImpl: async () => {
				hard429Calls++;
				return new Response(
					JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", details: [{ reason: "QUOTA_EXHAUSTED" }] } }),
					{ status: 429 },
				);
			},
		});
		assert.equal(hard429Calls, 1);
		assert.equal(hard429.status, 429);

		let slowDelayCalls = 0;
		const slowDelay = await fetchWithRetry("https://example.test", {
			retries: 3,
			sleepImpl: async () => {},
			fetchImpl: async () => {
				slowDelayCalls++;
				return new Response(
					JSON.stringify({ error: { retryDelay: "300s" } }),
					{ status: 429 },
				);
			},
		});
		assert.equal(slowDelayCalls, 1);
		assert.equal(slowDelay.status, 429);
	});

	it("aligns proxy upstream response classification for 402 and 408", async () => {
		const account = createTwinAccount();
		const action402 = await classifyUpstreamResponse(
			new Response('{"error":{"message":"billing spend cap"}}', { status: 402 }),
			"https://api.example.com",
			account,
			"gemini-3-flash",
			"gemini",
			"google-antigravity",
		);
		assert.equal(action402.kind, "rate-limited");
		if (action402.kind === "rate-limited") {
			assert.equal(action402.providerResourceExhausted, true);
		}

		const action408 = await classifyUpstreamResponse(
			new Response("request timeout", { status: 408 }),
			"https://api.example.com",
			account,
			"gemini-3-flash",
			"gemini",
			"google-antigravity",
		);
		assert.equal(action408.kind, "rotate-on-5xx");
	});

	it("retries standalone forwardRequest on 429/503 and aborts immediately on HTTP 500 and MODEL_CAPACITY_EXHAUSTED", async () => {
		let transientCalls = 0;
		const { server, url } = await startCaptureServer(() => {
			transientCalls += 1;
			if (transientCalls === 1) {
				return { status: 503, body: "service temporarily unavailable" };
			}
			if (transientCalls === 2) {
				return { status: 429, body: JSON.stringify({ error: { retryDelay: "0.01s" } }) };
			}
			return {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
				body: 'data: {"response":{"candidates":[{"content":{"parts":[{"text":"recovered"}]}}]}}\n\n',
			};
		});
		endpointOverrides.splice(0, endpointOverrides.length, url);

		try {
			const res = await forwardRequest(
				createTwinAccount(),
				{
					project: "twin",
					model: "gemini-3-flash",
					request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
				},
				{},
				undefined,
				{
					apiRetry: {
						maxRetries: 4,
						initialSleepDurationMs: 1,
						maxSleepDurationMs: 5,
					},
				},
			);
			assert.equal(res.response.status, 200);
			assert.equal(transientCalls, 3);
		} finally {
			await stopServer(server);
		}

		for (const abortCase of [
			{ status: 500, body: "internal error" },
			{
				status: 503,
				body: JSON.stringify({
					error: { details: [{ metadata: { reason: "MODEL_CAPACITY_EXHAUSTED" } }] },
				}),
			},
		]) {
			let abortCalls = 0;
			const abortSrv = await startCaptureServer(() => {
				abortCalls += 1;
				return abortCase;
			});
			endpointOverrides.splice(0, endpointOverrides.length, abortSrv.url);
			try {
				const res = await forwardRequest(
					createTwinAccount(),
					{
						project: "twin",
						model: "gemini-3-flash",
						request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
					},
					{},
					undefined,
					{
						apiRetry: {
							maxRetries: 4,
							initialSleepDurationMs: 1,
							maxSleepDurationMs: 5,
						},
					},
				);
				assert.equal(res.response.status, abortCase.status);
				assert.equal(abortCalls, 1);
			} finally {
				await stopServer(abortSrv.server);
			}
		}
	});

	it("includes Antigravity 2.34.0 model specs, pricing, and context windows", async () => {
		const gemini234Models = [
			"gemini-3.1-pro-preview-customtools",
			"gemini-3.7-flash",
			"gemini-3.7-flash-low",
			"gemini-3.7-flash-medium",
			"gemini-3.7-flash-high",
		];
		for (const model of gemini234Models) {
			assert.ok(DEFAULT_MODEL_SPECS[model], `Missing DEFAULT_MODEL_SPECS for ${model}`);
			assert.equal(ANTIGRAVITY_CONTEXT_WINDOWS[model], 1_000_000, `Expected 1M context window for ${model}`);
			assert.ok(MODEL_PRICING[model], `Missing MODEL_PRICING for ${model}`);
		}
		for (const claudeMaxModel of ["claude-opus-5-5-max", "claude-sonnet-5-5-max"]) {
			assert.ok(DEFAULT_MODEL_SPECS[claudeMaxModel], `Missing DEFAULT_MODEL_SPECS for ${claudeMaxModel}`);
			assert.equal(ANTIGRAVITY_CONTEXT_WINDOWS[claudeMaxModel], 1_000_000);
		}

		const action499 = await classifyUpstreamResponse(
			new Response('{"error":{"message":"cancelled"}}', { status: 499 }),
			"https://daily-cloudcode-pa.googleapis.com",
			createTwinAccount(),
			"gemini-3-flash",
			"gemini-3-flash",
		);
		assert.equal(action499.kind, "non-retryable-error");
		if (action499.kind === "non-retryable-error") {
			assert.equal(action499.httpStatus, 499);
			assert.equal(action499.reason, "HTTP_499");
		}
	});

	it("normalizes benchmark, kickstart, and OAuth requests as full Antigravity twins", async () => {
		const account = createTwinAccount();
		account.config.refreshToken = "twin-refresh-token";

		const spec = getBenchmarkSpec(account);
		assert.match(String(spec.body.requestId), /^agent\/[0-9a-f-]{36}$/);
		assert.match(String(spec.body.userPromptId), /^[0-9a-f-]{36}$/);
		assert.equal(spec.body.userAgent, "antigravity");
		assert.equal(spec.body.requestType, "agent");
		const specReq = spec.body.request as {
			sessionId?: string;
			systemInstruction?: { role?: string; parts?: Array<{ text?: string }> };
			contents?: Array<{ role?: string; parts?: Array<{ text?: string }> }>;
		};
		assert.match(String(specReq.sessionId), /^-?\d+$/);
		assert.equal("role" in (specReq.systemInstruction ?? {}), false);
		assert.deepEqual(specReq.systemInstruction, {
			parts: [{ text: ANTIGRAVITY_IDENTITY_PROMPT }],
		});
		assert.equal(specReq.contents?.[0]?.parts?.[0]?.text, "<USER_REQUEST>\nReply with exactly: OK\n</USER_REQUEST>");

		const { server, url, captures } = await startCaptureServer(() => ({
			status: 200,
			headers: { "Content-Type": "text/event-stream" },
			body: 'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}}\n\n',
		}));
		endpointOverrides.splice(0, endpointOverrides.length, url);

		try {
			const googleAdapter = getProviderAdapter("google-antigravity");
			const res = await googleAdapter.forwardKickstartRequest!(
				account,
				"gemini-3.8-flash-tiered",
			);
			assert.equal(res.response.status, 200);
			assert.equal(captures.length, 1);
			assert.equal(captures[0].headers["user-agent"], DEFAULT_ANTIGRAVITY_USER_AGENT);
			const kickBody = JSON.parse(captures[0].body) as Record<string, unknown>;
			assert.match(String(kickBody.requestId), /^agent\/[0-9a-f-]{36}$/);
			assert.match(String(kickBody.userPromptId), /^[0-9a-f-]{36}$/);
			assert.equal(kickBody.userAgent, "antigravity");
			assert.equal(kickBody.requestType, "agent");
			const kickReq = kickBody.request as {
				sessionId?: string;
				systemInstruction?: { role?: string; parts?: Array<{ text?: string }> };
				contents?: Array<{ role?: string; parts?: Array<{ text?: string }> }>;
			};
			assert.match(String(kickReq.sessionId), /^-?\d+$/);
			assert.equal("role" in (kickReq.systemInstruction ?? {}), false);
			assert.deepEqual(kickReq.systemInstruction, {
				parts: [{ text: ANTIGRAVITY_IDENTITY_PROMPT }],
			});
			assert.equal(kickReq.contents?.[0]?.parts?.[0]?.text, "<USER_REQUEST>\n.\n</USER_REQUEST>");
		} finally {
			await stopServer(server);
		}

		const originalFetch = globalThis.fetch;
		const oauthHeaders: Array<Record<string, string>> = [];
		globalThis.fetch = (async (_input, init) => {
			const h = new Headers(init?.headers);
			oauthHeaders.push(Object.fromEntries(h.entries()));
			return new Response(JSON.stringify({ access_token: "fresh-token", expires_in: 3600 }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		try {
			const googleAdapter = getProviderAdapter("google-antigravity");
			account.tokenExpires = 0;
			await googleAdapter.ensureValidToken(account);
			assert.equal(oauthHeaders.length, 1);
			assert.equal(oauthHeaders[0]["user-agent"], DEFAULT_ANTIGRAVITY_USER_AGENT);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("does not send X-Goog-User-Project by default and does not cascade HTTP 403 across endpoints", async () => {
		let primaryHits = 0;
		let backupHits = 0;
		const primaryHeaders: IncomingHttpHeaders[] = [];
		const primary = await startCaptureServer((captured) => {
			primaryHits += 1;
			primaryHeaders.push(captured.headers);
			return {
				status: 403,
				body: JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED", message: "ToS violation" } }),
			};
		});
		const backup = await startCaptureServer(() => {
			backupHits += 1;
			return { status: 200, body: "{}" };
		});
		endpointOverrides.splice(0, endpointOverrides.length, primary.url, backup.url);

		try {
			const account = createTwinAccount();
			const forwarded = await forwardRequest(
				account,
				{
					project: "ignored",
					model: "gemini-3-flash",
					request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
				},
				{},
				undefined,
				{ apiRetry: false },
			);
			assert.equal(forwarded.response.status, 403);
			assert.equal(forwarded.endpoint, primary.url);
			assert.equal(primaryHits, 1);
			assert.equal(backupHits, 0);
			assert.equal(primaryHeaders[0]["x-goog-user-project"], undefined);

			const codeAssist = await forwardCodeAssistRequest(
				account,
				"loadCodeAssist",
				{},
				{},
			);
			assert.equal(codeAssist.response.status, 403);
			assert.equal(codeAssist.endpoint, primary.url);
			assert.equal(primaryHits, 2);
			assert.equal(backupHits, 0);
			assert.equal(primaryHeaders[1]["x-goog-user-project"], undefined);
		} finally {
			await stopServer(primary.server);
			await stopServer(backup.server);
		}
	});
});
