import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
	setEffortRoutingOverride,
	setModelAliasesOverride,
	getEffortRouting,
	applyModelAlias,
	resolveDisplayModelKey,
} from "../src/types.js";
import { resolveEffortAliasModel } from "../src/providers/google-antigravity/translators.js";
import { validateConfig, formatValidationErrors } from "../src/validators.js";
import { applyConfigDefaults } from "../src/config-defaults.js";
import { AccountRotator } from "../src/rotator.js";
import { initDb, closeDb, setCachedConfig, getCachedConfig } from "../src/db-store.js";
import { logger } from "../src/logger.js";

describe("Effort-based model routing resolver", () => {
	afterEach(() => {
		setEffortRoutingOverride(null);
		setModelAliasesOverride(null);
	});

	it("returns null for everything when no config is set (opt-in default)", () => {
		assert.equal(getEffortRouting(), null);
		assert.equal(resolveEffortAliasModel("gemini-3.8-flash", "high"), null);
		assert.equal(resolveEffortAliasModel("gemini-3.8-flash", "low"), null);
		assert.equal(resolveEffortAliasModel("gemini-3.8-flash", undefined), null);
	});

	it("treats null, undefined, or empty object config as disabled", () => {
		setEffortRoutingOverride(null);
		assert.equal(getEffortRouting(), null);
		setEffortRoutingOverride(undefined);
		assert.equal(getEffortRouting(), null);
		setEffortRoutingOverride({});
		assert.equal(getEffortRouting(), null);
	});

	it("routes each configured effort to its target", () => {
		setEffortRoutingOverride({
			"gemini-3.8-flash": {
				defaultEffort: "medium",
				targets: {
					low: "gemini-3.8-flash-low",
					medium: "gemini-3.8-flash-medium",
					high: "gemini-3.8-flash-high",
				},
			},
		});

		assert.equal(
			resolveEffortAliasModel("gemini-3.8-flash", "low"),
			"gemini-3.8-flash-low",
		);
		assert.equal(
			resolveEffortAliasModel("gemini-3.8-flash", "medium"),
			"gemini-3.8-flash-medium",
		);
		assert.equal(
			resolveEffortAliasModel("gemini-3.8-flash", "high"),
			"gemini-3.8-flash-high",
		);
	});

	it("treats reserved alias and effort keys from JSON as ordinary own data", () => {
		setEffortRoutingOverride(JSON.parse(`{
			"constructor":{"defaultEffort":"__proto__","targets":{"constructor":"constructor-target","prototype":"prototype-target","__proto__":"proto-target"}},
			"prototype":{"defaultEffort":"constructor","targets":{"constructor":"prototype-constructor-target","prototype":"prototype-prototype-target","__proto__":"prototype-proto-target"}},
			"__proto__":{"defaultEffort":"prototype","targets":{"constructor":"proto-constructor-target","prototype":"proto-prototype-target","__proto__":"proto-proto-target"}}
		}`));

		const expected = [
			["constructor", "constructor", "constructor-target"],
			["constructor", "prototype", "prototype-target"],
			["constructor", "__proto__", "proto-target"],
			["prototype", "constructor", "prototype-constructor-target"],
			["prototype", "prototype", "prototype-prototype-target"],
			["prototype", "__proto__", "prototype-proto-target"],
			["__proto__", "constructor", "proto-constructor-target"],
			["__proto__", "prototype", "proto-prototype-target"],
			["__proto__", "__proto__", "proto-proto-target"],
		] as const;

		for (const [alias, effort, target] of expected) {
			assert.equal(resolveEffortAliasModel(alias, effort), target);
		}
	});

	it("does not treat inherited reserved names as configured aliases", () => {
		setEffortRoutingOverride({
			safe: {
				defaultEffort: "medium",
				targets: { medium: "gemini-3.8-flash-medium" },
			},
		});

		for (const name of ["constructor", "prototype", "__proto__"]) {
			assert.equal(resolveEffortAliasModel(name, "medium"), null);
		}
	});

	it("does not resolve inherited Object properties as model aliases", () => {
		for (const name of ["constructor", "prototype", "__proto__"]) {
			assert.equal(applyModelAlias(name), name);
		}
	});

	it("falls back to default effort for missing, null, non-string, empty, or whitespace effort", () => {
		setEffortRoutingOverride({
			"gemini-3.8-flash": {
				defaultEffort: "medium",
				targets: {
					low: "gemini-3.8-flash-low",
					medium: "gemini-3.8-flash-medium",
					high: "gemini-3.8-flash-high",
				},
			},
		});

		assert.equal(
			resolveEffortAliasModel("gemini-3.8-flash", undefined),
			"gemini-3.8-flash-medium",
		);
		assert.equal(
			resolveEffortAliasModel("gemini-3.8-flash", null),
			"gemini-3.8-flash-medium",
		);
		assert.equal(
			resolveEffortAliasModel("gemini-3.8-flash", 123),
			"gemini-3.8-flash-medium",
		);
		assert.equal(
			resolveEffortAliasModel("gemini-3.8-flash", ""),
			"gemini-3.8-flash-medium",
		);
		assert.equal(
			resolveEffortAliasModel("gemini-3.8-flash", "   "),
			"gemini-3.8-flash-medium",
		);
		assert.equal(
			resolveEffortAliasModel("gemini-3.8-flash", "unknown-effort"),
			"gemini-3.8-flash-medium",
		);
	});

	it("logs each provided malformed effort while falling back without throwing", () => {
		setEffortRoutingOverride({
			"gemini-3.8-flash": {
				defaultEffort: "medium",
				targets: { medium: "gemini-3.8-flash-medium" },
			},
		});

		const originalLog = logger.log;
		const debugMessages: string[] = [];
		logger.log = (level, scope, message) => {
			if (level === "debug" && scope === "compat") {
				debugMessages.push(String(message));
			}
		};

		try {
			for (const effort of [5, "", "   ", "unknown"]) {
				assert.equal(
					resolveEffortAliasModel("gemini-3.8-flash", effort),
					"gemini-3.8-flash-medium",
				);
			}
		} finally {
			logger.log = originalLog;
		}

		assert.equal(debugMessages.length, 4);
		for (const message of debugMessages) {
			assert.match(message, /falling back to default/);
		}
	});

	it("handles effort values case-insensitively and with whitespace", () => {
		setEffortRoutingOverride({
			"gemini-3.8-flash": {
				defaultEffort: "medium",
				targets: {
					low: "gemini-3.8-flash-low",
					medium: "gemini-3.8-flash-medium",
					high: "gemini-3.8-flash-high",
				},
			},
		});

		assert.equal(
			resolveEffortAliasModel("gemini-3.8-flash", "  HIGH  "),
			"gemini-3.8-flash-high",
		);
		assert.equal(
			resolveEffortAliasModel("gemini-3.8-flash", "Low"),
			"gemini-3.8-flash-low",
		);
	});

	it("matches alias names case-insensitively and with surrounding whitespace", () => {
		setEffortRoutingOverride({
			"gemini-3.8-flash": {
				defaultEffort: "medium",
				targets: {
					low: "gemini-3.8-flash-low",
					medium: "gemini-3.8-flash-medium",
					high: "gemini-3.8-flash-high",
				},
			},
		});

		assert.equal(
			resolveEffortAliasModel("GEMINI-3.8-FLASH", "high"),
			"gemini-3.8-flash-high",
		);
		assert.equal(
			resolveEffortAliasModel("  gemini-3.8-flash  ", "low"),
			"gemini-3.8-flash-low",
		);
	});

	it("returns null for non-alias models", () => {
		setEffortRoutingOverride({
			"gemini-3.8-flash": {
				defaultEffort: "medium",
				targets: {
					medium: "gemini-3.8-flash-medium",
				},
			},
		});

		assert.equal(resolveEffortAliasModel("gemini-3.8-flash-medium", "high"), null);
		assert.equal(resolveEffortAliasModel("claude-sonnet-4-6", "high"), null);
		assert.equal(resolveEffortAliasModel("unknown-model", "high"), null);
	});

	it("materializes omitted defaultEffort to medium at the setter level", () => {
		setEffortRoutingOverride({
			"gemini-3.8-flash": {
				targets: {
					low: "gemini-3.8-flash-low",
					medium: "gemini-3.8-flash-medium",
				},
			},
		});

		const rules = getEffortRouting();
		assert.ok(rules);
		assert.equal(rules["gemini-3.8-flash"].defaultEffort, "medium");
		assert.equal(
			resolveEffortAliasModel("gemini-3.8-flash", undefined),
			"gemini-3.8-flash-medium",
		);
	});

	it("honors explicit defaultEffort and routes custom effort keys", () => {
		setEffortRoutingOverride({
			"custom-alias": {
				defaultEffort: "minimal",
				targets: {
					minimal: "target-min",
					extreme: "target-max",
				},
			},
		});

		assert.equal(resolveEffortAliasModel("custom-alias", undefined), "target-min");
		assert.equal(resolveEffortAliasModel("custom-alias", "extreme"), "target-max");
		assert.equal(resolveEffortAliasModel("custom-alias", "minimal"), "target-min");
	});

	it("restores disabled state when setEffortRoutingOverride(null) is called", () => {
		setEffortRoutingOverride({
			"gemini-3.8-flash": {
				targets: { medium: "gemini-3.8-flash-medium" },
			},
		});
		assert.ok(getEffortRouting());
		setEffortRoutingOverride(null);
		assert.equal(getEffortRouting(), null);
		assert.equal(resolveEffortAliasModel("gemini-3.8-flash", "medium"), null);
	});
});

