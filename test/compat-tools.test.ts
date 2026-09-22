import { describe, it } from "node:test";
import assert from "node:assert";
import {
	anthropicToAntigravityBody,
	openAIToAntigravityBody,
	parseAntigravitySse,
	type OpenAIChatCompletionRequest,
} from "../src/compat.js";
import { cacheThoughtSignature, thoughtSignatureCache } from "../src/compat/cache.js";
import { validateMessages } from "../src/providers/google-antigravity/translators.js";

describe("OpenAI Compat Tool Calling", () => {
	it("converts basic messages without tools to multi-turn format", () => {
		const req: OpenAIChatCompletionRequest = {
			model: "claude-sonnet-4-6",
			messages: [
				{ role: "system", content: "You are a helpful assistant" },
				{ role: "user", content: "Hello" }
			]
		};

		const result = openAIToAntigravityBody(req);
		assert.strictEqual(result.requestType, "agent");
		assert.strictEqual(result.model, "claude-sonnet-4-6");
		
		const request = result.request as any;
		assert.strictEqual(request.systemInstruction.role, "system");
		assert.strictEqual(request.systemInstruction.parts[0].text, "You are a helpful assistant");
		assert.deepStrictEqual(request.contents, [
			{ role: "user", parts: [{ text: "Hello" }] }
		]);
		assert.strictEqual(request.tools, undefined);
	});

	it("disables Claude thinking when tool_choice forces a function", () => {
		const result = openAIToAntigravityBody({
			model: "claude-sonnet-4-6",
			messages: [{ role: "user", content: "Call lookup" }],
			tools: [{ type: "function", function: { name: "lookup" } }],
			tool_choice: { type: "function", function: { name: "lookup" } },
		});
		assert.equal((result.request as any).generationConfig.thinkingConfig, undefined);
	});

	it("converts tools to Gemini functionDeclarations", () => {
		const req: OpenAIChatCompletionRequest = {
			model: "gemini-3-flash",
			messages: [{ role: "user", content: "What is the weather?" }],
			tools: [
				{
					type: "function",
					function: {
						name: "get_weather",
						description: "Get the current weather",
						parameters: { type: "object", properties: { location: { type: "string" } } }
					}
				}
			]
		};

		const result = openAIToAntigravityBody(req);
		const request = result.request as any;
		
		assert.deepStrictEqual(request.tools, [{
			functionDeclarations: [
				{
					name: "get_weather",
					description: "Get the current weather",
					parameters: { type: "object", properties: { location: { type: "string" } } }
				}
			]
		}]);
	});

	it("sanitizes tool schemas before forwarding upstream", () => {
		const req: OpenAIChatCompletionRequest = {
			model: "gemini-3-flash",
			messages: [{ role: "user", content: "compact this" }],
			tools: [
				{
					type: "function",
					function: {
						name: "complex_schema",
						description: "schema cleanup",
						parameters: {
							type: "object",
							properties: {
								items: {
									type: "array",
									items: { type: "string" }
								}
							}
						}
					}
				}
			]
		};

		const result = openAIToAntigravityBody(req);
		const request = result.request as any;
		assert.equal(request.tools[0].functionDeclarations[0].name, "complex_schema");
		assert.ok(request.tools[0].functionDeclarations[0].parameters);
	});

	it("strips propertyNames from OpenAI tool parameters for Gemini", () => {
		const schemaWithPropertyNames = {
			type: "object",
			properties: {
				config: {
					type: "object",
					propertyNames: { pattern: "^[a-zA-Z0-9_]+$" },
					properties: {
						key: { type: "string" }
					}
				}
			}
		};

		const result = openAIToAntigravityBody({
			model: "gemini-3-flash",
			messages: [{ role: "user", content: "Validate this config" }],
			tools: [
				{
					type: "function",
					function: {
						name: "validate_config",
						parameters: schemaWithPropertyNames,
					},
				},
			],
		});
		const request = result.request as any;
		const parameters = request.tools[0].functionDeclarations[0].parameters;
		assert.strictEqual(parameters.properties.config.propertyNames, undefined);
		assert.strictEqual(parameters.properties.config.properties.key.type, "string");
	});

	it("strips propertyNames from Anthropic tool input schemas for Claude via Gemini", () => {
		const result = anthropicToAntigravityBody({
			model: "claude-sonnet-4-6",
			messages: [{ role: "user", content: "Validate this config" }],
			tools: [
				{
					name: "validate_config",
					input_schema: {
						type: "object",
						properties: {
							config: {
								type: "object",
								propertyNames: { pattern: "^[a-zA-Z0-9_]+$" },
								properties: {
									key: { type: "string" },
								},
							},
						},
					},
				},
			],
		});
		const request = result.request as any;
		const parameters = request.tools[0].functionDeclarations[0].parameters;

		assert.strictEqual(parameters.properties.config.propertyNames, undefined);
		assert.strictEqual(parameters.properties.config.properties.key.type, "string");
	});

	it("strips Gemini vendor schema extensions recursively", () => {
		const schema = {
			type: "object",
			deprecated: true,
			"x-google-identifier": "root",
			properties: {
				state: {
					type: "string",
					deprecated: true,
					"x-google-enum-descriptions": ["old"],
				},
				items: {
					type: "array",
					items: { type: "string", "x-vendor-extra": true },
				},
			},
			anyOf: [
				{
					type: "object",
					properties: { nested: { type: "number", "x-google-extra": true } },
				},
				{ type: "null", "x-google-null": true },
			],
		};

		const result = openAIToAntigravityBody({
			model: "gemini-3-flash",
			messages: [{ role: "user", content: "Inspect this schema" }],
			tools: [{ type: "function", function: { name: "inspect", parameters: schema } }],
		});
		const parameters = (result.request as any).tools[0].functionDeclarations[0].parameters;

		assert.equal(parameters.deprecated, undefined);
		assert.equal(parameters["x-google-identifier"], undefined);
		assert.equal(parameters.properties.state.deprecated, undefined);
		assert.equal(parameters.properties.state["x-google-enum-descriptions"], undefined);
		assert.equal(parameters.properties.items.items["x-vendor-extra"], undefined);
		assert.equal(parameters.anyOf[0].properties.nested["x-google-extra"], undefined);
		assert.equal(parameters.anyOf[1]["x-google-null"], undefined);
	});

	it("strips vendor extensions but preserves Claude JSON Schema keywords", () => {
		const result = anthropicToAntigravityBody({
			model: "claude-sonnet-4-6",
			messages: [{ role: "user", content: "Inspect this schema" }],
			tools: [{
				name: "inspect",
				input_schema: {
					type: "object",
					deprecated: true,
					"x-google-identifier": "root",
					properties: {
						value: { type: "string", minimum: 3, pattern: "^[a-z]+$", "x-google-extra": true },
					},
				},
			}],
		});
		const parameters = (result.request as any).tools[0].functionDeclarations[0].parameters;

		assert.equal(parameters.deprecated, undefined);
		assert.equal(parameters["x-google-identifier"], undefined);
		assert.equal(parameters.properties.value["x-google-extra"], undefined);
		assert.equal(parameters.properties.value.minimum, 3);
		assert.equal(parameters.properties.value.pattern, "^[a-z]+$");
	});

	it("accepts assistant tool calls without content but rejects missing content elsewhere", () => {
		const toolCall = {
			id: "call_123",
			type: "function",
			function: { name: "get_weather", arguments: "{}" },
		};

		assert.equal(validateMessages([{ role: "assistant", tool_calls: [toolCall] }]), true);
		assert.equal(validateMessages([{ role: "user" }]), false);
		assert.equal(validateMessages([{ role: "tool", tool_calls: [toolCall] }]), false);
		assert.equal(
			validateMessages([{ role: "assistant", tool_calls: [{ ...toolCall, function: { arguments: "{}" } }] }]),
			false,
		);
	});

	it("converts multi-turn conversation with tool calls and tool responses", () => {
		const req: OpenAIChatCompletionRequest = {
			model: "claude-sonnet-4-6",
			messages: [
				{ role: "user", content: "What is the weather in NYC?" },
				{ 
					role: "assistant", 
					content: null, 
					tool_calls: [{ id: "call_123", type: "function", function: { name: "get_weather", arguments: "{\"location\": \"NYC\"}" } }]
				},
				{ role: "tool", name: "get_weather", tool_call_id: "call_123", content: "{\"temp\": 72}" }
			]
		};

		const result = openAIToAntigravityBody(req);
		const request = result.request as any;

		assert.deepStrictEqual(request.contents, [
			{ role: "user", parts: [{ text: "What is the weather in NYC?" }] },
			{ role: "model", parts: [{ functionCall: { id: "call_123", name: "get_weather", args: { location: "NYC" } } }] },
			{ role: "user", parts: [{ functionResponse: { id: "call_123", name: "get_weather", response: { temp: 72 } } }] }
		]);
	});

	it("preserves JSON Schema and OpenAPI references as tool output text", () => {
		const outputs = [
			{
				name: "webfetch",
				content: JSON.stringify({
					$schema: "https://json-schema.org/draft/2020-12/schema",
					$ref: "#/$defs/Config",
					$defs: { Config: { type: "object" } },
				}),
			},
			{
				name: "bash",
				content: JSON.stringify({
					openapi: "3.1.0",
					components: {
						schemas: {
							HTTPValidationError: { type: "object" },
						},
					},
					paths: {
						"/items": {
							get: {
								responses: {
									"400": {
										content: {
											"application/json": {
												schema: {
													$ref: "#/components/schemas/HTTPValidationError",
												},
											},
										},
									},
								},
							},
						},
					},
				}),
			},
		];

		for (const [index, output] of outputs.entries()) {
			const callId = `call_schema_${index}`;
			cacheThoughtSignature(callId, "SG_TEST_SIGNATURE");
			try {
				const result = openAIToAntigravityBody({
					model: "gemini-3.8-flash-high",
					messages: [
						{ role: "user", content: "Fetch the schema" },
						{
							role: "assistant",
							content: null,
							tool_calls: [
								{
									id: callId,
									type: "function",
									function: { name: output.name, arguments: "{}" },
								},
							],
						},
						{
							role: "tool",
							name: output.name,
							tool_call_id: callId,
							content: output.content,
						},
					],
				});
				const contents = (result.request as any).contents;
				const functionResponse = contents
					.flatMap((content: any) => content.parts)
					.find((part: any) => part.functionResponse)?.functionResponse;

				assert.deepStrictEqual(functionResponse.response, { output: output.content });
			} finally {
				thoughtSignatureCache.delete(callId);
			}
		}
	});

	it("converts tool_choice appropriately", () => {
		const testChoice = (tool_choice: unknown, expectedMode: string, expectedNames?: string[]) => {
			const req: OpenAIChatCompletionRequest = {
				model: "gemini-3-flash",
				messages: [{ role: "user", content: "Hi" }],
				tool_choice
			};
			const result = openAIToAntigravityBody(req);
			const request = result.request as any;
			assert.strictEqual(request.toolConfig.functionCallingConfig.mode, expectedMode);
			if (expectedNames) {
				assert.deepStrictEqual(request.toolConfig.functionCallingConfig.allowedFunctionNames, expectedNames);
			} else {
				assert.strictEqual(request.toolConfig.functionCallingConfig.allowedFunctionNames, undefined);
			}
		};

		testChoice("none", "NONE");
		testChoice("auto", "AUTO");
		testChoice("required", "AUTO");
		testChoice({ type: "function", function: { name: "get_weather" } }, "ANY", ["get_weather"]);
	});

	it("parses Gemini SSE functionCall into OpenAI tool_calls", () => {
		const rawSse = `data: {"response": {"candidates": [{"content": {"parts": [{"functionCall": {"name": "get_weather", "args": {"location": "London"}}}]}}]}}

data: [DONE]

`;
		const result = parseAntigravitySse(rawSse);
		assert.strictEqual(result.text, "");
		assert.ok(result.toolCalls);
		assert.strictEqual(result.toolCalls.length, 1);
		
		const tc = result.toolCalls[0];
		assert.strictEqual(tc.type, "function");
		assert.strictEqual(tc.function.name, "get_weather");
		assert.strictEqual(tc.function.arguments, '{"location":"London"}');
		assert.ok(tc.id.startsWith("call_"));
	});

	it("summarizes tool history when a Gemini thinking turn has no cached signature", () => {
		const req: OpenAIChatCompletionRequest = {
			model: "gemini-3.8-flash-high",
			messages: [
				{ role: "user", content: "Find the weather" },
				{
					role: "assistant",
					content: null,
					tool_calls: [{ id: "call_missing_sig", type: "function", function: { name: "get_weather", arguments: "{\"location\":\"Quito\"}" } }]
				},
				{ role: "tool", name: "get_weather", tool_call_id: "call_missing_sig", content: "{\"temp\":18}" }
			]
		};

		const result = openAIToAntigravityBody(req);
		const request = result.request as any;
		assert.match(JSON.stringify(request.contents), /Context: The assistant used tools/);
	});

	it("does not leave a Gemini thinking fallback ending with a model turn", () => {
		const callId = "call_missing_sig_model_turn_regression";
		thoughtSignatureCache.delete(callId);
		try {
			const result = openAIToAntigravityBody({
				model: "gemini-3.6-flash-high",
				messages: [
					{ role: "user", content: "Find the weather" },
					{
						role: "assistant",
						content: null,
						tool_calls: [{
							id: callId,
							type: "function",
							function: { name: "get_weather", arguments: '{"location":"Quito"}' },
						}],
					},
					{
						role: "tool",
						name: "get_weather",
						tool_call_id: callId,
						content: '{"temp":18}',
					},
				],
			});
			const contents = (result.request as { contents: Array<{ role: string; parts: unknown[] }> }).contents;
			assert.equal(contents.at(-1)?.role, "user");
			assert.match(JSON.stringify(contents), /Context: The assistant used tools/);
			assert.match(JSON.stringify(contents.at(-1)?.parts), /Continue from the previous assistant message/);
		} finally {
			thoughtSignatureCache.delete(callId);
		}
	});

	it("resolves tool function name from history when cached signature re-enables functionCall path", () => {
		const callId = "call_cached_sig";
		cacheThoughtSignature(callId, "SG_TEST_SIGNATURE");
		try {
			const req: OpenAIChatCompletionRequest = {
				model: "gemini-3.8-flash-high",
				messages: [
					{ role: "user", content: "Find the weather" },
					{
						role: "assistant",
						content: null,
						tool_calls: [{ id: callId, type: "function", function: { name: "get_weather", arguments: "{\"location\":\"Quito\"}" } }]
					},
					{ role: "tool", tool_call_id: callId, content: "{\"temp\":18}" }
				]
			};

			const result = openAIToAntigravityBody(req);
			const request = result.request as any;
			const serialized = JSON.stringify(request.contents);

			assert.ok(serialized.includes(`"thoughtSignature":"SG_TEST_SIGNATURE"`), "cached signature must be re-injected");
			assert.ok(serialized.includes(`"name":"get_weather"`), "functionResponse name must come from tool_call history");
			assert.ok(!serialized.includes('"name":"unknown"'), "must not emit placeholder name unknown");
		} finally {
			thoughtSignatureCache.delete(callId);
		}
	});

	it("collapses anyOf/oneOf/allOf to first variant for Claude model schemas", () => {
		const req: OpenAIChatCompletionRequest = {
			model: "claude-sonnet-4-6",
			messages: [{ role: "user", content: "Hi" }],
			tools: [
				{
					type: "function",
					function: {
						name: "test_tool",
						parameters: {
							type: "object",
							properties: {
								value: {
									anyOf: [
										{ type: "string", minLength: 3 },
										{ type: "number" }
									]
								}
							}
						}
					}
				}
			]
		};

		const result = openAIToAntigravityBody(req);
		const request = result.request as any;
		const valueParam = request.tools[0].functionDeclarations[0].parameters.properties.value;
		assert.strictEqual(valueParam.type, "string");
		assert.strictEqual(valueParam.minLength, 3);
		assert.strictEqual(valueParam.anyOf, undefined);
	});

	it("converts anyOf with null variant to nullable:true (lossless)", () => {
		const req: OpenAIChatCompletionRequest = {
			model: "claude-sonnet-4-6",
			messages: [{ role: "user", content: "Hi" }],
			tools: [
				{
					type: "function",
					function: {
						name: "nullable_tool",
						parameters: {
							type: "object",
							properties: {
								name: {
									anyOf: [
										{ type: "string" },
										{ type: "null" }
									]
								}
							}
						}
					}
				}
			]
		};

		const result = openAIToAntigravityBody(req);
		const request = result.request as any;
		const nameParam = request.tools[0].functionDeclarations[0].parameters.properties.name;
		assert.strictEqual(nameParam.type, "string");
		assert.strictEqual(nameParam.nullable, true);
		assert.strictEqual(nameParam.anyOf, undefined);
	});

	it("deep merges allOf variants for Claude schemas (lossless)", () => {
		const req: OpenAIChatCompletionRequest = {
			model: "claude-sonnet-4-6",
			messages: [{ role: "user", content: "Hi" }],
			tools: [
				{
					type: "function",
					function: {
						name: "allof_tool",
						parameters: {
							type: "object",
							allOf: [
								{
									type: "object",
									properties: { a: { type: "string" } },
									required: ["a"]
								},
								{
									type: "object",
									properties: { b: { type: "number" } },
									required: ["b"]
								}
							]
						}
					}
				}
			]
		};

		const result = openAIToAntigravityBody(req);
		const request = result.request as any;
		const params = request.tools[0].functionDeclarations[0].parameters;
		assert.strictEqual(params.allOf, undefined);
		assert.deepStrictEqual(params.properties, {
			a: { type: "string" },
			b: { type: "number" }
		});
		assert.deepStrictEqual(params.required.sort(), ["a", "b"]);
	});

	it("merges anyOf object variants into union of properties", () => {
		const req: OpenAIChatCompletionRequest = {
			model: "claude-sonnet-4-6",
			messages: [{ role: "user", content: "Hi" }],
			tools: [
				{
					type: "function",
					function: {
						name: "union_tool",
						parameters: {
							type: "object",
							properties: {
								event: {
									anyOf: [
										{
											type: "object",
											properties: {
												kind: { type: "string" },
												data: { type: "string" }
											},
											required: ["kind", "data"]
										},
										{
											type: "object",
											properties: {
												kind: { type: "string" },
												error: { type: "string" }
											},
											required: ["kind", "error"]
										}
									]
								}
							}
						}
					}
				}
			]
		};

		const result = openAIToAntigravityBody(req);
		const request = result.request as any;
		const eventParam = request.tools[0].functionDeclarations[0].parameters.properties.event;
		assert.strictEqual(eventParam.type, "object");
		assert.strictEqual(eventParam.anyOf, undefined);
		// All properties from all variants should be present
		assert.ok(eventParam.properties.kind);
		assert.ok(eventParam.properties.data);
		assert.ok(eventParam.properties.error);
		// Only "kind" is required in ALL variants
		assert.deepStrictEqual(eventParam.required, ["kind"]);
	});

	it("collapses inline union type arrays to first non-null type and sets nullable:true", () => {
		const req: OpenAIChatCompletionRequest = {
			model: "claude-sonnet-4-6",
			messages: [{ role: "user", content: "Hi" }],
			tools: [
				{
					type: "function",
					function: {
						name: "union_tool",
						parameters: {
							type: "object",
							properties: {
								id: {
									type: ["number", "null"]
								},
								name: {
									type: ["string", "number"]
								}
							}
						}
					}
				}
			]
		};

		const result = openAIToAntigravityBody(req);
		const request = result.request as any;
		const idParam = request.tools[0].functionDeclarations[0].parameters.properties.id;
		assert.strictEqual(idParam.type, "number");
		assert.strictEqual(idParam.nullable, true);

		const nameParam = request.tools[0].functionDeclarations[0].parameters.properties.name;
		assert.strictEqual(nameParam.type, "string");
		assert.strictEqual(nameParam.nullable, undefined);
	});
});
