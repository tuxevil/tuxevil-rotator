import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  reasoningCapabilities,
  openCodeReasoning,
  openCodeVariants,
  mergeOpenCodeModels,
  mapAgentModel,
} from "../plugins/opencode-discovery/capabilities.mjs";
import { mapModelToOpenCode } from "../plugins/opencode-discovery/index.mjs";
import { buildCompositeInstallerScript } from "../src/install-agent.js";
import { buildRemoteInstallerScript } from "../src/install-opencode.js";
import {
  fetchCodexCatalog,
  getCodexModel,
  setDiscoveredCodexModels,
} from "../src/providers/openai-codex/catalog.js";
import { buildOpenAIModelCatalog } from "../src/compat.js";
import { setModelSpecsOverride } from "../src/compat/model-specs.js";
import { chatToCodexResponsesRequest } from "../src/providers/openai-codex/compat.js";
import { sanitizeCodexResponsesRequest } from "../src/providers/openai-codex/forward.js";
import { dynamicCatalog } from "../src/providers/google-antigravity/dynamic-catalog.js";
import { setEffortRoutingOverride, type AccountRuntime } from "../src/types.js";
import { setAntigravityModelsForTest } from "./fixtures/antigravity-catalog.js";

const codex = {
  id: "gpt-5.6-sol",
  owned_by: "openai-codex",
  meta: {
    family: "openai-codex",
    provider: "openai-codex",
    reasoning: true,
    reasoning_efforts: ["low", "medium", "high", "xhigh", "max"],
    default_reasoning_effort: "medium",
    context_length: 1_050_000,
    multimodal: true,
    tool_calling: true,
  },
};
const gemini = {
  id: "gemini-3.8-flash-high",
  meta: { thinking: true, multimodal: true },
};
const pluginFiles = Object.fromEntries(
  ["index.mjs", "package.json", "capabilities.mjs"].map((name) => [
    name,
    readFileSync(
      new URL(`../plugins/opencode-discovery/${name}`, import.meta.url),
      "utf8",
    ),
  ]),
);
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  setDiscoveredCodexModels([]);
  setEffortRoutingOverride(null);
  setModelSpecsOverride(null);
  dynamicCatalog.reset();
});

describe("Codex reasoning capability discovery", () => {
  it("retains upstream effort controls and excludes harness-only Ultra", async () => {
    const account = {
      config: { credentials: [{ provider: "openai-codex" }] },
      providerTokens: {
        "openai-codex": {
          accessToken: "test",
          tokenExpires: Date.now() + 60_000,
        },
      },
    } as unknown as AccountRuntime;
    globalThis.fetch = async () =>
      Response.json({
        models: [
          {
            slug: "gpt-5.6-sol",
            supported_reasoning_levels: [
              { effort: "low" },
              { effort: "high" },
              { effort: "max" },
              { effort: "ultra" },
              { effort: "high" },
            ],
            default_reasoning_level: "high",
          },
          {
            slug: "gpt-9-test",
            reasoning: false,
            supported_reasoning_levels: [{ effort: "high" }],
          },
          { slug: "gpt-10-test" },
        ],
      });
    await fetchCodexCatalog(account);
    assert.deepEqual(getCodexModel("gpt-5.6-sol")?.reasoningEfforts, [
      "low",
      "high",
      "max",
    ]);
    assert.equal(getCodexModel("gpt-5.6-sol")?.defaultReasoningEffort, "high");
    assert.deepEqual(getCodexModel("gpt-9-test")?.reasoningEfforts, []);
    assert.equal(
      getCodexModel("gpt-10-test")?.reasoningEfforts,
      undefined,
      "unknown models must not inherit guessed levels",
    );
    const catalog = buildOpenAIModelCatalog({
      hasActiveProvider: (id: string) => id === "openai-codex",
      getCodexModels: () => ["gpt-5.6-sol"],
    } as never);
    const meta = catalog.find((m) => m.id === "gpt-5.6-sol")!.meta;
    assert.deepEqual(meta.reasoning_efforts, ["low", "high", "max"]);
    assert.equal(meta.default_reasoning_effort, "high");
  });
  it("forwards each scalar effort over both supported API shapes", () => {
    for (const effort of codex.meta.reasoning_efforts) {
      const chat = chatToCodexResponsesRequest({
        model: codex.id,
        messages: [{ role: "user", content: "hello" }],
        reasoning_effort: effort,
      });
      assert.deepEqual(chat.reasoning, { effort });
      assert.deepEqual(
        sanitizeCodexResponsesRequest(
          { model: codex.id, input: "hello", reasoning: { effort } },
          codex.id,
        ).reasoning,
        { effort },
      );
    }
  });
});

