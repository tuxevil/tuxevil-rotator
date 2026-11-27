import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAccountIdentity, getCredentialGeneration } from "../src/account-identity.js";
import { closeDb, initDb, setCachedState } from "../src/db-store.js";
import { dynamicCatalog } from "../src/providers/google-antigravity/dynamic-catalog.js";
import { AccountRotator } from "../src/rotator.js";

describe("dynamic pool kickstart isolation (23c4d02a)", () => {
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

	it("kickstarts non-gemini/claude dynamic pools using their own models and never falls back to gemini family", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rotator-23c4d02a-"));
		dirs.push(dir);
		process.env.TUXEVIL_ROTATOR_DIR = dir;
		process.env.PI_ROTATOR_DIR = dir;
		delete process.env.DATABASE_URL;
		delete process.env.TUXEVIL_ROTATOR_DATABASE_URL;
		delete process.env.PI_ROTATOR_DATABASE_URL;

		await initDb();
		await setCachedState({ modelAccounts: {}, accounts: {} });
		dynamicCatalog.reset();

		const rotator = new AccountRotator({
			proxyPort: 0,
			requestsPerRotation: 5,
			rotateOnQuotaDrop: 20,
			quotaPollIntervalMs: 300_000,
			accounts: [
				{
					email: "gemma@example.com",
					tier: "pro",
					credentials: [{ provider: "google-antigravity", refreshToken: "r", projectId: "proj-g" }],
				},
			],
		});
		rotator.stopQuotaPolling();
		const acc = (rotator as any).accounts[0];
		acc.accessToken = "tok";
		acc.tokenExpires = Date.now() + 3_600_000;
		const id = getAccountIdentity(acc);
		const gen = getCredentialGeneration(acc, "google-antigravity");
		dynamicCatalog.retainAccounts([{ id, generation: gen }]);
		dynamicCatalog.updateFromEndpointResponse(
			{ models: { "gemma-3-27b": {}, "gemini-4-argon-high": {} } },
			id,
			gen,
			undefined,
			new Map([
				["gemma-3-27b", "gemma-3"],
				["gemini-4-argon-high", "gemini-4-argon"],
			]),
		);
		acc.quota = [
			{ modelKey: "gemma-3", displayName: "Gemma 3", providerId: "google-antigravity", percentRemaining: 100, resetTime: null, timerType: "fresh" },
			{ modelKey: "gemini-4-argon", displayName: "Gemini 4 Argon", providerId: "google-antigravity", percentRemaining: 100, resetTime: null, timerType: "fresh" },
		];

		const kickModels: string[] = [];
		globalThis.fetch = (async (input, init) => {
			const url = String(input);
			if (url.includes("streamGenerateContent")) {
				const model = (JSON.parse(String(init?.body)) as { model: string }).model;
				kickModels.push(model);
				if (model === "gemini-4-argon-high") {
					return new Response(JSON.stringify({ error: { message: "bad" } }), { status: 400 });
				}
				return new Response("", { status: 200 });
			}
			return new Response(JSON.stringify({ groups: [], models: {} }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const res1 = await rotator.kickstartTimerForAccount("gemma@example.com", "gemma-3", false);
		assert.equal(res1.ok, true);
		assert.deepEqual(kickModels, ["gemma-3-27b"]);

		// Dynamic pool gemini-4-argon failure must not leak into gemini family kickstart (gemini-3.8-flash-tiered)
		const res2 = await rotator.kickstartTimerForAccount("gemma@example.com", "gemini-4-argon", false);
		assert.equal(res2.ok, false);
		assert.deepEqual(kickModels, ["gemma-3-27b", "gemini-4-argon-high"]);
	});
});
