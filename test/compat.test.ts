import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import {
	anthropicToAntigravityBody,
	logValidationFailure,
	normalizeOpenAIResponsesRequest,
	normalizeAnthropicMessagesRequest,
	normalizeOpenAIChatCompletionRequest,
	openAIToAntigravityBody,
	parseAntigravitySse,
	resetResponsesStoreForTests,
	setModelSpecsOverride,
	validateAnthropicMessagesRequest,
	validateOpenAIChatCompletionRequest,
	validateOpenAIResponsesRequest,
} from "../src/compat.js";
import { logger } from "../src/logger.js";

describe("compat adapters", () => {
	it("normalizes OpenAI Responses prompt into input", () => {
		const normalized = normalizeOpenAIResponsesRequest({
			model: "gemini-3.8-flash-high",
			prompt: "ping",
		}) as { input: unknown };
		assert.equal(normalized.input, "ping");
	});

	it("validates OpenAI Responses contract", () => {
		const result = validateOpenAIResponsesRequest({
			model: "gemini-3-flash",
			input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
			instructions: "be terse",
			max_output_tokens: 64,
			reasoning: { effort: "medium" },
			tools: [{ type: "function", function: { name: "lookup" } }],
		});
		assert.equal(result.ok, true);
	});

	it("rejects unsupported Responses built-in tools", () => {
		const result = validateOpenAIResponsesRequest({
			model: "gemini-3-flash",
			input: "hello",
			tools: [{ type: "web_search" }],
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.errors.join("; "), /only function tools are supported/);
	});

	it("validates OpenAI chat completion contract", () => {
		const result = validateOpenAIChatCompletionRequest({
			model: "gemini-3-flash",
			messages: [{ role: "user", content: "hello" }],
			stream: false,
		});
		assert.equal(result.ok, true);
	});

	it("validates developer role in OpenAI chat completion contract", () => {
		const result = validateOpenAIChatCompletionRequest({
			model: "gemini-3-flash",
			messages: [
				{ role: "developer", content: "system instructions" },
				{ role: "user", content: "hello" }
			],
			stream: false,
		});
		assert.equal(result.ok, true);
	});

	it("rejects malformed OpenAI chat completion contract", () => {
		const result = validateOpenAIChatCompletionRequest({ model: "", messages: "nope" });
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.errors.join("; "), /model/);
	});

	it("normalizes OpenAI Responses-style input into chat messages", () => {
		const normalized = normalizeOpenAIChatCompletionRequest({
			model: "gemini-3.8-flash-high",
			input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }],
		});
		const result = validateOpenAIChatCompletionRequest(normalized);
		assert.equal(result.ok, true);
		if (result.ok) assert.deepEqual(result.value.messages, [{ role: "user", content: [{ type: "text", text: "ping" }] }]);
	});

	it("normalizes native Antigravity contents into OpenAI chat messages", () => {
		const normalized = normalizeOpenAIChatCompletionRequest({
			model: "gemini-3-flash",
			request: {
				contents: [{ role: "user", parts: [{ text: "hola" }] }],
			},
		});
		const result = validateOpenAIChatCompletionRequest(normalized);
		assert.equal(result.ok, true);
		if (result.ok) assert.deepEqual(result.value.messages, [{ role: "user", content: "hola" }]);
	});

	it("normalizes loose non-array messages into OpenAI chat messages", () => {
		const normalized = normalizeOpenAIChatCompletionRequest({
			model: "gemini-3.8-flash-high",
			messages: { role: "user", content: [{ type: "input_text", text: "hola" }] },
		});
		const result = validateOpenAIChatCompletionRequest(normalized);
		assert.equal(result.ok, true);
		if (result.ok) assert.deepEqual(result.value.messages, [{ role: "user", content: [{ type: "text", text: "hola" }] }]);
	});

	it("converts OpenAI messages into Antigravity request body", () => {
		const body = openAIToAntigravityBody({
			model: "claude-sonnet-4-6",
			messages: [
				{ role: "system", content: "be terse" },
				{ role: "user", content: "ping" },
			],
		});
		assert.equal(body.model, "claude-sonnet-4-6");
		const bodyStr = JSON.stringify(body);
		assert.match(bodyStr, /"project":"compat-placeholder"/);
		assert.match(bodyStr, /"userAgent":"antigravity"/);
		assert.match(bodyStr, /"requestType":"agent"/);
		assert.match(bodyStr, /"systemInstruction":{"role":"system","parts":\[{"text":"be terse"}\]}/);
		const reqStr = JSON.stringify(body.request);
		assert.match(reqStr, /"contents":\[{"role":"user","parts":\[{"text":"ping"}\]}\]/);
	});

	it("converts developer role messages to system instructions in Antigravity request body", () => {
		const body = openAIToAntigravityBody({
			model: "claude-sonnet-4-6",
			messages: [
				{ role: "developer", content: "be helpful and coding agent" },
				{ role: "user", content: "hello" },
			],
		});
		assert.equal(body.model, "claude-sonnet-4-6");
		const bodyStr = JSON.stringify(body);
		assert.match(bodyStr, /"systemInstruction":{"role":"system","parts":\[{"text":"be helpful and coding agent"}\]}/);
		const reqStr = JSON.stringify(body.request);
		assert.match(reqStr, /"contents":\[{"role":"user","parts":\[{"text":"hello"}\]}\]/);
	});

	it("validates Anthropic messages contract", () => {
		const result = validateAnthropicMessagesRequest({
			model: "claude-sonnet-4-6",
			system: "be terse",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 128,
		});
		assert.equal(result.ok, true);
	});

	it("normalizes native Antigravity contents into Anthropic messages", () => {
		const normalized = normalizeAnthropicMessagesRequest({
			model: "claude-opus-4-6-thinking",
			request: {
				systemInstruction: { role: "system", parts: [{ text: "be terse" }] },
				contents: [{ role: "user", parts: [{ text: "hello" }] }],
			},
		});
		const result = validateAnthropicMessagesRequest(normalized);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.deepEqual(result.value.messages, [
				{ role: "system", content: "be terse" },
				{ role: "user", content: "hello" },
			]);
		}
	});

	it("converts Anthropic messages into Antigravity request body", () => {
		const body = anthropicToAntigravityBody({
			model: "claude-sonnet-4-6",
			system: "policy",
			messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
		});
		assert.equal(body.model, "claude-sonnet-4-6");
		const bodyStr = JSON.stringify(body);
		assert.match(bodyStr, /"model":"claude-sonnet-4-6"/);
		assert.match(bodyStr, /"userAgent":"antigravity"/);
		assert.match(bodyStr, /"systemInstruction":{"role":"system","parts":\[{"text":"policy"}\]}/);
		const reqStr = JSON.stringify(body.request);
		assert.match(reqStr, /"contents":\[{"role":"user","parts":\[{"text":"hello"}\]}\]/);
	});

	it("converts OpenAI data URL images into Antigravity inlineData", () => {
		const body = openAIToAntigravityBody({
			model: "gemini-3-flash",
			messages: [{
				role: "user",
				content: [
					{ type: "text", text: "describe" },
					{ type: "image_url", image_url: { url: "data:image/png;base64,abc123" } },
				],
			}],
		});
		assert.match(JSON.stringify(body.request), /"inlineData"/);
		assert.match(JSON.stringify(body.request), /"mimeType":"image\/png"/);
		assert.match(JSON.stringify(body.request), /"data":"abc123"/);
	});

	it("converts Anthropic base64 images into Antigravity inlineData", () => {
		const body = anthropicToAntigravityBody({
			model: "gemini-3-flash",
			messages: [{
				role: "user",
				content: [
					{ type: "text", text: "describe" },
					{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "def456" } },
				],
			}],
		});
		assert.match(JSON.stringify(body.request), /"inlineData"/);
		assert.match(JSON.stringify(body.request), /"mimeType":"image\/jpeg"/);
		assert.match(JSON.stringify(body.request), /"data":"def456"/);
	});

	it("converts OpenAI tool response images into Antigravity inlineData", () => {
		const body = openAIToAntigravityBody({
			model: "claude-sonnet-4-6",
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Please look up pi" }],
				},
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call_abc",
							type: "function",
							function: { name: "read_file", arguments: "{}" },
						},
					],
				},
				{
					role: "tool",
					tool_call_id: "call_abc",
					name: "read_file",
					content: [
						{ type: "text", text: "Tool output text" },
						{
							type: "image_url",
							image_url: { url: "data:image/png;base64,toolimgbase64" },
						},
					],
				},
			],
		});

		const reqStr = JSON.stringify(body.request);
		assert.match(
			reqStr,
			/"functionResponse":\{(?:"[^"]+":"[^"]+",)?"name":"read_file","response":\{"output":"Tool output text"\}/,
		);
		assert.match(reqStr, /"inlineData"/);
		assert.match(reqStr, /"mimeType":"image\/png"/);
		assert.match(reqStr, /"data":"toolimgbase64"/);
	});
 
	it("strips dangling tool calls if not followed by tool results", () => {
		const body = openAIToAntigravityBody({
			model: "claude-sonnet-4-6",
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Please look up pi" }],
				},
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call_abc",
							type: "function",
							function: { name: "read_file", arguments: "{}" },
						},
					],
				},
				{
					role: "user",
					content: "Never mind, stop.",
				},
			],
		});

		const reqStr = JSON.stringify(body.request);
		// Check that the tool calls were stripped and replaced with fallback text
		assert.match(reqStr, /"role":"model","parts":\[{"text":"\.\.\."}\]/);
		assert.doesNotMatch(reqStr, /"functionCall"/);
	});

	it("filters out only incomplete tool calls if some succeeded and others didn't", () => {
		const body = openAIToAntigravityBody({
			model: "claude-sonnet-4-6",
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Please look up pi" }],
				},
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call_abc",
							type: "function",
							function: { name: "read_file", arguments: "{}" },
						},
						{
							id: "call_def",
							type: "function",
							function: { name: "write_file", arguments: "{}" },
						},
					],
				},
				{
					role: "tool",
					tool_call_id: "call_abc",
					name: "read_file",
					content: "some file content",
				},
			],
		});

		const reqStr = JSON.stringify(body.request);
		// Should keep "call_abc" (since there is a tool result for it)
		assert.match(reqStr, /"functionCall":\{"id":"call_abc","name":"read_file"/);
		// Should filter out "call_def" (since there is no tool result for it)
		assert.doesNotMatch(reqStr, /"call_def"/);
	});

	it("drops Claude tool results that no longer follow a matching tool call", () => {
		const body = openAIToAntigravityBody({
			model: "claude-sonnet-4-6",
			messages: [
				{
					role: "user",
					content: "Please call a tool.",
				},
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call_mr22ui45_0",
							type: "function",
							function: { name: "lookup", arguments: "{}" },
						},
					],
				},
				{
					role: "user",
					content: "Actually, one more instruction before the result.",
				},
				{
					role: "tool",
					tool_call_id: "call_mr22ui45_0",
					name: "lookup",
					content: "tool output",
				},
			],
		});

		const reqStr = JSON.stringify(body.request);
		assert.doesNotMatch(reqStr, /"functionResponse"/);
		assert.doesNotMatch(reqStr, /call_mr22ui45_0/);
	});

	it("keeps Anthropic tool_result blocks adjacent before mixed user text", () => {
		const body = anthropicToAntigravityBody({
			model: "claude-sonnet-4-6",
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Please look up pi" }],
				},
				{
					role: "assistant",
					content: [
						{ type: "tool_use", id: "call_mix", name: "lookup", input: { q: "pi" } },
					],
				},
				{
					role: "user",
					content: [
						{ type: "text", text: "Also use this note after the tool result." },
						{ type: "tool_result", tool_use_id: "call_mix", content: "3.14159" },
					],
				},
			],
		});

		const reqStr = JSON.stringify(body.request);
		const callIdx = reqStr.indexOf('"functionCall":{"id":"call_mix"');
		const responseIdx = reqStr.indexOf('"functionResponse":{"id":"call_mix"');
		const noteIdx = reqStr.indexOf("Also use this note after the tool result.");
		assert.notEqual(callIdx, -1);
		assert.notEqual(responseIdx, -1);
		assert.notEqual(noteIdx, -1);
		assert.ok(callIdx < responseIdx);
		assert.ok(responseIdx < noteIdx);
	});

	it("does not send Claude assistant prefill when history ends with assistant text", () => {
		const body = openAIToAntigravityBody({
			model: "claude-sonnet-4-6",
			messages: [
				{ role: "user", content: "Explain pi briefly." },
				{ role: "assistant", content: "Pi is" },
			],
		});

		const contents = (body.request as { contents: Array<{ role: string; parts: Array<{ text?: string }> }> }).contents;
		assert.notEqual(contents.at(-1)?.role, "model");
		assert.match(JSON.stringify(body.request), /Pi is/);
		assert.deepEqual(contents.at(-1), { role: "user", parts: [{ text: "Continue" }] });
	});

	it("does not send Claude assistant prefill for trailing dangling tool calls", () => {
		const body = openAIToAntigravityBody({
			model: "claude-sonnet-4-6",
			messages: [
				{ role: "user", content: "Please call a tool." },
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call_trailing",
							type: "function",
							function: { name: "lookup", arguments: "{}" },
						},
					],
				},
			],
		});

		const contents = (body.request as { contents: Array<{ role: string }> }).contents;
		assert.notEqual(contents.at(-1)?.role, "model");
		assert.doesNotMatch(JSON.stringify(body.request), /call_trailing/);
	});

	it("strips cache_control fields from OpenAI content blocks", () => {
		const body = openAIToAntigravityBody({
			model: "gemini-3-flash",
			messages: [{
				role: "user",
				content: [
					{ type: "text", text: "hello", cache_control: { type: "ephemeral" } } as never,
				],
			}],
		});
		assert.doesNotMatch(JSON.stringify(body.request), /cache_control/);
	});

	it("parses Antigravity SSE into a compat completion", () => {
		const parsed = parseAntigravitySse([
			'data: {"response":{"responseId":"abc","candidates":[{"content":{"parts":[{"text":"hel"}]}}]}}',
			'data: {"response":{"candidates":[{"content":{"parts":[{"text":"lo"}]},"finishReason":"MAX_TOKENS"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2}}}',
			"",
		].join("\n"));
		assert.equal(parsed.text, "hello");
		assert.equal(parsed.inputTokens, 3);
		assert.equal(parsed.outputTokens, 2);
		assert.equal(parsed.responseId, "abc");
		assert.equal(parsed.finishReason, "MAX_TOKENS");
	});

	it("delivers generated images as markdown data URIs and drops thought images", () => {
		const parsed = parseAntigravitySse([
			'data: {"response":{"candidates":[{"content":{"parts":[{"thought":true,"inlineData":{"mimeType":"image/png","data":"VGhvdWdodA=="}}]}}]}}',
			'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Here it is:"},{"inlineData":{"mimeType":"image/jpeg","data":"Q2F0SW1n"}}]}}]}}',
			'data: {"response":{"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"audio/wav","data":"QXVkaW8="}}]}}]}}',
			"",
		].join("\n"));
		assert.equal(parsed.text, "Here it is:\n\n![image](data:image/jpeg;base64,Q2F0SW1n)");
		assert.doesNotMatch(parsed.text, /VGhvdWdodA|QXVkaW8/);
	});

	it("sends generated images in assistant history back as inlineData with their signature", () => {
		parseAntigravitySse(
			'data: {"response":{"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"image/jpeg","data":"U2lnbmVkSW1n"},"thoughtSignature":"sig-img"}]}}]}}\n',
		);
		const body = openAIToAntigravityBody({
			model: "gemini-3-flash",
			messages: [
				{ role: "user", content: "Draw a cat." },
				{
					role: "assistant",
					content: "Here it is:\n\n![image](data:image/jpeg;base64,U2lnbmVkSW1n)\n\nEnjoy.",
				},
				{ role: "user", content: "Now make it blue." },
			],
		});
		const contents = (body.request as { contents: Array<{ role: string; parts: unknown[] }> }).contents;
		assert.deepEqual(contents[1], {
			role: "model",
			parts: [
				{ text: "Here it is:" },
				{ inlineData: { mimeType: "image/jpeg", data: "U2lnbmVkSW1n" }, thoughtSignature: "sig-img" },
				{ text: "Enjoy." },
			],
		});
	});

	it("collapses assistant history images to a placeholder for Claude", () => {
		const body = openAIToAntigravityBody({
			model: "claude-sonnet-4-6",
			messages: [
				{ role: "user", content: "Draw a cat." },
				{ role: "assistant", content: "Done ![image](data:image/png;base64,QUJDRA==)" },
				{ role: "user", content: "Describe it." },
			],
		});
		const reqStr = JSON.stringify(body.request);
		assert.match(reqStr, /Done \[image\]/);
		assert.doesNotMatch(reqStr, /QUJDRA|inlineData/);
	});

	it("handles empty SSE payloads without crashing", () => {
		const parsed = parseAntigravitySse("");
		assert.equal(parsed.text, "");
		assert.equal(parsed.inputTokens, 0);
		assert.equal(parsed.outputTokens, 0);
	});

	it("accepts model role in messages", () => {
		const result = validateOpenAIChatCompletionRequest({
			model: "gemini-3-flash",
			messages: [{ role: "model", content: "hello" }],
			stream: false,
		});
		assert.equal(result.ok, true);
	});

	it("converts model role and resumes with a user turn in Antigravity request body", () => {
		const body = openAIToAntigravityBody({
			model: "gemini-3-flash",
			messages: [
				{ role: "user", content: "hello" },
				{ role: "model", content: "hi there" },
			],
		});
		const contents = (body.request as { contents: Array<{ role: string }> }).contents;
		assert.deepEqual(contents.map((content) => content.role), ["user", "model", "user"]);
		const reqStr = JSON.stringify(body.request);
		assert.match(reqStr, /"text":"hi there"/);
		assert.match(reqStr, /"text":"Continue"/);
	});

	it("converts Responses function_call input items into assistant tool call history", () => {
		resetResponsesStoreForTests();
		const normalized = normalizeOpenAIResponsesRequest({
			model: "claude-sonnet-4-6",
			input: [
				{ type: "function_call", call_id: "call_123", name: "lookup", arguments: { q: "pi" } },
				{ type: "function_call_output", call_id: "call_123", output: { result: "3.14" } },
			],
		});
		const result = validateOpenAIResponsesRequest(normalized);
		assert.equal(result.ok, true);
		if (result.ok) {
			const body = openAIToAntigravityBody({
				model: result.value.model,
				messages: [
					{ role: "assistant", content: null, tool_calls: [{ id: "call_123", type: "function", function: { name: "lookup", arguments: "{\"q\":\"pi\"}" } }] },
					{ role: "tool", content: "{\"result\":\"3.14\"}", tool_call_id: "call_123", name: "lookup" },
				],
			});
			assert.match(JSON.stringify(body.request), /"functionCall"/);
			assert.match(JSON.stringify(body.request), /"functionResponse"/);
		}
	});

	it("converts Anthropic tool_use and tool_result messages correctly", () => {
		const body = anthropicToAntigravityBody({
			model: "claude-sonnet-4-6",
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Please look up pi" }],
				},
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Sure, let me check." },
						{ type: "tool_use", id: "tool_call_xyz", name: "lookup", input: { q: "pi" } },
					],
				},
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "tool_call_xyz", content: "3.14159" }
					]
				}
			],
		});

		const reqStr = JSON.stringify(body.request);
		// Check that the tool call and response are correctly structured
		assert.match(reqStr, /"functionCall":\{"id":"tool_call_xyz","name":"lookup","args":\{"q":"pi"\}\}/);
		assert.match(reqStr, /"functionResponse":\{"id":"tool_call_xyz","name":"lookup","response":\{"value":"3\.14159"\}|\{"content":"3\.14159"\}|\{"text":"3\.14159"\}|3\.14159\}/);
	});
});

