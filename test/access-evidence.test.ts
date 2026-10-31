import { it } from "node:test";
import assert from "node:assert/strict";
import { AccessEvidenceStore, classifyAccessObservation } from "../src/access-evidence.js";
import type { AccountConfig } from "../src/types.js";
const account: AccountConfig = { email: "test@example.com", projectId: "project", credentials: [{ provider: "ollama", apiKey: "private-key" }, { provider: "openai-codex", refreshToken: "private-refresh" }] };
it("keeps generic errors unknown and distinguishes quota, auth, transport and explicit codes", () => {
  assert.equal(classifyAccessObservation(400, 'model unavailable for free'), "unknown");
  assert.equal(classifyAccessObservation(403, 'denied'), "unknown");
  assert.equal(classifyAccessObservation(401), "authentication");
  assert.equal(classifyAccessObservation(402), "payment-or-plan");
  assert.equal(classifyAccessObservation(429), "quota");
  assert.equal(classifyAccessObservation(null, '', true), "transport");
  assert.equal(classifyAccessObservation(403, '{"error":{"type":"FreeTierError"}}'), "client-restriction");
  assert.equal(classifyAccessObservation(400, '{"error":{"code":"MODEL_NOT_SUPPORTED_FOR_PLAN"}}'), "entitlement");
});
it("separates provider plans and invalidates evidence after credential change or expiry", () => {
  const store = new AccessEvidenceStore();
  store.declarePlan(account, "ollama", "free", 1000);
  store.declarePlan(account, "openai-codex", "pro-paid", 1000);
  store.observe(account, "ollama", "beam", "other", 200, '', false, 1000);
  store.observe(account, "ollama", "beam", "opencode-declared", 429, '', false, 1000);
  assert.equal(store.forAccount(account, 2000).plans.length, 2);
  assert.equal(store.forAccount(account, 2000).observations.length, 2);
  const changed = { ...account, credentials: [{ provider: "ollama", apiKey: "new-key" }, account.credentials![1]] };
  assert.equal(store.forAccount(changed, 2000).observations.length, 0);
  assert.equal(store.forAccount(changed, 2000).plans.length, 0);
  const snapshot = store.snapshot(2000);
  assert.doesNotMatch(JSON.stringify(snapshot), /private-key|private-refresh/);
  assert.equal(new AccessEvidenceStore(snapshot).forAccount(account, 2000).observations.length, 2);
  assert.equal(store.forAccount(account, 302000).observations.length, 1);
  assert.equal(store.forAccount(account, 31 * 86400000).plans.length, 0);
});
it("keeps only the latest observation for the same exact scope", () => {
  const store = new AccessEvidenceStore();
  store.observe(account, "ollama", "beam", "other", 403, '{"error":"private-error-body"}', false, 1000);
  store.observe(account, "ollama", "beam", "other", 200, '', false, 2000);
  const snapshot = store.snapshot(3000);
  assert.equal(snapshot.observations.length, 1);
  assert.equal(snapshot.observations[0].kind, "success");
  assert.doesNotMatch(JSON.stringify(snapshot), /private-error-body/);
});

it("builds non-enforcing shadow diagnostics without treating uncertain plan data as entitlement", async () => {
  const { buildAccessShadowDecision } = await import("../src/access-evidence.js");
  const store = new AccessEvidenceStore();
  const google: AccountConfig = { email: "secret@example.com", provider: "google-antigravity", refreshToken: "private-refresh", projectId: "p", tier: "free" };
  const result = buildAccessShadowDecision(google, "google-antigravity", "gemini-4-argon-high", {}, store, Date.parse("2026-10-30T12:00:00Z"));
  assert.equal(result.policyState, "blocked");
  assert.equal(result.wouldBlock, true);
  assert.equal(result.enforced, false);
  assert.doesNotMatch(JSON.stringify(result), /secret@example.com|private-refresh/);
  const codex = buildAccessShadowDecision(account, "openai-codex", "gpt-6.1-terra", {}, store, Date.parse("2026-10-30T12:00:00Z"));
  assert.equal(codex.policyState, "unknown");
  assert.equal(codex.wouldBlock, false);
});


it("preserves the explicit opt-in shadow flag through configuration defaults", async () => {
  const { applyConfigDefaults } = await import("../src/config-defaults.js");
  const { validateConfig } = await import("../src/validators.js");
  const base = { accounts: [], proxyPort: 51200, requestsPerRotation: 5, rotateOnQuotaDrop: 20, quotaPollIntervalMs: 300000 };
  assert.equal(applyConfigDefaults(base).modelAccessShadow, false);
  assert.equal(applyConfigDefaults({ ...base, modelAccessShadow: true }).modelAccessShadow, true);
  assert.equal(validateConfig({ ...base, modelAccessShadow: "yes" }).ok, false);
});

