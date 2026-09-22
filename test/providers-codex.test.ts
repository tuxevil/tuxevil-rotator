import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCodexAuthorizationUrl,
  createOAuthState,
  generatePKCE,
  getCodexOAuthConfig,
  refreshCodexToken,
  startCodexCallbackServer,
  CodexOAuthError,
} from "../src/providers/openai-codex/oauth.js";
import { parseCodexAuthImport } from "../src/providers/openai-codex/login.js";
import {
  buildCodexPayload,
  consumeCodexKickstartResponse,
  extractCodexUsage,
  forwardCodexRequest,
  sanitizeCodexResponsesRequest,
} from "../src/providers/openai-codex/forward.js";
import {
  chatToCodexResponsesRequest,
  parseCodexResponseBody,
  parseCodexResponse,
} from "../src/providers/openai-codex/compat.js";
import { isCodexModelForRotator } from "../src/compat.js";
import {
  CODEX_QUOTA_MODEL_KEY,
  CODEX_UNSTARTED_TIMER_THRESHOLD_SECONDS,
  codexQuotaRows,
  parseCodexUsageResponse,
} from "../src/providers/openai-codex/quota.js";
import {
  CODEX_BASE_MODELS,
  isCodexModel,
  isCodexRequestModel,
  setDiscoveredCodexModels,
} from "../src/providers/openai-codex/catalog.js";
import type { AccountRuntime } from "../src/types.js";
import type { AccountRotator } from "../src/rotator.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  setDiscoveredCodexModels([]);
});

