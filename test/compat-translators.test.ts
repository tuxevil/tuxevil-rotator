import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import {
	openAIToAntigravityBody,
	anthropicToAntigravityBody,
	normalizeOpenAIChatCompletionRequest,
	normalizeOpenAIResponsesRequest,
	mapTieredReasoningEffortToThinkingLevel,
} from "../src/providers/google-antigravity/translators.js";
import { setModelSpecsOverride } from "../src/compat/model-specs.js";

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
			model: "gemini-3.5-flash",
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
			parts: [{ text: "be terse" }],
		});
		assert.deepEqual(body.request.contents, [
			{ role: "user", parts: [{ text: "ping" }] },
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
			parts: [{ text: "be polite" }],
		});
		assert.deepEqual(body.request.contents, [
			{ role: "user", parts: [{ text: "hello" }] },
		]);
	});

	it("normalizes loose non-array messages into OpenAI chat messages", () => {
		const normalized = normalizeOpenAIChatCompletionRequest({
			model: "gemini-3.5-flash-high",
			messages: { role: "user", content: [{ type: "input_text", text: "hola" }] },
		}) as { messages: unknown[] };
		assert.deepEqual(normalized.messages, [
			{ role: "user", content: [{ type: "text", text: "hola" }] },
		]);
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
			model: "gemini-3.5-flash",
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
