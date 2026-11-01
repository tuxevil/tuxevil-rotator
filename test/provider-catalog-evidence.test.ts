import { it } from "node:test";
import assert from "node:assert/strict";
import { dynamicCatalog } from "../src/providers/google-antigravity/dynamic-catalog.js";
import { antigravityCatalogEvidence, advertisedModelState } from "../src/provider-catalog-evidence.js";
import { getAccountIdentity, getCredentialGeneration } from "../src/account-identity.js";
import { buildModelAccessReport } from "../src/model-access-api.js";
import { setModelAliasesOverride } from "../src/types.js";
import type { AccountConfig, Config } from "../src/types.js";

it("reports exact account catalogs, expiry and unknown generations without conflating plan entitlement", () => {
  const account: AccountConfig={email:"catalog@example.test",projectId:"p",credentials:[{provider:"google-antigravity",refreshToken:"private"}]};
  const id=getAccountIdentity(account),generation=getCredentialGeneration(account,"google-antigravity");
  dynamicCatalog.reset();
  try {
    assert.equal(antigravityCatalogEvidence(account).freshness,"unknown");
    dynamicCatalog.retainAccounts([{id,generation}]);
    dynamicCatalog.updateFromEndpointResponse({models:{'gemini-3.8-flash-medium':{}}},id,generation);
    const catalog=antigravityCatalogEvidence(account);
    assert.equal(catalog.freshness,"fresh");assert.equal(advertisedModelState(catalog,'gemini-4-argon-medium'),"not-advertised");
    assert.equal(advertisedModelState(catalog,'gemini-3.8-flash-medium'),"advertised");
    assert.equal(advertisedModelState(antigravityCatalogEvidence(account,300000,catalog.expiresAt!), 'gemini-3.8-flash-medium'),"unknown");
    setModelAliasesOverride({'alias':'gemini-3.8-flash-medium'});
    assert.equal(advertisedModelState(catalog,'alias'),"advertised");
    const copy=antigravityCatalogEvidence(account);copy.models.length=0;
    assert.equal(antigravityCatalogEvidence(account).models.length,1);
    const config={accounts:[account],quotaPollIntervalMs:300000} as Config;
    const report=buildModelAccessReport(config,new URLSearchParams({accountId:id,provider:'google-antigravity',model:'gemini-4-argon-medium'}));
    assert.equal(report.catalogAvailability?.state,"not-advertised");assert.equal(report.informational,true);
    assert.equal(report.accounts[0].providerCatalogs[0].source,"fetchAvailableModels");
    assert.doesNotMatch(JSON.stringify(report),/private/);
    const changed=structuredClone(account);changed.credentials![0].refreshToken="replacement";
    assert.equal(antigravityCatalogEvidence(changed).freshness,"unknown");
    dynamicCatalog.updateFromEndpointResponse({models:{}},id,generation);
    assert.equal(antigravityCatalogEvidence(account).freshness,"fresh");
    assert.equal(advertisedModelState(antigravityCatalogEvidence(account),'gemini-3.8-flash-medium'),"not-advertised");
    dynamicCatalog.retainAccounts([]);assert.equal(antigravityCatalogEvidence(account).freshness,"unknown");
  } finally {dynamicCatalog.reset();setModelAliasesOverride(null);}
});
