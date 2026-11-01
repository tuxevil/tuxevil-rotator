import { it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import pg from "pg";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountRotator } from "../src/rotator.js";

it("enforces virtual keys over HTTP before auto selection and excludes forbidden models", async (t) => {
  // Dynamic imports ensure this isolated test process chooses the mocked PG repository.
  const directory = await mkdtemp(join(tmpdir(), "auto-http-auth-"));
  process.env.TUXEVIL_ROTATOR_DIR = directory;
  process.env.TUXEVIL_ROTATOR_DATABASE_URL = "postgres://test.invalid/isolated";
  let models = ["forbidden-model"];
  let blocked = false;
  t.mock.method(pg.Pool.prototype, "query", async (sql: string) => {
    if (sql.includes("COUNT(*)")) return { rows: [{ count: "1" }] };
    if (sql.includes("SELECT * FROM rotator_virtual_keys WHERE")) return { rows: [{ token_hash: "test-hash", key_name: "test", key_alias: "test", models, blocked, created_at: "2026-01-01" }] };
    return { rows: [] };
  });
  const db = await import("../src/db-store.js");
  await db.initDb();
  const { clearVirtualKeyCache } = await import("../src/virtual-keys.js");
  const { handleOpenAIChatCompletions } = await import("../src/compat.js");
  const { OLLAMA_CHAT_ENDPOINTS } = await import("../src/types.js");
  const endpoints = OLLAMA_CHAT_ENDPOINTS as string[];
  const originalEndpoints = [...endpoints];
  let forwardedModel: unknown;
  let providerError = false;
  const upstream = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += String(chunk); });
    req.on("end", () => {
      forwardedModel = JSON.parse(body).model;
      if (providerError) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ error: "private-provider-error" })); return; }
      res.setHeader("content-type", "application/x-ndjson");
      res.end(JSON.stringify({ model: "allowed-model", message: { role: "assistant", content: "hello back" }, done: true, prompt_eval_count: 3, eval_count: 2 }) + "\n");
    });
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === "object");
  endpoints.splice(0, endpoints.length, `http://127.0.0.1:${upstreamAddress.port}/api/chat`);
  let available = false;
  const account = {
    config: { email: "mock@test", provider: "ollama", apiKey: "mock-key" },
    accessToken: "mock", tokenExpires: Date.now() + 60000,
    inFlightRequests: 0, inFlightByModel: {}, cooldownsByModel: {}, quota: [], healthScore: 1,
  };
  const observed: string[] = [];
  const shadowEvents: Array<{ event?: string; provider?: string; enforced?: boolean; model?: string }> = [];
  t.mock.method(console, "info", (...args: unknown[]) => {
    const json = args.find(value => typeof value === "string" && value.startsWith("{"));
    if (typeof json === "string") shadowEvents.push(JSON.parse(json));
  });
  const rotator = {
    getConfig: () => ({ accounts: [], modelAccessShadow: true, typesafeRouting: { enabled: false }, protectivePauseMs: 0 }),
    getActiveAccount: async () => account,
    getRetryAfterMs: () => 0,
    getSafetyJitterMs: () => 0,
    getGlobalDelayMs: () => 0,
    recordUpstreamAttempt: () => {},
    markError: () => {},
    recordRequest: () => false,
    finishRequest: () => {},
    recordLatency: () => {},
    recordTokenUsage: () => {},
    recordRequestLog: () => {},
    recordProxyEvent: () => {},
    saveState: () => {},
    getStatus: () => ({ accounts: [] }),
    getOllamaModels: () => ["allowed-model", "forbidden-model"],
    getCodexModels: () => [],
    hasActiveProvider: (provider: string) => provider === "ollama",
    getAutoRoutingCandidateStatus: (model: string) => { observed.push(model); return { available, operationalScore: 0.9 }; },
  } as unknown as AccountRotator;
  const server = createServer((req, res) => { void handleOpenAIChatCompletions(req, res, rotator).catch(() => { res.statusCode = 500; res.end(); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const send = (key?: string) => fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hello" }] }),
  });
  try {
    assert.equal((await send()).status, 401);
    blocked = true;
    assert.equal((await send("rk-test")).status, 403);
    assert.deepEqual(observed, []);
    blocked = false;
    models = ["allowed-model"];
    clearVirtualKeyCache();
    // No account is available, but only the authorized model reaches health checks.
    assert.equal((await send("rk-test")).status, 503);
    assert.deepEqual(observed, ["allowed-model"]);
    observed.length = 0;
    models = ["absent-model"];
    clearVirtualKeyCache();
    assert.equal((await send("rk-test")).status, 503);
    assert.deepEqual(observed, []);
    models = ["allowed-model"];
    available = true;
    clearVirtualKeyCache();
    const success = await send("rk-test");
    assert.equal(success.status, 200, await success.clone().text());
    const payload = await success.json() as { choices: { message: { content: string } }[] };
    assert.equal(payload.choices[0].message.content, "hello back");
    assert.equal(forwardedModel, "allowed-model");
    const comparison = shadowEvents.find(event => event.event === "model-access-policy-shadow");
    assert.equal(comparison?.provider, "ollama");
    assert.equal(comparison?.model, "allowed-model");
    assert.equal(comparison?.enforced, false);
    const { accessEvidenceStore } = await import("../src/access-evidence.js");
    const evidence = accessEvidenceStore().forAccount(account.config);
    assert.equal(evidence.observations.at(-1)?.kind, "success");
    assert.equal(evidence.observations.at(-1)?.model, "allowed-model");
    providerError = true;
    const invalid = await send("rk-test");
    assert.equal(invalid.status, 502);
    assert.doesNotMatch(await invalid.text(), /private-provider-error/);
    assert.deepEqual(observed, ["allowed-model", "allowed-model"]);
  } finally {
    endpoints.splice(0, endpoints.length, ...originalEndpoints);
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.closeDb();
    delete process.env.TUXEVIL_ROTATOR_DATABASE_URL;
    delete process.env.TUXEVIL_ROTATOR_DIR;
    await rm(directory, { recursive: true, force: true });
  }
});
