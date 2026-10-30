import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import type { Config } from "../src/types.js";
import { join } from "node:path";
it("persists scoped evidence through the file repository without secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "access-evidence-"));
  const previous = process.env.TUXEVIL_ROTATOR_DIR;
  process.env.TUXEVIL_ROTATOR_DIR = directory;
  const { initDb, closeDb, getCachedAccessEvidence, setCachedAccessEvidence } = await import("../src/db-store.js");
  const { AccessEvidenceStore } = await import("../src/access-evidence.js");
  try {
    await initDb();
    const account = { email: "test@local", credentials: [{ provider: "ollama", apiKey: "private-key" }] };
    const store = new AccessEvidenceStore();
    store.declarePlan(account, "ollama", "free");
    store.observe(account, "ollama", "beam", "unknown", 200);
    await setCachedAccessEvidence(store.snapshot());
    const { serveProviderPlanApi, serveModelAccessApi } = await import("../src/model-access-api.js");
    const { getAccountIdentity } = await import("../src/account-identity.js");
    const { requireAdmin, setPersistedAdminToken } = await import("../src/admin-auth.js");
    const config = { accounts: [account] } as Config;
    setPersistedAdminToken("test-admin");
    const server = createServer((req, res) => {
      if (!requireAdmin(req, res)) return;
      if (req.method === "PUT") void serveProviderPlanApi(req, res, config);
      else serveModelAccessApi(res, config, new URL(req.url ?? "/", "http://localhost").searchParams);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/api/model-access`;
    const headers = { "x-rotator-admin-token": "test-admin", "content-type": "application/json" };
    try {
      assert.equal((await fetch(url + "/plan", { method: "PUT", body: "{}" })).status, 401);
      const response = await fetch(url + "/plan", { method: "PUT", headers, body: JSON.stringify({ accountId: getAccountIdentity(account), provider: "ollama", plan: "free" }) });
      assert.equal(response.status, 200);
      assert.doesNotMatch(await response.text(), /private-key/);
      const params = new URLSearchParams({ accountId: getAccountIdentity(account), provider: "ollama", model: "beam" });
      const query = await fetch(url + "?" + params, { headers });
      const body = await query.json() as { planSource: string; decision: { state: string; declaredPlan: string } };
      assert.equal(body.planSource, "provider-declaration");
      assert.equal(body.decision.declaredPlan, "free");
      assert.equal(body.decision.state, "unknown");
      assert.equal((await fetch(url + "/plan", { method: "PUT", headers, body: JSON.stringify({ accountId: getAccountIdentity(account), provider: "unconnected", plan: "free" }) })).status, 400);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      setPersistedAdminToken(null);
    }
    const text = await readFile(join(directory, "model-access-evidence.json"), "utf8");
    assert.doesNotMatch(text, /private-key/);
    await closeDb();
    await initDb();
    const restored = new AccessEvidenceStore(getCachedAccessEvidence()).forAccount(account);
    assert.equal(restored.plans[0].plan, "free");
    assert.equal(restored.observations[0].kind, "success");
  } finally {
    await closeDb();
    if (previous === undefined) delete process.env.TUXEVIL_ROTATOR_DIR; else process.env.TUXEVIL_ROTATOR_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
