import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { AccessEvidenceStore } from "../src/access-evidence.js";
import { getAccountIdentity, getCredentialGeneration } from "../src/account-identity.js";
import { evaluateAutoModelAccess } from "../src/auto-model-access.js";
import { buildModelAccessReport } from "../src/model-access-api.js";
import { dynamicCatalog } from "../src/providers/google-antigravity/dynamic-catalog.js";
import { setModelAliasesOverride, type AccountConfig, type Config } from "../src/types.js";

const provider = "google-antigravity";

function proAccount(name: string, models?: string[]): AccountConfig {
  const account: AccountConfig = {
    email: `${name}@example.test`,
    projectId: `${name}-project`,
    tier: "pro",
    credentials: [{ provider, refreshToken: `${name}-token` }],
  };
  if (models) {
    const id = getAccountIdentity(account);
    const generation = getCredentialGeneration(account, provider);
    dynamicCatalog.retainAccounts([{ id, generation }]);
    dynamicCatalog.updateFromEndpointResponse(
      { models: Object.fromEntries(models.map((model) => [model, {}])) },
      id,
      generation,
    );
  }
  return account;
}

afterEach(() => {
  dynamicCatalog.reset();
  setModelAliasesOverride(null);
});

it("allows Carbon for a Pro account whose live catalog advertises it", () => {
  const account = proAccount("carbon-on", ["gemini-4-carbon-low", "gemini-4-carbon-medium", "gemini-4-carbon-high"]);
  const decision = evaluateAutoModelAccess(account, provider, "gemini-4-carbon-medium", new AccessEvidenceStore());
  assert.equal(decision.eligible, true);
  assert.equal(decision.catalog, "advertised");
  assert.equal(decision.plan, "pro-paid");
});

it("resolves operator aliases before matching the account catalog", () => {
  const account = proAccount("carbon-alias", ["gemini-4-carbon-medium"]);
  setModelAliasesOverride({ "carbon-alias": "gemini-4-carbon-medium" });
  assert.equal(evaluateAutoModelAccess(account, provider, "carbon-alias", new AccessEvidenceStore()).eligible, true);
});

it("blocks Carbon when the catalog only lists the family as disabled", () => {
  const account = proAccount("carbon-off", ["gemini-4-carbon-disabled", "gemini-4-hydrogen-medium"]);
  const store = new AccessEvidenceStore();
  const decision = evaluateAutoModelAccess(account, provider, "gemini-4-carbon-medium", store);
  assert.equal(decision.eligible, false);
  assert.equal(decision.catalog, "disabled");
  assert.match(decision.reason, /disabled in this account's catalog/);
  // The `-disabled` placeholder itself is never routable.
  assert.equal(evaluateAutoModelAccess(account, provider, "gemini-4-carbon-disabled", store).eligible, false);
  assert.equal(evaluateAutoModelAccess(account, provider, "gemini-4-hydrogen-medium", store).eligible, true);
});

it("blocks a model the fresh catalog does not list at all", () => {
  const account = proAccount("carbon-missing", ["gemini-4-hydrogen-medium"]);
  const decision = evaluateAutoModelAccess(account, provider, "gemini-4-argon-medium", new AccessEvidenceStore());
  assert.equal(decision.eligible, false);
  assert.equal(decision.catalog, "not-advertised");
  assert.match(decision.reason, /not in this account's catalog/);
});

it("falls back to the plan rules without a usable snapshot", () => {
  const store = new AccessEvidenceStore();
  const noSnapshot = proAccount("no-snapshot");
  const carbon = evaluateAutoModelAccess(noSnapshot, provider, "gemini-4-carbon-medium", store);
  assert.equal(carbon.eligible, false);
  assert.equal(carbon.catalog, undefined);
  assert.match(carbon.reason, /Ultra or Enterprise/);
  assert.equal(evaluateAutoModelAccess(noSnapshot, provider, "gemini-4-argon-medium", store).eligible, true);

  // A snapshot for a replaced credential is not this credential's catalog.
  const rotated = proAccount("rotated", ["gemini-4-carbon-medium"]);
  rotated.credentials![0].refreshToken = "replacement";
  assert.equal(evaluateAutoModelAccess(rotated, provider, "gemini-4-carbon-medium", store).eligible, false);

  // An expired snapshot no longer speaks for the account.
  const stale = proAccount("stale", ["gemini-4-carbon-medium"]);
  const later = Date.now() + 31 * 60_000;
  const staleDecision = evaluateAutoModelAccess(stale, provider, "gemini-4-carbon-medium", store, later);
  assert.equal(staleDecision.eligible, false);
  assert.equal(staleDecision.catalog, undefined);
});

it("lets recent provider rejection evidence win over a catalog allow", () => {
  const account = proAccount("carbon-rejected", ["gemini-4-carbon-medium"]);
  const store = new AccessEvidenceStore();
  const now = Date.now();
  store.observe(account, provider, "gemini-4-carbon-medium", "unknown", 402, "", false, now);
  const decision = evaluateAutoModelAccess(account, provider, "gemini-4-carbon-medium", store, now + 1);
  assert.equal(decision.eligible, false);
  assert.match(decision.reason, /recent .* rejection/);
});

it("reports the catalog-based routing verdict next to the plan explanation", () => {
  const account = proAccount("report", ["gemini-4-carbon-medium"]);
  const config = { accounts: [account], quotaPollIntervalMs: 300_000 } as Config;
  const report = buildModelAccessReport(config, new URLSearchParams({
    accountId: getAccountIdentity(account),
    provider,
    model: "gemini-4-carbon-medium",
  }));
  assert.equal(report.routing?.eligible, true);
  assert.equal(report.routing?.catalog, "advertised");
  assert.equal(report.catalogAvailability?.state, "advertised");
});
