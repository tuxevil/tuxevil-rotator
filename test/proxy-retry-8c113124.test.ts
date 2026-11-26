import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { startProxy, withRotation } from "../src/proxy.js";
import { ANTIGRAVITY_ENDPOINTS } from "../src/types.js";
import { setAntigravityModelsForTest } from "./fixtures/antigravity-catalog.js";

describe("proxy last-attempt retry guard (8c113124)", () => {
	const eps = ANTIGRAVITY_ENDPOINTS as unknown as string[];
	const savedEndpoints = [...eps];

	afterEach(() => {
		eps.splice(0, eps.length, ...savedEndpoints);
	});

	function makeAccount(email: string): any {
		return {
			config: { email, projectId: "test-project", refreshToken: "rt", label: email },
			accessToken: `token-${email}`,
			tokenExpires: Date.now() + 3_600_000,
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

	function makeMultiRotator(accounts: any[]): any {
		let idx = 0;
		return {
			getActiveAccount: async () => accounts[idx],
			getRetryAfterMs: () => 0,
			rotateToNext: async () => {
				if (idx >= accounts.length - 1) return null;
				idx++;
				return accounts[idx];
			},
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
				poolSize: 2,
				poolHealthyCount: 2,
				uptimeSeconds: 0,
			}),
			markFlagged: () => {},
			markError: () => {},
			recordRequest: () => false,
			recordProxyEvent: () => {},
			getGlobalDelayMs: () => 0,
			getConfig: () => ({
				streamRecoveryMaxRetries: 1,
				antigravityApiRetry: { maxRetries: 2, initialSleepDurationMs: 1, maxSleepDurationMs: 5 },
			}),
			getAccountCount: () => accounts.length,
			saveState: async () => {},
			getStatus: () => ({ accounts: [] }),
			getOllamaModels: () => [],
			resolveQuotaModelKeyForDisplay: (m: string) => m,
			recordRequestLog: () => {},
			recordLatency: () => {},
			recordTokenUsage: () => {},
		};
	}

	it("surfaces upstream 503 on the final rotation attempt instead of 502 All retry attempts failed", async () => {
		setAntigravityModelsForTest(["gemini-3.1-pro"]);
		const upstream = createServer((req, res) => {
			req.resume();
			req.on("end", () => {
				res.writeHead(503, { "Content-Type": "application/json" });
				res.end('{"error":{"code":503,"status":"UNAVAILABLE","message":"PREFILL_QUEUE_OVERLOADED"}}');
			});
		});
		await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
		const addr = upstream.address() as AddressInfo;
		eps.splice(0, eps.length, `http://127.0.0.1:${addr.port}`);

		const rotator = makeMultiRotator([makeAccount("a@example.com"), makeAccount("b@example.com")]);
		const body = {
			project: "compat-placeholder",
			model: "gemini-3.1-pro",
			request: { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
		};

		try {
			const outcome = await withRotation(rotator, "gemini-3.1-pro", {}, body, async () => "no");
			assert.equal(outcome.ok, false);
			if (!outcome.ok) {
				assert.equal(outcome.status, 503);
			}
		} finally {
			await new Promise<void>((r) => upstream.close(() => r()));
		}
	});

	it("preserves upstream 429 and Retry-After on the final handleProxyRequest attempt", async () => {
		setAntigravityModelsForTest(["gemini-3.1-pro"]);
		let hits = 0;
		const upstream = createServer((req, res) => {
			req.resume();
			req.on("end", () => {
				hits++;
				if (hits === 1) {
					res.writeHead(503, { "Content-Type": "application/json" });
					res.end('{"error":{"code":503,"status":"UNAVAILABLE","message":"PREFILL_QUEUE_OVERLOADED"}}');
					return;
				}
				res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "30" });
				res.end('{"error":{"status":"RATE_LIMITED","message":"rate limit"}}');
			});
		});
		await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
		const upAddr = upstream.address() as AddressInfo;
		eps.splice(0, eps.length, `http://127.0.0.1:${upAddr.port}`);

		const rotator = makeMultiRotator([makeAccount("a@example.com"), makeAccount("b@example.com")]);
		const proxy = startProxy(rotator, 0, "127.0.0.1");
		await once(proxy, "listening");
		const pAddr = proxy.address() as AddressInfo;

		try {
			const res = await fetch(`http://127.0.0.1:${pAddr.port}/v1internal:streamGenerateContent?alt=sse`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					project: "compat-placeholder",
					model: "gemini-3.1-pro",
					request: { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
				}),
			});
			assert.equal(res.status, 429);
			assert.equal(res.headers.get("retry-after"), "30");
		} finally {
			await new Promise<void>((r) => proxy.close(() => r()));
			await new Promise<void>((r) => upstream.close(() => r()));
		}
	});
});
