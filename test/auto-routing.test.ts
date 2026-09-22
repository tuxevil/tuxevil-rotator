import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { afterEach, describe, it } from "node:test";
import {
  buildAutoRoutingCandidates,
  selectAutoRoutingTarget,
  type AutoRoutingCatalogEntry,
  type AutoRoutingRequest,
} from "../src/auto-routing.js";
import type { Config } from "../src/types.js";

const servers: Server[] = [];

async function startServer(
  handler: (body: Record<string, unknown>) => { status: number; body: unknown },
): Promise<string> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk.toString(); });
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* test server */ }
      const result = handler(body);
      res.writeHead(result.status, { "content-type": "application/json" });
      res.end(JSON.stringify(result.body));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

function fakeRotator(baseURL: string, apiKey = "test-typesafe-key") {
  const config: Config = {
    accounts: [],
    proxyPort: 51200,
    requestsPerRotation: 5,
    rotateOnQuotaDrop: 20,
    quotaPollIntervalMs: 300_000,
    typesafeRouting: {
      enabled: true,
      apiKey,
      baseURL,
      timeoutMs: 1_000,
      minConfidence: 0.45,
      maxCandidates: 32,
      maxExcerptChars: 80,
    },
  };
  return {
    getConfig: () => config,
    hasActiveProvider: (providerId: string) => providerId === "google-antigravity" || providerId === "ollama",
    getAutoRoutingCandidateStatus: (model: string, providerId: string) => ({
      available: true,
      operationalScore: providerId === "ollama" ? 0.9 : model.includes("pro") ? 0.4 : 0.6,
      poolKey: `${providerId}:${model}`,
    }),
  };
}

