import {it} from 'node:test';import assert from 'node:assert/strict';import{gateOllamaOutput}from'../src/ollama-output-gate.js';
it('retains empty reasoning prefixes, replays useful chunks once, and detects terminal empty replies',async()=>{
 for(const raw of [JSON.stringify({message:{content:'answer'},done:true}),JSON.stringify({message:{content:'',tool_calls:[{function:{name:'bash',arguments:{command:'test'}}}]}})+'\n']){
  const result=await gateOllamaOutput(new Response(raw).body!);assert.equal(result.useful,true);assert.equal(await new Response(result.body).text(),raw);
 }
 const raw=JSON.stringify({message:{thinking:'private',content:''},done:true})+'\n';const result=await gateOllamaOutput(new Response(raw).body!);assert.equal(result.useful,false);assert.equal(await new Response(result.body).text(),raw);
});
it('bounds prefix memory and wait, canceling an unusable upstream',async()=>{
 await assert.rejects(()=>gateOllamaOutput(new Response('123456789').body!,100,4),/prefix limit/);
 let canceled=false;const silent=new ReadableStream<Uint8Array>({cancel(){canceled=true;}});await assert.rejects(()=>gateOllamaOutput(silent,10),/deadline/);assert.equal(canceled,true);
});
