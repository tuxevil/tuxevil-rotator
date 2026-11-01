/** Retain only the prefix before useful output. No caller-visible bytes are replayed. */
export async function gateOllamaOutput(body: ReadableStream<Uint8Array>, timeoutMs=30000, maxBytes=1048576): Promise<{body:ReadableStream<Uint8Array>; useful:boolean}> {
 const reader=body.getReader(),chunks:Uint8Array[]=[];const decoder=new TextDecoder();let pending='',bytes=0;
 const hasUseful=(line:string):boolean=>{try{const m=JSON.parse(line)?.message;return typeof m?.content==='string'&&m.content.trim().length>0||Array.isArray(m?.tool_calls)&&m.tool_calls.some((t:{function?:{name?:unknown}})=>typeof t?.function?.name==='string'&&t.function.name.length>0);}catch{return false;}};
 const started=Date.now();
 try{
  while(true){
   let timer:ReturnType<typeof setTimeout>|undefined;
   const chunk=await Promise.race([reader.read(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Ollama useful-output deadline exceeded')),Math.max(1,timeoutMs-(Date.now()-started)))})]).finally(()=>clearTimeout(timer));
   if(chunk.done){const collected=new ReadableStream<Uint8Array>({start(c){for(const x of chunks)c.enqueue(x);c.close()}});return{body:collected,useful:hasUseful(pending)};}
   chunks.push(chunk.value);bytes+=chunk.value.byteLength;if(bytes>maxBytes)throw Error('Ollama useful-output prefix limit exceeded');
   pending+=decoder.decode(chunk.value,{stream:true});const lines=pending.split('\n');pending=lines.pop()??'';
   for(const line of lines){const useful=hasUseful(line);
    if(useful){let index=0;return{useful:true,body:new ReadableStream<Uint8Array>({async pull(c){if(index<chunks.length){c.enqueue(chunks[index++]);return;}try{const next=await reader.read();if(next.done)c.close();else c.enqueue(next.value);}catch(e){c.error(e)}},cancel(reason){return reader.cancel(reason)}})};}
   }
  }
 }catch(e){void reader.cancel().catch(()=>{});throw e;}
}