describe("Antigravity reasoning effort metadata", () => {
  it("exposes reasoning_efforts and default_reasoning_effort for effort-routed Gemini aliases", () => {
    setAntigravityModelsForTest([
      "gemini-3.8-flash-low",
      "gemini-3.8-flash-medium",
      "gemini-3.8-flash-high",
      "gemini-4-hydrogen-sonar",
    ]);
    setEffortRoutingOverride({
      "gemini-3.8-flash": {
        defaultEffort: "medium",
        targets: {
          high: "gemini-3.8-flash-high",
          low: "gemini-3.8-flash-low",
          medium: "gemini-3.8-flash-medium",
          custom: "gemini-3.8-flash-high",
        },
      },
    });

    const catalog = buildOpenAIModelCatalog();
    const alias = catalog.find((m) => m.id === "gemini-3.8-flash");
    assert.ok(alias);
    assert.equal(alias.meta.thinking, true);
    assert.deepEqual(alias.meta.reasoning_efforts, ["low", "medium", "high"]);
    assert.equal(alias.meta.default_reasoning_effort, "medium");

    const mapped = mapModelToOpenCode(alias);
    assert.deepEqual(mapped.modelDef.capabilities.reasoning, {
      supported: true,
      effort: ["low", "medium", "high"],
    });
    assert.deepEqual(mapped.modelDef.variants, [
      { id: "low", settings: { reasoningEffort: "low" } },
      { id: "medium", settings: { reasoningEffort: "medium" } },
      { id: "high", settings: { reasoningEffort: "high" } },
    ]);

    const fixed = catalog.find((m) => m.id === "gemini-4-hydrogen-sonar");
    assert.ok(fixed);
    assert.equal(fixed.meta.reasoning_efforts, undefined);
    assert.equal(fixed.meta.default_reasoning_effort, undefined);
  });

  it("omits disabled effort targets from meta.reasoning_efforts", () => {
    setAntigravityModelsForTest([
      "gemini-3.8-flash-low",
      "gemini-3.8-flash-medium",
      "gemini-3.8-flash-high",
    ]);
    setEffortRoutingOverride({
      "gemini-3.8-flash": {
        defaultEffort: "medium",
        targets: {
          low: "gemini-3.8-flash-low",
          medium: "gemini-3.8-flash-medium",
          high: "gemini-3.8-flash-high",
        },
      },
    });

    const catalog = buildOpenAIModelCatalog({
      getConfig: () => ({
        disabledModels: ["google-antigravity/gemini-3.8-flash-high"],
      }),
      hasActiveProvider: () => false,
    } as never);
    const alias = catalog.find((m) => m.id === "gemini-3.8-flash");
    assert.ok(alias);
    assert.deepEqual(alias.meta.reasoning_efforts, ["low", "medium"]);
    assert.equal(alias.meta.default_reasoning_effort, "medium");
  });

  it("marks effort aliases with a non-thinking default target as thinking when other targets think", () => {
    dynamicCatalog.updateFromEndpointResponse({
      models: {
        "gemini-4-argon-disabled": {
          maxTokens: 1_048_576,
          maxOutputTokens: 65_536,
          supportsThinking: false,
          quotaInfo: { remainingFraction: 1 },
        },
        "gemini-4-argon-low": {
          maxTokens: 1_048_576,
          maxOutputTokens: 65_536,
          supportsThinking: true,
          thinkingBudget: 4000,
          quotaInfo: { remainingFraction: 1 },
        },
        "gemini-4-argon-high": {
          maxTokens: 1_048_576,
          maxOutputTokens: 65_536,
          supportsThinking: true,
          thinkingBudget: 24576,
          quotaInfo: { remainingFraction: 1 },
        },
      },
    });
    setEffortRoutingOverride({
      "gemini-4-argon": {
        defaultEffort: "none",
        targets: {
          none: "gemini-4-argon-disabled",
          low: "gemini-4-argon-low",
          high: "gemini-4-argon-high",
        },
      },
    });

    const alias = buildOpenAIModelCatalog().find((m) => m.id === "gemini-4-argon");
    assert.ok(alias);
    assert.equal(alias.meta.thinking, true);
    assert.deepEqual(alias.meta.reasoning_efforts, ["none", "low", "high"]);
    assert.equal(alias.meta.default_reasoning_effort, "none");

    const mapped = mapModelToOpenCode(alias);
    assert.deepEqual(mapped.modelDef.capabilities.reasoning, {
      supported: true,
      effort: ["low", "high"],
      toggle: true,
    });
  });

  it("publishes low/medium/high for adaptive tiered Gemini models only while thinkingBudget is -1", () => {
    dynamicCatalog.updateFromEndpointResponse({
      models: {
        "gemini-3.8-flash-tiered": {
          maxTokens: 1_048_576,
          maxOutputTokens: 65_536,
          supportsThinking: true,
          thinkingBudget: -1,
          quotaInfo: { remainingFraction: 1 },
        },
      },
    });

    const adaptive = buildOpenAIModelCatalog().find(
      (m) => m.id === "gemini-3.8-flash-tiered",
    );
    assert.ok(adaptive);
    assert.deepEqual(adaptive.meta.reasoning_efforts, ["low", "medium", "high"]);
    assert.equal(adaptive.meta.default_reasoning_effort, undefined);

    setModelSpecsOverride({
      "gemini-3.8-flash-tiered": { thinkingBudget: 8192 },
    });
    const fixedOverride = buildOpenAIModelCatalog().find(
      (m) => m.id === "gemini-3.8-flash-tiered",
    );
    assert.ok(fixedOverride);
    assert.equal(fixedOverride.meta.reasoning_efforts, undefined);
  });
});