describe("openai-codex OAuth", () => {
  it("includes GPT-6 models and keeps the GPT-5.6 Codex models", () => {
    assert.deepEqual(
      CODEX_BASE_MODELS.map((model) => model.id),
      [
        "gpt-6-astra",
        "gpt-6-sol",
        "gpt-6-luna",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
      ],
    );
    assert.equal(isCodexModel("gpt-6-astra"), true);
    assert.equal(isCodexModel("gpt-6-sol"), true);
    assert.equal(isCodexModel("gpt-6-luna"), true);
    assert.equal(isCodexModel("gpt-5.6-luna"), true);
    assert.equal(isCodexModel("gpt-5-codex"), false);
    assert.equal(isCodexModel("gpt-5.6-sol"), true);
    assert.equal(isCodexRequestModel("gpt-5.6-sol"), true);
  });

  it("does not classify Google models returned by Codex discovery", () => {
    setDiscoveredCodexModels([
      {
        id: "claude-sonnet-4-6",
        contextWindow: 500_000,
        reasoning: true,
        multimodal: true,
        tools: true,
        source: "discovered",
      },
      {
        id: "gpt-oss-120b-medium",
        contextWindow: 131_072,
        reasoning: true,
        multimodal: false,
        tools: true,
        source: "discovered",
      },
      {
        id: "gpt-5.6-nova",
        contextWindow: 272_000,
        reasoning: true,
        multimodal: true,
        tools: true,
        source: "discovered",
      },
      {
        id: "gpt-5.6-sol",
        contextWindow: 272_000,
        reasoning: true,
        multimodal: true,
        tools: true,
        source: "discovered",
      },
      {
        id: "gpt-6-codex-preview",
        contextWindow: 272_000,
        reasoning: true,
        multimodal: true,
        tools: true,
        source: "discovered",
      },
    ]);

    assert.equal(isCodexModel("claude-sonnet-4-6"), false);
    assert.equal(isCodexModel("gpt-oss-120b-medium"), false);
    assert.equal(isCodexModel("gpt-5.6-nova"), true);
    assert.equal(isCodexModel("gpt-5.6-sol"), true);
    assert.equal(isCodexModel("gpt-6-codex-preview"), true);
  });

  it("does not route non-Codex models from a contaminated rotator catalog", () => {
    const rotator = {
      getCodexModels: () => ["claude-sonnet-4-6", "gpt-oss-120b-medium"],
    } as unknown as AccountRotator;

    assert.equal(isCodexModelForRotator(rotator, "claude-sonnet-4-6"), false);
    assert.equal(isCodexModelForRotator(rotator, "gpt-oss-120b-medium"), false);
  });

  it("routes paid-only Codex models to Codex", () => {
    const rotator = {
      getCodexModels: () => ["gpt-5.6-terra", "gpt-5.6-luna"],
    } as unknown as AccountRotator;

    assert.equal(isCodexModelForRotator(rotator, "gpt-5.6-sol"), true);
  });

  it("generates S256 PKCE and a state-bound URL", () => {
    const { verifier, challenge } = generatePKCE();
    assert.ok(verifier.length >= 40);
    assert.match(challenge, /^[A-Za-z0-9_-]+$/);
    const defaultConfig = getCodexOAuthConfig();
    assert.equal(defaultConfig.redirectUri, "http://localhost:1455/auth/callback");
    const config = getCodexOAuthConfig({ CODEX_OAUTH_REDIRECT_URI: "http://127.0.0.1:1999/auth/callback" });
    const url = new URL(buildCodexAuthorizationUrl(config, createOAuthState(), challenge));
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("redirect_uri"), config.redirectUri);
    assert.equal(url.searchParams.get("scope"), "openid profile email offline_access");
    assert.equal(url.searchParams.get("originator"), "codex_cli_rs");
    assert.equal(url.searchParams.get("prompt"), "login");
  });

  it("rejects an invalid callback state and accepts a valid callback", async () => {
    const state = createOAuthState();
    const callback = await startCodexCallbackServer(state, {
      callbackHost: "127.0.0.1",
      callbackPort: 0,
      redirectUri: "http://127.0.0.1:0/auth/callback",
    });
    try {
      const invalid = await fetch(`${callback.address}?code=secret-code&state=wrong`);
      assert.equal(invalid.status, 400);
      const validUrl = `${callback.address}?code=oauth-code&state=${encodeURIComponent(state)}`;
      const valid = await fetch(validUrl);
      assert.equal(valid.status, 200);
      assert.equal(await callback.waitForCode(), "oauth-code");
    } finally {
      await callback.close();
    }
  });

  it("classifies refresh errors without echoing token material", async () => {
    const secret = "refresh-secret-value";
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "invalid_grant", refresh_token: secret }), { status: 401 })) as typeof fetch;
    await assert.rejects(
      () => refreshCodexToken(secret, getCodexOAuthConfig({ CODEX_OAUTH_TOKEN_URL: "https://example.invalid/token" })),
      (error: unknown) => {
        assert.ok(error instanceof CodexOAuthError);
        assert.equal(error.code, "invalid_grant");
        assert.equal(error.reloginRequired, true);
        assert.equal((error as Error).message.includes(secret), false);
        return true;
      },
    );
  });
});

