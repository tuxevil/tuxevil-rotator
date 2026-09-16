import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getProviderAdapter, isKnownProvider } from "../src/providers/registry.js";
import { opencodeZenAdapter, OPENCODE_ZEN_PROVIDER_ID } from "../src/providers/opencode-zen/index.js";
import {
  OPENCODE_ZEN_FREE_MODELS,
  OPENCODE_ZEN_RESPONSES_URL,
  OPENCODE_ZEN_MODELS_URL,
  isOpenCodeZenResponsesModel,
  isOpenCodeZenModel,
} from "../src/providers/opencode-zen/catalog.js";
import {
  getOpenCodeZenApiKey,
  validateCredentials,
  defaultAccountEmail,
} from "../src/providers/opencode-zen/credentials.js";
import {
  buildOpenCodeZenPayload,
  buildOpenCodeZenResponsesPayload,
  forwardRequest,
  OpenCodeZenSseAccumulator,
  OpenCodeZenResponsesStreamParser,
  parseOpenCodeZenResponsesJson,
  transformOpenCodeZenResponsesStream,
  getBenchmarkSpec,
} from "../src/providers/opencode-zen/forward.js";
import { fetchOpenCodeZenQuota } from "../src/providers/opencode-zen/quota.js";
import { parseOpenAiJson, anthropicToOpenAIChatRequest } from "../src/compat.js";
import type { AccountRuntime } from "../src/types.js";
import type { QuotaFetchContext } from "../src/providers/adapter.js";

