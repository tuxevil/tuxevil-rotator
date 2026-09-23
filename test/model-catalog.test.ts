import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { serveGeminiModels, serveOpenAIModels } from "../src/compat.js";
import { serveModelsApi } from "../src/dashboard.js";
import { getModelSpec, setModelSpecsOverride } from "../src/compat/model-specs.js";
import { dynamicCatalog } from "../src/providers/google-antigravity/dynamic-catalog.js";
import { setEffortRoutingOverride } from "../src/types.js";
import { logger } from "../src/logger.js";

function captureJson(render: (res: never) => void): unknown {
	let raw = "";
	render({
		writeHead() {},
		end(chunk: string) {
			raw += chunk;
		},
	} as never);
	return JSON.parse(raw);
}

describe("model discovery", () => {
	it("hides provider catalogs without active credentials", () => {
		const payload = captureJson((res) =>
			serveOpenAIModels(res, {
				hasActiveProvider: () => false,
				getOllamaModels: () => [],
			} as never),
		) as { data: Array<{ id: string; owned_by: string }> };

		assert.ok(payload.data.some((model) => model.owned_by === "tuxevil-rotator"));
		assert.ok(!payload.data.some((model) => model.owned_by === "openai-codex"));
		assert.ok(!payload.data.some((model) => model.owned_by === "ollama"));
	});

	it("includes only active provider catalogs", () => {
		const payload = captureJson((res) =>
			serveOpenAIModels(res, {
				hasActiveProvider: (providerId: string) =>
					providerId === "openai-codex" || providerId === "ollama",
				getOllamaModels: () => ["gemma4:31b"],
			} as never),
		) as { data: Array<{ id: string; owned_by: string }> };

		assert.ok(payload.data.some((model) => model.owned_by === "openai-codex"));
		assert.ok(payload.data.some((model) => model.id === "gpt-5.6-sol" && model.owned_by === "openai-codex"));
		for (const modelId of ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]) {
			assert.ok(payload.data.some((model) => model.id === modelId && model.owned_by === "openai-codex"));
		}
		assert.ok(payload.data.some((model) => model.id === "gemma4:31b" && model.owned_by === "ollama"));
	});

	it("exposes rich metadata in /v1/models", () => {
		const payload = captureJson(serveOpenAIModels) as { data: Array<{ meta: Record<string, unknown> }> };
		assert.ok(payload.data.length > 0);
		assert.equal(payload.data[0].meta.tool_calling, true);
		assert.ok("quota_pool" in payload.data[0].meta);
	});

	it("exposes gemini-compatible model listings", () => {
		const payload = captureJson(serveGeminiModels) as { models: Array<{ supportedGenerationMethods: string[] }> };
		assert.ok(payload.models.length > 0);
		assert.deepEqual(payload.models[0].supportedGenerationMethods, ["generateContent", "streamGenerateContent"]);
	});

	it("exposes gemini-3.7-flash-tiered exactly once in /v1/models with expected metadata", () => {
		const payload = captureJson(serveOpenAIModels) as {
			data: Array<{
				id: string;
				owned_by: string;
				context_window: number;
				meta: Record<string, unknown>;
			}>;
		};
		const entries = payload.data.filter((m) => m.id === "gemini-3.7-flash-tiered");
		assert.equal(entries.length, 1);
		const entry = entries[0];
		assert.equal(entry.owned_by, "tuxevil-rotator");
		assert.equal(entry.context_window, 1048576);
		assert.equal(entry.meta.family, "gemini-3.7-flash");
		assert.equal(entry.meta.quota_pool, "gemini");
		assert.equal(entry.meta.multimodal, true);
		assert.equal(entry.meta.tool_calling, true);
	});

	it("exposes gemini-3.7-flash-tiered exactly once in the gemini catalog with expected metadata", () => {
		const payload = captureJson(serveGeminiModels) as {
			models: Array<{
				name: string;
				baseModelId: string;
				inputTokenLimit: number;
				capabilities: { tools: boolean; multimodal: boolean; quotaPool: string };
			}>;
		};
		const entries = payload.models.filter((m) => m.name === "models/gemini-3.7-flash-tiered");
		assert.equal(entries.length, 1);
		const entry = entries[0];
		assert.equal(entry.baseModelId, "gemini-3.7-flash");
		assert.equal(entry.inputTokenLimit, 1048576);
		assert.equal(entry.capabilities.tools, true);
		assert.equal(entry.capabilities.multimodal, true);
		assert.equal(entry.capabilities.quotaPool, "gemini");
	});

	it("creates no virtual gemini-3.7-flash low/medium/high catalog entries", () => {
		const openAiPayload = captureJson(serveOpenAIModels) as {
			data: Array<{ id: string }>;
		};
		const geminiPayload = captureJson(serveGeminiModels) as {
			models: Array<{ name: string }>;
		};
		for (const variant of ["low", "medium", "high"]) {
			const id = `gemini-3.7-flash-${variant}`;
			assert.ok(!openAiPayload.data.some((m) => m.id === id));
			assert.ok(!geminiPayload.models.some((m) => m.name === `models/${id}`));
		}
	});

	it("exposes all three native gemini-3.8-flash ids with expected metadata", () => {
		const openAiPayload = captureJson(serveOpenAIModels) as {
			data: Array<{
				id: string;
				owned_by: string;
				context_window: number;
				meta: Record<string, unknown>;
			}>;
		};
		const geminiPayload = captureJson(serveGeminiModels) as {
			models: Array<{ name: string; baseModelId: string; inputTokenLimit: number }>;
		};

		for (const variant of ["low", "medium", "high"]) {
			const id = `gemini-3.8-flash-${variant}`;
			const openAiEntries = openAiPayload.data.filter((model) => model.id === id);
			assert.equal(openAiEntries.length, 1);
			assert.equal(openAiEntries[0].owned_by, "tuxevil-rotator");
			assert.equal(openAiEntries[0].context_window, 1048576);
			assert.equal(openAiEntries[0].meta.family, "gemini-3.8-flash");
			assert.equal(openAiEntries[0].meta.quota_pool, "gemini");

			const geminiEntries = geminiPayload.models.filter(
				(model) => model.name === `models/${id}`,
			);
			assert.equal(geminiEntries.length, 1);
			assert.equal(geminiEntries[0].baseModelId, "gemini-3.8-flash");
			assert.equal(geminiEntries[0].inputTokenLimit, 1048576);
		}
	});

	it("does not advertise unsupported bare or tiered gemini-3.8-flash ids", () => {
		const payload = captureJson(serveOpenAIModels) as {
			data: Array<{ id: string }>;
		};
		for (const id of ["gemini-3.8-flash", "gemini-3.8-flash-tiered"]) {
			assert.ok(!payload.data.some((model) => model.id === id));
		}
	});

	it("does not advertise retired gemini-3.5-flash ids", () => {
		dynamicCatalog.updateFromEndpointResponse({
			models: {
				"Gemini-3.5-Flash-High": { quotaInfo: { remainingFraction: 1 } },
			},
		});
		try {
			const payload = captureJson(serveOpenAIModels) as {
				data: Array<{ id: string }>;
			};
			assert.ok(
				!payload.data.some((model) =>
					model.id.toLowerCase().startsWith("gemini-3.5-") &&
					model.id.toLowerCase() !== "gemini-3.5-flash-lite",
				),
			);
			assert.deepEqual(dynamicCatalog.getAllModels(), []);
		} finally {
			dynamicCatalog.reset();
		}
	});

	it("publishes dynamic output and thinking metadata without using the context window as output", () => {
		dynamicCatalog.updateFromEndpointResponse({
			models: {
				"gemini-4.0-flash-thinking": {
					maxTokens: 2_000_000,
					maxOutputTokens: 32_000,
					supportsThinking: true,
					thinkingBudget: 12_000,
					minThinkingBudget: 2_000,
					quotaInfo: { remainingFraction: 1 },
				},
			},
		});
		try {
			const openAiPayload = captureJson(serveOpenAIModels) as {
				data: Array<{ id: string; meta: Record<string, unknown> }>;
			};
			const openAiEntry = openAiPayload.data.find(
				(model) => model.id === "gemini-4.0-flash-thinking",
			);
			assert.ok(openAiEntry);
			assert.equal(openAiEntry.meta.max_output_tokens, 32_000);
			assert.equal(openAiEntry.meta.thinking, true);
			assert.equal(openAiEntry.meta.thinking_budget, 12_000);
			assert.equal(openAiEntry.meta.min_thinking_budget, 2_000);

			const geminiPayload = captureJson(serveGeminiModels) as {
				models: Array<{
					name: string;
					inputTokenLimit: number;
					outputTokenLimit: number;
					capabilities: Record<string, unknown>;
				}>;
			};
			const geminiEntry = geminiPayload.models.find(
				(model) => model.name === "models/gemini-4.0-flash-thinking",
			);
			assert.ok(geminiEntry);
			assert.equal(geminiEntry.inputTokenLimit, 2_000_000);
			assert.equal(geminiEntry.outputTokenLimit, 32_000);
			assert.equal(geminiEntry.capabilities.thinking, true);
			assert.equal(geminiEntry.capabilities.thinkingBudget, 12_000);
			assert.equal(geminiEntry.capabilities.minThinkingBudget, 2_000);
		} finally {
			dynamicCatalog.reset();
		}
	});

	it("publishes operator-overridden effective specs for dynamic models", () => {
		dynamicCatalog.updateFromEndpointResponse({
			models: {
				"gemini-4.0-operator-model": {
					maxTokens: 2_000_000,
					maxOutputTokens: 32_000,
					supportsThinking: false,
					quotaInfo: { remainingFraction: 1 },
				},
			},
		});
		setModelSpecsOverride({
			"gemini-4.0": {
				maxOutputTokens: 7000,
				thinkingBudget: 2000,
				minThinkingBudget: 1000,
				isThinking: true,
				contextWindow: 300_000,
			},
		});

		try {
			const openAiPayload = captureJson(serveOpenAIModels) as {
				data: Array<{
					id: string;
					context_window: number;
					meta: Record<string, unknown>;
				}>;
			};
			const openAiEntry = openAiPayload.data.find(
				(model) => model.id === "gemini-4.0-operator-model",
			);
			assert.ok(openAiEntry);
			assert.equal(openAiEntry.context_window, 300_000);
			assert.equal(openAiEntry.meta.max_output_tokens, 7000);
			assert.equal(openAiEntry.meta.thinking, true);
			assert.equal(openAiEntry.meta.thinking_budget, 2000);
			assert.equal(openAiEntry.meta.min_thinking_budget, 1000);

			const geminiPayload = captureJson(serveGeminiModels) as {
				models: Array<{
					name: string;
					inputTokenLimit: number;
					outputTokenLimit: number;
					capabilities: Record<string, unknown>;
				}>;
			};
			const geminiEntry = geminiPayload.models.find(
				(model) => model.name === "models/gemini-4.0-operator-model",
			);
			assert.ok(geminiEntry);
			assert.equal(geminiEntry.inputTokenLimit, 300_000);
			assert.equal(geminiEntry.outputTokenLimit, 7000);
			assert.equal(geminiEntry.capabilities.thinking, true);
			assert.equal(geminiEntry.capabilities.thinkingBudget, 2000);
			assert.equal(geminiEntry.capabilities.minThinkingBudget, 1000);
		} finally {
			setModelSpecsOverride(null);
			dynamicCatalog.reset();
		}
	});

	it("ships the exact default spec for gemini-3.7-flash-tiered", () => {
		assert.deepEqual(getModelSpec("gemini-3.7-flash-tiered"), {
			maxOutputTokens: 65536,
			thinkingBudget: -1,
			isThinking: true,
			contextWindow: 1_000_000,
		});
	});

	it("ships adaptive specs for native gemini-3.8-flash reasoning levels", () => {
		for (const variant of ["low", "medium", "high"]) {
			assert.deepEqual(getModelSpec(`gemini-3.8-flash-${variant}`), {
				maxOutputTokens: 65536,
				thinkingBudget: -1,
				isThinking: true,
				contextWindow: 1_000_000,
			});
		}
	});
});

