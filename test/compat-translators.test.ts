import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import {
	openAIToAntigravityBody,
	anthropicToAntigravityBody,
	normalizeOpenAIChatCompletionRequest,
	normalizeOpenAIResponsesRequest,
	convertResponsesToChatRequest,
	mapTieredReasoningEffortToThinkingLevel,
} from "../src/providers/google-antigravity/translators.js";
import { setModelSpecsOverride } from "../src/compat/model-specs.js";
import { dynamicCatalog } from "../src/providers/google-antigravity/dynamic-catalog.js";
import {
	ANTIGRAVITY_IDENTITY_PROMPT,
	setEffortRoutingOverride,
	setModelAliasesOverride,
} from "../src/types.js";

type AntigravityBodyWithRequest = ReturnType<typeof openAIToAntigravityBody> & {
	request: {
		systemInstruction?: unknown;
		contents?: unknown;
		generationConfig?: {
			maxOutputTokens?: number;
			thinkingConfig?: Record<string, unknown>;
		};
	};
};

describe("translators component", () => {
	it("normalizes OpenAI Responses prompt into input", () => {
		const normalized = normalizeOpenAIResponsesRequest({
			model: "gemini-3.8-flash-high",
			prompt: "ping",
		}) as { input: unknown };
		assert.equal(normalized.input, "ping");
	});

	it("converts OpenAI messages into Antigravity request body", () => {
		const body = openAIToAntigravityBody({
			model: "claude-sonnet-4-6",
			messages: [
				{ role: "system", content: "be terse" },
				{ role: "user", content: "ping" },
			],
		}) as AntigravityBodyWithRequest;
		assert.equal(body.model, "claude-sonnet-4-6");
		assert.equal(body.project, "compat-placeholder");
		assert.equal(body.userAgent, "antigravity");
		assert.equal(body.requestType, "agent");
		assert.deepEqual(body.request.systemInstruction, {
			role: "system",
			parts: [{ text: `${ANTIGRAVITY_IDENTITY_PROMPT}\n\nbe terse` }],
		});
		assert.deepEqual(body.request.contents, [
			{ role: "user", parts: [{ text: "<USER_REQUEST>\nping\n</USER_REQUEST>" }] },
		]);
	});

	it("converts Anthropic messages into Antigravity request body", () => {
		const body = anthropicToAntigravityBody({
			model: "claude-sonnet-4-6",
			system: "be polite",
			messages: [
				{ role: "user", content: "hello" },
			],
		}) as AntigravityBodyWithRequest;
		assert.equal(body.model, "claude-sonnet-4-6");
		assert.deepEqual(body.request.systemInstruction, {
			role: "system",
			parts: [{ text: `${ANTIGRAVITY_IDENTITY_PROMPT}\n\nbe polite` }],
		});
		assert.deepEqual(body.request.contents, [
			{ role: "user", parts: [{ text: "<USER_REQUEST>\nhello\n</USER_REQUEST>" }] },
		]);
	});

	it("normalizes loose non-array messages into OpenAI chat messages", () => {
		const normalized = normalizeOpenAIChatCompletionRequest({
			model: "gemini-3.8-flash-high",
			messages: { role: "user", content: [{ type: "input_text", text: "hola" }] },
		}) as { messages: unknown[] };
		assert.deepEqual(normalized.messages, [
			{ role: "user", content: [{ type: "text", text: "hola" }] },
		]);
	});
});