describe("resolveDisplayModelKey with effort routing", () => {
	afterEach(() => {
		setEffortRoutingOverride(null);
	});

	it("preserves single-arg behavior identically without effort routing", () => {
		assert.equal(resolveDisplayModelKey("gemini-3.8-flash"), "gemini-3-flash");
		assert.equal(resolveDisplayModelKey("gemini-3.8-flash-high"), "gemini-3.8-flash-high");
		assert.equal(resolveDisplayModelKey("claude-sonnet-4-6"), "claude-sonnet-4-6");
	});

	it("resolves from effectiveModel when requestModel matches configured effort routing alias", () => {
		setEffortRoutingOverride({
			"gemini-3.8-flash": {
				defaultEffort: "medium",
				targets: {
					low: "gemini-3.8-flash-low",
					medium: "gemini-3.8-flash-medium",
					high: "gemini-3.8-flash-high",
				},
			},
		});

		assert.equal(
			resolveDisplayModelKey("gemini-3.8-flash", "gemini-3.8-flash-high"),
			"gemini-3.8-flash-high",
		);
		assert.equal(
			resolveDisplayModelKey("gemini-3.8-flash", "gemini-3.8-flash-low"),
			"gemini-3.8-flash-low",
		);
		assert.equal(
			resolveDisplayModelKey("gemini-3.8-flash", "gemini-3.8-flash-medium"),
			"gemini-3.8-flash-medium",
		);

		assert.equal(resolveDisplayModelKey("gemini-3.8-flash"), "gemini-3-flash");

		assert.equal(
			resolveDisplayModelKey("other-model", "gemini-3.8-flash-high"),
			"other-model",
		);
	});
});