describe("logValidationFailure", () => {
	it("truncates large payloads to 200 chars and redacts secrets", () => {
		const lines: string[] = [];
		const originalWriter = (logger as unknown as { writer: (line: string) => void }).writer;
		(logger as unknown as { writer: (line: string) => void }).writer = (line) => lines.push(line);
		try {
			const hugePayload = {
				text: "Bearer abc.def.ghi",
				access_token: "ya29.VERYLONGSECRET",
				content: "x".repeat(500),
			};
			logValidationFailure("Test scope", hugePayload);
			assert.equal(lines.length, 1);
			const line = lines[0];
			assert.match(line, /Test scope:/);
			assert.match(line, /\[REDACTED\]/);
			assert.match(line, /\[\+\d+ chars\]/);
			assert.ok(line.length < 400, `expected truncated line, got ${line.length} chars`);
		} finally {
			(logger as unknown as { writer: (line: string) => void }).writer = originalWriter;
		}
	});

	it("does not truncate small payloads", () => {
		const lines: string[] = [];
		const originalWriter = (logger as unknown as { writer: (line: string) => void }).writer;
		(logger as unknown as { writer: (line: string) => void }).writer = (line) => lines.push(line);
		try {
			logValidationFailure("Small", { ok: false });
			assert.equal(lines.length, 1);
			assert.doesNotMatch(lines[0], /\[\+\d+ chars\]/);
		} finally {
			(logger as unknown as { writer: (line: string) => void }).writer = originalWriter;
		}
	});
});

