import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyCompletion,
  buildChatRequest,
  complianceRequest,
  emptyResult,
  errorVerdict,
  evaluateCompliance,
  isAudioOnlyModel,
  newDocument,
  newPanel,
  SseDecoder,
  userMessage,
} from "../src/web/lib/playground.js";
import { parsePlaygroundDocument } from "../src/web/lib/playground-storage.js";
import {
  PlaygroundError,
  runChat,
} from "../src/web/state/playground-client.js";

const completion = (content = "hello") => ({
  choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 7, completion_tokens: 2 },
});
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
const chunk = (text: string, finish: string | null = null) => ({
  choices: [{ delta: { content: text }, finish_reason: finish }],
});
const fetcher =
  (response: Response): typeof fetch =>
  async () =>
    response;
const request = complianceRequest("test-model", "basic");

describe("playground request and history contracts", () => {
  it("keeps comparison histories independent and omits failed/incomplete tool turns", () => {
    const left = newPanel();
    left.model = "left";
    const right = newPanel();
    right.model = "right";
    const result = { ...emptyResult(), done: true, content: "left answer" };
    left.turns.push({
      request: {
        ...request,
        messages: [{ role: "user", content: "left only" }],
      },
      result,
    });
    left.turns.push({ request, result, error: "interrupted" });
    const message = userMessage("next", []);
    assert.deepEqual(
      buildChatRequest(left, message).messages.map((m) => m.content),
      ["left only", "left answer", "next"],
    );
    assert.deepEqual(
      buildChatRequest(right, message).messages.map((m) => m.content),
      ["next"],
    );
    assert.deepEqual(
      buildChatRequest(left, message, true).messages.map((m) => m.content),
      ["left only", "left answer", "next"],
    );
    left.turns[0].result!.tools = [
      {
        id: "call1",
        type: "function",
        function: { name: "test", arguments: "{}" },
      },
    ];
    assert.deepEqual(
      buildChatRequest(left, message).messages.map((m) => m.content),
      ["next"],
    );
  });
  it("sends images and validates parameters before issuing requests", () => {
    const panel = newPanel();
    panel.model = "vision";
    panel.params.system = "describe images";
    panel.params.tools =
      '[{"type":"function","function":{"name":"test","parameters":{"type":"object"}}}]';
    const image = { name: "test.png", url: "data:image/png;base64,aGVsbG8=" };
    const built = buildChatRequest(panel, userMessage("describe", [image]));
    assert.equal(built.messages[0].role, "system");
    assert.deepEqual(built.messages[1].content, [
      { type: "text", text: "describe" },
      { type: "image_url", image_url: { url: image.url } },
    ]);
    assert.equal(built.tools?.length, 1);
    panel.params.temperature = "NaN";
    assert.throws(
      () => buildChatRequest(panel, userMessage("test", [])),
      /Temperature/,
    );
    panel.params.temperature = "";
    panel.params.tools = "{}";
    assert.throws(
      () => buildChatRequest(panel, userMessage("test", [])),
      /JSON array/,
    );
  });
  it("round trips images and results, rejects unsafe images and incompatible imports", () => {
    const doc = newDocument();
    doc.images.push({
      name: "tiny.png",
      url: "data:image/png;base64,aGVsbG8=",
    });
    const result = emptyResult();
    applyCompletion(result, completion(), false, 5);
    result.done = true;
    doc.chat.turns.push({ request, result });
    assert.deepEqual(
      parsePlaygroundDocument(JSON.parse(JSON.stringify(doc))),
      doc,
    );
    const interrupted = structuredClone(doc);
    interrupted.chat.turns.push({ request, result: null });
    assert.match(
      parsePlaygroundDocument(interrupted).chat.turns.at(-1)!.error!,
      /Interrupted/,
    );

    assert.throws(
      () => parsePlaygroundDocument({ ...doc, version: 2 }),
      /unsupported version/,
    );
    assert.throws(
      () =>
        parsePlaygroundDocument({
          ...doc,
          images: [{ name: "bad", url: "javascript:alert(1)" }],
        }),
      /Invalid/,
    );
    assert.throws(
      () =>
        parsePlaygroundDocument({
          ...doc,
          chat: { ...doc.chat, turns: [{ request, result: {} }] },
        }),
      /Invalid/,
    );
    assert.throws(
      () =>
        parsePlaygroundDocument({
          ...doc,
          compare: [doc.compare[0], doc.compare[0]],
        }),
      /Invalid/,
    );
  });
});