describe("OpenCode Zen Provider Adapter", () => {
  it("registers in the provider registry", () => {
    assert.equal(isKnownProvider("opencode-zen"), true);
    assert.equal(getProviderAdapter("opencode-zen"), opencodeZenAdapter);
    assert.equal(opencodeZenAdapter.id, "opencode-zen");
    assert.equal(opencodeZenAdapter.displayName, "OpenCode Zen");
    assert.equal(opencodeZenAdapter.credentialKind, "api-key");
  });

  it("identifies OpenCode Zen free models correctly", () => {
    assert.equal(OPENCODE_ZEN_FREE_MODELS.length, 6);
    assert.ok(OPENCODE_ZEN_FREE_MODELS.includes("big-pickle"));
    assert.ok(OPENCODE_ZEN_FREE_MODELS.includes("nemotron-3.5-lightning-free"));
    assert.ok(OPENCODE_ZEN_FREE_MODELS.includes("nemotron-3-ultra-free"));
    assert.ok(OPENCODE_ZEN_FREE_MODELS.includes("mimo-v2.5-free"));
    assert.ok(OPENCODE_ZEN_FREE_MODELS.includes("muse-spark-1.3-contributor-free"));
    assert.ok(OPENCODE_ZEN_FREE_MODELS.includes("ling-3.0-flash-fin-free"));
    assert.ok(!OPENCODE_ZEN_FREE_MODELS.includes("deepseek-v4-flash-free" as never));
    assert.ok(!OPENCODE_ZEN_FREE_MODELS.includes("hy3-free" as never));


    for (const model of OPENCODE_ZEN_FREE_MODELS) {
      assert.equal(isOpenCodeZenModel(model), true);
    }

    assert.equal(isOpenCodeZenModel("custom-model-free"), true);
    assert.equal(isOpenCodeZenModel("gpt-4o"), false);
    assert.equal(isOpenCodeZenModel("gemini-3.8-flash-high"), false);
    assert.equal(isOpenCodeZenResponsesModel("muse-spark-1.3-contributor-free"), true);
    assert.equal(isOpenCodeZenResponsesModel("ling-3.0-flash-fin-free"), false);
  });

  it("validates credentials correctly", async () => {
    const validConfig = {
      email: "zen-test@opencode.ai",
      credentials: [{ provider: OPENCODE_ZEN_PROVIDER_ID, apiKey: "zen-secret-key" }],
    };
    const invalidConfig = {
      email: "bad@opencode.ai",
      credentials: [{ provider: OPENCODE_ZEN_PROVIDER_ID, apiKey: "" }],
    };

    assert.equal(getOpenCodeZenApiKey(validConfig), "zen-secret-key");
    assert.equal((await validateCredentials(validConfig)).ok, true);
    assert.equal((await validateCredentials(invalidConfig)).ok, false);
  });

  it("derives default account email", () => {
    assert.equal(defaultAccountEmail("1234567890abcdef"), "zen-90abcdef@opencode.ai");
  });

  it("builds chat completion request payloads", () => {
    const body = {
      project: "",
      model: "big-pickle",
      request: {
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      },
    };
    const payload = buildOpenCodeZenPayload(body);
    assert.equal(payload.model, "big-pickle");
    assert.deepEqual(payload.messages, [{ role: "user", content: "Hello" }]);
    assert.equal(payload.stream, true);
  });

  it("normalises developer role to system in OpenCodeZen payloads", () => {
    const body = {
      project: "",
      model: "big-pickle",
      request: {
        messages: [
          { role: "developer", content: "You are a helpful assistant." },
          { role: "user", content: "Hello" },
        ],
        stream: false,
      },
    };
    const payload = buildOpenCodeZenPayload(body);
    const messages = payload.messages as Array<{ role: string; content: string }>;
    assert.equal(messages[0].role, "system", "developer role should be normalised to system");
    assert.equal(messages[0].content, "You are a helpful assistant.");
    assert.equal(messages[1].role, "user");
  });

  it("accumulates SSE streaming text and token usage", () => {
    const accumulator = new OpenCodeZenSseAccumulator();

    const chunk1 = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n';
    const chunk2 = 'data: {"choices":[{"delta":{"content":" World"}}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n';

    const usage1 = accumulator.append(chunk1);
    assert.equal(usage1, null);
    assert.equal(accumulator.getText(), "Hello");

    const usage2 = accumulator.append(chunk2);
    assert.notEqual(usage2, null);
    assert.equal(usage2?.inputTokens, 10);
    assert.equal(usage2?.outputTokens, 2);
    assert.equal(accumulator.getText(), "Hello World");

    const finalUsage = accumulator.final();
    assert.equal(finalUsage?.inputTokens, 10);
    assert.equal(finalUsage?.outputTokens, 2);
  });

  it("provides a benchmark spec", () => {
    const spec = getBenchmarkSpec();
    assert.equal(spec.body.model, "big-pickle");
    const raw = JSON.stringify({
      choices: [{ message: { content: "OK" } }],
      usage: { prompt_tokens: 5, completion_tokens: 1 },
    });
    assert.equal(spec.parseText(raw), "OK");
    assert.equal(spec.parseUsage(raw)?.outputTokens, 1);
  });

  it("builds a Responses payload for Muse Spark", () => {
    const payload = buildOpenCodeZenResponsesPayload({
      project: "",
      model: "muse-spark-1.3-contributor-free",
      request: {
        messages: [
          { role: "system", content: "Be concise." },
          { role: "user", content: "Hello" },
        ],
        max_tokens: 16,
        stream: false,
      },
    });

    assert.equal(payload.model, "muse-spark-1.3-contributor-free");
    assert.equal(payload.instructions, "Be concise.");
    assert.deepEqual(payload.input, [
      { role: "user", content: [{ type: "input_text", text: "Hello" }] },
    ]);
    assert.equal(payload.max_output_tokens, 16);
    assert.equal(payload.stream, false);
    assert.equal(payload.store, false);
  });

  it("parses and transforms Responses output for compatibility clients", async () => {
    const raw = JSON.stringify({
      id: "resp_muse",
      object: "response",
      status: "completed",
      model: "muse-spark-1.3-contributor-free",
      output: [{
        type: "message",
        content: [{ type: "output_text", text: "Hello from Muse" }],
      }],
      output_text: "Hello from Muse",
      usage: {
        input_tokens: 11,
        output_tokens: 4,
        total_tokens: 15,
        input_tokens_details: { cached_tokens: 7 },
      },
    });
    const parsed = parseOpenCodeZenResponsesJson(raw);
    assert.equal(parsed.text, "Hello from Muse");
    assert.equal(parsed.inputTokens, 11);
    assert.equal(parsed.outputTokens, 4);
    assert.equal(parsed.cachedTokens, 7);
    assert.equal(parsed.responseId, "resp_muse");

    const upstream = new Response([
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","delta":"Hello"}\n\n',
      'event: response.completed\n',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":3,"input_tokens_details":{"cached_tokens":1}}}}\n\n',
    ].join("")).body;
    assert.ok(upstream);
    const chatStream = transformOpenCodeZenResponsesStream(
      upstream,
      "muse-spark-1.3-contributor-free",
    );
    const chatSse = await new Response(chatStream).text();
    assert.match(chatSse, /"content":"Hello"/);
    assert.match(chatSse, /"prompt_tokens":2/);
    assert.match(chatSse, /"completion_tokens":3/);
    assert.match(chatSse, /"cached_tokens":1/);
  });

  it("parses Responses stream events and tracks tool calls", () => {
    const parser = new OpenCodeZenResponsesStreamParser();
    const updates = parser.append([
      'event: response.output_item.added\n',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_item","type":"function_call","call_id":"call_1","name":"lookup","arguments":""}}\n\n',
      'event: response.function_call_arguments.delta\n',
      'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"q\\":\\"pi\\"}"}\n\n',
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","delta":"done"}\n\n',
    ].join(""));

    assert.deepEqual(updates.map((update) => update.kind), ["tool-start", "tool-delta", "text"]);
    const completion = parser.toCompletion();
    assert.equal(completion.text, "done");
    assert.equal(completion.toolCalls?.[0]?.function.name, "lookup");
    assert.equal(completion.toolCalls?.[0]?.function.arguments, '{"q":"pi"}');
  });

  it("routes Muse to Responses and supplies OpenCode session headers", async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    let capturedHeaders: Headers | undefined;
    globalThis.fetch = (async (input, init) => {
      capturedUrl = String(input);
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({
        id: "resp_muse",
        object: "response",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          input_tokens_details: { cached_tokens: 1 },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    try {
      const account = {
        config: {
          email: "zen-test@opencode.ai",
          credentials: [{ provider: OPENCODE_ZEN_PROVIDER_ID, apiKey: "zen-secret-key" }],
        },
      } as AccountRuntime;
      const forwarded = await forwardRequest(account, {
        project: "",
        model: "muse-spark-1.3-contributor-free",
        requestType: "openai-chat",
        request: {
          messages: [{ role: "user", content: "Hello" }],
          stream: false,
          max_tokens: 16,
        },
      }, {});

      assert.equal(capturedUrl, OPENCODE_ZEN_RESPONSES_URL);
      const input = capturedBody.input as Array<{ role?: string }> | undefined;
      assert.equal(input?.[0]?.role, "user");
      assert.equal(capturedBody.max_output_tokens, 16);
      assert.match(capturedHeaders?.get("x-opencode-session") ?? "", /^zen-session-/);
      const chatResponse = await forwarded.response.json() as {
        object: string;
        choices: Array<{ message: { content: string } }>;
        usage: { prompt_tokens_details?: { cached_tokens?: number } };
      };
      assert.equal(chatResponse.object, "chat.completion");
      assert.equal(chatResponse.choices[0].message.content, "OK");
      assert.equal(chatResponse.usage.prompt_tokens_details?.cached_tokens, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("translates Muse Responses streams for Chat-compatible callers", async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    globalThis.fetch = (async (input, init) => {
      capturedUrl = String(input);
      assert.equal(new Headers(init?.headers).get("x-opencode-session")?.startsWith("zen-session-"), true);
      return new Response([
        'event: response.output_text.delta\n',
        'data: {"type":"response.output_text.delta","delta":"streamed"}\n\n',
        'event: response.completed\n',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2,"input_tokens_details":{"cached_tokens":2}}}}\n\n',
      ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    try {
      const account = {
        config: {
          email: "zen-test@opencode.ai",
          credentials: [{ provider: OPENCODE_ZEN_PROVIDER_ID, apiKey: "zen-secret-key" }],
        },
      } as AccountRuntime;
      const forwarded = await forwardRequest(account, {
        project: "",
        model: "muse-spark-1.3-contributor-free",
        requestType: "openai-chat",
        request: {
          messages: [{ role: "user", content: "Hello" }],
          stream: true,
        },
      }, {});
      const chatSse = await forwarded.response.text();

      assert.equal(capturedUrl, OPENCODE_ZEN_RESPONSES_URL);
      assert.match(chatSse, /"content":"streamed"/);
      assert.match(chatSse, /"prompt_tokens":3/);
      assert.match(chatSse, /"completion_tokens":2/);
      assert.match(chatSse, /"cached_tokens":2/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fetches quota pool status", async () => {
    const account: AccountRuntime = {
      config: {
        email: "test@opencode.ai",
        credentials: [{ provider: OPENCODE_ZEN_PROVIDER_ID, apiKey: "valid-key" }],
      },
      accessToken: null,
      tokenExpires: 0,
      requestsSinceRotation: 0,
      totalRequests: 0,
      cooldownsByModel: {},
      quotaExhaustedAt: 0,
      quota: [],
      lastQuotaPoll: 0,
      lastUsed: 0,
      lastError: null,
      consecutiveErrors: 0,
      disabled: false,
      flagged: false,
      inFlightRequests: 0,
      inFlightByModel: {},
      allowFreshWindowStartsOverride: false,
      dailyRequestCount: 0,
      dailyRequestDay: "2026-08-12",
      healthScore: 100,
      tokenBucket: { tokens: 10, lastRefillAt: Date.now() },
    };

    const ctx: QuotaFetchContext = {
      log: () => {},
      markFlagged: () => {},
      reportQuotaPollFlag: () => {},
    };

    // Global fetch mock for testing
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr === OPENCODE_ZEN_MODELS_URL) {
        return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    try {
      await fetchOpenCodeZenQuota(account, ctx);
      assert.equal(account.quota.length, 1);
      assert.equal(account.quota[0].providerId, OPENCODE_ZEN_PROVIDER_ID);
      assert.equal(account.quota[0].displayName, "OpenCode");
      assert.equal(account.quota[0].percentRemaining, 100);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("parses OpenAI JSON response correctly", () => {
    const rawJson = JSON.stringify({
      id: "chatcmpl-123",
      object: "chat.completion",
      choices: [
        {
          message: {
            role: "assistant",
            content: "Hello from DeepSeek!",
            reasoning_content: "Thinking step 1",
          },
        },
      ],
      usage: {
        prompt_tokens: 15,
        completion_tokens: 5,
      },
    });

    const parsed = parseOpenAiJson(rawJson);
    assert.equal(parsed.text, "Hello from DeepSeek!");
    assert.equal(parsed.thinkingText, "Thinking step 1");
    assert.equal(parsed.inputTokens, 15);
    assert.equal(parsed.outputTokens, 5);
    assert.equal(parsed.responseId, "chatcmpl-123");
  });

  it("parses SSE fallback in parseOpenAiJson if raw response contains SSE lines", () => {
    const rawSse =
      'data: {"choices":[{"delta":{"reasoning_content":"Thinking..."}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"Hello world!"}}],"usage":{"prompt_tokens":10,"completion_tokens":4}}\n\n' +
      'data: [DONE]\n\n';

    const parsed = parseOpenAiJson(rawSse);
    assert.equal(parsed.text, "Hello world!");
    assert.equal(parsed.thinkingText, "Thinking...");
    assert.equal(parsed.inputTokens, 10);
    assert.equal(parsed.outputTokens, 4);
  });

  it("parses SSE tool_calls across split chunks in parseOpenAiJson", () => {
    const rawSse =
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-webfetch-123","type":"function","function":{"name":"WebFetch","arguments":""}}]}}]}\n\n' +
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"url\\":\\"https://example.com\\"}"}}]}}]}\n\n' +
      'data: [DONE]\n\n';

    const parsed = parseOpenAiJson(rawSse);
    assert.ok(parsed.toolCalls);
    assert.equal(parsed.toolCalls.length, 1);
    assert.equal(parsed.toolCalls[0].id, "call-webfetch-123");
    assert.equal(parsed.toolCalls[0].function.name, "WebFetch");
    assert.equal(parsed.toolCalls[0].function.arguments, '{"url":"https://example.com"}');
  });

  it("converts Anthropic messages request to OpenAI chat request", () => {
    const anthropicReq = {
      model: "big-pickle",
      messages: [{ role: "user" as const, content: "Hi" }],
      system: "You are helpful",
      max_tokens: 100,
    };

    const converted = anthropicToOpenAIChatRequest(anthropicReq);
    assert.equal(converted.model, "big-pickle");
    assert.equal(converted.messages.length, 2);
    assert.equal(converted.messages[0].role, "system");
    assert.equal(converted.messages[0].content, "You are helpful");
    assert.equal(converted.messages[1].role, "user");
    assert.equal(converted.messages[1].content, "Hi");
  });
});
