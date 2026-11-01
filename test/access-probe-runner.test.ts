import { it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("matrix dry run is read-only; disabled models do not stop others; resume avoids repeated completions", async () => {
  const directory = await mkdtemp(join(tmpdir(),"access-probe-runner-"));
  const output = join(directory,"results.json"); let attempts = 0;
  const server = createServer(async (req,res) => {
    assert.equal(req.headers["x-rotator-admin-token"],"test-secret");
    res.setHeader("Content-Type","application/json");
    if(req.url === "/api/model-access") { res.end(JSON.stringify({accounts:[{id:"private@example.test",providers:["ollama","opencode-zen"],providerPlans:[{provider:"ollama",plan:"free"},{provider:"opencode-zen",plan:"free"}]}]}));return; }
    if(req.url === "/api/catalog") { res.end(JSON.stringify({models:[{providerId:"ollama",id:"beam",offReason:"model-disabled"},{providerId:"ollama",id:"gemma4:31b",offReason:null},{providerId:"opencode-zen",id:"big-pickle",offReason:null},{providerId:"opencode-zen",id:"sample-free",offReason:null},{providerId:"opencode-zen",id:"paid-model",offReason:null}]}));return; }
    assert.equal(req.url,"/api/model-access/probe");assert.equal(req.method,"POST");
    const chunks: Buffer[]=[];for await (const chunk of req) chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString());
    assert.notEqual(body.model,"beam");assert.notEqual(body.model,"paid-model");attempts++;
    res.end(JSON.stringify({kind:"success",status:200,observedAt:Date.now(),expiresAt:Date.now()+86400000,durationMs:1,enforced:false,clientVerified:false}));
  });
  server.listen(0,"127.0.0.1"); await once(server,"listening");
  const address=server.address();assert.ok(address && typeof address!=="string");
  const run=(args: string[], extra: Record<string,string> = {})=>promisify(execFile)(process.execPath,["scripts/probe-model-access.mjs",...args],{env:{...process.env,ROTATOR_URL:`http://127.0.0.1:${address.port}`,ROTATOR_ADMIN_TOKEN:"test-secret",ROTATOR_PROBE_OUTPUT:output,...extra}});
  try {
    await run([]); assert.equal(attempts,0);
    await run(["--execute"]); assert.equal(attempts,3);
    let result=JSON.parse(await readFile(output,"utf8"));assert.equal(result.planned,4);assert.equal(result.results.length,4);
    assert.equal(result.results.filter((r: {skipped?: string})=>r.skipped==="model-disabled").length,1);
    assert.equal(JSON.stringify(result).includes("private@example"),false);assert.equal(JSON.stringify(result).includes("test-secret"),false);
    await run(["--execute","--resume"]);assert.equal(attempts,3);
    result=JSON.parse(await readFile(output,"utf8"));assert.equal(result.results.length,4);
    await run(["--execute"],{ROTATOR_PROBE_PROVIDERS:"ollama"});assert.equal(attempts,4);
    result=JSON.parse(await readFile(output,"utf8"));assert.equal(result.planned,2);
    assert.equal(result.results.every((r: {provider:string})=>r.provider==="ollama"),true);
  } finally { server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true}); }
});

it("matrix records catalog skips per model and forwards only an explicit diagnostic override",async()=>{
 const directory=await mkdtemp(join(tmpdir(),'catalog-runner-'));const output=join(directory,'results.json');let calls=0;
 const server=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url==='/api/model-access'){res.end(JSON.stringify({accounts:[{id:'private-id',providers:['google-antigravity'],providerPlans:[]}]}));return;}
  if(req.url==='/api/catalog'){res.end(JSON.stringify({models:['gemini-3.8-flash-medium','gemini-4-argon-medium','claude-sonnet-4-6'].map(id=>({id,providerId:'google-antigravity',offReason:null}))}));return;}
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());calls++;
  if(body.allowUnadvertised!==true&&body.model!=='gemini-4-argon-medium'){res.statusCode=409;res.end(JSON.stringify({reason:body.model.startsWith('claude')?'catalog-stale':'model-not-advertised'}));return;}
  res.end(JSON.stringify({kind:'success',status:200,observedAt:Date.now(),expiresAt:Date.now()+60000,diagnosticOverride:body.allowUnadvertised===true,enforced:false}));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');
 const run=(args:string[])=>promisify(execFile)(process.execPath,['scripts/probe-model-access.mjs',...args],{env:{...process.env,ROTATOR_URL:`http://127.0.0.1:${address.port}`,ROTATOR_ADMIN_TOKEN:'test',ROTATOR_PROBE_OUTPUT:output}});
 try{
  await run(['--execute']);let result=JSON.parse(await readFile(output,'utf8'));assert.equal(calls,3);
  assert.equal(result.results[0].skipped,'model-not-advertised');assert.equal(result.results[1].kind,'success');assert.equal(result.results[2].skipped,'catalog-stale');assert.equal(result.allowUnadvertised,false);
  await run(['--execute','--allow-unadvertised']);result=JSON.parse(await readFile(output,'utf8'));assert.equal(calls,6);assert.equal(result.allowUnadvertised,true);assert.equal(result.results.every((r:{diagnosticOverride:boolean})=>r.diagnosticOverride),true);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
});
