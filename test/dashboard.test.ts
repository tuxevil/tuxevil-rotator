import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import {
  serveDashboard,
  serveDashboardKeys,
  serveDashboardLogs,
} from "../src/dashboard.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function renderPage(servePage: (res: never) => void): string {
  let html = "";
  servePage({
    writeHead() {},
    end(chunk: string) {
      html += chunk;
    },
  } as never);
  return html;
}

function renderDashboard(): string {
  return renderPage(serveDashboard);
}

function renderDashboardKeys(): string {
  return renderPage(serveDashboardKeys);
}

function renderDashboardLogs(): string {
  return renderPage(serveDashboardLogs);
}

function readDashboardJs(): string {
  return readFileSync(
    join(__dirname, "..", "src", "static", "dashboard.js"),
    "utf-8",
  );
}

function readDashboardCss(): string {
  return readFileSync(
    join(__dirname, "..", "src", "static", "dashboard.css"),
    "utf-8",
  );
}

describe("dashboard", () => {
  it("serves a complete HTML document", () => {
    const html = renderDashboard();
    assert.match(html, /^<!DOCTYPE html>/);
    assert.match(html, /<title>Tuxevil Rotator<\/title>/);
    assert.match(html, /<script src="\/static\/dashboard\.js"><\/script>/);
  });

  it("contains syntactically valid dashboard JavaScript", () => {
    const js = readDashboardJs();
    assert.ok(js.length > 0, "dashboard.js is empty");
    assert.doesNotThrow(() => new Script(js));
  });

  it("assigns distinct family colors for token graph (Claude: Red, Gemini: Blue, Ollama: Green)", () => {
    const js = readDashboardJs();
    const sandbox: Record<string, unknown> = {
      window: { location: { search: "" } } as Record<string, unknown>,
      URLSearchParams: globalThis.URLSearchParams,
      EventSource: function () {},
      setInterval: () => {},
      clearInterval: () => {},
      setTimeout: () => {},
      clearTimeout: () => {},
      localStorage: {
        getItem: () => null,
        setItem: () => {},
      },
      document: {
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: () => {},
      },
    };
    const script = new Script(js + "\nthis.getModelColor = getModelColor; this.TOKEN_MODEL_COLORS = TOKEN_MODEL_COLORS;");
    script.runInNewContext(sandbox);

    const getModelColor = sandbox.getModelColor as (m: string) => string;

    // Claude Pool (Red spectrum)
    const opusColor = getModelColor("claude-opus-4-6-thinking");
    const sonnetColor = getModelColor("claude-sonnet-4-6");
    const gptOssAntigravity = getModelColor("gpt-oss-120b-medium");

    assert.equal(opusColor, "#b91c1c");
    assert.equal(sonnetColor, "#ef4444");
    assert.equal(gptOssAntigravity, "#f87171");

    // Gemini Pool (Blue spectrum)
    const gemini31High = getModelColor("gemini-3.1-pro-high");
    const gemini31Low = getModelColor("gemini-3.1-pro-low");
    const gemini35High = getModelColor("gemini-3.5-flash-high");
    const gemini35Low = getModelColor("gemini-3.5-flash-low");
    const gemini36High = getModelColor("gemini-3.6-flash-high");
    const gemini36Low = getModelColor("gemini-3.6-flash-low");
    const gemini3Flash = getModelColor("gemini-3-flash");

    // Same family must share same color
    assert.equal(gemini31High, gemini31Low);
    assert.equal(gemini35High, gemini35Low);
    assert.equal(gemini36High, gemini36Low);

    // Different families must have distinct colors
    assert.notEqual(gemini31High, gemini35High);
    assert.notEqual(gemini35High, gemini36High);
    assert.notEqual(gemini36High, gemini3Flash);

    // Ollama Pool (Green spectrum)
    const kimi = getModelColor("kimi-k3");
    const qwen = getModelColor("qwen3.5:397b");
    const glm = getModelColor("glm-5.2");
    const gptOss20b = getModelColor("gpt-oss:20b");

    assert.equal(kimi, "#047857");
    assert.equal(qwen, "#0f766e");
    assert.equal(glm, "#10b981");
    assert.equal(gptOss20b, "#dcfce7");

    // Codex Pool (Yellow spectrum)
    assert.equal(getModelColor("gpt-5.6-sol"), "#a16207");
    assert.equal(getModelColor("gpt-5.6-terra"), "#eab308");
    assert.equal(getModelColor("gpt-5.6-luna"), "#fde047");

    // Codex pool must differ from other pools
    assert.notEqual(getModelColor("gpt-5.6-sol"), getModelColor("claude-opus-4-6-thinking"));
    assert.notEqual(getModelColor("gpt-5.6-terra"), getModelColor("gemini-3.1-pro"));
    assert.notEqual(getModelColor("gpt-5.6-luna"), getModelColor("kimi-k3"));
  });

  it("shows sub-cent savings for low-volume priced models", () => {
    const js = readDashboardJs();
    const sandbox: Record<string, unknown> = {
      window: { location: { search: "" } } as Record<string, unknown>,
      URLSearchParams: globalThis.URLSearchParams,
      EventSource: function () {},
      setInterval: () => {},
      clearInterval: () => {},
      setTimeout: () => {},
      clearTimeout: () => {},
      localStorage: { getItem: () => null, setItem: () => {} },
      document: {
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: () => {},
      },
    };
    const script = new Script(
      js +
        "\nthis.calcSavingsFromBuckets = calcSavingsFromBuckets;" +
        "\nthis.formatModelSavingsLabel = formatModelSavingsLabel;",
    );
    script.runInNewContext(sandbox);

    const calcSavingsFromBuckets = sandbox.calcSavingsFromBuckets as (
      buckets: Array<Record<string, unknown>>,
    ) => { byModel: Record<string, { totalUsd: number }> };
    const formatModelSavingsLabel = sandbox.formatModelSavingsLabel as (
      savings: { totalUsd: number },
    ) => string;
    const savings = calcSavingsFromBuckets([
      {
        byModel: {
          "gpt-oss-120b-medium": { inputTokens: 686, outputTokens: 413 },
        },
      },
    ]);

    assert.equal(savings.byModel["gpt-oss-120b-medium"].totalUsd, 0.005502);
    assert.match(
      formatModelSavingsLabel(savings.byModel["gpt-oss-120b-medium"]),
      /\$0\.0055/,
    );
    assert.equal(formatModelSavingsLabel({ totalUsd: 0 }), "");
  });

  it("calculates savings for Codex GPT-5.6 models", () => {
    const js = readDashboardJs();
    const sandbox: Record<string, unknown> = {
      window: { location: { search: "" } } as Record<string, unknown>,
      URLSearchParams: globalThis.URLSearchParams,
      EventSource: function () {},
      fetch: () => Promise.resolve(),
      setInterval: () => {},
      clearInterval: () => {},
      setTimeout: () => {},
      clearTimeout: () => {},
      localStorage: { getItem: () => null, setItem: () => {} },
      document: {
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: () => {},
      },
    };
    const script = new Script(js + "\nthis.calcSavingsFromBuckets = calcSavingsFromBuckets;");
    script.runInNewContext(sandbox);

    const calcSavingsFromBuckets = sandbox.calcSavingsFromBuckets as (
      buckets: Array<Record<string, unknown>>,
    ) => { byModel: Record<string, { totalUsd: number }> };
    const savings = calcSavingsFromBuckets([
      {
        byModel: {
          "gpt-5.6-sol": { inputTokens: 1_000_000, outputTokens: 1_000_000 },
          "gpt-5.6-terra": { inputTokens: 1_000_000, outputTokens: 1_000_000 },
          "gpt-5.6-luna": { inputTokens: 1_000_000, outputTokens: 1_000_000 },
        },
      },
    ]);

    assert.equal(savings.byModel["gpt-5.6-sol"].totalUsd, 35);
    assert.equal(savings.byModel["gpt-5.6-terra"].totalUsd, 14);
    assert.equal(savings.byModel["gpt-5.6-luna"].totalUsd, 1.4);
  });

  it("prices gemini-3.7-flash-tiered with its own rates and never falls through to gemini-3-flash", () => {
    const js = readDashboardJs();
    const sandbox: Record<string, unknown> = {
      window: { location: { search: "" } } as Record<string, unknown>,
      URLSearchParams: globalThis.URLSearchParams,
      EventSource: function () {},
      fetch: () => Promise.resolve(),
      setInterval: () => {},
      clearInterval: () => {},
      setTimeout: () => {},
      clearTimeout: () => {},
      localStorage: { getItem: () => null, setItem: () => {} },
      document: {
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: () => {},
      },
    };
    const script = new Script(
      js +
        "\nthis.getModelPricingClient = getModelPricingClient;" +
        "\nthis.calcSavingsFromBuckets = calcSavingsFromBuckets;",
    );
    script.runInNewContext(sandbox);

    const getModelPricingClient = sandbox.getModelPricingClient as (
      m: string,
    ) => { input: number; output: number } | null;
    const calcSavingsFromBuckets = sandbox.calcSavingsFromBuckets as (
      buckets: Array<Record<string, unknown>>,
    ) => { byModel: Record<string, { totalUsd: number }> };

    // Exact entry
    const exact = getModelPricingClient("gemini-3.7-flash-tiered");
    assert.ok(exact);
    assert.equal(exact.input, 0.75);
    assert.equal(exact.output, 3.75);
    // Provider-prefixed id resolves via the 3.7-flash fallback...
    const prefixed = getModelPricingClient("google/gemini-3.7-flash-tiered");
    assert.ok(prefixed);
    assert.equal(prefixed.input, 0.75);
    assert.equal(prefixed.output, 3.75);
    // ...and never collapses to the generic gemini-3-flash rates.
    const legacy = getModelPricingClient("gemini-3-flash");
    assert.ok(legacy);
    assert.equal(legacy.input, 0.5);
    assert.equal(legacy.output, 3.0);
    assert.notEqual(prefixed.input, legacy.input);

    const savings = calcSavingsFromBuckets([
      {
        byModel: {
          "gemini-3.7-flash-tiered": {
            inputTokens: 1_000_000,
            outputTokens: 1_000_000,
          },
        },
      },
    ]);
    assert.equal(savings.byModel["gemini-3.7-flash-tiered"].totalUsd, 4.5);
  });

  it("does not offer kickstart controls for Codex quota pools", () => {
    const js = readDashboardJs();
    const sandbox: Record<string, unknown> = {
      window: { location: { search: "" } } as Record<string, unknown>,
      URLSearchParams: globalThis.URLSearchParams,
      EventSource: function () {},
      setInterval: () => {},
      clearInterval: () => {},
      setTimeout: () => {},
      clearTimeout: () => {},
      localStorage: { getItem: () => null, setItem: () => {} },
      document: {
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: () => {},
      },
    };
    const script = new Script(
      js +
        "\nthis.isKickstartSupported = isKickstartSupported;",
    );
    script.runInNewContext(sandbox);
    const isKickstartSupported = sandbox.isKickstartSupported as (
      quota: Record<string, unknown>,
    ) => boolean;

    assert.equal(
      isKickstartSupported({ modelKey: "openai-codex", providerId: "openai-codex" }),
      false,
    );
    assert.equal(
      isKickstartSupported({ modelKey: "session", providerId: "ollama" }),
      true,
    );
  });

  it("includes optional admin-token client support", () => {
    const js = readDashboardJs();
    assert.match(js, /X-Rotator-Admin-Token/);
    assert.match(js, /rotatorAdminToken/);
    assert.match(js, /authFetch/);
    assert.match(js, /authEventUrl/);
  });

  it("keeps dashboard masking controls available", () => {
    const html = renderDashboard();
    const js = readDashboardJs();
    assert.match(html, /PII: Visible/);
    assert.match(js, /function toggleMask\(\)/);
  });

  it("renders the free tier model access attention item", () => {
    const js = readDashboardJs();
    const start = js.indexOf("var freeTierAccounts = accounts.filter");
    assert.ok(start > 0, "free tier accounts filter missing");
    const item = js.slice(start, js.indexOf("if (items.length === 0)", start));
    assert.match(item, /Free tier model access/);
    assert.match(item, /modelTierAccess/);
    assert.match(item, /HTTP 403/);
    assert.match(item, /requires a subscription/);
    assert.match(item, /✓/);
    assert.match(item, /✗/);
  });

  it("includes a plus tier option in account controls", () => {
    const js = readDashboardJs();
    assert.match(js, /'plus'/);
    assert.match(js, /PLUS<\/div>/);
  });

  it("includes the v2 config editor controls", () => {
    const html = renderDashboard();
    const js = readDashboardJs();
    assert.match(html, /Config Editor/);
    assert.match(html, /configEditorModal/);
    assert.match(html, /routingInspectorModal/);
    assert.match(html, /Routing Inspector/);
    assert.match(html, /sequential-quota/);
    assert.match(html, /sticky-quota/);
    assert.match(js, /\/api\/config/);
    assert.match(js, /openConfigEditorModal/);
    assert.match(js, /openRoutingInspectorModal/);
    assert.match(js, /saveConfigEditor/);
    assert.match(html, /Attention Needed/);
  });

  it("declares utf-8 and responsive viewport in head", () => {
    const html = renderDashboard();
    assert.match(html, /charset="?utf-8"?/i);
    assert.match(html, /name="viewport".*content="width=device-width/i);
  });

  it("includes the accounts control-room shell", () => {
    const html = renderDashboard();
    assert.match(html, /<body class="accounts-page">/);
    assert.match(html, /class="accounts-dashboard"/);
    assert.match(html, /class="dashboard-intro"/);
    assert.match(html, /class="dashboard-live-chip"/);
    assert.match(html, /dashboard-refresh-btn/);
  });

  it("includes control-room shells for virtual keys and spend logs", () => {
    const keysHtml = renderDashboardKeys();
    const logsHtml = renderDashboardLogs();

    assert.match(keysHtml, /<body class="keys-page">/);
    assert.match(keysHtml, /class="keys-workspace"/);
    assert.match(keysHtml, /Access \/ Credentials/);
    assert.match(keysHtml, /class="workspace-live-chip"/);
    assert.match(keysHtml, /keySearchInput/);

    assert.match(logsHtml, /<body class="logs-page">/);
    assert.match(logsHtml, /class="logs-workspace"/);
    assert.match(logsHtml, /Observability \/ Spend telemetry/);
    assert.match(logsHtml, /class="logs-filter-heading"/);
    assert.match(logsHtml, /logsTable/);
  });

  it("keeps the accounts title readable and the desktop grid dense", () => {
    const css = readDashboardCss();
    const titleRule = css.match(/\.accounts-page \.header h1\s*{([^}]*)}/)?.[1];
    const gradientRule = css.match(
      /@supports\s*\(\s*background-clip:\s*text\s*\)\s+or\s+\(\s*-webkit-background-clip:\s*text\s*\)[\s\S]*?\.accounts-page \.header h1\s*{([^}]*)}/,
    )?.[1];
    const gridRule = css.match(/\.accounts-page \.accounts-grid\s*{([^}]*)}/)?.[1];
    const dashboardRule = css.match(/\.accounts-page \.accounts-dashboard\s*{([^}]*)}/)?.[1];

    assert.ok(titleRule, "accounts title rule not found");
    assert.match(titleRule, /background:\s*#f4f2ff/);
    assert.match(titleRule, /color:\s*#f4f2ff/);
    assert.match(titleRule, /-webkit-text-fill-color:\s*#f4f2ff/);

    assert.ok(gradientRule, "accounts title gradient rule not found");
    assert.match(gradientRule, /background:\s*linear-gradient\(135deg,\s*#fff,\s*#b8a9ff\)/);
    assert.match(gradientRule, /-webkit-background-clip:\s*text/);
    assert.match(gradientRule, /background-clip:\s*text/);
    assert.match(gradientRule, /-webkit-text-fill-color:\s*transparent/);

    assert.ok(gridRule, "accounts grid rule not found");
    assert.match(gridRule, /grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(100%,\s*300px\),\s*1fr\)\)/);

    assert.ok(dashboardRule, "accounts dashboard rule not found");
    assert.match(dashboardRule, /max-width:\s*none/);
  });

  it("references all documented admin API endpoints", () => {
    const js = readDashboardJs();
    const endpoints = [
      "/api/status",
      "/api/config",
      "/api/events",
      "/api/benchmark",
      "/api/enable/",
      "/api/disable/",
      "/api/quarantine/",
      "/api/restore/",
      "/api/clear-inflight/",
      "/api/clear-breaker/",
      "/api/settings/fresh-window-starts/",
      "/api/account-fresh-window-starts/",
      "/api/settings/auto-warmup/",
      "/api/kickstart/",
      "/api/self-update",
    ];
    for (const endpoint of endpoints) {
      assert.ok(js.includes(endpoint), `missing endpoint: ${endpoint}`);
    }
  });

  it("includes the account benchmark controls", () => {
    const html = renderDashboard();
    const js = readDashboardJs();
    assert.match(html, /Account Benchmark/);
    assert.match(html, /benchmarkBtn/);
    assert.match(js, /function runBenchmark\(\)/);
    assert.match(js, /benchmarkResults/);
  });

  it("renders routing inspector health score components", () => {
    const js = readDashboardJs();
    assert.match(js, /function renderHealthBreakdown\(entry\)/);
    assert.match(js, /breakdown\.quotaComponent/);
    assert.match(js, /breakdown\.errorPenalty/);
    assert.match(js, /breakdown\.cooldownPenalty/);
    assert.match(js, /breakdown\.availabilityPenalty/);
    assert.match(js, /Health breakdown/);
  });

  it("applies PII masking to account benchmark rows", () => {
    const js = readDashboardJs();
    assert.match(js, /escapeHtml\(maskText\(result\.account\)\)/);
  });

  it("embeds the escapeHtml and jsString helpers used to defend against XSS", () => {
    const js = readDashboardJs();
    assert.match(js, /function escapeHtml\(/);
    assert.match(js, /function jsString\(/);
    assert.match(js, /function maskText\(/);
    assert.match(js, /function maskEmail\(/);
  });

  it("validates notification links and escapes notification IDs in handlers", () => {
    const js = readDashboardJs();
    assert.match(js, /function safeActionUrl\(/);
    assert.match(js, /safeActionUrl\(n\.actionUrl\)/);
    assert.match(js, /jsString\(n\.id\)/);
  });

  it("escapeHtml correctly escapes the five HTML-sensitive characters", () => {
    const js = readDashboardJs();
    const match = js.match(/function escapeHtml\([^)]*\)\s*{[\s\S]*?\n\s*\}/);
    assert.ok(match, "escapeHtml function not found in dashboard JS");
    const fnSrc = match[0];
    const ctx: { escapeHtml?: (s: unknown) => string } = {};
    new Function("ctx", `${fnSrc}; ctx.escapeHtml = escapeHtml;`)(ctx);
    assert.equal(
      ctx.escapeHtml!("<script>alert(1)</script>"),
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
    assert.equal(ctx.escapeHtml!("a & b"), "a &amp; b");
    assert.equal(ctx.escapeHtml!('"quoted"'), "&quot;quoted&quot;");
    assert.equal(ctx.escapeHtml!("'apos'"), "&#39;apos&#39;");
    assert.equal(ctx.escapeHtml!(null), "null");
    assert.equal(ctx.escapeHtml!(42), "42");
  });

  it("jsString correctly escapes a single quote, backslash, and newlines", () => {
    const js = readDashboardJs();
    const escapeSrc = js.match(
      /function escapeHtml\([^)]*\)\s*{[\s\S]*?\n\s*\}/,
    );
    const jsStringSrc = js.match(
      /function jsString\([^)]*\)\s*{[\s\S]*?\n\s*\}/,
    );
    assert.ok(escapeSrc, "escapeHtml function not found in dashboard JS");
    assert.ok(jsStringSrc, "jsString function not found in dashboard JS");
    const ctx: { jsString?: (s: string) => string } = {};
    new Function(
      "ctx",
      `${escapeSrc[0]}\n${jsStringSrc[0]}\nctx.jsString = jsString;`,
    )(ctx);
    assert.equal(ctx.jsString!("hello"), "hello");
    assert.equal(ctx.jsString!("it's"), "it\\&#39;s");
    assert.equal(ctx.jsString!("a\\b"), "a\\\\b");
    assert.equal(ctx.jsString!("line1\nline2"), "line1\\nline2");
  });

  it("does not contain hardcoded OAuth client_id or client_secret", () => {
    const html = renderDashboard();
    assert.doesNotMatch(html, /\.apps\.googleusercontent\.com/);
    assert.doesNotMatch(html, /GOCSPX-[A-Za-z0-9_-]{20,}/);
  });

  it("does not embed OAuth credentials in utility scripts", () => {
    const scripts = [
      "scripts/query_models.js",
      "scripts/test_generate.js",
      "scripts/test_loop.js",
    ];
    for (const script of scripts) {
      const source = readFileSync(join(__dirname, "..", script), "utf-8");
      assert.doesNotMatch(source, /CLIENT_(?:ID|SECRET)\s*=\s*atob\(/, script);
      assert.match(source, /process\.env\.ANTIGRAVITY_CLIENT_ID/, script);
      assert.match(source, /process\.env\.ANTIGRAVITY_CLIENT_SECRET/, script);
    }
  });

  it("does not inline any obvious secret keys (refreshToken, accessToken)", () => {
    const html = renderDashboard();
    assert.doesNotMatch(html, /refreshToken\s*[:=]\s*["']1\/\//);
    assert.doesNotMatch(html, /accessToken\s*[:=]\s*["']ya29\./);
  });

  it("contains syntactically valid dashboard-keys.js and dashboard-logs.js with mask support", () => {
    const keysJs = readFileSync(join(__dirname, "..", "src", "static", "dashboard-keys.js"), "utf-8");
    const logsJs = readFileSync(join(__dirname, "..", "src", "static", "dashboard-logs.js"), "utf-8");
    assert.doesNotThrow(() => new Script(keysJs));
    assert.doesNotThrow(() => new Script(logsJs));
    assert.match(keysJs, /function toggleMask\(\)/);
    assert.match(logsJs, /function toggleMask\(\)/);
    assert.match(keysJs, /MASK_MODE/);
    assert.match(logsJs, /MASK_MODE/);
  });

  it("renders the Generate Virtual Key model grid dynamically from /api/models", () => {
    // The model grid used to be hardcoded in the HTML template, so models
    // added by new providers (Ollama, OpenAI Codex, OpenCode Zen) were
    // missing from the Allowed Models picker. The dashboard now fetches
    // /api/models and groups results by owned_by, so we verify the JS
    // exposes the helpers used to drive that flow and the HTML shell no
    // longer ships the stale hardcoded list.
    const keysJs = readFileSync(join(__dirname, "..", "src", "static", "dashboard-keys.js"), "utf-8");
    const keysHtml = renderDashboardKeys();
    assert.match(
      keysJs,
      /function renderModelGridFromCatalog\(/,
      "renderModelGridFromCatalog helper must exist",
    );
    assert.match(
      keysJs,
      /function ensureModelGridRendered\(/,
      "ensureModelGridRendered helper must exist",
    );
    assert.match(
      keysJs,
      /function providerLabel\(/,
      "providerLabel helper must exist",
    );
    assert.match(
      keysJs,
      /fetch\("\/api\/models"/,
      "ensureModelGridRendered must fetch /api/models",
    );
    assert.match(
      keysJs,
      /owned_by/,
      "catalog must be grouped by owned_by",
    );
    // The static hardcoded list of Gemini/Claude/GPT-OSS checkboxes is
    // removed from the modal HTML so the JS is the single source of
    // truth for which models are presented.
    assert.doesNotMatch(
      keysHtml,
      /value="gemini-3\.1-pro-high" class="modelCb"/,
      "stale hardcoded Gemini 3.1 Pro model card must be gone",
    );
    assert.doesNotMatch(
      keysHtml,
      /value="claude-opus-4-6-thinking" class="modelCb"/,
      "stale hardcoded Claude Opus model card must be gone",
    );
    // The empty grid container the JS populates must be present.
    assert.match(keysHtml, /id="modelGrid"/);
    assert.match(keysHtml, /id="modelGridEmpty"/);
  });
});