describe("agent reasoning translations", () => {
  it("adds V2 controls and variants without creating effort-suffixed model IDs", () => {
    const mapped = mapModelToOpenCode(codex);
    assert.equal(mapped.id, codex.id);
    assert.deepEqual(mapped.modelDef.capabilities.reasoning, {
      supported: true,
      effort: codex.meta.reasoning_efforts,
    });
    assert.deepEqual(
      mapped.modelDef.variants,
      codex.meta.reasoning_efforts.map((e) => ({
        id: e,
        settings: { reasoningEffort: e },
      })),
    );
    assert.equal(
      openCodeVariants(gemini).length,
      0,
      "fixed Antigravity variants have no scalar controls",
    );
    assert.deepEqual(
      openCodeReasoning({
        id: "no",
        meta: { reasoning: false, reasoning_efforts: ["high"] },
      }),
      {},
    );
    assert.deepEqual(
      reasoningCapabilities({
        id: "m",
        meta: {
          reasoning: true,
          reasoning_efforts: ["high", "ultra", "bogus", "high"],
        },
      }).efforts,
      ["high"],
    );
  });
  it("preserves user options, custom variants, disabled variants and model limits", () => {
    const result = mergeOpenCodeModels(
      {
        [codex.id]: {
          options: { reasoningEffort: "low" },
          limit: { context: 5000 },
          variants: {
            high: { disabled: true },
            deep: { reasoningEffort: "max" },
          },
        },
      },
      [codex],
    );
    const model = result[codex.id] as Record<string, any>;
    assert.equal(model.options.reasoningEffort, "low");
    assert.equal(model.variants.high.disabled, true);
    assert.equal(model.variants.deep.reasoningEffort, "max");
    assert.equal(model.variants.medium.reasoningEffort, "medium");
    assert.equal(model.limit.context, 5000);
    assert.equal(model.limit.output, 8192);
    const claw = mapAgentModel(codex) as Record<string, any>;
    assert.equal(claw.reasoning, true);
    assert.deepEqual(
      claw.compat.supportedReasoningEfforts,
      codex.meta.reasoning_efforts,
    );
  });
});

