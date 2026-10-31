// Dry run by default. Explicit --execute performs one short completion per scope.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const base = process.env.ROTATOR_URL ?? 'http://127.0.0.1:51200';
if (!/^https?:\/\//.test(base)) throw Error('Invalid ROTATOR_URL');
const token = process.env.ROTATOR_ADMIN_TOKEN ?? (process.env.ROTATOR_ADMIN_TOKEN_FILE ? (await readFile(process.env.ROTATOR_ADMIN_TOKEN_FILE, 'utf8')).trim() : '');
if (!token) throw Error('ROTATOR_ADMIN_TOKEN or ROTATOR_ADMIN_TOKEN_FILE required');
const headers = {'x-rotator-admin-token':token,'content-type':'application/json'};
const get = async path => { const r=await fetch(base+path,{headers});if(!r.ok)throw Error('Admin read failed '+r.status);return r.json(); };
const report = await get('/api/model-access'); const catalog = await get('/api/catalog');
const wanted = {
 'ollama':['beam','gemma4:31b','gpt-oss:120b','gpt-oss:20b','nemotron-3-nano:30b','nemotron-3-super','nemotron-3-ultra'],
 'openai-codex':['gpt-6-luna','gpt-5.6-terra','gpt-5.6-luna','gpt-6.1-terra'],
 'google-antigravity':['gemini-3.8-flash-medium','gemini-4-argon-medium','claude-sonnet-4-6','claude-opus-4-6-thinking','claude-sonnet-5-5-medium','claude-opus-5-5-medium'],
 'opencode-zen':catalog.models.filter(m=>m.providerId==='opencode-zen'&&(m.id.endsWith('-free')||m.id==='big-pickle')).map(m=>m.id),
};
const missing = Object.entries(wanted).flatMap(([provider,models])=>models.filter(model=>!catalog.models.some(m=>m.providerId===provider&&m.id===model)).map(model=>({provider,model})));
const scopes = report.accounts.flatMap(a=>a.providers.flatMap(provider=>(wanted[provider]??[]).filter(model=>catalog.models.some(m=>m.providerId===provider&&m.id===model)).map(model=>({accountId:a.id,provider,model,plan:a.providerPlans.find(p=>p.provider===provider)?.plan??'unknown'}))));
const execute = process.argv.includes('--execute');
const output = process.env.ROTATOR_PROBE_OUTPUT ?? '/tmp/model-access-probe-results.json';
const previous = process.argv.includes('--resume') ? JSON.parse(await readFile(output, 'utf8')) : null;
const results=[];
const prior = new Map((previous?.results??[]).filter(r=>r.kind).map(r=>[JSON.stringify([r.account,r.provider,r.model,r.plan]),r]));
const snapshot=()=>({generatedAt:new Date().toISOString(),executed:execute,planned:scopes.length,missing,results});
const save=()=>writeFile(output,JSON.stringify(snapshot(),null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({executed:execute,planned:scopes.length,missing,byProvider:Object.fromEntries(Object.keys(wanted).map(p=>[p,scopes.filter(s=>s.provider===p).length]))}));
if(execute){
 const stopped=new Map();
 for(const scope of scopes){
  const {accountId,...safe}=scope;const account=createHash('sha256').update(accountId).digest('hex');const key=account+'/'+scope.provider;
  const earlier=prior.get(JSON.stringify([account,scope.provider,scope.model,scope.plan]));
  if(earlier && earlier.expiresAt>Date.now()) { results.push(earlier); if(['authentication','quota','transport'].includes(earlier.kind)) stopped.set(key,earlier.kind); continue; }
  const unavailable=catalog.models.find(m=>m.providerId===scope.provider&&m.id===scope.model)?.offReason;
  if(unavailable){results.push({...safe,account,skipped:'model-disabled'});continue;}
  if(stopped.has(key)){results.push({...safe,account,skipped:stopped.get(key)});continue;}
  const response=await fetch(base+'/api/model-access/probe',{method:'POST',headers,body:JSON.stringify(scope),signal:AbortSignal.timeout(45000)});
  if(response.status===401||response.status>=500)throw Error('Probe service unavailable '+response.status);
  const value=await response.json();
  if(value.reason==='probe-busy') throw Error('Another access probe is running; resume later');
  // Never persist upstream bodies or arbitrary endpoint errors.
  const result={...safe,account,apiStatus:response.status,...(response.ok?Object.fromEntries(['kind','status','observedAt','expiresAt','durationMs','enforced','clientVerified'].map(k=>[k,value[k]])):{skipped:['account-unavailable','provider-disabled','model-disabled','account-busy'].includes(value.reason)?value.reason:'account-busy-disabled-or-unavailable'})};
  results.push(result);
  if(['authentication','quota','transport'].includes(result.kind)||['account-unavailable','provider-disabled','account-busy'].includes(result.skipped))stopped.set(key,result.kind??result.skipped);
  await save();
  console.log(JSON.stringify({completed:results.length,total:scopes.length,provider:scope.provider,model:scope.model,kind:result.kind??result.skipped}));
 }
}
await save();
