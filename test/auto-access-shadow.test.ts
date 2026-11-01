import {it} from 'node:test';import assert from 'node:assert/strict';
import {AccessEvidenceStore} from '../src/access-evidence.js';import {summarizeAutoAccess} from '../src/auto-access-shadow.js';
it('excludes only when every eligible credential has an explicit current rejection; expires and permits recovery',()=>{
 const a={email:'a@test',credentials:[{provider:'openai-codex',providerAccountId:'a',refreshToken:'secret'}]},b={email:'b@test',credentials:[{provider:'openai-codex',providerAccountId:'b',refreshToken:'other'}]};const store=new AccessEvidenceStore();
 const body=JSON.stringify({detail:"The 'gpt-6.1-terra' model is not supported when using Codex with a ChatGPT account."});
 store.observe(a,'openai-codex','gpt-6.1-terra','unknown',400,body,false,1000);
 assert.equal(summarizeAutoAccess([a],'openai-codex','gpt-6.1-terra',store,2000).wouldExclude,true);
 assert.equal(summarizeAutoAccess([a,b],'openai-codex','gpt-6.1-terra',store,2000).wouldExclude,false);
 assert.equal(summarizeAutoAccess([],'openai-codex','gpt-6.1-terra',store,2000).wouldExclude,false);
 assert.equal(summarizeAutoAccess([a],'openai-codex','gpt-6.1-terra',store,3601001).wouldExclude,false);
 const replacement=structuredClone(a);replacement.credentials[0].refreshToken='replacement';assert.equal(summarizeAutoAccess([replacement],'openai-codex','gpt-6.1-terra',store,2000).wouldExclude,false);
 for(const status of [401,429,500,400]){store.observe(a,'openai-codex','gpt-6.1-terra','unknown',status,'',false,3000);assert.equal(summarizeAutoAccess([a],'openai-codex','gpt-6.1-terra',store,4000).wouldExclude,false);}
 store.observe(a,'openai-codex','gpt-6.1-terra','unknown',200,'',false,5000);assert.equal(summarizeAutoAccess([a],'openai-codex','gpt-6.1-terra',store,6000).wouldExclude,false);
});

it('logs a permission-safe projection while returning the unchanged actual selection',async()=>{
 const {selectAutoRoutingTarget}=await import('../src/auto-routing.js');
 const config={modelAccessShadow:true} as import('../src/types.js').Config;
 const rotator={getConfig:()=>config,getAutoRoutingCandidateStatus:()=>({available:true,operationalScore:1}),getAutoRoutingEvidenceStatus:(model:string)=>({eligibleAccounts:1,rejectedAccounts:model==='a'?1:0,wouldExclude:model==='a'})};
 const catalog=['a','b','forbidden'].map(modelId=>({providerId:'ollama',modelId,contextWindow:100000,multimodal:true,tools:true,reasoning:true}));
 const logs:string[]=[];const original=console.info;console.info=(...args:unknown[])=>{logs.push(args.join(' '))};
 try{const selected=await selectAutoRoutingTarget(rotator,catalog,{route:'openai-chat',input:{messages:[{role:'user',content:'private prompt'}]},isModelAllowed:model=>model!=='forbidden'});
 assert.equal(selected?.candidate.modelId,'a');const event=JSON.parse(logs.find(x=>x.includes('auto-routing-access-shadow'))!.slice('[tuxevil-rotator] '.length));assert.equal(event.would_select_model,'b');assert.equal(event.enforced,false);assert.doesNotMatch(JSON.stringify(event),/private prompt/);
 }finally{console.info=original;}
});
