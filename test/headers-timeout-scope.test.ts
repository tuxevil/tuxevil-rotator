import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	ANTIGRAVITY_HEADERS_TIMEOUT_MS,
	DEFAULT_HEADERS_TIMEOUT_MS,
} from "../src/fetch-with-retry.js";
import { forwardRequest as forwardOllama } from "../src/providers/ollama/forward.js";
import { forwardRequest as forwardGoogle } from "../src/providers/google-antigravity/forward.js";
import { ANTIGRAVITY_ENDPOINTS, type AccountRuntime } from "../src/types.js";

const realSetTimeout = globalThis.setTimeout;
const realFetch = globalThis.fetch;
const endpoints = ANTIGRAVITY_ENDPOINTS as unknown as string[];
const savedEndpoints = [...endpoints];

afterEach(() => {
	globalThis.setTimeout = realSetTimeout;
	globalThis.fetch = realFetch;
	endpoints.splice(0, endpoints.length, ...savedEndpoints);
});

/** Record every timer delay scheduled while `run` executes. */
async function captureTimerDelays(run: () => Promise<unknown>): Promise<number[]> {
	const delays: number[] = [];
	globalThis.setTimeout = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
		delays.push(Number(ms ?? 0));
		return realSetTimeout(handler as () => void, ms, ...args);
	}) as typeof setTimeout;
	globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
	try {
		await run();
	} finally {
		globalThis.setTimeout = realSetTimeout;
	}
	return delays;
}

function makeAccount(credentials: NonNullable<AccountRuntime["config"]["credentials"]>): AccountRuntime {
	return {
		config: { email: "timeout@example.com", projectId: "p", credentials },
		accessToken: "token",
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
		dailyRequestDay: "2026-11-27",
		healthScore: 1,
		tokenBucket: { tokens: 1, lastRefillAt: Date.now() },
	} as AccountRuntime;
}

describe("upstream headers timeout scope", () => {
	it("keeps the 120s default for non-Google providers such as Ollama", async () => {
		const account = makeAccount([{ provider: "ollama", apiKey: "k" }]);
		const delays = await captureTimerDelays(() =>
			forwardOllama(account, { model: "gpt-oss:20b", request: { contents: [] } } as never, {}),
		);
		assert.ok(delays.includes(DEFAULT_HEADERS_TIMEOUT_MS), `delays: ${delays.join(",")}`);
		assert.ok(!delays.includes(ANTIGRAVITY_HEADERS_TIMEOUT_MS));
	});

	it("uses the 600s Antigravity headers timeout only for Google CCPA requests", async () => {
		endpoints.splice(0, endpoints.length, "https://ccpa.test");
		const account = makeAccount([{ provider: "google-antigravity", refreshToken: "r", projectId: "p" }]);
		const delays = await captureTimerDelays(() =>
			forwardGoogle(
				account,
				{ project: "p", model: "gemini-3.1-pro", request: { contents: [] } },
				{},
				undefined,
				{ apiRetry: false },
			),
		);
		assert.ok(delays.includes(ANTIGRAVITY_HEADERS_TIMEOUT_MS), `delays: ${delays.join(",")}`);
		assert.ok(!delays.includes(DEFAULT_HEADERS_TIMEOUT_MS));
	});
});
