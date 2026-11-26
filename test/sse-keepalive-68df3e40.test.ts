import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { startProxy } from "../src/proxy.js";
import { ANTIGRAVITY_ENDPOINTS } from "../src/types.js";
import { setAntigravityModelsForTest } from "./fixtures/antigravity-catalog.js";

describe("native SSE passthrough keepalive (68df3e40)", () => {
	const eps = ANTIGRAVITY_ENDPOINTS as unknown as string[];
	const savedEndpoints = [...eps];

	afterEach(() => {
		eps.splice(0, eps.length, ...savedEndpoints);
	});

	it("flushes SSE headers and emits : ping before the first delayed upstream chunk", async () => {
		setAntigravityModelsForTest(["gemini-3.1-pro"]);

		let released = false;
		let release!: () => void;
		const latch = new Promise<void>((resolve) => {
			release = () => {
				released = true;
				resolve();
			};
		});
		let headersBeforeRelease = false;
		let pingBeforeRelease = false;

		const upstream = http.createServer((req, res) => {
			req.resume();
			req.on("end", () => {
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.flushHeaders();
				const deadline = setTimeout(release, 1500);
				void latch.then(() => {
					clearTimeout(deadline);
					res.end('data: {"response":{"candidates":[{"content":{"parts":[{"text":"late"}]}}]}}\n\n');
				});
			});
		});
		upstream.listen(0, "127.0.0.1");
		await once(upstream, "listening");
		const upAddr = upstream.address() as AddressInfo;
		eps.splice(0, eps.length, `http://127.0.0.1:${upAddr.port}`);

		const account: any = {
			config: { email: "a@x", projectId: "p", refreshToken: "rt", label: "a@x" },
			accessToken: "token-a",
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
		const rotator: any = {
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
			getConfig: () => ({ streamRecoveryMaxRetries: 0, sseKeepaliveIntervalMs: 25 }),
			saveState: async () => {},
			getStatus: () => ({ accounts: [] }),
			getOllamaModels: () => [],
			resolveQuotaModelKeyForDisplay: (m: string) => m,
			recordRequestLog: () => {},
			recordLatency: () => {},
			recordTokenUsage: () => {},
		};

		const proxy = startProxy(rotator, 0, "127.0.0.1");
		await once(proxy, "listening");
		const pAddr = proxy.address() as AddressInfo;

		let body = "";
		try {
			await new Promise<void>((resolve) => {
				const payload = JSON.stringify({
					project: "test-project",
					model: "gemini-3.1-pro",
					request: { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
				});
				const creq = http.request(
					{
						host: "127.0.0.1",
						port: pAddr.port,
						method: "POST",
						path: "/v1internal:streamGenerateContent?alt=sse",
						headers: {
							"Content-Type": "application/json",
							"Content-Length": Buffer.byteLength(payload),
						},
					},
					(cres) => {
						if (!released) headersBeforeRelease = true;
						cres.on("data", (chunk: Buffer) => {
							body += chunk.toString();
							if (!released && body.includes(": ping\n\n")) {
								pingBeforeRelease = true;
								release();
							}
						});
						cres.on("end", () => resolve());
						cres.on("error", () => resolve());
					},
				);
				creq.on("error", () => resolve());
				creq.end(payload);
			});
		} finally {
			release();
			await new Promise<void>((r) => proxy.close(() => r()));
			await new Promise<void>((r) => upstream.close(() => r()));
		}

		assert.equal(headersBeforeRelease, true);
		assert.equal(pingBeforeRelease, true);
		assert.ok(body.includes("late"));
	});
});
