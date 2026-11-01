import { it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, closeDb } from "../src/db-store.js";
import { completedAccessProbe, serveAccessProbe } from "../src/access-probe.js";
import { getProviderAdapter } from "../src/providers/registry.js";
import { getAccountIdentity } from "../src/account-identity.js";
import type { AccountRotator } from "../src/rotator.js";
import type { AccountRuntime } from "../src/types.js";

it("requires provider completion evidence, rejecting HTTP 200 stream errors and truncation", () => {
  assert.equal(completedAccessProbe("ollama", '{"done":true}'), true);
  assert.equal(completedAccessProbe("ollama", '{"error":"denied"}'), false);
  assert.equal(completedAccessProbe("openai-codex", 'data: {"type":"response.completed"}\n'), true);
  assert.equal(completedAccessProbe("openai-codex", 'data: {"type":"response.failed","error":{}}\n'), false);
  assert.equal(completedAccessProbe("openai-codex", 'data: {"type":"response.created"}\n'), false);
  assert.equal(completedAccessProbe("openai-codex", 'data: {"type":"response.error"}\ndata: {"type":"response.completed"}\n'), false);
  assert.equal(completedAccessProbe("google-antigravity", 'data: {"response":{"candidates":[{"finishReason":"STOP"}]}}\n'), true);
  assert.equal(completedAccessProbe("google-antigravity", 'data: {"error":{"code":403}}\n'), false);
  assert.equal(completedAccessProbe("opencode-zen", '{"choices":[{"finish_reason":"stop"}]}'), true);
});

it("probes exactly the selected provider/account, records quota, rejects invalid scope without forwarding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "probe-evidence-"));
  const previous = process.env.TUXEVIL_ROTATOR_DIR;
  process.env.TUXEVIL_ROTATOR_DIR = directory;
  const account = { config: { email: "probe@example.test", credentials: [{provider:"ollama",apiKey:"test"}] }, inFlightRequests: 0, disabled: false, flagged: false } as AccountRuntime;
  let calls = 0, active = 0;
  let response = new Response('{"error":"quota"}', {status:429});
  const rotator = {
    getBenchmarkAccounts: () => [account],
    getConfig: () => ({ accounts: [account.config] }),
    getOllamaModels: () => ["beam"], getCodexModels: () => [],
    isProviderOffForAccount: () => false,
    ensureValidToken: async (a: AccountRuntime, provider: string) => { assert.equal(a, account); assert.equal(provider,"ollama"); },
    startRequest: () => { active++; }, finishRequest: () => { active--; }, recordUpstreamAttempt: () => {},
  } as unknown as AccountRotator;
  const adapter = getProviderAdapter("ollama"); const original = adapter.forwardRequest;
  adapter.forwardRequest = async (a, body, headers) => {
    calls++; assert.equal(a,account); assert.equal(body.model,"beam"); assert.deepEqual(headers,{});
    return { response, endpoint:"test" };
  };
  const server = createServer((req,res) => { void serveAccessProbe(req,res,rotator); });
  server.listen(0,"127.0.0.1"); await once(server,"listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const post = (body: unknown) => fetch(url,{method:"POST",body:JSON.stringify(body)});
  try {
    assert.equal((await post({accountId:getAccountIdentity(account.config),provider:"ollama",model:"beam"})).status,503);
    assert.equal(calls,0); await initDb();
    const result = await post({accountId:getAccountIdentity(account.config),provider:"ollama",model:"beam"});
    assert.equal(result.status,200); const value = await result.json();
    assert.equal(value.kind,"quota"); assert.equal(value.enforced,false); assert.equal(value.clientVerified,false);
    assert.equal(JSON.stringify(value).includes("probe@example"),false);
    assert.equal((await post({accountId:getAccountIdentity(account.config),provider:"openai-codex",model:"beam"})).status,400);
    assert.equal((await post({accountId:getAccountIdentity(account.config),provider:"ollama",model:"nonexistent"})).status,400);
    account.inFlightRequests = 5;
    const busy = await post({accountId:getAccountIdentity(account.config),provider:"ollama",model:"beam"});
    assert.equal(busy.status,409); assert.equal((await busy.json()).reason,"account-busy");
    assert.equal(calls,1); account.inFlightRequests = 0;
    response = new Response('{"error":"stream failed"}');
    assert.equal((await (await post({accountId:getAccountIdentity(account.config),provider:"ollama",model:"beam"})).json()).kind,"unknown");
    response = new Response('{"done":true}');
    assert.equal((await (await post({accountId:getAccountIdentity(account.config),provider:"ollama",model:"beam"})).json()).kind,"success");
    assert.equal(calls,3); assert.equal(active,0);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release=resolve; });
    const started = new Promise<void>(resolve => { entered=resolve; });
    adapter.forwardRequest = async () => { calls++; entered(); await gate; return {response:new Response('{"done":true}'),endpoint:"test"}; };
    const pending = post({accountId:getAccountIdentity(account.config),provider:"ollama",model:"beam"});
    await started;
    const concurrent = await post({accountId:getAccountIdentity(account.config),provider:"ollama",model:"beam"});
    assert.equal(concurrent.status,409); assert.equal((await concurrent.json()).reason,"probe-busy");
    release(); assert.equal((await pending).status,200); assert.equal(calls,4); assert.equal(active,0);
    const persisted = JSON.parse(await readFile(join(directory,"model-access-evidence.json"),"utf8"));
    assert.equal(persisted.observations[0].kind,"success");
    assert.equal(persisted.observations[0].model,"beam");
  } finally { adapter.forwardRequest=original; server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); await closeDb();
    if (previous === undefined) delete process.env.TUXEVIL_ROTATOR_DIR; else process.env.TUXEVIL_ROTATOR_DIR = previous;
    await rm(directory,{recursive:true,force:true}); }
});