describe("setModelSpecsOverride", () => {
	afterEach(() => {
		setModelSpecsOverride(null);
	});

	it("returns the same defaults for known model ids", () => {
		const body = openAIToAntigravityBody({
			model: "gemini-3.1-pro-high",
			messages: [{ role: "user", content: "hello" }],
		}) as { request: { generationConfig: { maxOutputTokens?: number; thinkingConfig?: { thinkingBudget?: number } } } };
		// Without an override, the spec for gemini-3.1-pro-high uses
		// thinkingBudget=10001 and maxOutputTokens=65535.
		assert.equal(body.request.generationConfig.thinkingConfig?.thinkingBudget, 10001);
	});

	it("operator override replaces the bundled spec", () => {
		setModelSpecsOverride({
			"gemini-3.1-pro-high": { maxOutputTokens: 12345, thinkingBudget: 999, isThinking: true },
		});
		const body = openAIToAntigravityBody({
			model: "gemini-3.1-pro-high",
			messages: [{ role: "user", content: "hello" }],
		}) as { request: { generationConfig: { maxOutputTokens?: number; thinkingConfig?: { thinkingBudget?: number } } } };
		// thinkingBudget comes straight from the override; maxOutputTokens is capped
		// at min(tb+8192, spec.maxOutputTokens) = min(9191, 12345) = 9191.
		assert.equal(body.request.generationConfig.thinkingConfig?.thinkingBudget, 999);
		assert.equal(body.request.generationConfig.maxOutputTokens, 9191);
	});

	it("passing null restores bundled defaults", () => {
		setModelSpecsOverride({
			"gemini-3.1-pro-high": { maxOutputTokens: 12345, thinkingBudget: 999, isThinking: true },
		});
		setModelSpecsOverride(null);
		const body = openAIToAntigravityBody({
			model: "gemini-3.1-pro-high",
			messages: [{ role: "user", content: "hello" }],
		}) as { request: { generationConfig: { maxOutputTokens?: number; thinkingConfig?: { thinkingBudget?: number } } } };
		assert.equal(body.request.generationConfig.thinkingConfig?.thinkingBudget, 10001);
	});
});
