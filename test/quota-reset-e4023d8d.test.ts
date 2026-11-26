import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, initDb, setCachedState } from "../src/db-store.js";
import { dynamicCatalog } from "../src/providers/google-antigravity/dynamic-catalog.js";
import { fetchProviderQuota } from "../src/providers/google-antigravity/quota.js";

describe("full 100% weekly quota reset clears stale cooldown (e4023d8d)", () => {
	const originalFetch = globalThis.fetch;
	const dirs: string[] = [];

	afterEach(async () => {
		globalThis.fetch = originalFetch;
		dynamicCatalog.reset();
		await closeDb().catch(() => {});
		while (dirs.length > 0) {
			const dir = dirs.pop()!;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("clears stale multi-day gemini cooldown when authoritative summary reports 100% weekly without resetTime", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rotator-e4023d8d-"));
		dirs.push(dir);
		process.env.TUXEVIL_ROTATOR_DIR = dir;
		process.env.PI_ROTATOR_DIR = dir;
		delete process.env.DATABASE_URL;
		delete process.env.TUXEVIL_ROTATOR_DATABASE_URL;
		delete process.env.PI_ROTATOR_DATABASE_URL;

		await initDb();
		await setCachedState({ modelAccounts: {}, accounts: {} });
		dynamicCatalog.reset();

		const H = 3_600_000;
		const D = 24 * H;
		const now = Date.now();

		globalThis.fetch = (async (input) => {
			const url = String(input);
			if (url.includes("retrieveUserQuotaSummary")) {
				return new Response(
					JSON.stringify({
						groups: [
							{
								displayName: "Gemini Models",
								description: "Models within this group: Gemini 3.8 Flash",
								buckets: [
									{ bucketId: "gemini-5h", window: "5h", remainingFraction: 1 },
									{ bucketId: "gemini-weekly", window: "weekly", remainingFraction: 1 },
								],
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response(
				JSON.stringify({
					models: {
						"gemini-3.8-flash-high": {
							displayName: "Gemini 3.8 Flash (High)",
							quotaInfo: { remainingFraction: 1 },
						},
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch;

		const account: any = {
			config: {
				email: "poc@example.com",
				tier: "pro",
				credentials: [{ provider: "google-antigravity", refreshToken: "refresh-poc", projectId: "proj-poc" }],
			},
			accessToken: "access-poc",
			tokenExpires: now + H,
			requestsSinceRotation: 0,
			totalRequests: 0,
			cooldownsByModel: { gemini: now + 4 * D },
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
			dailyRequestDay: "2026-11-20",
			healthScore: 1,
			tokenBucket: { tokens: 50, lastRefillAt: now },
		};

		await fetchProviderQuota(account, {
			log: () => {},
			markFlagged: () => {},
			reportQuotaPollFlag: () => {},
		});

		assert.equal(account.cooldownsByModel.gemini, undefined);
		const gemini = account.quota.find((q: any) => q.modelKey === "gemini");
		assert.equal(gemini?.percentRemaining, 100);
	});
});
