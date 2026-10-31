import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountRuntime, AccountConfig } from "../src/types.js";

it("keeps plans and observations visible across a real Codex refresh and repository reload without extending TTL", async () => {
  const directory=await mkdtemp(join(tmpdir(),"codex-continuity-"));
  const previous=process.env.TUXEVIL_ROTATOR_DIR;process.env.TUXEVIL_ROTATOR_DIR=directory;
  const originalFetch=globalThis.fetch;
  const {initDb,closeDb,getCachedAccessEvidence}=await import("../src/db-store.js");
  const {saveAccountsConfig,loadConfig}=await import("../src/config-storage.js");
  const {getDefaultConfig}=await import("../src/config-defaults.js");
  const {accessEvidenceStore,persistAccessEvidence,AccessEvidenceStore}=await import("../src/access-evidence.js");
  await import("../src/proxy.js");
  const {getProviderAdapter}=await import("../src/providers/registry.js");
  const {buildModelAccessReport}=await import("../src/model-access-api.js");
  const config=getDefaultConfig();
  const account: AccountConfig={email:"continuity@example.test",credentials:[{provider:"openai-codex",providerAccountId:"principal-a",refreshToken:"refresh-v1"},{provider:"ollama",apiKey:"ollama-key"}]};config.accounts=[account];
  const runtime={config:structuredClone(account)} as AccountRuntime;
  const jwt=(id:string)=>'header.'+Buffer.from(JSON.stringify({email:account.email,'https://api.openai.com/auth':{chatgpt_account_id:id}})).toString('base64url')+'.signature';
  try {
    await initDb();await saveAccountsConfig(config);
    const store=accessEvidenceStore();const now=Date.now();
    store.declarePlan(account,"openai-codex","free",now);store.observe(account,"openai-codex","gpt-6-luna","unknown",200,"",false,now);
    store.declarePlan(account,"ollama","free",now);await persistAccessEvidence();
    const before=store.snapshot();
    globalThis.fetch=(async()=>Response.json({access_token:jwt('principal-a'),refresh_token:'refresh-v2',expires_in:3600})) as typeof fetch;
    await getProviderAdapter("openai-codex").ensureValidToken(runtime);
    const current=loadConfig().accounts[0];
    const visible=store.forAccount(current);
    assert.equal(visible.plans.filter(p=>p.provider==='openai-codex').length,1);
    assert.equal(visible.observations.length,1);
    assert.equal(visible.plans.find(p=>p.provider==='openai-codex')?.expiresAt,before.plans.find(p=>p.provider==='openai-codex')?.expiresAt);
    assert.equal(visible.observations[0].observedAt,before.observations[0].observedAt);
    assert.equal(visible.observations[0].expiresAt,before.observations[0].expiresAt);
    const restored=new AccessEvidenceStore(getCachedAccessEvidence());
    assert.equal(restored.forAccount(current).observations.length,1);
    assert.equal(buildModelAccessReport(loadConfig(),new URLSearchParams()).accounts[0].providerPlans.length,2);
    // A response for another principal must not publish or persist its token.
    const stable=loadConfig(); const wrongRuntime={config:structuredClone(current)} as AccountRuntime;
    globalThis.fetch=(async()=>Response.json({access_token:jwt('principal-b'),refresh_token:'wrong-principal-token',expires_in:3600})) as typeof fetch;
    await assert.rejects(()=>getProviderAdapter("openai-codex").ensureValidToken(wrongRuntime), /different account identity/);
    assert.deepEqual(loadConfig(),stable);
    assert.equal(wrongRuntime.providerTokens?.['openai-codex']?.accessToken??null,null);
    assert.deepEqual(store.snapshot(),new AccessEvidenceStore(getCachedAccessEvidence()).snapshot());
    globalThis.fetch=(async()=>Response.json({access_token:jwt('principal-a'),id_token:jwt('principal-b'),refresh_token:'conflicting-token',expires_in:3600})) as typeof fetch;
    await assert.rejects(()=>getProviderAdapter("openai-codex").ensureValidToken(wrongRuntime), /different account identity/);
    assert.deepEqual(loadConfig(),stable);
    const {persistCodexCredentialRefresh,persistCodexRefreshToken}=await import("../src/providers/openai-codex/credentials.js");
    const manual=structuredClone(stable);manual.accounts[0].credentials!.find(c=>c.provider==='openai-codex')!.refreshToken='manual-current';
    await saveAccountsConfig(manual);
    await assert.rejects(()=>persistCodexCredentialRefresh(loadConfig(),{config:structuredClone(current)} as AccountRuntime,'late-refresh',{providerAccountId:'principal-a'}),/credential changed during refresh/);
    assert.deepEqual(loadConfig(),manual);
    await saveAccountsConfig(stable);
    // Production's queued refresh must reload settings after a manual update.
    const pending=persistCodexRefreshToken({config:structuredClone(current)} as AccountRuntime,'queued-refresh',{providerAccountId:'principal-a'});
    const rejected=assert.rejects(pending,/credential changed during refresh/);
    await saveAccountsConfig(manual);await rejected;
    assert.deepEqual(loadConfig(),manual);
    await saveAccountsConfig(stable);
    // An opaque token remains usable, but cannot attest evidence continuity.
    const unknownRuntime={config:structuredClone(current)} as AccountRuntime;
    globalThis.fetch=(async()=>Response.json({access_token:'opaque-token',refresh_token:'refresh-v3',expires_in:3600})) as typeof fetch;
    await getProviderAdapter("openai-codex").ensureValidToken(unknownRuntime);
    assert.equal(store.forAccount(loadConfig().accounts[0]).observations.length,0);
    const replaced=structuredClone(current);replaced.credentials!.find(c=>c.provider==='openai-codex')!.refreshToken='manual-replacement';
    assert.equal(restored.forAccount(replaced).observations.length,0);
    assert.equal(restored.forAccount(replaced).plans.filter(p=>p.provider==='openai-codex').length,0);
  } finally {globalThis.fetch=originalFetch;await closeDb();if(previous===undefined)delete process.env.TUXEVIL_ROTATOR_DIR;else process.env.TUXEVIL_ROTATOR_DIR=previous;await rm(directory,{recursive:true,force:true});}
});
