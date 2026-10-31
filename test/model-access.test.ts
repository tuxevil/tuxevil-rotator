import { it } from "node:test";
import assert from "node:assert/strict";
import { evaluateModelAccess, MODEL_ACCESS_RULES } from "../src/model-access.js";
import { buildModelAccessReport } from "../src/model-access-api.js";
import type { Config } from "../src/types.js";
const at = "2026-10-30T12:00:00Z";
it("distinguishes free, trial and paid Antigravity plans and effort variants", () => {
  for (const model of ["gemini-4-argon-high", "claude-sonnet-5-5-medium", "claude-opus-5-5-high"]) {
    assert.equal(evaluateModelAccess({ provider: "google-antigravity", model, plan: "free", at }).state, "blocked");
    assert.equal(evaluateModelAccess({ provider: "google-antigravity", model, plan: "pro-paid", at }).state, "allowed");
    assert.equal(evaluateModelAccess({ provider: "google-antigravity", model, plan: "pro", at }).state, "unknown");
  }
  assert.equal(evaluateModelAccess({ provider: "google-antigravity", model: "claude-opus-5-5-high", plan: "pro-trial", at }).state, "blocked");
  assert.equal(evaluateModelAccess({ provider: "google-antigravity", model: "gemini-4-argon", plan: "pro-trial", at }).state, "conditional");
});
it("handles the announced removal and does not invent historical evidence", () => {
  const query = { provider: "google-antigravity", model: "claude-sonnet-4-6-thinking", plan: "free" };
  assert.equal(evaluateModelAccess({ ...query, at: "2026-11-01T23:59:59Z" }).state, "allowed");
  assert.equal(evaluateModelAccess({ ...query, at: "2026-11-02T00:00:00Z" }).state, "blocked");
  assert.equal(evaluateModelAccess({ ...query, at: "2026-09-01" }).state, "unknown");
  assert.throws(() => evaluateModelAccess({ ...query, at: "invalid" }));
  assert.equal(evaluateModelAccess({ provider: "google-antigravity", model: "gemini-3.8-flash", plan: "free", at: "2026-12-01" }).state, "unknown");
});
it("keeps pending operator claims unknown and client declarations conditional", () => {
  assert.equal(evaluateModelAccess({ provider: "openai-codex", model: "gpt-6-luna", plan: "free", at }).state, "unknown");
  for (const client of ["unknown", "other", "opencode"]) {
    const result = evaluateModelAccess({ provider: "opencode-zen", model: "mimo-v2.5-free", client, at });
    assert.equal(result.state, "conditional"); assert.equal(result.clientVerified, false);
  }
  assert.equal(evaluateModelAccess({ provider: "opencode-zen", model: "paid-model", at }).state, "unknown");
  assert.equal(evaluateModelAccess({ provider: "opencode-zen", model: "big-pickle", client: "opencode", at }).state, "conditional");
  assert.equal(MODEL_ACCESS_RULES.filter(r => r.provider === "ollama").length, 7);
});
it("does not expose credentials or infer linked provider plans", () => {
  const config = { accounts: [{ email: "account@test", projectId: "project", refreshToken: "private-refresh", tier: "free", credentials: [{ provider: "google-antigravity", refreshToken: "private-google" }, { provider: "openai-codex", refreshToken: "private-codex" }] }] } as Config;
  const report = buildModelAccessReport(config, new URLSearchParams());
  assert.equal(report.accounts[0].inferredPlan, "unknown");
  assert.doesNotMatch(JSON.stringify(report), /private-refresh|private-google|private-codex/);
  const params = new URLSearchParams({ accountId: report.accounts[0].id, provider: "openai-codex", model: "gpt-6-luna", plan: "free", at });
  assert.equal(buildModelAccessReport(config, params).planSource, "query-assumption");
  params.set("provider", "ollama"); assert.throws(() => buildModelAccessReport(config, params));
  params.set("accountId", "absent"); assert.throws(() => buildModelAccessReport(config, params));
});

it("documents exact Terra6.1 Free/Plus policy without extending it to future variants or older dates",()=>{
 const query={provider:'openai-codex',model:'gpt-6.1-terra',at:'2026-10-31'};
 assert.equal(evaluateModelAccess({...query,plan:'free'}).state,'blocked');
 assert.equal(evaluateModelAccess({...query,plan:'plus'}).state,'allowed');
 assert.equal(evaluateModelAccess({...query,plan:'free',model:'gpt-6.1-terra-future'}).state,'unknown');
 assert.equal(evaluateModelAccess({...query,plan:'free',at:'2026-10-25'}).state,'unknown');
 assert.equal(evaluateModelAccess({...query,plan:'free',at:'2026-12-01'}).state,'unknown');
 assert.equal(evaluateModelAccess({...query,plan:'free'}).informational,true);
});