describe("openai-codex import and payload", () => {
  it("imports nested Codex CLI auth.json and keeps only refresh credentials", () => {
    const parsed = parseCodexAuthImport({
      tokens: {
        access_token: "access-secret",
        refresh_token: "refresh-secret",
        id_token: "not-a-jwt",
      },
      email: "codex@example.com",
      account_id: "acct-1",
    });
    assert.equal(parsed.account.email, "codex@example.com");
    assert.deepEqual(parsed.account.credentials, [{ provider: "openai-codex", refreshToken: "refresh-secret", providerAccountId: "acct-1" }]);
    assert.equal(parsed.account.refreshToken, undefined);
  });

  it("accepts a flat export and rejects missing refresh tokens", () => {
    const parsed = parseCodexAuthImport({ access_token: "a", refresh_token: "r", email: "flat@example.com" });
    assert.equal(parsed.account.credentials?.[0]?.refreshToken, "r");
    assert.throws(() => parseCodexAuthImport({ access_token: "a", email: "flat@example.com" }), /refresh_token is required/);
  });

  it("defaults store=false and strips persistent references and inherited auth", () => {
    const body = buildCodexPayload({
      model: "gpt-5.6-luna",
      project: "",
      request: { input: "hello", previous_response_id: "resp_1", conversation: "conv_1", stream: true },
    });
    assert.equal(body.store, false);
    assert.equal(body.previous_response_id, undefined);
    const request = sanitizeCodexResponsesRequest({ store: true, input_items: ["old"], background: true }, "gpt-5.6-luna");
    assert.equal(request.store, false);
    assert.equal(request.stream, true);
    assert.equal(request.instructions, "You are a helpful assistant.");
    assert.deepEqual(
      sanitizeCodexResponsesRequest({
        tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
        tool_choice: { type: "function", function: { name: "lookup" } },
      }, "gpt-5.6-luna"),
      {
        tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
        tool_choice: { type: "function", name: "lookup" },
        model: "gpt-5.6-luna",
        instructions: "You are a helpful assistant.",
        store: false,
        stream: true,
      },
    );
    assert.equal(request.input_items, undefined);
    assert.equal(request.background, undefined);
    const stringInputRequest = sanitizeCodexResponsesRequest({
      input: "hello",
      max_output_tokens: 16,
    }, "gpt-5.6-luna");
    assert.deepEqual(stringInputRequest.input, [
      { role: "user", content: [{ type: "input_text", text: "hello" }] },
    ]);
    assert.equal("max_output_tokens" in stringInputRequest, false);
  });

  it("drains successful kickstart SSE and surfaces streamed failures", async () => {
    const completed = new Response([
      "event: response.completed\n",
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
    ].join(""), { status: 200 });
    await consumeCodexKickstartResponse(completed);
    assert.equal(completed.bodyUsed, true);

    const failed = new Response([
      "event: response.failed\n",
      'data: {"type":"response.failed","error":{"message":"model unavailable"}}\n\n',
    ].join(""), { status: 200 });
    await assert.rejects(
      consumeCodexKickstartResponse(failed),
      /model unavailable/,
    );
  });

  it("extracts Responses usage and chooses the worst quota window", () => {
    assert.deepEqual(extractCodexUsage('data: {"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":7}}}\n\n'), { inputTokens: 12, outputTokens: 7 });
    const snapshot = parseCodexUsageResponse({ rate_limit: { primary_window: { used_percent: 20, reset_after_seconds: 100 }, secondary_window: { used_percent: 80, reset_after_seconds: 200 } } });
    assert.ok(snapshot);
    const rows = codexQuotaRows(snapshot!);
    assert.equal(rows[0]?.modelKey, CODEX_QUOTA_MODEL_KEY);
    assert.equal(rows[0]?.percentRemaining, 20);
  });

  it("treats the Codex 30-day reset sentinel as an unstarted timer", () => {
    const unstarted = parseCodexUsageResponse({
      rate_limit: {
        primary_window: {
          used_percent: 0,
          reset_after_seconds: CODEX_UNSTARTED_TIMER_THRESHOLD_SECONDS + 1,
        },
        secondary_window: {
          used_percent: 0,
          reset_after_seconds: CODEX_UNSTARTED_TIMER_THRESHOLD_SECONDS + 1,
        },
      },
    });
    const [unstartedRow] = codexQuotaRows(unstarted!);
    assert.equal(unstartedRow?.timerType, "fresh");
    assert.equal(unstartedRow?.resetTime, null);

    const started = parseCodexUsageResponse({
      rate_limit: {
        primary_window: {
          used_percent: 0,
          reset_after_seconds: CODEX_UNSTARTED_TIMER_THRESHOLD_SECONDS,
        },
        secondary_window: {
          used_percent: 0,
          reset_after_seconds: CODEX_UNSTARTED_TIMER_THRESHOLD_SECONDS,
        },
      },
    });
    const [startedRow] = codexQuotaRows(started!);
    assert.equal(startedRow?.timerType, "7d");
    assert.ok(startedRow?.resetTime);
  });

  it("forwards only Codex authentication and the provider-scoped account id", async () => {
    const account = {
      config: {
        email: "codex@example.com",
        credentials: [{ provider: "openai-codex", refreshToken: "refresh", providerAccountId: "acct-codex" }],
      },
      providerTokens: { "openai-codex": { accessToken: "codex-access", tokenExpires: Date.now() + 60_000 } },
    } as unknown as AccountRuntime;
    const original = globalThis.fetch;
    let received: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
    globalThis.fetch = (async (input, init) => {
      received = {
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      return new Response(JSON.stringify({ id: "resp_1", output: [] }), { status: 200 });
    }) as typeof fetch;
    try {
      await forwardCodexRequest(
        account,
        { project: "", model: "gpt-5.6-luna", request: { input: "hello", stream: false } },
        {
          authorization: "Bearer inherited-google",
          accept: "*/*",
          "content-type": "application/json",
          "user-agent": "OpenAI/1.0.0",
          "x-goog-api-key": "google-secret",
          "x-ollama-key": "ollama-secret",
        },
      );
    } finally {
      globalThis.fetch = original;
    }
    assert.ok(received);
    assert.match(received.url, /chatgpt\.com\/backend-api\/codex\/responses$/);
    assert.equal(received.headers.get("authorization"), "Bearer codex-access");
    assert.equal(received.headers.get("chatgpt-account-id"), "acct-codex");
    assert.equal(received.headers.get("accept"), "text/event-stream");
    assert.equal(received.headers.get("content-type"), "application/json");
    assert.equal(received.headers.get("openai-beta"), "responses=v1");
    assert.equal(received.headers.get("user-agent"), "tuxevil-rotator/openai-codex");
    assert.equal(received.headers.get("x-goog-api-key"), null);
    assert.equal(received.headers.get("x-ollama-key"), null);
    assert.equal(received.body.store, false);
  });

  it("converts Chat tools and Responses output back without losing arguments", () => {
    const converted = chatToCodexResponsesRequest({
      model: "gpt-5.6-luna",
      messages: [
        { role: "user", content: [{ type: "text", text: "Call the tool" }] },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }] },
        { role: "tool", tool_call_id: "call_1", content: "result" },
      ],
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
      tool_choice: { type: "function", function: { name: "lookup" } },
      stream: false,
    } as never);
  assert.equal(converted.instructions, "You are a helpful assistant.");
  assert.equal(converted.stream, true);
    assert.equal("max_output_tokens" in converted, false);
    assert.deepEqual(converted.tools, [{ type: "function", name: "lookup", parameters: { type: "object" } }]);
    assert.deepEqual(converted.tool_choice, { type: "function", name: "lookup" });
    assert.equal(converted.store, false);
    assert.deepEqual(converted.input, [
      { role: "user", content: [{ type: "input_text", text: "Call the tool" }] },
      { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"q":"x"}' },
      { type: "function_call_output", call_id: "call_1", output: "result" },
    ]);
    const completion = parseCodexResponse(JSON.stringify({
      output: [
        { type: "message", content: [{ type: "output_text", text: "done" }] },
        { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"q":"x"}' },
      ],
      usage: { input_tokens: 3, output_tokens: 2 },
    }));
    assert.equal(completion.text, "done");
    assert.equal(completion.toolCalls?.[0]?.function.arguments, '{"q":"x"}');
    assert.equal(completion.inputTokens, 3);
  });

  it("preserves function calls when Codex returns SSE for a non-stream request", () => {
    const completion = parseCodexResponseBody([
      "event: response.output_item.added\n",
      'data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_1","name":"lookup"}}\n\n',
      "event: response.function_call_arguments.delta\n",
      'data: {"type":"response.function_call_arguments.delta","delta":"{\\"q\\":\\"x\\"}"}\n\n',
      "event: response.output_item.done\n",
      'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","name":"lookup","arguments":"{\\"q\\":\\"x\\"}"}}\n\n',
      "event: response.completed\n",
      'data: {"type":"response.completed","response":{"output":[],"usage":{"input_tokens":3,"output_tokens":2}}}\n\n',
    ].join(""));
    assert.equal(completion.text, "");
    assert.deepEqual(completion.toolCalls?.[0], {
      id: "call_1",
      type: "function",
      function: { name: "lookup", arguments: '{"q":"x"}' },
    });
  });
});