describe("playground transport", () => {
  it("uses the admin route, sends same-origin cookies and captures JSON metrics", async () => {
    const result = await runChat(
      request,
      new AbortController().signal,
      undefined,
      async (url, init) => {
        assert.equal(url, "/api/playground/chat/completions");
        assert.equal(init?.credentials, "same-origin");
        assert.deepEqual(JSON.parse(String(init?.body)), request);
        assert.equal(new Headers(init?.headers).has("authorization"), false);
        return Response.json(completion(), {
          headers: { "x-rotator-model": "resolved" },
        });
      },
    );
    assert.equal(result.content, "hello");
    assert.equal(result.done, true);
    assert.equal(result.inputTokens, 7);
    assert.equal(result.outputTokens, 2);
    assert.equal(result.metadata["x-rotator-model"], "resolved");
    assert.ok(result.durationMs >= 0);
    assert.ok(result.firstContentMs !== null);
  });
  it("parses arbitrarily split CRLF SSE, usage frames, UTF-8 and tool deltas", async () => {
    const bytes = new TextEncoder().encode(
      ": comment\r\n\r\n" +
        frame(chunk("hé")) +
        frame(chunk("llo", "stop")) +
        frame({
          choices: [],
          usage: { prompt_tokens: 8, completion_tokens: 3 },
        }) +
        "data: [DONE]\r\n\r\n",
    );
    const response = new Response(
      new ReadableStream({
        start(controller) {
          for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    const progress: string[] = [];
    const result = await runChat(
      { ...request, stream: true },
      new AbortController().signal,
      (r) => progress.push(r.content),
      fetcher(response),
    );
    assert.equal(result.content, "héllo");
    assert.equal(result.outputTokens, 3);
    assert.equal(result.done, true);
    assert.ok(progress.includes("hé"));
    const tool = emptyResult();
    applyCompletion(
      tool,
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "a",
                  function: { name: "echo", arguments: '{"x":' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      true,
      1,
    );
    applyCompletion(
      tool,
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: "1}" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      true,
      2,
    );
    assert.equal(tool.tools[0].function.arguments, '{"x":1}');
  });
  it("preserves partial output on truncated streams and cancels malformed transport", async () => {
    const response = new Response(frame(chunk("partial")), {
      headers: { "content-type": "text/event-stream" },
    });
    await assert.rejects(
      runChat(
        { ...request, stream: true },
        new AbortController().signal,
        undefined,
        fetcher(response),
      ),
      (err: unknown) => {
        assert.ok(err instanceof PlaygroundError);
        assert.equal(err.result.content, "partial");
        assert.equal(err.result.done, false);
        assert.match(err.message, /Stream ended/);
        return true;
      },
    );
    const parser = new SseDecoder(() => {});
    parser.push("data: {bad");
    assert.throws(() => parser.finish(), /Incomplete/);
    let cancelled = false;
    const invalid = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("data: invalid\n\n"));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    await assert.rejects(
      runChat(
        { ...request, stream: true },
        new AbortController().signal,
        undefined,
        fetcher(invalid),
      ),
      PlaygroundError,
    );
    assert.equal(cancelled, true);
  });
  it("propagates cancellation and timeout to fetch", async () => {
    let aborted = 0;
    const waiting: typeof fetch = async (_url, init) =>
      new Promise((_resolve, reject) => {
        const abort = () => {
          aborted++;
          reject(new Error("aborted"));
        };
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      });
    const controller = new AbortController();
    const pending = runChat(request, controller.signal, undefined, waiting);
    controller.abort();
    await assert.rejects(
      pending,
      (err: unknown) => err instanceof PlaygroundError && err.cancelled,
    );
    await assert.rejects(
      runChat(request, new AbortController().signal, undefined, waiting, 5),
      /timed out/,
    );
    assert.equal(aborted, 2);
  });
  it("isolates errors between concurrent model requests and preserves API errors", async () => {
    const results = await Promise.allSettled([
      runChat(
        request,
        new AbortController().signal,
        undefined,
        fetcher(Response.json(completion())),
      ),
      runChat(
        request,
        new AbortController().signal,
        undefined,
        fetcher(
          Response.json(
            { error: { message: "Unsupported response_format" } },
            { status: 400 },
          ),
        ),
      ),
    ]);
    assert.equal(results[0].status, "fulfilled");
    assert.equal(results[1].status, "rejected");
    if (results[1].status === "rejected") {
      assert.equal(results[1].reason.result.status, 400);
      assert.equal(errorVerdict(400, results[1].reason.message), "unsupported");
    }
    assert.equal(errorVerdict(404, "Model not found"), "error");
    assert.equal(errorVerdict(429, "Too many requests"), "error");
  });
});

describe("API compliance evaluators", () => {
  it("requires the actual expected output rather than accepting HTTP success", () => {
    const result = emptyResult();
    applyCompletion(result, completion("ROTATOR_OK"), false, 1);
    result.done = true;
    assert.equal(evaluateCompliance("system", result).verdict, "passed");
    assert.equal(evaluateCompliance("json", result).verdict, "failed");
    result.content = '{"rotator_ok":true}';
    assert.equal(evaluateCompliance("json", result).verdict, "passed");
    result.content = '```json\n{"rotator_ok":true}\n```';
    assert.equal(evaluateCompliance("json", result).verdict, "failed");
    result.tools = [
      {
        id: "call1",
        type: "function",
        function: { name: "rotator_echo", arguments: '{"text":"ROTATOR_OK"}' },
      },
    ];
    assert.equal(evaluateCompliance("tools", result).verdict, "passed");
    result.tools[0].function.arguments = "bad JSON";
    assert.equal(evaluateCompliance("tools", result).verdict, "failed");
    result.done = false;
    assert.equal(evaluateCompliance("stream", result).verdict, "failed");
  });

  it("treats only the transcription compatibility names as audio-only", () => {
    for (const id of ["whisper-1", "whisper", "Whisper-1", " whisper-1 "])
      assert.equal(isAudioOnlyModel(id), true, id);
    // Gemini models transcribe audio and also serve Chat Completions.
    for (const id of ["gemini-3.8-flash-low", "gpt-5.6-terra"])
      assert.equal(isAudioOnlyModel(id), false, id);
  });
});