const catalog: AutoRoutingCatalogEntry[] = [
  {
    providerId: "google-antigravity",
    modelId: "gemini-pro",
    contextWindow: 1_000_000,
    multimodal: true,
    tools: true,
    reasoning: true,
    family: "gemini",
  },
  {
    providerId: "ollama",
    modelId: "local-fast",
    contextWindow: 128_000,
    multimodal: false,
    tools: true,
    reasoning: false,
    family: "ollama",
  },
];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("TypeSafe Jev auto-routing", () => {
  it("sends bounded semantic state and maps Jev's choice back to a catalog candidate", async () => {
    let received: Record<string, unknown> | null = null;
    const baseURL = await startServer((body) => {
      received = body;
      return {
        status: 200,
        body: {
          model: "jev-test",
          answers: {
            task_effort: {
              type: "choice",
              choice: "medium",
              confidence: 0.9,
              probabilities: { low: 0, medium: 1, high: 0, max: 0 },
            },
            selected_model: {
              type: "choice",
              choice: "candidate_0",
              confidence: 0.92,
              probabilities: { candidate_0: 0.92, candidate_1: 0.08, none: 0 },
            },
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      };
    });

    const rotator = fakeRotator(baseURL);
    rotator.getConfig().typesafeRouting!.maxExcerptChars = 512;
    const result = await selectAutoRoutingTarget(
      rotator,
      catalog,
      {
        route: "openai-chat",
        requestedModel: "auto",
        input: {
          messages: [
            { role: "system", content: "Do not send this private system prompt" },
            { role: "user", content: "Choose a model for this request at https://private.example/do-not-send" },
            { role: "assistant", content: "I will compare the available capabilities. data:image/png;base64,secret" },
          ],
          tools: [{ description: "Do not send this tool schema" }],
          attachment: "https://private.example/do-not-send",
        },
      } satisfies AutoRoutingRequest,
    );

    assert.equal(result?.mode, "typesafe");
    assert.equal(result?.candidate.modelId, "gemini-pro");
    assert.equal(result?.confidence, 0.92);
    const captured: Record<string, unknown> = received ?? (() => {
      throw new Error("TypeSafe test server did not receive a request");
    })();
    const state = captured.state as Record<string, unknown>;
    assert.equal((state.candidates as Array<Record<string, unknown>>).length, 2);
    const context = state.request_context as Record<string, unknown>;
    assert.equal(context.latest_user_request, "Choose a model for this request at [url omitted]");
    assert.deepEqual(context.recent_assistant_intent, ["I will compare the available capabilities. [media omitted]"]);
    assert.doesNotMatch(JSON.stringify(captured), /private\.example/);
    assert.doesNotMatch(JSON.stringify(captured), /private system prompt|tool schema|base64,secret/);
  });

  it("fails open to the best operational candidate when Jev is unavailable", async () => {
    const baseURL = await startServer(() => ({ status: 503, body: { error: "offline" } }));
    const result = await selectAutoRoutingTarget(
      fakeRotator(baseURL),
      catalog,
      { route: "openai-chat", input: "hello" },
    );
    assert.equal(result?.mode, "deterministic");
    assert.equal(result?.candidate.modelId, "local-fast");
    assert.equal(result?.reason, "typesafe-error");
  });

  it("does not call TypeSafe when the optional integration is disabled", async () => {
    let called = false;
    const baseURL = await startServer(() => {
      called = true;
      return { status: 500, body: {} };
    });
    const rotator = fakeRotator(baseURL, "");
    rotator.getConfig().typesafeRouting = { enabled: false, baseURL };
    const result = await selectAutoRoutingTarget(rotator, catalog, {
      route: "openai-chat",
      input: "hello",
    });
    assert.equal(result?.mode, "deterministic");
    assert.equal(called, false);
  });

  it("sends a bounded provider/family-diverse shortlist without an artificial abstain option", async () => {
    let received: Record<string, unknown> | null = null;
    const baseURL = await startServer((body) => {
      received = body;
      return {
        status: 200,
        body: {
          answers: {
            task_effort: {
              type: "choice",
              choice: "medium",
              confidence: 0.9,
              probabilities: { low: 0, medium: 1, high: 0, max: 0 },
            },
            selected_model: {
              choice: "candidate_0",
              confidence: 0.8,
              probabilities: { candidate_0: 0.8 },
            },
          },
        },
      };
    });
    const rotator = fakeRotator(baseURL);
    rotator.getConfig().typesafeRouting!.shortlistSize = 4;
    const expandedCatalog: AutoRoutingCatalogEntry[] = [
      ...Array.from({ length: 8 }, (_, index) => ({
        providerId: "google-antigravity",
        modelId: `gemini-family-${index}`,
        contextWindow: 1_000_000,
        multimodal: true,
        tools: true,
        reasoning: true,
        family: `gemini-family-${index}`,
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        providerId: "ollama",
        modelId: `local-${index}`,
        contextWindow: 128_000,
        multimodal: false,
        tools: true,
        reasoning: false,
        family: "ollama",
      })),
    ];

    const built = buildAutoRoutingCandidates(rotator, expandedCatalog, {
      route: "openai-chat",
      input: "pick a suitable text model",
    });
    assert.equal(built.candidates.length, 4);
    assert.equal(new Set(built.candidates.map((candidate) => candidate.providerId)).size, 2);
    assert.equal(new Set(built.candidates.map((candidate) => candidate.family)).size, 4);

    const result = await selectAutoRoutingTarget(rotator, expandedCatalog, {
      route: "openai-chat",
      input: "pick a suitable text model",
    });
    assert.equal(result?.mode, "typesafe");
    const captured: Record<string, unknown> = received ?? (() => {
      throw new Error("TypeSafe test server did not receive a request");
    })();
    const state = captured.state as Record<string, unknown>;
    assert.equal((state.candidates as unknown[]).length, 4);
    assert.doesNotMatch(JSON.stringify(captured), /none/);
  });

  it("bounds role-aware decision context and preserves the end of a long user request", async () => {
    let received: Record<string, unknown> | null = null;
    const baseURL = await startServer((body) => {
      received = body;
      return {
        status: 200,
        body: {
          answers: {
            task_effort: {
              type: "choice",
              choice: "high",
              confidence: 0.9,
              probabilities: { low: 0, medium: 0, high: 1, max: 0 },
            },
            selected_model: {
              choice: "candidate_0",
              confidence: 0.9,
              probabilities: { candidate_0: 1 },
            },
          },
        },
      };
    });
    const rotator = fakeRotator(baseURL);
    rotator.getConfig().typesafeRouting!.maxExcerptChars = 256;
    const longRequest = `${"analyze the architecture carefully ".repeat(20)}Preserve this final constraint.`;
    await selectAutoRoutingTarget(rotator, catalog, {
      route: "openai-chat",
      input: {
        messages: [
          { role: "user", content: "Earlier project context" },
          { role: "assistant", content: "Prior decision and current intent" },
          { role: "user", content: longRequest },
          { role: "tool", content: "Error: tool call returned unavailable" },
        ],
      },
    });

    const captured: Record<string, unknown> = received ?? (() => { throw new Error("TypeSafe test server did not receive a request"); })();
    const state = captured.state as Record<string, unknown>;
    const context = state.request_context as Record<string, string | string[]>;
    const texts = Object.values(context).flatMap((value) => Array.isArray(value) ? value : [value]);
    assert.ok(texts.reduce((total, value) => total + value.length, 0) <= 256);
    assert.match(context.latest_user_request as string, /\[truncated\]/);
    assert.match(context.latest_user_request as string, /Preserve this final constraint\./);
    assert.equal(context.previous_user_context, "Earlier project context");
    assert.deepEqual(context.recent_assistant_intent, ["Prior decision and current intent"]);
    assert.match((context.recent_tool_results as string[])[0], /^\[error\]/);
  });

  it("honors Jev's selected candidate instead of replacing it with a health blend", async () => {
    const baseURL = await startServer((body) => {
      const state = body.state as Record<string, unknown>;
      const candidates = state.candidates as Array<Record<string, unknown>>;
      const nominated = candidates.find((candidate) => candidate.model === "gemini-pro");
      assert.ok(nominated);
      const probabilities = Object.fromEntries(candidates.map((candidate) => [
        String(candidate.id), candidate.id === nominated.id ? 0.51 : 0.49,
      ]));
      return {
        status: 200,
        body: {
          answers: {
            task_effort: {
              type: "choice",
              choice: "medium",
              confidence: 0.9,
              probabilities: { low: 0, medium: 1, high: 0, max: 0 },
            },
            selected_model: {
              choice: nominated.id,
              confidence: 0.51,
              probabilities,
            },
          },
        },
      };
    });
    const result = await selectAutoRoutingTarget(
      fakeRotator(baseURL),
      catalog,
      { route: "openai-chat", input: "hello" },
    );
    assert.equal(result?.mode, "typesafe");
    assert.equal(result?.candidate.modelId, "gemini-pro");
  });

  it("enforces a high-effort Jev judgment when a reasoning-capable option exists", async () => {
    const baseURL = await startServer((body) => {
      const state = body.state as Record<string, unknown>;
      const candidates = state.candidates as Array<Record<string, unknown>>;
      const fast = candidates.find((candidate) => candidate.reasoning === false);
      const reasoning = candidates.find((candidate) => candidate.reasoning === true);
      assert.ok(fast && reasoning);
      return {
        status: 200,
        body: {
          answers: {
            task_effort: {
              type: "choice",
              choice: "high",
              confidence: 0.9,
              probabilities: { low: 0, medium: 0, high: 1, max: 0 },
            },
            selected_model: {
              choice: fast.id,
              confidence: 0.8,
              probabilities: { [String(fast.id)]: 0.8, [String(reasoning.id)]: 0.2 },
            },
          },
        },
      };
    });
    const result = await selectAutoRoutingTarget(
      fakeRotator(baseURL),
      catalog,
      { route: "openai-chat", input: "Investigate a complex distributed-systems failure" },
    );
    assert.equal(result?.candidate.reasoning, true);
    assert.equal(result?.reason, "typesafe-reasoning-guard");
  });

  it("keeps the high-effort capability guard when the model choice is uncertain", async () => {
    const baseURL = await startServer((body) => {
      const state = body.state as Record<string, unknown>;
      const candidates = state.candidates as Array<Record<string, unknown>>;
      const fast = candidates.find((candidate) => candidate.reasoning === false);
      assert.ok(fast);
      return {
        status: 200,
        body: {
          answers: {
            task_effort: {
              type: "choice",
              choice: "high",
              confidence: 0.9,
              probabilities: { low: 0, medium: 0, high: 1, max: 0 },
            },
            selected_model: {
              choice: fast.id,
              confidence: 0.3,
              probabilities: { [String(fast.id)]: 1 },
            },
          },
        },
      };
    });
    const result = await selectAutoRoutingTarget(
      fakeRotator(baseURL),
      catalog,
      { route: "openai-chat", input: "Investigate a complex distributed-systems failure" },
    );
    assert.equal(result?.mode, "deterministic");
    assert.equal(result?.candidate.reasoning, true);
    assert.equal(result?.reason, "typesafe-low-confidence");
  });

  it("supports shadow mode without changing the served deterministic target", async () => {
    const baseURL = await startServer((body) => {
      const state = body.state as Record<string, unknown>;
      const candidates = state.candidates as Array<Record<string, unknown>>;
      const nominated = candidates.find((candidate) => candidate.model === "gemini-pro");
      assert.ok(nominated);
      return {
        status: 200,
        body: {
          answers: {
            task_effort: {
              type: "choice",
              choice: "medium",
              confidence: 0.9,
              probabilities: { low: 0, medium: 1, high: 0, max: 0 },
            },
            selected_model: {
              choice: nominated.id,
              confidence: 0.3,
              probabilities: { [String(nominated.id)]: 1 },
            },
          },
        },
      };
    });
    const rotator = fakeRotator(baseURL);
    rotator.getConfig().typesafeRouting!.shadowMode = true;
    const logged: string[] = [];
    const originalInfo = console.info;
    console.info = (...values: unknown[]) => logged.push(values.map(String).join(" "));
    try {
      const result = await selectAutoRoutingTarget(
        rotator,
        catalog,
        { route: "openai-chat", input: "hello" },
      );
      assert.equal(result?.mode, "shadow");
      assert.equal(result?.candidate.modelId, "local-fast");
      assert.equal(result?.reason, "typesafe-shadow-low-confidence");
    } finally {
      console.info = originalInfo;
    }
    assert.match(logged.join("\n"), /gemini-pro/);
    assert.match(logged.join("\n"), /local-fast/);
    assert.match(logged.join("\n"), /below_confidence_threshold/);
    assert.doesNotMatch(logged.join("\n"), /hello|apiKey|test-typesafe-key/);
  });
});
