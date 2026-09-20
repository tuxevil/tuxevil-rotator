import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { afterEach, describe, it } from "node:test";
import {
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

    const result = await selectAutoRoutingTarget(
      fakeRotator(baseURL),
      catalog,
      {
        route: "openai-chat",
        requestedModel: "auto",
        input: {
          messages: [{ role: "user", content: "Choose a model for this request" }],
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
    assert.equal(state.prompt_excerpt, "user\nChoose a model for this request");
    assert.doesNotMatch(JSON.stringify(captured), /private\.example/);
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
});