describe("gemini-3.8-flash native reasoning levels", () => {
	it("keeps low/medium/high model ids unchanged and thinking adaptive", () => {
		for (const variant of ["low", "medium", "high"]) {
			const id = `gemini-3.8-flash-${variant}`;
			const body = openAIToAntigravityBody({
				model: id,
				messages: [{ role: "user", content: "ping" }],
				reasoning_effort: "high",
			}) as AntigravityBodyWithRequest;
			assert.equal(body.model, id);
			assert.deepEqual(body.request.generationConfig?.thinkingConfig, {
				includeThoughts: true,
			});
		}
	});

	it("protects adaptive thinking models against low max_tokens exhaustion", () => {
		for (const variant of ["low", "medium", "high"]) {
			const id = `gemini-3.8-flash-${variant}`;
			const body = openAIToAntigravityBody({
				model: id,
				messages: [{ role: "user", content: "ping" }],
				max_tokens: 500,
			}) as AntigravityBodyWithRequest;
			// With max_tokens: 500, maxOutputTokens must be elevated with headroom (500 + 8192 = 8692)
			// so thinking tokens do not exhaust the response.
			assert.equal(body.request.generationConfig?.maxOutputTokens, 8692);
			assert.deepEqual(body.request.generationConfig?.thinkingConfig, {
				includeThoughts: true,
			});
		}
	});

	it("leaves maxOutputTokens unset when max_tokens is not provided", () => {
		const body = openAIToAntigravityBody({
			model: "gemini-3.8-flash-high",
			messages: [{ role: "user", content: "ping" }],
		}) as AntigravityBodyWithRequest;
		assert.equal(body.request.generationConfig?.maxOutputTokens, undefined);
	});
});

describe("gemini-3.7-flash-tiered thinkingLevel mapping", () => {
	afterEach(() => {
		setModelSpecsOverride(null);
	});

	it("maps low/medium/high reasoning_effort to thinkingLevel for the exact tiered model", () => {
		const cases: Array<[string, string]> = [
			["low", "LOW"],
			["medium", "MEDIUM"],
			["high", "HIGH"],
		];
		for (const [effort, level] of cases) {
			const body = openAIToAntigravityBody({
				model: "gemini-3.7-flash-tiered",
				messages: [{ role: "user", content: "ping" }],
				reasoning_effort: effort,
			}) as AntigravityBodyWithRequest;
			assert.deepEqual(body.request.generationConfig?.thinkingConfig, {
				includeThoughts: true,
				thinkingLevel: level,
			});
		}
	});

	it("matches the canonical model id case-insensitively", () => {
		const body = openAIToAntigravityBody({
			model: "Gemini-3.7-Flash-Tiered",
			messages: [{ role: "user", content: "ping" }],
			reasoning_effort: "HIGH",
		}) as AntigravityBodyWithRequest;
		assert.deepEqual(body.request.generationConfig?.thinkingConfig, {
			includeThoughts: true,
			thinkingLevel: "HIGH",
		});
	});

	it("emits adaptive includeThoughts only when no effort is supplied", () => {
		const body = openAIToAntigravityBody({
			model: "gemini-3.7-flash-tiered",
			messages: [{ role: "user", content: "ping" }],
		}) as AntigravityBodyWithRequest;
		assert.deepEqual(body.request.generationConfig?.thinkingConfig, {
			includeThoughts: true,
		});
	});

	it("does not emit thinkingLevel for virtual tiered siblings", () => {
		for (const model of [
			"gemini-3.7-flash-tiered-high",
			"gemini-3.7-flash-tiered-medium",
			"gemini-3.7-flash-tiered-low",
		]) {
			const body = openAIToAntigravityBody({
				model,
				messages: [{ role: "user", content: "ping" }],
				reasoning_effort: "high",
			}) as AntigravityBodyWithRequest;
			const tc = body.request.generationConfig?.thinkingConfig;
			assert.equal(tc?.thinkingLevel, undefined);
			assert.equal(tc?.thinkingBudget, undefined);
			assert.equal(tc?.includeThoughts, true);
		}
	});

	it("ignores unsupported effort values without emitting an invalid enum", () => {
		for (const effort of ["minimal", "none", "Fast", "MINIMAL", "", undefined]) {
			const body = openAIToAntigravityBody({
				model: "gemini-3.7-flash-tiered",
				messages: [{ role: "user", content: "ping" }],
				...(effort !== undefined ? { reasoning_effort: effort } : {}),
			}) as AntigravityBodyWithRequest;
			assert.deepEqual(body.request.generationConfig?.thinkingConfig, {
				includeThoughts: true,
			});
		}
	});

	it("keeps gemini-3.6-flash-high on fixed thinkingBudget 10000 with no thinkingLevel", () => {
		const body = openAIToAntigravityBody({
			model: "gemini-3.6-flash-high",
			messages: [{ role: "user", content: "ping" }],
			reasoning_effort: "high",
		}) as AntigravityBodyWithRequest;
		const tc = body.request.generationConfig?.thinkingConfig;
		assert.equal(tc?.thinkingBudget, 10000);
		assert.equal(tc?.thinkingLevel, undefined);
	});

	it("does not change other models' effort handling", () => {
		const body = openAIToAntigravityBody({
			model: "gemini-3.6-flash-high",
			messages: [{ role: "user", content: "ping" }],
			reasoning_effort: "high",
		}) as AntigravityBodyWithRequest;
		const tc = body.request.generationConfig?.thinkingConfig;
		assert.equal(tc?.thinkingLevel, undefined);
		assert.equal(tc?.thinkingBudget, 10000);
	});

	it("keeps Anthropic requests on the tiered model adaptive without a thinkingLevel", () => {
		const body = anthropicToAntigravityBody({
			model: "gemini-3.7-flash-tiered",
			system: "be terse",
			messages: [{ role: "user", content: "ping" }],
		}) as AntigravityBodyWithRequest;
		const tc = body.request.generationConfig?.thinkingConfig;
		// deepStrictEqual requires the exact key set: a thinkingLevel or
		// thinkingBudget key present would fail this assertion.
		assert.deepEqual(tc, { includeThoughts: true });
	});

	it("prefers a fixed operator thinkingBudget override over reasoning_effort", () => {
		setModelSpecsOverride({
			"gemini-3.7-flash-tiered": {
				maxOutputTokens: 65536,
				thinkingBudget: 7777,
				isThinking: true,
			},
		});
		const body = openAIToAntigravityBody({
			model: "gemini-3.7-flash-tiered",
			messages: [{ role: "user", content: "ping" }],
			reasoning_effort: "high",
		}) as AntigravityBodyWithRequest;
		const tc = body.request.generationConfig?.thinkingConfig;
		assert.equal(tc?.thinkingBudget, 7777);
		assert.equal(tc?.thinkingLevel, undefined);
		assert.equal(tc?.includeThoughts, true);
	});

	it("restores effort mapping once the fixed override is cleared", () => {
		setModelSpecsOverride({
			"gemini-3.7-flash-tiered": {
				maxOutputTokens: 65536,
				thinkingBudget: 7777,
				isThinking: true,
			},
		});
		setModelSpecsOverride(null);
		const body = openAIToAntigravityBody({
			model: "gemini-3.7-flash-tiered",
			messages: [{ role: "user", content: "ping" }],
			reasoning_effort: "high",
		}) as AntigravityBodyWithRequest;
		assert.deepEqual(body.request.generationConfig?.thinkingConfig, {
			includeThoughts: true,
			thinkingLevel: "HIGH",
		});
	});
});

