import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import {
  normalizeProviderEntries,
  resolvePluginOptions,
  mapModelToOpenCode,
  fetchRotatorModels,
  default as discoveryPlugin,
} from "../plugins/opencode-discovery/index.mjs";

interface FakeEditor {
  get: (id: string) => unknown;
  add: (record: unknown) => void;
}

interface FakeCtx {
  options: Record<string, unknown>;
  provider: {
    list: () => Promise<unknown>;
    transform: (
      callback: (editor: FakeEditor) => void,
    ) => Promise<{ dispose: () => Promise<void> }>;
    reload?: () => Promise<void>;
  };
}

describe("OpenCode V2 rotator discovery plugin", () => {
  const envBase = process.env.TUXEVIL_ROTATOR_BASE_URL;

  afterEach(() => {
    if (envBase === undefined) delete process.env.TUXEVIL_ROTATOR_BASE_URL;
    else process.env.TUXEVIL_ROTATOR_BASE_URL = envBase;
  });

  it("exports a V2 definition with id and setup", () => {
    assert.equal(typeof discoveryPlugin, "object");
    assert.equal(discoveryPlugin.id, "tuxevil.model-discovery");
    assert.equal(typeof discoveryPlugin.setup, "function");
  });

  it("resolves options from explicit plugin options", () => {
    const resolved = resolvePluginOptions({
      baseURL: "http://192.168.1.50:51200/v1/",
      providerID: "custom-rotator",
      providerName: "My Rotator",
      timeoutMs: 5000,
    });

    assert.equal(resolved.baseURL, "http://192.168.1.50:51200/v1");
    assert.equal(resolved.providerID, "custom-rotator");
    assert.equal(resolved.providerName, "My Rotator");
    assert.equal(resolved.timeoutMs, 5000);
    assert.equal(resolved.refreshMs, 600_000);
  });

  it("resolves baseURL from environment variable when not in options", () => {
    process.env.TUXEVIL_ROTATOR_BASE_URL = "http://remote-rotator:51200/v1";
    const resolved = resolvePluginOptions({});
    assert.equal(resolved.baseURL, "http://remote-rotator:51200/v1");
  });

  it("removes only trailing slashes from baseURLs", () => {
    for (const [baseURL, expected] of [
      ["http://localhost:51200/v1///", "http://localhost:51200/v1"],
      ["http://localhost:51200/a///b", "http://localhost:51200/a///b"],
      ["http://localhost:51200/v1/\n", "http://localhost:51200/v1/\n"],
      ["///", ""],
    ]) {
      assert.equal(resolvePluginOptions({ baseURL }).baseURL, expected);
    }
  });

  it("normalizes long slash runs without blocking plugin startup", () => {
    const pluginUrl = new URL(
      "../plugins/opencode-discovery/index.mjs",
      import.meta.url,
    ).href;
    // Isolate synchronous work: a test-runner timeout cannot interrupt a ReDoS.
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      import assert from "node:assert/strict";
      const { resolvePluginOptions } = await import(${JSON.stringify(pluginUrl)});
      const prefix = "http://localhost:51200/v1";
      const slashes = "/".repeat(300_000);
      const internal = prefix + slashes + "x";
      assert.equal(resolvePluginOptions({ baseURL: internal }).baseURL, internal);
      assert.equal(resolvePluginOptions({ baseURL: prefix + slashes }).baseURL, prefix);
    `,
      ],
      { timeout: 5000, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  });

  it("discovers baseURL/id/name from V2 provider records", () => {
    const resolved = resolvePluginOptions({}, [
      {
        id: "remote-rot",
        info: {
          name: "Remote Tuxevil",
          settings: { baseURL: "http://10.0.0.99:51200/v1" },
        },
      },
    ]);
    assert.equal(resolved.baseURL, "http://10.0.0.99:51200/v1");
    assert.equal(resolved.providerID, "remote-rot");
    assert.equal(resolved.providerName, "Remote Tuxevil");
  });

  it("normalizeProviderEntries also accepts the legacy config.provider map", () => {
    const entries = normalizeProviderEntries({
      "remote-rot": {
        name: "Remote Tuxevil",
        options: { baseURL: "http://10.0.0.99:51200/v1" },
      },
    });
    assert.deepEqual(entries, [
      {
        id: "remote-rot",
        name: "Remote Tuxevil",
        baseURL: "http://10.0.0.99:51200/v1",
      },
    ]);

    const resolved = resolvePluginOptions({}, entries);
    assert.equal(resolved.baseURL, "http://10.0.0.99:51200/v1");
    assert.equal(resolved.providerID, "remote-rot");
    assert.equal(resolved.providerName, "Remote Tuxevil");
  });

  it("falls back to default 127.0.0.1:51200/v1 when nothing is specified", () => {
    const resolved = resolvePluginOptions({});
    assert.equal(resolved.baseURL, "http://127.0.0.1:51200/v1");
    assert.equal(resolved.providerID, "antigravity");
  });

  it("maps raw models to OpenCode model definitions", () => {
    const mapped = mapModelToOpenCode({
      id: "m",
      meta: {
        context_length: 1000,
        max_output_tokens: 200,
        multimodal: true,
        tool_calling: false,
      },
    });
    assert.equal(mapped.id, "m");
    assert.deepEqual(mapped.modelDef, {
      name: "m",
      limit: { context: 1000, output: 200 },
      capabilities: {
        tools: false,
        input: ["text", "image"],
        output: ["text"],
      },
    });

    const fallback = mapModelToOpenCode({ id: "d" });
    assert.deepEqual(fallback.modelDef.limit, {
      context: 128000,
      output: 8192,
    });
    assert.equal(fallback.modelDef.capabilities.tools, true);
    assert.deepEqual(fallback.modelDef.capabilities.input, ["text"]);
  });

  it("fetches models from a live endpoint with a valid URL", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] }));
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as { port: number };
    try {
      const models = await fetchRotatorModels(
        `http://127.0.0.1:${port}/v1`,
        2000,
      );
      assert.deepEqual(
        models.map((m) => m.id),
        ["m1", "m2"],
      );
    } finally {
      server.close();
    }
  });

  it("rejects invalid baseURLs with a clear error (prior fetch() URL is invalid)", async () => {
    await assert.rejects(
      fetchRotatorModels("not a url", 1000),
      /fetch\(\) URL is invalid/,
    );
  });

  it("setup registers the discovered provider and merges user customizations", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: [
            { id: "gptom", meta: { context_length: 5000, multimodal: true } },
            { id: "m2" },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as { port: number };
    const baseURL = `http://127.0.0.1:${port}/v1`;

    const existingProvider = {
      provider: {
        name: "Config Name",
        settings: { baseURL: "http://stale:1/v1" },
      },
      models: new Map([
        ["gptom", { name: "Custom GPTom", limit: { context: 999 } }],
      ]),
    };

    const added: Array<{ info: Record<string, unknown>; models: unknown[] }> =
      [];
    const ctx: FakeCtx = {
      options: {
        baseURL,
        providerID: "rot-test",
        providerName: "Test Rotator",
        timeoutMs: 2000,
        refreshMs: 0,
      },
      provider: {
        list: async () => [],
        transform: async (callback) => {
          const editor: FakeEditor = {
            get: (id) => (id === "rot-test" ? existingProvider : undefined),
            add: (record) => {
              added.push(
                record as { info: Record<string, unknown>; models: unknown[] },
              );
            },
          };
          callback(editor);
          return { dispose: async () => {} };
        },
      },
    };

    try {
      const cleanup = await discoveryPlugin.setup(ctx);
      assert.equal(
        cleanup,
        undefined,
        "refreshMs 0 must not schedule a background timer",
      );
      assert.equal(added.length, 1);

      const info = added[0].info as Record<string, unknown>;
      const settings = info.settings as Record<string, unknown>;
      assert.equal(info.name, "Config Name");
      assert.equal(info.activation, "enabled");
      assert.equal(info.package, "@opencode/ai/providers/openai-compatible");
      assert.equal(settings.baseURL, baseURL);

      const models = added[0].models as Array<Record<string, unknown>>;
      assert.equal(models.length, 2);

      const gptom = models.find((m) => m.id === "gptom") as Record<
        string,
        unknown
      >;
      assert.equal(gptom?.name, "Custom GPTom");
      const gptomLimit = gptom?.limit as Record<string, number>;
      assert.equal(gptomLimit.context, 999);
      assert.equal(gptomLimit.output, 8192);
      const gptomCaps = gptom?.capabilities as Record<string, unknown>;
      assert.deepEqual(gptomCaps.input, ["text", "image"]);

      const m2 = models.find((m) => m.id === "m2") as Record<string, unknown>;
      const m2Limit = m2?.limit as Record<string, number>;
      assert.equal(m2Limit.context, 128000);
      assert.equal(m2Limit.output, 8192);
      assert.equal(m2?.name, "m2");
    } finally {
      server.close();
    }
  });

  it("setup degrades safely when the endpoint is invalid or unreachable", async () => {
    const added: unknown[] = [];
    const ctx: FakeCtx = {
      options: { baseURL: "not a url", providerID: "rot-test", refreshMs: 0 },
      provider: {
        list: async () => [],
        transform: async (callback) => {
          callback({
            get: () => undefined,
            add: (record) => added.push(record),
          });
          return { dispose: async () => {} };
        },
      },
    };

    const result = await discoveryPlugin.setup(ctx);
    assert.equal(result, undefined);
    assert.equal(added.length, 0);
  });

  it("setup degrades safely when the endpoint is unreachable (dead port)", async () => {
    // Bind a port, close it, and use it as a guaranteed-dead endpoint
    const deadServer = http.createServer(() => {});
    await new Promise<void>((resolve) =>
      deadServer.listen(0, "127.0.0.1", resolve),
    );
    const { port } = deadServer.address() as { port: number };
    deadServer.close();
    await new Promise((resolve) => deadServer.close(resolve));

    const added: unknown[] = [];
    const ctx: FakeCtx = {
      options: {
        baseURL: `http://127.0.0.1:${port}/v1`,
        providerID: "rot-test",
        timeoutMs: 300,
        refreshMs: 0,
      },
      provider: {
        list: async () => [],
        transform: async (callback) => {
          callback({
            get: () => undefined,
            add: (record) => added.push(record),
          });
          return { dispose: async () => {} };
        },
      },
    };

    const result = await discoveryPlugin.setup(ctx);
    assert.equal(result, undefined);
    assert.equal(added.length, 0);
  });
});

