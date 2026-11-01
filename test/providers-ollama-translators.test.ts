import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  openAIToOllamaBody,
  anthropicToOllamaBody,
  parseOllamaNdjson,
} from "../src/providers/ollama/translators.js";
import { getModelSpec } from "../src/compat/model-specs.js";

describe("openAIToOllamaBody", () => {
  it("maps chat messages, stream flag, temperature and num_predict", () => {
    const body = openAIToOllamaBody({
      model: "gpt-oss:20b",
      stream: false,
      temperature: 0.5,
      max_tokens: 256,
      messages: [
        { role: "system", content: "Be concise" },
        { role: "user", content: "ping" },
      ],
    });
    assert.equal(body.model, "gpt-oss:20b");
    const request = body.request as Record<string, unknown>;
    assert.equal(request.stream, false);
    const messages = request.messages as Array<Record<string, unknown>>;
    assert.deepEqual(messages, [
      { role: "system", content: "Be concise" },
      { role: "user", content: "ping" },
    ]);
    const options = request.options as Record<string, unknown>;
    assert.equal(options.temperature, 0.5);
    assert.equal(options.num_predict, 256);
  });

  it("defaults num_predict to the catalog default when no max tokens given", () => {
    const body = openAIToOllamaBody({
      model: "gpt-oss:20b",
      messages: [{ role: "user", content: "hi" }],
    });
    const options = (body.request as Record<string, unknown>)
      .options as Record<string, unknown>;
    assert.equal(options.num_predict, getModelSpec("gpt-oss:20b")?.maxOutputTokens ?? 65536);
  });

  it("preserves assistant tool_calls and tool results", () => {
    const body = openAIToOllamaBody({
      model: "gpt-oss:20b",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "lookup", arguments: '{"q":"x"}' },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: "result",
        },
        { role: "user", content: "thanks" },
      ],
    });
    const messages = (body.request as { messages: unknown }).messages as Array<
      Record<string, unknown>
    >;
    assert.equal(messages[0].role, "assistant");
    const toolCalls = messages[0].tool_calls as Array<Record<string, unknown>>;
    assert.equal(toolCalls[0].id, "call_1");
    // Ollama expects arguments as an object (OpenAI sends a JSON string).
    assert.deepEqual(
      (toolCalls[0].function as Record<string, unknown>).arguments,
      { q: "x" },
    );
    assert.equal(messages[1].role, "tool");
    assert.equal(messages[1].tool_call_id, "call_1");
  });

  it("converts image content parts to data URLs", () => {
    const body = openAIToOllamaBody({
      model: "gpt-oss:20b",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: "YWJjZA==",
              },
            },
          ],
        },
      ],
    });
    const messages = (body.request as { messages: unknown }).messages as Array<
      Record<string, unknown>
    >;
    const content = messages[0].content as Array<Record<string, unknown>>;
    assert.equal(content[0].type, "text");
    assert.equal(content[1].type, "image_url");
    assert.equal(
      (content[1].image_url as Record<string, string>).url,
      "data:image/jpeg;base64,YWJjZA==",
    );
  });

  it("passes tools through to the ollama payload", () => {
    const body = openAIToOllamaBody({
      model: "gpt-oss:20b",
      tools: [
        {
          type: "function",
          function: { name: "lookup", parameters: { type: "object" } },
        },
      ],
      messages: [{ role: "user", content: "use tools" }],
    });
    const request = body.request as Record<string, unknown>;
    const tools = request.tools as Array<Record<string, unknown>>;
    assert.equal(tools.length, 1);
    assert.equal((tools[0].function as Record<string, unknown>).name, "lookup");
  });
});