it("continues only an attested Codex generation, preserves expiry and newer destination evidence", () => {
  const old: AccountConfig={email:"principal@example.test",credentials:[{provider:"openai-codex",providerAccountId:"p1",refreshToken:"old"},{provider:"ollama",apiKey:"key"}]};
  const next=structuredClone(old);next.credentials![0].refreshToken="new";
  const store=new AccessEvidenceStore();store.declarePlan(old,"openai-codex","free",1000);store.observe(old,"openai-codex","gpt-6-luna","unknown",200,"",false,1000);
  store.declarePlan(old,"ollama","free",1000);
  assert.equal(store.continueCodexRefresh(old,next,"different",2000),false);
  assert.equal(store.forAccount(next,2000).observations.length,0);
  const original=store.forAccount(old,2000);
  store.declarePlan(next,"openai-codex","plus",2000);
  store.observe(next,"openai-codex","gpt-6-luna","unknown",429,"",false,2000);
  assert.equal(store.continueCodexRefresh(old,next,"p1",3000),true);
  const visible=store.forAccount(next,3000);
  assert.equal(visible.plans.find(p=>p.provider==='openai-codex')?.plan,'plus');
  assert.equal(visible.observations[0].kind,'quota');
  assert.equal(visible.observations[0].observedAt,2000);
  assert.deepEqual(visible.plans.find(p=>p.provider==='ollama'),original.plans.find(p=>p.provider==='ollama'));
  const replaced=structuredClone(next);replaced.credentials![0].refreshToken='manual';
  assert.equal(store.forAccount(replaced,3000).observations.length,0);
  const refreshedManual=structuredClone(replaced);refreshedManual.credentials![0].refreshToken='manual-refreshed';
  assert.equal(store.continueCodexRefresh(replaced,refreshedManual,'p1',3000),false);
  assert.equal(store.forAccount(refreshedManual,3000).observations.length,0);
  const otherPrincipal=structuredClone(next);otherPrincipal.credentials![0].providerAccountId='p2';
  assert.equal(store.continueCodexRefresh(next,otherPrincipal,'p1',3000),false);
  const renamed=structuredClone(next);renamed.email='another@example.test';
  assert.equal(store.continueCodexRefresh(next,renamed,'p1',3000),false);
  const expired=new AccessEvidenceStore();expired.observe(old,'openai-codex','gpt-6-luna','unknown',429,'',false,1000);
  expired.continueCodexRefresh(old,next,'p1',400000);
  assert.equal(expired.forAccount(next,400000).observations.length,0);
});

it("recognizes a Codex rejection for the exact account/model without interpreting generic400 as entitlement",()=>{
 const detail=JSON.stringify({detail:"The 'gpt-6.1-terra' model is not supported when using Codex with a ChatGPT account."});
 assert.equal(classifyAccessObservation(400,detail,false,'openai-codex','gpt-6.1-terra'),'model-unavailable');
 assert.equal(classifyAccessObservation(400,detail,false,'ollama','gpt-6.1-terra'),'unknown');
 assert.equal(classifyAccessObservation(400,detail,false,'openai-codex','gpt-6-luna'),'unknown');
 assert.equal(classifyAccessObservation(400,JSON.stringify({detail:'Unsupported parameter: temperature'}),false,'openai-codex','gpt-6.1-terra'),'unknown');
 assert.equal(classifyAccessObservation(400,JSON.stringify({detail:"The 'gpt-6.1-terra' model is not supported when using Codex with a ChatGPT account. private-extra"}),false,'openai-codex','gpt-6.1-terra'),'unknown');
 assert.equal(classifyAccessObservation(403,detail,false,'openai-codex','gpt-6.1-terra'),'unknown');
 const store=new AccessEvidenceStore();store.observe(account,'openai-codex','gpt-6.1-terra','unknown',400,detail,false,1000);
 const snapshot=store.snapshot(2000);assert.equal(snapshot.observations[0].kind,'model-unavailable');
 assert.doesNotMatch(JSON.stringify(snapshot),/ChatGPT account|not supported|private-refresh/);
 assert.equal(new AccessEvidenceStore(snapshot).forAccount(account,2000).observations[0].kind,'model-unavailable');
});
