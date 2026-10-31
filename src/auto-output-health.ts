/** Transient output-quality circuit, separate from account entitlement evidence. */
const failures=new Map<string,number>();
const key=(provider:string,model:string)=>JSON.stringify([provider,model]);
export function markEmptyAutoOutput(provider:string,model:string,now=Date.now()):void {
 for(const [k,expiry] of failures)if(expiry<=now)failures.delete(k);
 if(failures.size>=256)failures.delete(failures.keys().next().value!);
 failures.set(key(provider,model),now+300000);
}
export function isAutoOutputCooling(provider:string,model:string,now=Date.now()):boolean {
 const k=key(provider,model),expiry=failures.get(k);if(expiry===undefined)return false;
 if(expiry<=now){failures.delete(k);return false;}return true;
}
