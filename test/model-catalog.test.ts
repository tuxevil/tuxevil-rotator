import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { serveGeminiModels, serveOpenAIModels } from "../src/compat.js";
import { getModelSpec } from "../src/compat/model-specs.js";

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

	it("ships the exact default spec for gemini-3.7-flash-tiered", () => {
		assert.deepEqual(getModelSpec("gemini-3.7-flash-tiered"), {
			maxOutputTokens: 65536,
			thinkingBudget: -1,
			isThinking: true,
		});
	});
});