describe("mapTieredReasoningEffortToThinkingLevel", () => {
	it("maps only the exact canonical id and only low/medium/high", () => {
		assert.equal(
			mapTieredReasoningEffortToThinkingLevel("low", "gemini-3.7-flash-tiered"),
			"LOW",
		);
		assert.equal(
			mapTieredReasoningEffortToThinkingLevel("MEDIUM", "GEMINI-3.7-FLASH-TIERED"),
			"MEDIUM",
		);
		assert.equal(
			mapTieredReasoningEffortToThinkingLevel("high", "gemini-3.7-flash-tiered"),
			"HIGH",
		);
		assert.equal(
			mapTieredReasoningEffortToThinkingLevel("high", "gemini-3.7-flash-tiered-high"),
			undefined,
		);
		assert.equal(
			mapTieredReasoningEffortToThinkingLevel("minimal", "gemini-3.7-flash-tiered"),
			undefined,
		);
		assert.equal(
			mapTieredReasoningEffortToThinkingLevel(undefined, "gemini-3.7-flash-tiered"),
			undefined,
		);
		assert.equal(
			mapTieredReasoningEffortToThinkingLevel("high", "gemini-3.7-flash-high"),
			undefined,
		);
		assert.equal(
			mapTieredReasoningEffortToThinkingLevel("high", "gemini-3.6-flash-tiered"),
			undefined,
		);
		assert.equal(
			mapTieredReasoningEffortToThinkingLevel("high", "gemini-3.6-flash-high"),
			undefined,
		);
	});
});

