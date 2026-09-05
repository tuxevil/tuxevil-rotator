import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	MODEL_PRICING,
	QUOTA_MODEL_KEYS,
	getModelPricing,
	resolveDisplayModelKey,
	resolveQuotaModelKey,
} from "../src/types.js";
import { extractQuotas } from "../src/providers/google-antigravity/quota.js";
import { parseGoogleQuotaResponse } from "../src/providers/google-antigravity/dynamic-catalog.js";
import { readFileSync } from "node:fs";

describe("model resolution", () => {
	it("maps Gemini variants to the shared Gemini quota pool", () => {
		assert.equal(resolveQuotaModelKey("gemini-3.1-pro-low"), "gemini");
		assert.equal(resolveQuotaModelKey("gemini-3.1-pro-high"), "gemini");
		assert.equal(resolveQuotaModelKey("some-gemini-pro-model"), "gemini");
	});

	it("maps Flash requests to the Gemini quota pool", () => {
		assert.equal(resolveQuotaModelKey("gemini-3-flash"), "gemini");
		assert.equal(resolveQuotaModelKey("google/gemini-flash-latest"), "gemini");
		assert.equal(resolveQuotaModelKey("gemini-3-flash-agent"), "gemini");
		for (const variant of ["high", "medium", "low", "tiered"]) {
			assert.equal(
				resolveQuotaModelKey(`gemini-3.6-flash-${variant}`),
				"gemini",
			);
		}
		for (const variant of ["high", "medium", "low"]) {
			assert.equal(
				resolveQuotaModelKey(`gemini-3.8-flash-${variant}`),
				"gemini",
			);
		}
	});

	it("maps GPT-OSS requests to the Claude quota pool", () => {
		assert.equal(resolveQuotaModelKey("gpt-oss-120b-medium"), "claude");
		assert.equal(resolveQuotaModelKey("gpt-oss-120b"), "claude");
	});

	it("maps Claude variants to the Claude quota pool", () => {
		assert.equal(resolveQuotaModelKey("claude-opus-4-6-thinking"), "claude");
		assert.equal(resolveQuotaModelKey("claude-sonnet-4-6"), "claude");
		assert.equal(resolveQuotaModelKey("vendor/claude-custom"), "claude");
	});

	it("returns null for unknown quota models", () => {
		assert.equal(resolveQuotaModelKey("unknown-local-model"), null);
	});

	it("preserves display model distinctions used by telemetry/pricing", () => {
		assert.equal(resolveDisplayModelKey("gemini-3.1-pro-low"), "gemini-3.1-pro-low");
		assert.equal(resolveDisplayModelKey("gemini-3.1-pro-high"), "gemini-3.1-pro-high");
		assert.equal(resolveDisplayModelKey("claude-sonnet-4-6"), "claude-sonnet-4-6");
		assert.equal(resolveDisplayModelKey("claude-opus-4-6-thinking"), "claude-opus-4-6-thinking");
		assert.equal(resolveDisplayModelKey("gemini-3-flash-agent"), "gemini-3-flash");
		assert.equal(resolveDisplayModelKey("gemini-3.8-flash-high"), "gemini-3.8-flash-high");
		assert.equal(resolveDisplayModelKey("gemini-3.8-flash-medium"), "gemini-3.8-flash-medium");
		assert.equal(resolveDisplayModelKey("gemini-3.8-flash-low"), "gemini-3.8-flash-low");
		assert.equal(resolveDisplayModelKey("gemini-3.6-flash-high"), "gemini-3.6-flash-high");
		assert.equal(resolveDisplayModelKey("gemini-3.6-flash-medium"), "gemini-3.6-flash-medium");
		assert.equal(resolveDisplayModelKey("gemini-3.6-flash-low"), "gemini-3.6-flash-low");
		assert.equal(resolveDisplayModelKey("gemini-3.6-flash-tiered"), "gemini-3.6-flash-tiered");
		assert.equal(resolveDisplayModelKey("gpt-oss-120b-medium"), "gpt-oss-120b-medium");
	});

	it("has pricing entries for every known display family", () => {
		assert.ok(MODEL_PRICING["gemini-3.1-pro"]);
		assert.ok(MODEL_PRICING["gemini-3.1-pro-low"]);
		assert.ok(MODEL_PRICING["gemini-3.1-pro-high"]);
		assert.ok(MODEL_PRICING["gemini-3-flash"]);
		assert.ok(MODEL_PRICING["gemini-3.6-flash-high"]);
		assert.ok(MODEL_PRICING["gemini-3.6-flash-medium"]);
		assert.ok(MODEL_PRICING["gemini-3.6-flash-low"]);
		assert.ok(MODEL_PRICING["gemini-3.6-flash-tiered"]);
		assert.ok(MODEL_PRICING["gemini-3.8-flash-high"]);
		assert.ok(MODEL_PRICING["gemini-3.8-flash-medium"]);
		assert.ok(MODEL_PRICING["gemini-3.8-flash-low"]);
		assert.ok(MODEL_PRICING["claude-opus-4-6-thinking"]);
		assert.ok(MODEL_PRICING["claude-sonnet-4-6"]);
		assert.ok(MODEL_PRICING["gpt-oss-120b-medium"]);
		assert.ok(MODEL_PRICING["gpt-5.6-sol"]);
		assert.ok(MODEL_PRICING["gpt-5.6-terra"]);
		assert.ok(MODEL_PRICING["gpt-5.6-luna"]);
		assert.ok(MODEL_PRICING["deepseek-v4-flash-free"]);
		assert.ok(MODEL_PRICING["nemotron-3.5-lightning-free"]);
		assert.ok(MODEL_PRICING["nemotron-3-ultra-free"]);
		assert.ok(MODEL_PRICING["mimo-v2.5-free"]);
		assert.ok(MODEL_PRICING["hy3-free"]);

	});

	it("uses official Codex GPT-5.6 text-token pricing", () => {
		assert.deepEqual(MODEL_PRICING["gpt-5.6-sol"], {
			inputPer1M: 5.0,
			outputPer1M: 30.0,
			cachingPer1M: 0.5,
		});
		assert.deepEqual(MODEL_PRICING["gpt-5.6-terra"], {
			inputPer1M: 2.0,
			outputPer1M: 12.0,
			cachingPer1M: 0.2,
		});
		assert.deepEqual(MODEL_PRICING["gpt-5.6-luna"], {
			inputPer1M: 0.2,
			outputPer1M: 1.2,
			cachingPer1M: 0.02,
		});
	});

	it("uses the official Gemini 3.6 Flash pricing", () => {
		const p = MODEL_PRICING["gemini-3.6-flash-high"];
		assert.ok(p);
		assert.equal(p.inputPer1M, 1.50);
		assert.equal(p.outputPer1M, 7.50);
		assert.equal(p.cachingPer1M, 0.15);
		assert.equal(p.cachingStoragePer1MPerHour, 1.00);
	});

	it("uses the official Gemini 3.7 Flash introductory pricing", () => {
		assert.deepEqual(MODEL_PRICING["gemini-3.7-flash-tiered"], {
			inputPer1M: 0.75,
			outputPer1M: 3.75,
			cachingPer1M: 0.075,
			cachingStoragePer1MPerHour: 0.5,
		});
	});

	it("uses the official Gemini 3.8 Flash introductory pricing", () => {
		for (const variant of ["low", "medium", "high"]) {
			assert.deepEqual(MODEL_PRICING[`gemini-3.8-flash-${variant}`], {
				inputPer1M: 0.75,
				outputPer1M: 3.75,
				cachingPer1M: 0.075,
				cachingStoragePer1MPerHour: 0.5,
			});
		}
	});

	it("keeps quota model keys unique", () => {
		const keys = Object.values(QUOTA_MODEL_KEYS).map((entry) => entry.key);
		assert.equal(new Set(keys).size, keys.length);
	});

	it("resolves gemini-3.7-flash-tiered to the shared gemini quota pool", () => {
		assert.equal(resolveQuotaModelKey("gemini-3.7-flash-tiered"), "gemini");
		assert.equal(resolveQuotaModelKey("google/gemini-3.7-flash-tiered"), "gemini");
	});

	it("keeps gemini-3.7-flash-tiered as its exact display key", () => {
		assert.equal(
			resolveDisplayModelKey("gemini-3.7-flash-tiered"),
			"gemini-3.7-flash-tiered",
		);
		// Provider-prefixed requests resolve to the same canonical display key.
		assert.equal(
			resolveDisplayModelKey("google/gemini-3.7-flash-tiered"),
			"gemini-3.7-flash-tiered",
		);
	});

	it("does not treat gemini-3.7-flash low/medium/high as supported virtual models", () => {
		for (const variant of ["low", "medium", "high"]) {
			const id = `gemini-3.7-flash-${variant}`;
			// Falls back to the generic Flash display key, never a 3.7 virtual key.
			assert.equal(resolveDisplayModelKey(id), "gemini-3-flash");
			// No quota alt-key or alias entry is created for the virtual variant.
			assert.ok(!QUOTA_MODEL_KEYS.gemini.altKeys.includes(id));
		}
	});

	it("appends gemini-3.7-flash-tiered exactly once to the gemini quota altKeys", () => {
		const altKeys = QUOTA_MODEL_KEYS.gemini.altKeys;
		const matches = altKeys.filter((k) => k === "gemini-3.7-flash-tiered");
		assert.equal(matches.length, 1);
	});

	it("includes each native gemini-3.8-flash id exactly once in quota altKeys", () => {
		const altKeys = QUOTA_MODEL_KEYS.gemini.altKeys;
		for (const variant of ["low", "medium", "high"]) {
			const id = `gemini-3.8-flash-${variant}`;
			assert.equal(altKeys.filter((key) => key === id).length, 1);
		}
	});

	it("extracts gemini pool quota via a gemini-3.8-flash alt key", () => {
		const quotas = extractQuotas({
			models: {
				"gemini-3.8-flash-high": {
					quotaInfo: { remainingFraction: 0.73 },
				},
			},
		}, []);
		assert.deepEqual(quotas.map((quota) => ({
			key: quota.modelKey,
			percent: quota.percentRemaining,
		})), [{ key: "gemini", percent: 73 }]);
	});

	it("extracts gemini pool quota via the gemini-3.7-flash-tiered alt key", () => {
		const data = {
			models: {
				"gemini-3.7-flash-tiered": {
					quotaInfo: { remainingFraction: 0.42 },
				},
			},
		};
		const quotas = extractQuotas(data, []);
		const gemini = quotas.find((q) => q.modelKey === "gemini");
		assert.ok(gemini, "alt-key extraction should surface the shared gemini pool");
		assert.equal(gemini.displayName, "Gemini");
		assert.equal(gemini.percentRemaining, 42);
		// No other pool key present in the stub response.
		assert.equal(quotas.length, 1);
	});

	it("skips metadata-only family entries and uses the first quota-bearing sibling", () => {
		const quotas = extractQuotas({
			models: {
				"gemini-future-metadata-only": { displayName: "metadata only" },
				"gemini-future-exhausted": {
					quotaInfo: { remainingFraction: 0 },
				},
				"gemini-future-available": {
					quotaInfo: { remainingFraction: 0.9 },
				},
			},
		}, []);

		assert.deepEqual(quotas.map(({ modelKey, percentRemaining }) => ({
			modelKey,
			percentRemaining,
		})), [{ modelKey: "gemini", percentRemaining: 0 }]);
	});

	it("uses the most exhausted sibling for a shared quota pool", () => {
		const quotas = extractQuotas({
			models: {
				"gemini-3.1-pro": { quotaInfo: { remainingFraction: 1 } },
				"gemini-3-flash": { quotaInfo: { remainingFraction: 0 } },
			},
		}, []);

		assert.equal(quotas.find((q) => q.modelKey === "gemini")?.percentRemaining, 0);
	});

	it("keeps legacy reset-only Claude and Gemini entries visible", () => {
		const fixture = JSON.parse(
			readFileSync(new URL("./fixtures/google-quota-partial.json", import.meta.url), "utf8"),
		);
		const parsed = parseGoogleQuotaResponse(fixture);
		assert.ok(parsed);
		const quotas = extractQuotas(parsed, []);

		assert.deepEqual(
			quotas.map(({ modelKey, percentRemaining, resetTime }) => ({
				modelKey,
				percentRemaining,
				resetTime,
			})),
			[
				{
					modelKey: "claude",
					percentRemaining: 0,
					resetTime: "2099-09-06T19:15:02Z",
				},
				{
					modelKey: "gemini",
					percentRemaining: 0,
					resetTime: "2099-09-10T18:36:32Z",
				},
			],
		);
	});

	it("ignores malformed canonical quota and uses a valid family sibling", () => {
		const quotas = extractQuotas({
			models: {
				gemini: {
					quotaInfo: {
						remainingFraction: 2,
						resetTime: "2099-01-01T00:00:00Z",
					},
				},
				"gemini-valid-sibling": {
					quotaInfo: { remainingFraction: 0.9 },
				},
			},
		}, []);

		assert.deepEqual(quotas.map(({ modelKey, percentRemaining }) => ({
			modelKey,
			percentRemaining,
		})), [{ modelKey: "gemini", percentRemaining: 90 }]);
	});

	it("uses provider-aware versioned Gemini pricing fallbacks", () => {
		assert.equal(getModelPricing("google/gemini-3.8-flash-preview")?.inputPer1M, 0.75);
		assert.equal(getModelPricing("google/gemini-3.7-flash-preview")?.inputPer1M, 0.75);
		assert.equal(getModelPricing("google/gemini-3.6-flash-preview")?.inputPer1M, 1.5);
		assert.equal(getModelPricing("google/gemini-4.0-flash-preview")?.inputPer1M, 0.5);
		assert.equal(getModelPricing("acme-flash-preview"), undefined);
	});

	it("treats intact Google quota as fresh even when reset times are present", () => {
		const fiveHoursFromNow = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString();
		const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
		const oldQuota = [
			{
				modelKey: "claude",
				displayName: "Claude",
				percentRemaining: 100,
				resetTime: fiveHoursFromNow,
				timerType: "5h" as const,
			},
			{
				modelKey: "gemini",
				displayName: "Gemini",
				percentRemaining: 100,
				resetTime: sevenDaysFromNow,
				timerType: "7d" as const,
			},
		];
		const quotas = extractQuotas(
			{
				models: {
					claude: {
						quotaInfo: { remainingFraction: 1, resetTime: fiveHoursFromNow },
					},
					gemini: {
						quotaInfo: { remainingFraction: 1, resetTime: sevenDaysFromNow },
					},
				},
			},
			oldQuota,
		);

		for (const quota of quotas) {
			assert.equal(quota.timerType, "fresh");
			assert.equal(quota.resetTime, null);
		}

		const [partiallyUsed] = extractQuotas(
			{
				models: {
					claude: {
						quotaInfo: {
							remainingFraction: 0.999,
							resetTime: fiveHoursFromNow,
						},
					},
				},
			},
			[],
		);
		assert.equal(partiallyUsed.percentRemaining, 100);
		assert.equal(partiallyUsed.timerType, "5h");
		assert.equal(partiallyUsed.resetTime, fiveHoursFromNow);
	});

it("orders quota model keys: claude, gemini", () => {
		const orderedKeys = Object.keys(QUOTA_MODEL_KEYS);
		assert.deepEqual(orderedKeys, ["claude", "gemini"]);
	});
});