describe("anthropicToOllamaBody", () => {
  it("converts anthropic messages to ollama native shape", () => {
    const body = anthropicToOllamaBody({
      model: "anthropic/claude-3.5-haiku:beta",
      max_tokens: 128,
      system: "You are a helpful assistant",
      messages: [{ role: "user", content: "hello" }],
    });
    const request = body.request as Record<string, unknown>;
    const messages = request.messages as Array<Record<string, unknown>>;
    assert.deepEqual(messages, [
      { role: "system", content: "You are a helpful assistant" },
      { role: "user", content: "hello" },
    ]);
    const options = request.options as Record<string, unknown>;
    assert.equal(options.num_predict, 128);
  });

  it("converts tool_use and tool_result round-trips", () => {
    const body = anthropicToOllamaBody({
      model: "anthropic/claude-3.5-haiku:beta",
      max_tokens: 128,
      tools: [
        {
          name: "lookup",
          description: "Look things up",
          input_schema: { type: "object", properties: { q: { type: "string" } } },
        },
      ],
      tool_choice: { type: "tool", name: "lookup" },
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "checking" },
            { type: "tool_use", id: "tu_1", name: "lookup", input: { q: "x" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: "found it" },
          ],
        },
      ],
    });
    const request = body.request as Record<string, unknown>;
    const messages = request.messages as Array<Record<string, unknown>>;
    assert.equal(messages[0].role, "assistant");
    const toolCalls = messages[0].tool_calls as Array<Record<string, unknown>>;
    assert.equal((toolCalls[0].function as Record<string, unknown>).name, "lookup");
    assert.deepEqual(
      (toolCalls[0].function as Record<string, unknown>).arguments,
      { q: "x" },
    );
    assert.equal(messages[1].role, "tool");
    assert.equal(messages[1].tool_call_id, "tu_1");
  });
});

describe("parseOllamaNdjson", () => {
  it("concatenates content deltas and reads usage from the done record", () => {
    const raw = [
      JSON.stringify({
        model: "gpt-oss:20b",
        created_at: "2026-01-01T00:00:00Z",
        message: { role: "assistant", content: "Hel" },
        done: false,
      }),
      JSON.stringify({
        model: "gpt-oss:20b",
        created_at: "2026-01-01T00:00:01Z",
        message: { role: "assistant", content: "lo" },
        done: false,
      }),
      JSON.stringify({
        model: "gpt-oss:20b",
        created_at: "2026-01-01T00:00:02Z",
        message: { role: "assistant", content: "" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 11,
        eval_count: 7,
      }),
    ].join("\n");
    const completion = parseOllamaNdjson(raw);
    assert.equal(completion.text, "Hello");
    assert.equal(completion.inputTokens, 11);
    assert.equal(completion.outputTokens, 7);
  });

  it("collects tool calls from streamed records", () => {
    const raw = [
      JSON.stringify({
        model: "gpt-oss:20b",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              function: {
                name: "lookup",
                arguments: '{"q":"x"}',
              },
            },
          ],
        },
        done: false,
      }),
      JSON.stringify({
        model: "gpt-oss:20b",
        message: { role: "assistant", content: "" },
        done: true,
        prompt_eval_count: 3,
        eval_count: 4,
      }),
    ].join("\n");
    const completion = parseOllamaNdjson(raw);
    assert.equal(completion.toolCalls?.length, 1);
    assert.equal(
      completion.toolCalls?.[0].function.name,
      "lookup",
    );
    assert.equal(
      completion.toolCalls?.[0].function.arguments,
      '{"q":"x"}',
    );
    assert.equal(completion.inputTokens, 3);
    assert.equal(completion.outputTokens, 4);
  });
});
it("rejects Ollama error and malformed bodies instead of producing empty successes", () => {
  assert.ok(parseOllamaNdjson('{"error":"private upstream detail"}').streamError);
  assert.ok(parseOllamaNdjson('not-json').streamError);
  assert.ok(parseOllamaNdjson('{"done":true,"message":{"content":""}}').streamError);
  assert.doesNotMatch(parseOllamaNdjson('{"error":"private upstream detail"}').streamError ?? "", /private upstream detail/);
});

it("preserves reasoning and limit metadata but rejects a missing final answer", () => {
  const result = parseOllamaNdjson(JSON.stringify({ message: { content: "", thinking: "reasoning" }, done: true, done_reason: "length", eval_count: 32 }));
  assert.equal(result.thinkingText, "reasoning");
  assert.equal(result.finishReason, "MAX_TOKENS");
  assert.match(result.streamError ?? "", /no completion content/);
});


it("accepts pretty-printed nonstreaming Ollama JSON", () => {
  const result = parseOllamaNdjson(JSON.stringify({ message: { content: "answer" }, done: true, eval_count: 1 }, null, 2));
  assert.equal(result.text, "answer");
  assert.equal(result.streamError, undefined);
});