function runScript(
  script: string,
  home: string,
  extraEnv: Record<string, string> = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-s"], {
      env: {
        ...process.env,
        HOME: home,
        HERMES_HOME: join(home, ".hermes"),
        OPENCLAW_CONFIG_PATH: "",
        OPENCLAW_STATE_DIR: "",
        ...extraEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Installer exited ${code}: ${output}`)),
    );
    child.stdin.end(script);
  });
}

it("connection commands persist reasoning capabilities, preserve preferences and tolerate offline reruns", async () => {
  const home = mkdtempSync(join(tmpdir(), "agent-reasoning-"));
  const dirs = [".config/opencode", ".hermes", ".openclaw", ".pi/agent"];
  for (const dir of dirs) mkdirSync(join(home, dir), { recursive: true });
  const json = (path: string) =>
    JSON.parse(readFileSync(join(home, path), "utf8"));
  writeFileSync(
    join(home, ".config/opencode/opencode.json"),
    JSON.stringify({
      model: "other/model",
      provider: {
        rot: {
          options: { apiKey: "rk-keep" },
          models: {
            [codex.id]: {
              options: { reasoningEffort: "low" },
              variants: { high: { disabled: true } },
            },
          },
        },
      },
    }),
  );
  writeFileSync(
    join(home, ".hermes/config.yaml"),
    JSON.stringify({
      model: { provider: "other", default: "other-model" },
      agent: { reasoning_effort: "low" },
      custom_providers: [
        { name: "rot", api_key: "rk-keep", api_mode: "chat_completions" },
      ],
    }),
  );
  writeFileSync(
    join(home, ".openclaw/openclaw.json"),
    JSON.stringify({
      agents: {
        defaults: {
          model: { primary: "native/model" },
          models: { "native/model": {} },
        },
      },
      models: {
        providers: {
          rot: {
            apiKey: "rk-keep",
            models: [
              {
                id: codex.id,
                compat: { supportedReasoningEfforts: ["low", "high"] },
              },
            ],
          },
        },
      },
    }),
  );
  let offline = false;
  const server = createServer((_req, res) => {
    res.writeHead(offline ? 503 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [codex, gemini] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const script = buildCompositeInstallerScript(pluginFiles, {
    targets: ["auto"],
    rotatorUrl: url,
    providerId: "rot",
    providerName: "Rotator",
  });
  try {
    await runScript(script, home);
    const open = json(".config/opencode/opencode.json");
    assert.equal(open.model, "other/model");
    assert.equal(open.provider.rot.options.apiKey, "rk-keep");
    assert.equal(
      open.provider.rot.models[codex.id].variants.max.reasoningEffort,
      "max",
    );
    assert.equal(
      open.provider.rot.models[codex.id].variants.high.disabled,
      true,
    );
    const { execFileSync } = await import("node:child_process");
    const hermes = JSON.parse(
      execFileSync(
        "python3",
        [
          "-c",
          "import yaml,json,sys;print(json.dumps(yaml.safe_load(open(sys.argv[1]))))",
          join(home, ".hermes/config.yaml"),
        ],
        { encoding: "utf8" },
      ),
    );
    assert.equal(hermes.agent.reasoning_effort, "low");
    assert.equal(hermes.model.default, "other-model");
    assert.equal(hermes.custom_providers[0].api_key, "rk-keep");
    assert.equal(
      hermes.model_overrides["custom:rot"][codex.id].supports_reasoning,
      true,
    );
    const claw = json(".openclaw/openclaw.json");
    assert.equal(claw.agents.defaults.model.primary, "native/model");
    assert.ok(claw.agents.defaults.models[`rot/${codex.id}`]);
    assert.equal(claw.models.providers.rot.apiKey, "rk-keep");
    assert.equal(claw.models.providers.rot.api, "openai-completions");
    assert.deepEqual(
      claw.models.providers.rot.models.find((m: any) => m.id === codex.id)
        .compat.supportedReasoningEfforts,
      ["low", "high"],
    );
    const pi = json(".pi/agent/models.json");
    assert.equal(
      pi.providers.rot.models.find((m: any) => m.id === codex.id).compat
        .supportsReasoningEffort,
      true,
    );
    const before = dirs.map((dir, i) =>
      readFileSync(
        join(
          home,
          dir,
          ["opencode.json", "config.yaml", "openclaw.json", "models.json"][i],
        ),
        "utf8",
      ),
    );
    offline = true;
    await runScript(script, home);
    assert.deepEqual(
      dirs.map((dir, i) =>
        readFileSync(
          join(
            home,
            dir,
            ["opencode.json", "config.yaml", "openclaw.json", "models.json"][i],
          ),
          "utf8",
        ),
      ),
      before,
    );
    // Named modern Hermes providers and profile homes are updated in-place.
    const profile = join(home, "profile");
    mkdirSync(profile);
    writeFileSync(
      join(profile, "config.yaml"),
      JSON.stringify({
        model: { default: "keep-model" },
        agent: { reasoning_effort: "high" },
        providers: { rot: { api: url, api_key: "rk-profile", models: {} } },
      }),
    );
    await runScript(
      buildCompositeInstallerScript(pluginFiles, {
        targets: ["hermes"],
        rotatorUrl: url,
        providerId: "rot",
        providerName: "Rotator",
      }),
      home,
      { HERMES_HOME: profile },
    );
    const profileConfig = JSON.parse(
      execFileSync(
        "python3",
        [
          "-c",
          "import yaml,json,sys;print(json.dumps(yaml.safe_load(open(sys.argv[1]))))",
          join(profile, "config.yaml"),
        ],
        { encoding: "utf8" },
      ),
    );
    assert.equal(profileConfig.providers.rot.api_key, "rk-profile");
    assert.equal(profileConfig.agent.reasoning_effort, "high");
    assert.equal(profileConfig.model.default, "keep-model");
    assert.equal(profileConfig.custom_providers.length, 0);
    assert.equal(
      readFileSync(join(home, ".hermes/config.yaml"), "utf8"),
      before[1],
      "updating a profile must leave the default Hermes home untouched",
    );

    // The dedicated OpenCode command must include the same variants.
    const target = join(home, "dedicated-opencode");
    offline = false;
    await runScript(
      buildRemoteInstallerScript(pluginFiles, {
        rotatorUrl: url,
        providerId: "rot",
        providerName: "Rotator",
        targetDir: target,
      }),
      home,
    );
    const dedicated = JSON.parse(
      readFileSync(join(target, "opencode.json"), "utf8"),
    );
    assert.equal(
      dedicated.provider.rot.models[codex.id].variants.xhigh.reasoningEffort,
      "xhigh",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});

it("rejects unknown agent targets rather than reporting a successful no-op", () => {
  assert.throws(
    () =>
      buildCompositeInstallerScript(pluginFiles, {
        targets: ["typo" as never],
        rotatorUrl: "http://127.0.0.1:51200/v1",
        providerId: "rot",
        providerName: "Rot",
      }),
    /Unknown agent target/,
  );
});