it("reloads the provider when effort metadata changes without changing model IDs", async () => {
  let levels = ["low", "high"];
  let reloads = 0;
  const server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        data: [
          {
            id: "gpt-test",
            meta: { reasoning: true, reasoning_efforts: levels },
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let cleanup: (() => void) | undefined;
  try {
    const ctx = {
      options: {
        baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        refreshMs: 10,
      },
      provider: {
        list: async () => [],
        transform: async (callback: (editor: FakeEditor) => void) => {
          callback({ get: () => undefined, add() {} });
          return { dispose: async () => {} };
        },
        reload: async () => {
          reloads++;
        },
      },
    };
    cleanup = await discoveryPlugin.setup(ctx);
    levels = ["low", "medium", "high", "xhigh"];
    for (let i = 0; i < 100 && !reloads; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(reloads > 0);
  } finally {
    cleanup?.();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("merges discovered reasoning efforts into existing models that only declared reasoning.supported", async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        data: [
          {
            id: "gemini-3.8-flash",
            meta: {
              thinking: true,
              reasoning_efforts: ["low", "medium", "high"],
              default_reasoning_effort: "medium",
            },
          },
          {
            id: "gemini-4-argon",
            meta: {
              thinking: true,
              reasoning_efforts: ["low", "medium", "high"],
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const existingProvider = {
    provider: { name: "Tuxevil Rotator" },
    models: new Map([
      [
        "gemini-3.8-flash",
        {
          name: "gemini-3.8-flash",
          capabilities: { reasoning: { supported: true } },
        },
      ],
      [
        "gemini-4-argon",
        {
          name: "gemini-4-argon",
          capabilities: { reasoning: { supported: true, effort: ["high"] } },
        },
      ],
    ]),
  };
  const added: Array<{ models: Array<Record<string, unknown>> }> = [];
  try {
    await discoveryPlugin.setup({
      options: {
        baseURL: `http://127.0.0.1:${port}/v1`,
        providerID: "tuxevil-rotator",
        refreshMs: 0,
      },
      provider: {
        list: async () => [],
        transform: async (callback: (editor: FakeEditor) => void) => {
          callback({
            get: (id) => (id === "tuxevil-rotator" ? existingProvider : undefined),
            add: (record) =>
              added.push(record as { models: Array<Record<string, unknown>> }),
          });
          return { dispose: async () => {} };
        },
      },
    });
    assert.equal(added.length, 1);
    const flash = added[0].models.find((m) => m.id === "gemini-3.8-flash") as Record<
      string,
      any
    >;
    assert.deepEqual(flash.capabilities.reasoning, {
      supported: true,
      effort: ["low", "medium", "high"],
    });
    assert.deepEqual(flash.variants, [
      { id: "low", settings: { reasoningEffort: "low" } },
      { id: "medium", settings: { reasoningEffort: "medium" } },
      { id: "high", settings: { reasoningEffort: "high" } },
    ]);

    const argon = added[0].models.find((m) => m.id === "gemini-4-argon") as Record<
      string,
      any
    >;
    assert.deepEqual(argon.capabilities.reasoning, {
      supported: true,
      effort: ["high"],
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