describe("effortRouting config validation", () => {
	const baseValidConfig = {
		accounts: [{ email: "test@example.com", refreshToken: "tok", projectId: "pid" }],
	};

	it("accepts valid effortRouting config with implicit defaultEffort (medium)", () => {
		const result = validateConfig({
			...baseValidConfig,
			effortRouting: {
				"gemini-3.8-flash": {
					targets: {
						low: "gemini-3.8-flash-low",
						medium: "gemini-3.8-flash-medium",
						high: "gemini-3.8-flash-high",
					},
				},
			},
		});
		assert.equal(result.ok, true, formatValidationErrors(result.errors));
	});

	it("accepts valid effortRouting config with explicit defaultEffort", () => {
		const result = validateConfig({
			...baseValidConfig,
			effortRouting: {
				"gemini-3.8-flash": {
					defaultEffort: "high",
					targets: {
						low: "gemini-3.8-flash-low",
						high: "gemini-3.8-flash-high",
					},
				},
			},
		});
		assert.equal(result.ok, true, formatValidationErrors(result.errors));
	});

	it("accepts null effortRouting", () => {
		const result = validateConfig({
			...baseValidConfig,
			effortRouting: null,
		});
		assert.equal(result.ok, true, formatValidationErrors(result.errors));
	});

	it("rejects non-object non-null effortRouting", () => {
		const result = validateConfig({
			...baseValidConfig,
			effortRouting: "invalid",
		});
		assert.equal(result.ok, false);
		assert.ok(
			result.errors.includes("config.effortRouting must be an object or null when provided"),
		);
	});

	it("rejects empty/whitespace alias key", () => {
		const result = validateConfig({
			...baseValidConfig,
			effortRouting: {
				"   ": {
					targets: { medium: "target-model" },
				},
			},
		});
		assert.equal(result.ok, false);
		assert.ok(
			result.errors.includes("config.effortRouting keys must be non-empty strings"),
		);
	});

	it("rejects non-object rule", () => {
		const result = validateConfig({
			...baseValidConfig,
			effortRouting: {
				"my-alias": "not-an-object",
			},
		});
		assert.equal(result.ok, false);
		assert.ok(
			result.errors.includes("config.effortRouting.my-alias must be an object"),
		);
	});

	it("rejects missing or non-object targets", () => {
		const result = validateConfig({
			...baseValidConfig,
			effortRouting: {
				"my-alias": { defaultEffort: "medium" },
			},
		});
		assert.equal(result.ok, false);
		assert.ok(
			result.errors.includes("config.effortRouting.my-alias.targets must be an object"),
		);
	});

	it("rejects empty/whitespace effort key in targets", () => {
		const result = validateConfig({
			...baseValidConfig,
			effortRouting: {
				"my-alias": {
					targets: {
						"": "target-model",
						medium: "target-model",
					},
				},
			},
		});
		assert.equal(result.ok, false);
		assert.ok(
			result.errors.includes("config.effortRouting.my-alias.targets keys must be non-empty strings"),
		);
	});

	it("rejects non-string target value", () => {
		const result = validateConfig({
			...baseValidConfig,
			effortRouting: {
				"my-alias": {
					targets: {
						medium: 12345,
					},
				},
			},
		});
		assert.equal(result.ok, false);
		assert.ok(
			result.errors.includes("config.effortRouting.my-alias.targets.medium must be a non-empty string"),
		);
	});

	it("rejects non-string defaultEffort", () => {
		const result = validateConfig({
			...baseValidConfig,
			effortRouting: {
				"my-alias": {
					defaultEffort: 42,
					targets: { medium: "target-model" },
				},
			},
		});
		assert.equal(result.ok, false);
		assert.ok(
			result.errors.includes("config.effortRouting.my-alias.defaultEffort must be a string when provided"),
		);
	});

	it("rejects missing effective default (implicit medium)", () => {
		const result = validateConfig({
			...baseValidConfig,
			effortRouting: {
				"my-alias": {
					targets: {
						low: "target-low",
						high: "target-high",
					},
				},
			},
		});
		assert.equal(result.ok, false);
		assert.ok(
			result.errors.includes('config.effortRouting.my-alias default effort "medium" has no matching target'),
		);
	});

	it("rejects missing effective default (explicit defaultEffort)", () => {
		const result = validateConfig({
			...baseValidConfig,
			effortRouting: {
				"my-alias": {
					defaultEffort: "extreme",
					targets: {
						low: "target-low",
						high: "target-high",
					},
				},
			},
		});
		assert.equal(result.ok, false);
		assert.ok(
			result.errors.includes('config.effortRouting.my-alias default effort "extreme" has no matching target'),
		);
	});

	it("rejects case-insensitive collision of alias keys", () => {
		const result = validateConfig({
			...baseValidConfig,
			effortRouting: {
				"gemini-3.8-flash": {
					targets: { medium: "target-1" },
				},
				"GEMINI-3.8-FLASH": {
					targets: { medium: "target-2" },
				},
			},
		});
		assert.equal(result.ok, false);
		assert.ok(
			result.errors.includes('config.effortRouting keys collide case-insensitively: "gemini-3.8-flash" / "GEMINI-3.8-FLASH"'),
		);
	});

	it("rejects case-insensitive collision of effort keys in targets", () => {
		const result = validateConfig({
			...baseValidConfig,
			effortRouting: {
				"my-alias": {
					targets: {
						LOW: "target-low-1",
						low: "target-low-2",
						medium: "target-med",
					},
				},
			},
		});
		assert.equal(result.ok, false);
		assert.ok(
			result.errors.includes('config.effortRouting.my-alias.targets keys collide case-insensitively: "LOW" / "low"'),
		);
	});

	it("rejects case-insensitive overlap between modelAliases and effortRouting", () => {
		const result = validateConfig({
			...baseValidConfig,
			modelAliases: {
				"my-model": "upstream-model",
			},
			effortRouting: {
				"MY-MODEL": {
					targets: { medium: "target-model" },
				},
			},
		});
		assert.equal(result.ok, false);
		assert.ok(
			result.errors.includes('config.effortRouting.MY-MODEL conflicts with config.modelAliases entry of the same name'),
		);
	});

	it("rejects alias-as-target chaining", () => {
		const result = validateConfig({
			...baseValidConfig,
			effortRouting: {
				"alias-a": {
					targets: { medium: "alias-b" },
				},
				"alias-b": {
					targets: { medium: "concrete-model" },
				},
			},
		});
		assert.equal(result.ok, false);
		assert.ok(
			result.errors.includes('config.effortRouting.alias-a.targets.medium chains into effort-routing alias "alias-b" (not supported)'),
		);
	});

	it("rejects statically known non-Google model collisions on alias name", () => {
		const codexResult = validateConfig({
			...baseValidConfig,
			effortRouting: {
				"gpt-5.6-sol": {
					targets: { medium: "target-model" },
				},
			},
		});
		assert.equal(codexResult.ok, false);
		assert.ok(
			codexResult.errors.includes('config.effortRouting.gpt-5.6-sol collides with non-Antigravity model "gpt-5.6-sol"'),
		);

		const openCodeZenResult = validateConfig({
			...baseValidConfig,
			effortRouting: {
				"big-pickle": {
					targets: { medium: "target-model" },
				},
			},
		});
		assert.equal(openCodeZenResult.ok, false);
		assert.ok(
			openCodeZenResult.errors.includes('config.effortRouting.big-pickle collides with non-Antigravity model "big-pickle"'),
		);

		const ollamaResult = validateConfig({
			...baseValidConfig,
			effortRouting: {
				"gemma4:31b": {
					targets: { medium: "target-model" },
				},
			},
		});
		assert.equal(ollamaResult.ok, false);
		assert.ok(
			ollamaResult.errors.includes('config.effortRouting.gemma4:31b collides with non-Antigravity model "gemma4:31b"'),
		);
	});

	it("rejects statically known non-Google model collisions on target name", () => {
		const result = validateConfig({
			...baseValidConfig,
			effortRouting: {
				"gemini-3.8-flash": {
					targets: {
						low: "gpt-5.6-terra",
						medium: "gemini-3.8-flash-medium",
					},
				},
			},
		});
		assert.equal(result.ok, false);
		assert.ok(
			result.errors.includes('config.effortRouting.gemini-3.8-flash collides with non-Antigravity model "gpt-5.6-terra"'),
		);
	});
});

