import {it} from 'node:test';import assert from 'node:assert/strict';
import {markEmptyAutoOutput,isAutoOutputCooling} from '../src/auto-output-health.js';
import {buildAutoRoutingCandidates} from '../src/auto-routing.js';
it('temporarily excludes an empty-output model from auto, preserves alternatives and expires',()=>{
 markEmptyAutoOutput('ollama','empty-fixture',1000);
 assert.equal(isAutoOutputCooling('ollama','empty-fixture',2000),true);
 assert.equal(isAutoOutputCooling('other','empty-fixture',2000),false);
 assert.equal(isAutoOutputCooling('ollama','empty-fixture',301000),false);
 markEmptyAutoOutput('ollama','empty-fixture');
 const rows=['empty-fixture','healthy-fixture'].map(modelId=>({providerId:'ollama',modelId,contextWindow:100000,multimodal:true,tools:true,reasoning:true}));
 const result=buildAutoRoutingCandidates({},rows,{route:'openai-chat',input:{messages:[{role:'user',content:'test'}]}});
 assert.deepEqual(result.candidates.map(c=>c.modelId),['healthy-fixture']);assert.equal(result.excluded['empty-output-cooldown'],1);
});
