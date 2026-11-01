import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { setPersistedAdminToken } from "../src/admin-auth.js";
import { startProxy } from "../src/proxy.js";
import { stopNotificationPoller } from "../src/notification-poller.js";
import { stopVersionChecker } from "../src/version-check.js";
import { setAntigravityModelsForTest } from "./fixtures/antigravity-catalog.js";

function makeRotator() {
  const state = {
    enabledEmail: "",
    events: [] as string[],
  };
  const rotator = {
    saveState() {},
    getStatus() {
      return { accounts: [], security: { adminTokenConfigured: true } };
    },
    enableAccount(email: string) {
      state.enabledEmail = email;
      return email === "user@example.com";
    },
    recordProxyEvent(message: string) {
      state.events.push(message);
    },
  };
  return { rotator, state };
}

async function startTestProxy(rotator: unknown): Promise<Server> {
  const server = startProxy(rotator as never, 0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe("proxy admin routes", () => {
  let server: Server | null = null;
  const previousTelemetry = process.env.PI_ROTATOR_TELEMETRY;

  beforeEach(() => {
    process.env.PI_ROTATOR_TELEMETRY = "off";
    setPersistedAdminToken("secret");
  });

  afterEach(async () => {
    setPersistedAdminToken(null);
    stopVersionChecker();
    stopNotificationPoller();
    if (server) {
      await closeServer(server);
      server = null;
    }
    if (previousTelemetry === undefined) {
      delete process.env.PI_ROTATOR_TELEMETRY;
    } else {
      process.env.PI_ROTATOR_TELEMETRY = previousTelemetry;
    }
  });

  it("protects access diagnostics and explains dated rules without exposing secrets", async () => {
    const { rotator } = makeRotator();
    server = await startTestProxy({ ...rotator, getConfig: () => ({ accounts: [{ email: "test@example.com", projectId: "p", refreshToken: "private-refresh", provider: "google-antigravity", tier: "free" }] }) });
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}/api/model-access`;
    assert.equal((await fetch(base)).status, 401);
    assert.equal((await fetch(base + "/probe", { method: "POST", body: "{}" })).status, 401);
    assert.equal((await fetch(base + "/plan", { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
    const headers = { "x-rotator-admin-token": "secret" };
    const response = await fetch(base + "?provider=google-antigravity&model=claude-sonnet-4-6&plan=free&at=2026-11-02", { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json() as { decision: { state: string } };
    assert.equal(body.decision.state, "blocked");
    assert.doesNotMatch(JSON.stringify(body), /private-refresh/);
    assert.equal((await fetch(base + "?provider=google-antigravity", { headers })).status, 400);
  });

  it("matches dynamic admin routes by pathname while preserving query-token auth", async () => {
    const { rotator, state } = makeRotator();
    server = await startTestProxy(rotator);
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(
      `http://127.0.0.1:${port}/api/enable/user%40example.com?token=secret`,
      { method: "POST" },
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, { ok: true, email: "user@example.com" });
    assert.equal(state.enabledEmail, "user@example.com");
  });

  it("lets hosted OAuth callbacks reach state validation when admin auth is enabled", async () => {
    const { rotator } = makeRotator();
    server = await startTestProxy(rotator);
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(
      `http://127.0.0.1:${port}/auth/antigravity/callback?code=abc&state=missing`,
    );
    const body = await response.text();

    assert.equal(response.status, 400);
    assert.match(body, /Session Expired/);
    assert.doesNotMatch(body, /Unauthorized/);
  });

  it("does not expose config import exception details", async () => {
    const { rotator } = makeRotator();
    server = await startTestProxy(rotator);
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(
      `http://127.0.0.1:${port}/api/config?token=secret`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "{ invalid json",
      },
    );
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(body, { ok: false, error: "Invalid config request" });
    assert.doesNotMatch(JSON.stringify(body), /Unexpected token|SyntaxError/);
  });

  it("serves the admin /api/models catalog used by the Generate Virtual Key modal", async () => {
    setAntigravityModelsForTest([
      "gemini-3.1-pro-high",
      "claude-sonnet-4-6",
    ]);
    // Build a rotator whose live Antigravity snapshot plus one Ollama
    // model and one Codex model so the test exercises the active-provider
    // branch of buildOpenAIModelCatalog.
    const rotator = {
      saveState() {},
      getStatus() {
        return { accounts: [] };
      },
      hasActiveProvider(providerId: string) {
        return providerId === "ollama" || providerId === "openai-codex";
      },
      getOllamaModels() {
        return ["gemma4:31b"];
      },
      recordProxyEvent() {},
    };
    server = await startTestProxy(rotator);
    const port = (server.address() as AddressInfo).port;

    const noToken = await fetch(`http://127.0.0.1:${port}/api/models`);
    assert.equal(noToken.status, 401, "unauthenticated /api/models must be rejected");

    const response = await fetch(
      `http://127.0.0.1:${port}/api/models?token=secret`,
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      ok: boolean;
      count: number;
      data: Array<{ id: string; owned_by: string }>;
    };
    assert.equal(body.ok, true);
    assert.equal(body.count, body.data.length);

    // Models observed in the current Antigravity snapshot must be present.
    assert.ok(
      body.data.some((m) => m.owned_by === "tuxevil-rotator" && m.id === "gemini-3.1-pro-high"),
      "missing dynamically advertised Gemini model",
    );
    assert.ok(
      body.data.some((m) => m.owned_by === "tuxevil-rotator" && m.id === "claude-sonnet-4-6"),
      "missing static Claude model",
    );

    // The Ollama model must come from the rotator's getOllamaModels() result.
    assert.ok(
      body.data.some((m) => m.owned_by === "ollama" && m.id === "gemma4:31b"),
      "missing Ollama model from active provider",
    );

    // Codex allowlist models must appear because hasActiveProvider returned true.
    assert.ok(
      body.data.some((m) => m.owned_by === "openai-codex" && m.id === "gpt-5.6-sol"),
      "missing Codex model from active provider",
    );
  });

  it("/api/models omits catalogs from providers with no active credentials", async () => {
    const rotator = {
      saveState() {},
      getStatus() {
        return { accounts: [] };
      },
      hasActiveProvider() {
        return false;
      },
      getOllamaModels() {
        return ["gemma4:31b"];
      },
      recordProxyEvent() {},
    };
    server = await startTestProxy(rotator);
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(
      `http://127.0.0.1:${port}/api/models?token=secret`,
    );
    const body = (await response.json()) as {
      data: Array<{ id: string; owned_by: string }>;
    };

    assert.ok(
      !body.data.some((m) => m.owned_by === "openai-codex"),
      "Codex models must be hidden when the provider is inactive",
    );
    assert.ok(
      !body.data.some((m) => m.owned_by === "ollama"),
      "Ollama models must be hidden when the provider is inactive",
    );
    assert.ok(
      !body.data.some((m) => m.owned_by === "opencode-zen"),
      "OpenCode Zen models must be hidden when the provider is inactive",
    );
  });
});