describe("dynamic thinking constraints", () => {
	afterEach(() => {
		dynamicCatalog.reset();
	});

	it("honors explicit supportsThinking=false across compatibility protocols", () => {
		dynamicCatalog.updateFromEndpointResponse({
			models: {
				"gemini-4.0-fast": {
					supportsThinking: false,
					quotaInfo: { remainingFraction: 1 },
				},
			},
		});

		const requests = [
			openAIToAntigravityBody({
				model: "gemini-4.0-fast",
				messages: [{ role: "user", content: "ping" }],
				reasoning_effort: "high",
			}),
			openAIToAntigravityBody(convertResponsesToChatRequest({
				model: "gemini-4.0-fast",
				input: "ping",
				reasoning: { effort: "high" },
			}).chatRequest),
			anthropicToAntigravityBody({
				model: "gemini-4.0-fast",
				messages: [{ role: "user", content: "ping" }],
			}),
		] as AntigravityBodyWithRequest[];

		for (const request of requests) {
			assert.equal(request.request.generationConfig?.thinkingConfig, undefined);
		}
	});

	it("honors minThinkingBudget consistently across compatibility protocols", () => {
		dynamicCatalog.updateFromEndpointResponse({
			models: {
				"gemini-4.0-min-budget": {
					maxOutputTokens: 12_000,
					supportsThinking: true,
					thinkingBudget: 1_000,
					minThinkingBudget: 4_000,
					quotaInfo: { remainingFraction: 1 },
				},
			},
		});

		const requests = [
			openAIToAntigravityBody({
				model: "gemini-4.0-min-budget",
				messages: [{ role: "user", content: "ping" }],
				max_tokens: 3_000,
			}),
			openAIToAntigravityBody(convertResponsesToChatRequest({
				model: "gemini-4.0-min-budget",
				input: "ping",
				max_output_tokens: 3_000,
			}).chatRequest),
			anthropicToAntigravityBody({
				model: "gemini-4.0-min-budget",
				messages: [{ role: "user", content: "ping" }],
				max_tokens: 3_000,
			}),
		] as AntigravityBodyWithRequest[];

		for (const request of requests) {
			assert.equal(
				request.request.generationConfig?.thinkingConfig?.thinkingBudget,
				4_000,
			);
			assert.equal(request.request.generationConfig?.maxOutputTokens, 12_000);
		}
	});

	it("never emits a fixed thinking budget that consumes all output tokens", () => {
		dynamicCatalog.updateFromEndpointResponse({
			models: {
				"gemini-4.0-tight-output": {
					maxOutputTokens: 4_096,
					supportsThinking: true,
					thinkingBudget: 5_000,
					minThinkingBudget: 1_024,
					quotaInfo: { remainingFraction: 1 },
				},
			},
		});

		const body = openAIToAntigravityBody({
			model: "gemini-4.0-tight-output",
			messages: [{ role: "user", content: "ping" }],
		}) as AntigravityBodyWithRequest;
		const generation = body.request.generationConfig!;
		const budget = generation.thinkingConfig?.thinkingBudget as number;
		assert.ok(Number.isFinite(budget) && budget > 0);
		assert.ok(budget < generation.maxOutputTokens!);
	});
});

