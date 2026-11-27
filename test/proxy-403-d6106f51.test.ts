import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { withRotation } from "../src/proxy.js";
import { ANTIGRAVITY_ENDPOINTS } from "../src/types.js";
import { setAntigravityModelsForTest } from "./fixtures/antigravity-catalog.js";

describe("model-scoped 403 entitlement handling (d6106f51)", () => {
	const eps = ANTIGRAVITY_ENDPOINTS as unknown as string[];
	const savedEndpoints = [...eps];

	afterEach(() => {
		eps.splice(0, eps.length, ...savedEndpoints);
	});

	it("does not quarantine account when a model-scoped 403 includes forbidden/policy wording", async () => {
		setAntigravityModelsForTest(["gemini-3.1-pro", "gemini-3-flash"]);
		const upstream = createServer((req, res) => {
			req.resume();
			res.writeHead(403, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					error: {
						code: "MODEL_NOT_SUPPORTED_FOR_PLAN",
						message: "Model access forbidden by subscription policy",
					},
				}),
			);
		});
		await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
		const addr = upstream.address() as AddressInfo;
		eps.splice(0, eps.length, `http://127.0.0.1:${addr.port}`);

		let invalidated = 0;
		let flagged = 0;
		const account: any = {
			config: { email: "poc@example.com", projectId: "test-project", refreshToken: "rt", label: "poc@example.com" },
			accessToken: "token-poc",
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
			rotateToNext: async () => null,
			finishRequest: () => {},
			getSafetyJitterMs: () => 0,
			recordUpstreamAttempt: () => {},
			markExhausted: () => {},
			recordProvider429: () => {},
			getRetryAfterMs: () => 0,
			getFlagContext: () => ({
				timerType: "5h",
				accountQuotaPercent: 50,
				wasProAccount: true,
				accountRequestsLastHour: 1,
				poolSize: 5,
				poolHealthyCount: 4,
				uptimeSeconds: 600,
			}),
			markFlagged: () => {
				flagged++;
			},
			markProviderInvalid: () => {
				invalidated++;
			},
			markError: () => {},
			recordRequest: () => false,
			recordProxyEvent: () => {},
			getGlobalDelayMs: () => 0,
		};

		try {
			const outcome = await withRotation(
				rotator,
				"gemini-3.1-pro",
				{},
				{ project: "test-project", model: "gemini-3.1-pro", request: {} },
				async () => "no",
			);
			assert.equal(outcome.ok, false);
			if (!outcome.ok) {
				assert.equal(outcome.status, 403);
			}
			assert.equal(invalidated, 0);
			assert.equal(flagged, 0);
		} finally {
			await new Promise<void>((r) => upstream.close(() => r()));
		}
	});
});