describe("effort routing catalog swap", () => {
	afterEach(() => {
		setEffortRoutingOverride(null);
		dynamicCatalog.reset();
	});

	it("swaps targets only in /v1/models while /v1beta/models retains concrete models", () => {
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

		const openAiPayload = captureJson(serveOpenAIModels) as {
			data: Array<{
				id: string;
				owned_by: string;
				context_window: number;
				meta: Record<string, unknown>;
			}>;
		};

		const aliasEntries = openAiPayload.data.filter((m) => m.id === "gemini-3.8-flash");
		assert.equal(aliasEntries.length, 1);
		assert.equal(aliasEntries[0].owned_by, "tuxevil-rotator");
		assert.equal(aliasEntries[0].context_window, 1048576);
		assert.equal(aliasEntries[0].meta.family, "gemini-3.8-flash");
		assert.equal(aliasEntries[0].meta.quota_pool, "gemini");

		for (const target of ["gemini-3.8-flash-low", "gemini-3.8-flash-medium", "gemini-3.8-flash-high"]) {
			assert.ok(!openAiPayload.data.some((m) => m.id === target), `Target ${target} should be hidden`);
		}

		const geminiPayload = captureJson(serveGeminiModels) as {
			models: Array<{ name: string; baseModelId: string; inputTokenLimit: number }>;
		};
		const geminiAliasEntries = geminiPayload.models.filter(
			(m) => m.name === "models/gemini-3.8-flash",
		);
		assert.equal(geminiAliasEntries.length, 0);

		for (const target of ["gemini-3.8-flash-low", "gemini-3.8-flash-medium", "gemini-3.8-flash-high"]) {
			assert.ok(geminiPayload.models.some((m) => m.name === `models/${target}`));
		}

		const dashboardPayload = captureJson((res) =>
			serveModelsApi(res, { hasActiveProvider: () => false } as never),
		) as { data: Array<{ id: string }> };
		assert.equal(
			dashboardPayload.data.filter((model) => model.id === "gemini-3.8-flash").length,
			1,
		);
		assert.ok(
			!["gemini-3.8-flash-low", "gemini-3.8-flash-medium", "gemini-3.8-flash-high"]
				.some((target) => dashboardPayload.data.some((model) => model.id === target)),
		);
	});

	it("inherits the complete dynamic default-target metadata", () => {
		dynamicCatalog.updateFromEndpointResponse({
			models: {
				"gemini-4.0-effort-medium": {
					maxTokens: 2_000_000,
					maxOutputTokens: 32_000,
					supportsThinking: true,
					thinkingBudget: 12_000,
					minThinkingBudget: 2_000,
					quotaInfo: { remainingFraction: 1 },
				},
			},
		});
		setEffortRoutingOverride({
			"gemini-4.0-effort": {
				defaultEffort: "medium",
				targets: { medium: "gemini-4.0-effort-medium" },
			},
		});

		const openAiPayload = captureJson(serveOpenAIModels) as {
			data: Array<{
				id: string;
				context_window: number;
				meta: Record<string, unknown>;
			}>;
		};
		const openAiAlias = openAiPayload.data.find(
			(model) => model.id === "gemini-4.0-effort",
		);
		assert.ok(openAiAlias);
		assert.equal(openAiAlias.context_window, 2_000_000);
		assert.equal(openAiAlias.meta.max_output_tokens, 32_000);
		assert.equal(openAiAlias.meta.thinking, true);
		assert.equal(openAiAlias.meta.thinking_budget, 12_000);
		assert.equal(openAiAlias.meta.min_thinking_budget, 2_000);

		const geminiPayload = captureJson(serveGeminiModels) as {
			models: Array<{
				name: string;
				inputTokenLimit: number;
				outputTokenLimit: number;
				capabilities: Record<string, unknown>;
			}>;
		};
		assert.ok(!geminiPayload.models.some(
			(model) => model.name === "models/gemini-4.0-effort",
		));
		const geminiTarget = geminiPayload.models.find(
			(model) => model.name === "models/gemini-4.0-effort-medium",
		);
		assert.ok(geminiTarget);
		assert.equal(geminiTarget.inputTokenLimit, 2_000_000);
		assert.equal(geminiTarget.outputTokenLimit, 32_000);
		assert.equal(geminiTarget.capabilities.thinkingBudget, 12_000);
		assert.equal(geminiTarget.capabilities.minThinkingBudget, 2_000);
	});

	it("keeps unmapped variants visible when only partial targets are configured", () => {
		setEffortRoutingOverride({
			"gemini-3.8-flash": {
				defaultEffort: "high",
				targets: {
					low: "gemini-3.8-flash-low",
					high: "gemini-3.8-flash-high",
				},
			},
		});

		const openAiPayload = captureJson(serveOpenAIModels) as {
			data: Array<{ id: string }>;
		};

		assert.ok(openAiPayload.data.some((m) => m.id === "gemini-3.8-flash"));
		assert.ok(!openAiPayload.data.some((m) => m.id === "gemini-3.8-flash-low"));
		assert.ok(!openAiPayload.data.some((m) => m.id === "gemini-3.8-flash-high"));
		assert.ok(openAiPayload.data.some((m) => m.id === "gemini-3.8-flash-medium"));
	});

	it("fails soft when default target is absent (alias not added, targets not hidden)", () => {
		setEffortRoutingOverride({
			"my-custom-alias": {
				defaultEffort: "medium",
				targets: {
					medium: "nonexistent-model-id",
					low: "gemini-3.8-flash-low",
				},
			},
		});

		const originalLog = logger.log;
		const warnings: string[] = [];
		logger.log = (level, scope, message) => {
			if (level === "warn" && scope === "compat") warnings.push(String(message));
		};
		let openAiPayload: { data: Array<{ id: string }> };
		try {
			openAiPayload = captureJson(serveOpenAIModels) as {
				data: Array<{ id: string }>;
			};
		} finally {
			logger.log = originalLog;
		}

		assert.ok(!openAiPayload.data.some((m) => m.id === "my-custom-alias"));
		assert.ok(openAiPayload.data.some((m) => m.id === "gemini-3.8-flash-low"));
		assert.ok(
			warnings.some(
				(message) =>
					message.includes("my-custom-alias") &&
					message.includes("nonexistent-model-id") &&
					message.includes("absent from catalog"),
			),
		);

		dynamicCatalog.updateFromEndpointResponse({
			models: {
				"nonexistent-model-id": { quotaInfo: { remainingFraction: 1 } },
			},
		});
		const activatedPayload = captureJson(serveOpenAIModels) as {
			data: Array<{ id: string }>;
		};
		assert.ok(activatedPayload.data.some((model) => model.id === "my-custom-alias"));
		assert.ok(
			!activatedPayload.data.some((model) => model.id === "nonexistent-model-id"),
		);
		assert.ok(
			!activatedPayload.data.some((model) => model.id === "gemini-3.8-flash-low"),
		);
	});

	it("replaces colliding static and dynamic catalog entries with the configured aliases", () => {
		dynamicCatalog.updateFromEndpointResponse({
			models: {
				"gemini-dynamic-alias": { quotaInfo: { remainingFraction: 1 } },
				"gemini-4.0-default": {
					maxTokens: 345_678,
					quotaInfo: { remainingFraction: 1 },
				},
			},
		});
		setEffortRoutingOverride({
			"gemini-3.8-flash-high": {
				defaultEffort: "medium",
				targets: { medium: "gemini-4.0-default" },
			},
			"gemini-dynamic-alias": {
				defaultEffort: "medium",
				targets: { medium: "gemini-4.0-default" },
			},
		});

		const payload = captureJson(serveOpenAIModels) as {
			data: Array<{ id: string; context_window: number }>;
		};
		for (const alias of ["gemini-3.8-flash-high", "gemini-dynamic-alias"]) {
			const matches = payload.data.filter((model) => model.id === alias);
			assert.equal(matches.length, 1);
			assert.equal(matches[0].context_window, 345_678);
		}
	});

	it("hides dynamically discovered targets as well", () => {
		dynamicCatalog.updateFromEndpointResponse({
			models: {
				"gemini-3.8-flash-dynamic-target": {
					quotaInfo: { remainingFraction: 1 },
					displayName: "Gemini 3.8 Flash Dynamic",
				},
			},
		});

		setEffortRoutingOverride({
			"gemini-3.8-flash": {
				defaultEffort: "medium",
				targets: {
					medium: "gemini-3.8-flash-medium",
					custom: "gemini-3.8-flash-dynamic-target",
				},
			},
		});

		const openAiPayload = captureJson(serveOpenAIModels) as {
			data: Array<{ id: string }>;
		};

		assert.ok(openAiPayload.data.some((m) => m.id === "gemini-3.8-flash"));
		assert.ok(!openAiPayload.data.some((m) => m.id === "gemini-3.8-flash-dynamic-target"));
	});
});