describe("effort-based routing in openAIToAntigravityBody", () => {
	afterEach(() => {
		setEffortRoutingOverride(null);
		setModelAliasesOverride(null);
		setModelSpecsOverride(null);
		dynamicCatalog.reset();
	});

	it("routes alias + effort to upstream model with displayModel = alias and adaptive thinking", () => {
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

		const body = openAIToAntigravityBody({
			model: "gemini-3.8-flash",
			messages: [{ role: "user", content: "ping" }],
			reasoning_effort: "high",
		}) as AntigravityBodyWithRequest;

		assert.equal(body.model, "gemini-3.8-flash-high");
		assert.equal(body.displayModel, "gemini-3.8-flash");
		assert.deepEqual(body.request.generationConfig?.thinkingConfig, {
			includeThoughts: true,
		});
	});

	it("keeps explicit suffixed ID unchanged even with conflicting reasoning_effort", () => {
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

		const body = openAIToAntigravityBody({
			model: "gemini-3.8-flash-low",
			messages: [{ role: "user", content: "ping" }],
			reasoning_effort: "high",
		}) as AntigravityBodyWithRequest;

		assert.equal(body.model, "gemini-3.8-flash-low");
		assert.equal(body.displayModel, "gemini-3.8-flash-low");
	});

	it("modelSpecs override still wins on the resolved target", () => {
		setEffortRoutingOverride({
			"gemini-3.8-flash": {
				defaultEffort: "medium",
				targets: {
					low: "gemini-3.8-flash-low",
					high: "gemini-3.8-flash-high",
				},
			},
		});
		setModelSpecsOverride({
			"gemini-3.8-flash-high": {
				maxOutputTokens: 4096,
				thinkingBudget: 2048,
				isThinking: true,
			},
		});

		const body = openAIToAntigravityBody({
			model: "gemini-3.8-flash",
			messages: [{ role: "user", content: "ping" }],
			reasoning_effort: "high",
		}) as AntigravityBodyWithRequest;

		assert.equal(body.model, "gemini-3.8-flash-high");
		assert.equal(body.displayModel, "gemini-3.8-flash");
		assert.deepEqual(body.request.generationConfig?.thinkingConfig, {
			includeThoughts: true,
			thinkingBudget: 2048,
		});
		assert.equal(body.request.generationConfig?.maxOutputTokens, 4096);
	});

	it("uses dynamic target thinking and output constraints after effort routing", () => {
		dynamicCatalog.updateFromEndpointResponse({
			models: {
				"gemini-4.0-effort-target": {
					maxOutputTokens: 12_000,
					supportsThinking: true,
					thinkingBudget: 1_000,
					minThinkingBudget: 4_000,
					quotaInfo: { remainingFraction: 1 },
				},
			},
		});
		setEffortRoutingOverride({
			"gemini-4.0-effort": {
				defaultEffort: "medium",
				targets: { medium: "gemini-4.0-effort-target" },
			},
		});

		const body = openAIToAntigravityBody({
			model: "gemini-4.0-effort",
			messages: [{ role: "user", content: "ping" }],
			max_tokens: 3_000,
		}) as AntigravityBodyWithRequest;

		assert.equal(body.model, "gemini-4.0-effort-target");
		assert.deepEqual(body.request.generationConfig?.thinkingConfig, {
			includeThoughts: true,
			thinkingBudget: 4_000,
		});
		assert.equal(body.request.generationConfig?.maxOutputTokens, 12_000);
	});

	it("remaps configured target via operator modelAliases", () => {
		setEffortRoutingOverride({
			"gemini-3.8-flash": {
				defaultEffort: "medium",
				targets: {
					medium: "gemini-3.8-flash-medium",
					high: "gemini-3.8-flash-high",
				},
			},
		});
		setModelAliasesOverride({
			"gemini-3.8-flash-high": "gemini-custom-upstream",
		});

		const body = openAIToAntigravityBody({
			model: "gemini-3.8-flash",
			messages: [{ role: "user", content: "ping" }],
			reasoning_effort: "high",
		}) as AntigravityBodyWithRequest;

		assert.equal(body.model, "gemini-custom-upstream");
		assert.equal(body.displayModel, "gemini-3.8-flash");
	});

	it("guarantees input.model is not mutated after openAIToAntigravityBody", () => {
		setEffortRoutingOverride({
			"gemini-3.8-flash": {
				defaultEffort: "medium",
				targets: {
					high: "gemini-3.8-flash-high",
				},
			},
		});

		const req = {
			model: "gemini-3.8-flash",
			messages: [{ role: "user" as const, content: "ping" }],
			reasoning_effort: "high",
		};

		openAIToAntigravityBody(req);
		assert.equal(req.model, "gemini-3.8-flash");
	});
});
