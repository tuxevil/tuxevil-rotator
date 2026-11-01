import { it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp,rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveAccessProbe } from "../src/access-probe.js";
import { initDb,closeDb } from "../src/db-store.js";
import { getAccountIdentity,getCredentialGeneration,getCredentialGenerationFingerprint } from "../src/account-identity.js";
import { dynamicCatalog } from "../src/providers/google-antigravity/dynamic-catalog.js";
import { getProviderAdapter } from "../src/providers/registry.js";
import type { AccountRuntime } from "../src/types.js";
import type { AccountRotator } from "../src/rotator.js";

it("skips unadvertised, stale and missing account catalogs before auth/forwarding; explicit override is auditable",async()=>{
 const directory=await mkdtemp(join(tmpdir(),'probe-catalog-'));const previous=process.env.TUXEVIL_ROTATOR_DIR;process.env.TUXEVIL_ROTATOR_DIR=directory;
 const account={config:{email:'catalog@example.test',projectId:'p',credentials:[{provider:'google-antigravity',refreshToken:'private'}]},inFlightRequests:0} as AccountRuntime;
 const id=getAccountIdentity(account),generation=getCredentialGeneration(account,'google-antigravity');
 let forwarded=0,auth=0;
 const rotator={getConfig:()=>({accounts:[account.config],quotaPollIntervalMs:300000}),getBenchmarkAccounts:()=>[account],getOllamaModels:()=>[],getCodexModels:()=>[],isProviderOffForAccount:()=>false,startRequest:()=>{},finishRequest:()=>{},recordUpstreamAttempt:()=>{},ensureValidToken:async()=>{auth++;}} as unknown as AccountRotator;
 const adapter=getProviderAdapter('google-antigravity'),original=adapter.forwardRequest;
 adapter.forwardRequest=async()=>{forwarded++;return{endpoint:'test',response:new Response('data: {"response":{"candidates":[{"finishReason":"STOP"}]}}\n')}};
 const server=createServer((req,res)=>{void serveAccessProbe(req,res,rotator)});server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');
 const post=(extra:Record<string,unknown>={})=>fetch(`http://127.0.0.1:${address.port}`,{method:'POST',body:JSON.stringify({accountId:id,provider:'google-antigravity',model:'gemini-4-argon-medium',...extra})});
 try{
  await initDb();dynamicCatalog.reset();dynamicCatalog.retainAccounts([{id,generation},{id:'other',generation:'other-generation'}]);
  dynamicCatalog.updateFromEndpointResponse({models:{'gemini-3.8-flash-medium':{}}},id,generation);
  dynamicCatalog.updateFromEndpointResponse({models:{'gemini-4-argon-medium':{}}},'other','other-generation');
  let r=await post();assert.equal(r.status,409);assert.equal((await r.json()).reason,'model-not-advertised');assert.equal(forwarded,0);assert.equal(auth,0);
  assert.equal((await post({allowUnadvertised:'true'})).status,400);
  r=await post({allowUnadvertised:true});const override=await r.json();assert.equal(r.status,200);assert.equal(override.diagnosticOverride,true);assert.equal(override.catalogAvailability,'not-advertised');assert.equal(forwarded,1);
  const persistedAccounts=[{id,credentialGenerationFingerprint:getCredentialGenerationFingerprint(account,'google-antigravity')}];
  const snapshots=dynamicCatalog.getPersistedSnapshots(persistedAccounts);snapshots.accounts[id].capturedAt=Date.now()-700000;
  dynamicCatalog.restorePersistedSnapshots(snapshots,persistedAccounts);
  r=await post();assert.equal(r.status,409);assert.equal((await r.json()).reason,'catalog-stale');assert.equal(forwarded,1);
  dynamicCatalog.retainAccounts([{id:'other',generation:'other-generation'}]);
  r=await post();assert.equal(r.status,409);assert.equal((await r.json()).reason,'catalog-unknown');assert.equal(forwarded,1);
 }finally{adapter.forwardRequest=original;dynamicCatalog.reset();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await closeDb();if(previous===undefined)delete process.env.TUXEVIL_ROTATOR_DIR;else process.env.TUXEVIL_ROTATOR_DIR=previous;await rm(directory,{recursive:true,force:true});}
});
