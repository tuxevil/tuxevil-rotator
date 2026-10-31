import type { AccountConfig } from "./types.js";
import { accessEvidenceStore, type AccessEvidenceStore } from "./access-evidence.js";
/** Inputs are operationally eligible accounts. One account's denial never excludes its siblings. */
export function summarizeAutoAccess(accounts: AccountConfig[], provider: string, model: string, store: AccessEvidenceStore = accessEvidenceStore(), now = Date.now()) {
 let rejectedAccounts=0;
 for(const account of accounts){
  const latest=store.forAccount(account,now).observations.filter(o=>o.provider===provider&&o.model===model&&o.client==='unknown').sort((a,b)=>b.observedAt-a.observedAt)[0];
  if(latest&&['model-unavailable','entitlement'].includes(latest.kind))rejectedAccounts++;
 }
 return {eligibleAccounts:accounts.length,rejectedAccounts,wouldExclude:accounts.length>0&&rejectedAccounts===accounts.length};
}
