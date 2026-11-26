import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAccountIdentity, getCredentialGeneration } from "../src/account-identity.js";
import { closeDb, initDb, setCachedState } from "../src/db-store.js";
import { dynamicCatalog } from "../src/providers/google-antigravity/dynamic-catalog.js";
import { AccountRotator } from "../src/rotator.js";
import { QUOTA_API_URL, QUOTA_SUMMARY_API_URL } from "../src/types.js";

describe("in-flight quota poll vs concurrent markExhausted (deff1eb2)", () => {
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

	it("preserves a cooldown written concurrently while fetchProviderQuota awaits summary", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rotator-deff1eb2-"));
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
		const weeklyReset = new Date(now + 6 * D).toISOString();
		const reset5h = new Date(now + 2.5 * H).toISOString();

		let summaryReached!: () => void;
		const summaryReachedP = new Promise<void>((r) => (summaryReached = r));
		let releaseSummary!: () => void;
		const releaseP = new Promise<void>((r) => (releaseSummary = r));

		globalThis.fetch = (async (input) => {
			const url = String(input);
			if (url === QUOTA_SUMMARY_API_URL) {
				summaryReached();
				await releaseP;
				return new Response(
					JSON.stringify({
						groups: [
							{
								displayName: "Gemini Models",
								description: "Models within this group: Gemini 4 Hydrogen",
								buckets: [
									{ bucketId: "gemini-5h", window: "5h", remainingFraction: 0.5, resetTime: reset5h },
									{ bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.5, resetTime: weeklyReset },
								],
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === QUOTA_API_URL) {
				return new Response(
					JSON.stringify({
						models: {
							"gemini-4-hydrogen-high": {
								displayName: "Gemini 4 Hydrogen (High)",
								quotaInfo: { remainingFraction: 0.5, resetTime: reset5h },
							},
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error(`unexpected fetch ${url}`);
		}) as typeof fetch;

		const rotator = new AccountRotator({
			proxyPort: 0,
			requestsPerRotation: 5,
			rotateOnQuotaDrop: 20,
			quotaPollIntervalMs: 300_000,
			accounts: [
				{
					email: "poc-race@example.com",
					tier: "pro",
					credentials: [{ provider: "google-antigravity", refreshToken: "r-poc", projectId: "proj-poc" }],
				},
			],
		});
		rotator.stopQuotaPolling();
		const runtime = (rotator as any).accounts[0];
		runtime.accessToken = "access-poc";
		runtime.tokenExpires = now + H;
		dynamicCatalog.retainAccounts([
			{ id: getAccountIdentity(runtime), generation: getCredentialGeneration(runtime, "google-antigravity") },
		]);

		const pollP = rotator.pollAccountQuota(runtime);
		await summaryReachedP;

		rotator.markExhausted(runtime, "gemini-4-hydrogen-high", 12 * H);
		const cooldownBefore = runtime.cooldownsByModel.gemini;
		assert.ok(typeof cooldownBefore === "number" && cooldownBefore - Date.now() >= 6 * H);

		releaseSummary();
		await pollP;

		assert.equal(runtime.cooldownsByModel.gemini, cooldownBefore);
		const row = (runtime.quota || []).find((q: any) => q.modelKey === "gemini");
		assert.equal(row?.percentRemaining, 0);
	});
});
