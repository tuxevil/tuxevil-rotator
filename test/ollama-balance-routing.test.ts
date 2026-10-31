import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountRuntime } from "../src/types.js";

const testDir = mkdtempSync(join(tmpdir(), "ollama-balance-routing-"));
process.env.TUXEVIL_ROTATOR_DIR = testDir;
process.env.PI_ROTATOR_DIR = testDir;
delete process.env.DATABASE_URL;
delete process.env.TUXEVIL_ROTATOR_DATABASE_URL;
delete process.env.PI_ROTATOR_DATABASE_URL;
let extractBalancePools: typeof import("../src/providers/ollama/quota.js").extractBalancePools;
let AccountRotator: typeof import("../src/rotator.js").AccountRotator;
let closeDb: typeof import("../src/db-store.js").closeDb;
before(async () => {
  ({ extractBalancePools } = await import("../src/providers/ollama/quota.js"));
  ({ AccountRotator } = await import("../src/rotator.js"));
  const db = await import("../src/db-store.js");
  closeDb = db.closeDb;
  await db.initDb();
});
after(async () => {
  await closeDb();
  rmSync(testDir, { recursive: true, force: true });
});

describe("Ollama balance routing", () => {
  it("gates legacy windows and uses purchased credits after included balance is exhausted", () => {
    const rotator = new AccountRotator({
      accounts: [{ email: "credits@test.dev", credentials: [{ provider: "ollama", apiKey: "test-key" }] }],
      proxyPort: 0, requestsPerRotation: 5, rotateOnQuotaDrop: 20, quotaPollIntervalMs: 300_000,
    });
    rotator.stopQuotaPolling();
    const [account] = (rotator as unknown as { accounts: AccountRuntime[] }).accounts;
    const setBalance = (purchased: number) => {
      account.quota = extractBalancePools({
        included: { balance_usd: 0, allowance_usd: 2.5 },
        purchased: { balance_usd: purchased },
      }).map(q => ({ ...q, providerId: "ollama" }));
    };
    account.quota = extractBalancePools({ included: {
      session: { remaining_percent: 50 }, weekly: { remaining_percent: 0 },
    } }).map(q => ({ ...q, providerId: "ollama" }));
    assert.equal(rotator.getAutoRoutingCandidateStatus("gemma4:31b", "ollama").available, false, "legacy weekly limits still gate Ollama routing");
    setBalance(5);
    assert.equal(rotator.getAutoRoutingCandidateStatus("gemma4:31b", "ollama").available, true);
    setBalance(0);
    assert.equal(rotator.getAutoRoutingCandidateStatus("gemma4:31b", "ollama").available, false);
  });

  it("excludes Ollama models outside the confirmed Free credits from auto", () => {
    const rotator = new AccountRotator({
      accounts: [{ email: "credits@test.dev", credentials: [{ provider: "ollama", apiKey: "test-key" }] }],
      proxyPort: 0, requestsPerRotation: 5, rotateOnQuotaDrop: 20, quotaPollIntervalMs: 300_000,
    });
    rotator.stopQuotaPolling();
    rotator.setOllamaModels(["beam", "deepseek-v4.1-flash:1017"]);
    const [account] = (rotator as unknown as { accounts: AccountRuntime[] }).accounts;
    account.quota = extractBalancePools({ purchased: { balance_usd: 5 } }).map(q => ({ ...q, providerId: "ollama" }));
    assert.equal(rotator.getAutoRoutingCandidateStatus("beam", "ollama").available, true);
    const deepseek = rotator.getAutoRoutingCandidateStatus("deepseek-v4.1-flash:1017", "ollama");
    assert.equal(deepseek.available, true, "operational health stays separate from auto plan eligibility");
    const access = rotator.getAutoRoutingAccessStatus("deepseek-v4.1-flash:1017", "ollama");
    assert.equal(access.eligible, false);
    assert.match(access.reason ?? "", /Free-plan auto-routing list/);
  });

  it("selects a Codex Plus account for a Plus-only auto model", async () => {
    const rotator = new AccountRotator({
      accounts: [
        { email: "free@test.dev", tier: "free", credentials: [{ provider: "openai-codex", refreshToken: "free", providerAccountId: "free" }] },
        { email: "plus@test.dev", tier: "plus", credentials: [{ provider: "openai-codex", refreshToken: "plus", providerAccountId: "plus" }] },
      ],
      proxyPort: 0, requestsPerRotation: 5, rotateOnQuotaDrop: 20, quotaPollIntervalMs: 300_000,
    });
    rotator.stopQuotaPolling();
    rotator.setCodexModels(["gpt-6.1-terra"]);
    (rotator as unknown as { ensureValidTokenForModel: () => Promise<void> }).ensureValidTokenForModel = async () => {};
    const account = await rotator.getActiveAccount("gpt-6.1-terra", undefined, "openai-codex", {
      providerId: "openai-codex",
      modelId: "gpt-6.1-terra",
    });
    assert.equal(account?.config.email, "plus@test.dev");
    if (account) rotator.finishRequest(account, "gpt-6.1-terra", "openai-codex");
  });
});