describe("applyConfigDefaults plumbing", () => {
	it("carries modelSpecs, modelAliases, effortRouting, and TypeSafe routing through defaults", () => {
		const initial = {
			proxyPort: 51200,
			accounts: [],
			modelSpecs: {
				"custom-model": { maxOutputTokens: 2048, thinkingBudget: -1, isThinking: true },
			},
			modelAliases: {
				"my-alias": "upstream-model",
			},
			effortRouting: {
				"gemini-3.8-flash": {
					defaultEffort: "medium",
					targets: {
						medium: "gemini-3.8-flash-medium",
					},
				},
			},
			typesafeRouting: {
				enabled: true,
				apiKey: "typesafe-key",
				shadowMode: true,
			},
		};

		const withDefaults = applyConfigDefaults(initial as any);
		assert.deepEqual(withDefaults.modelSpecs, initial.modelSpecs);
		assert.deepEqual(withDefaults.modelAliases, initial.modelAliases);
		assert.deepEqual(withDefaults.effortRouting, initial.effortRouting);
		assert.equal(withDefaults.typesafeRouting?.shadowMode, true);
		assert.equal(
			applyConfigDefaults({
				proxyPort: 51200,
				accounts: [],
				typesafeRouting: { enabled: true, apiKey: "typesafe-key" },
			} as any).typesafeRouting?.shadowMode,
			false,
		);
	});

	it("preserves modelSpecs, modelAliases, and effortRouting through rotator.getConfig() and persistence round-trip", async () => {
		await initDb();
		try {
			const config = {
				proxyPort: 51200,
				accounts: [{ email: "test@example.com", refreshToken: "tok", projectId: "pid" }],
				modelSpecs: {
					"custom-model": { maxOutputTokens: 2048, thinkingBudget: -1, isThinking: true },
				},
				modelAliases: {
					"my-alias": "upstream-model",
				},
				effortRouting: {
					"gemini-3.8-flash": {
						defaultEffort: "medium",
						targets: {
							medium: "gemini-3.8-flash-medium",
						},
					},
				},
			};

			const rotator = new AccountRotator(config as any);
			rotator.stopQuotaPolling();
			const retrieved = rotator.getConfig();
			assert.deepEqual(retrieved.modelSpecs, config.modelSpecs);
			assert.deepEqual(retrieved.modelAliases, config.modelAliases);
			assert.deepEqual(retrieved.effortRouting, config.effortRouting);

			await setCachedConfig(config as any);
			const loaded = getCachedConfig();
			assert.ok(loaded);
			assert.deepEqual(loaded.modelSpecs, config.modelSpecs);
			assert.deepEqual(loaded.modelAliases, config.modelAliases);
			assert.deepEqual(loaded.effortRouting, config.effortRouting);
		} finally {
			await closeDb();
		}
	});
});
