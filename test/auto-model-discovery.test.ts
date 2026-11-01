import {it} from 'node:test';import assert from 'node:assert/strict';
import {buildOpenAIModelCatalog} from '../src/compat.js';import type {AccountRotator} from '../src/rotator.js';
it('announces auto when enabled with backing models and omits it otherwise',()=>{
 const make=(enabled:boolean,models:string[])=>({getConfig:()=>({typesafeRouting:{enabled},disabledProviders:['google-antigravity','openai-codex','opencode-zen']}),hasActiveProvider:(id:string)=>id==='ollama',getOllamaModels:()=>models,getCodexModels:()=>[]}) as unknown as AccountRotator;
 const catalog=buildOpenAIModelCatalog(make(true,['gemma4:31b']));assert.equal(catalog.filter(m=>m.id==='auto').length,1);assert.ok(catalog.find(m=>m.id==='auto')!.context_window>0);
 assert.equal(buildOpenAIModelCatalog(make(false,['gemma4:31b'])).some(m=>m.id==='auto'),false);
 assert.equal(buildOpenAIModelCatalog(make(true,[])).some(m=>m.id==='auto'),false);
});
