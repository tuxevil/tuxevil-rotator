import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAccountIdentity, getCredentialGeneration } from "../src/account-identity.js";
import { closeDb, initDb, setCachedState } from "../src/db-store.js";
import { dynamicCatalog } from "../src/providers/google-antigravity/dynamic-catalog.js";
import { AccountRotator } from "../src/rotator.js";
import { QUOTA_API_URL, QUOTA_SUMMARY_API_URL } from "../src/types.js";

describe("quota poll preserves short 429 cooldown when upstream quota is healthy (caffcd72)", () => {
  const originalFetch = globalThis.fetch;
  const dirs: string[] = [];
  const savedDir = process.env.TUXEVIL_ROTATOR_DIR;

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    dynamicCatalog.reset();
    await closeDb().catch(() => {});
    if (savedDir === undefined) delete process.env.TUXEVIL_ROTATOR_DIR;
    else process.env.TUXEVIL_ROTATOR_DIR = savedDir;
    while (dirs.length > 0) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it("does not escalate a 30s cooldown to the advertised 5h/weekly reset when upstream reports 70% remaining", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rotator-caffcd72-"));
    dirs.push(dir);
    process.env.TUXEVIL_ROTATOR_DIR = dir;

    await initDb();
    await setCachedState({ modelAccounts: {}, accounts: {} });
    dynamicCatalog.reset();

    const H = 3_600_000;
    const D = 24 * H;
    const now = Date.now();
    const weeklyReset = new Date(now + 6 * D).toISOString();
    const reset5h = new Date(now + 2.5 * H).toISOString();

    let summaryReached!: () => void;
    const summaryReachedP = new Promise<void>((r) => (summaryReached = r));
    let releaseSummary!: () => void;
    const releaseP = new Promise<void>((r) => (releaseSummary = r));
    let pauseSummary = true;

    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url === QUOTA_SUMMARY_API_URL) {
        if (pauseSummary) {
          summaryReached();
          await releaseP;
        }
        return new Response(
          JSON.stringify({
            groups: [
              {
                displayName: "Gemini Models",
                description: "Models within this group: Gemini 4 Hydrogen",
                buckets: [
                  { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.7, resetTime: reset5h },
                  { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.7, resetTime: weeklyReset },
                ],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === QUOTA_API_URL) {
        return new Response(
          JSON.stringify({
            models: {
              "gemini-4-hydrogen-high": {
                displayName: "Gemini 4 Hydrogen (High)",
                quotaInfo: { remainingFraction: 0.7, resetTime: reset5h },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    const rotator = new AccountRotator({
      proxyPort: 0,
      requestsPerRotation: 5,
      rotateOnQuotaDrop: 20,
      quotaPollIntervalMs: 300_000,
      accounts: [
        {
          email: "test-caffcd72@example.com",
          tier: "pro",
          credentials: [{ provider: "google-antigravity", refreshToken: "r-test", projectId: "proj-test" }],
        },
      ],
    });
    rotator.stopQuotaPolling();
    const runtime = (rotator as unknown as { accounts: Array<{ accessToken?: string; tokenExpires?: number; cooldownsByModel: Record<string, number> }> }).accounts[0];
    runtime.accessToken = "access-test";
    runtime.tokenExpires = now + H;
    dynamicCatalog.retainAccounts([
      { id: getAccountIdentity(runtime as never), generation: getCredentialGeneration(runtime as never, "google-antigravity") },
    ]);

    // Case 1: markExhausted(30s) concurrently during pollAccountQuota
    const pollP = rotator.pollAccountQuota(runtime as never);
    await summaryReachedP;
    rotator.markExhausted(runtime as never, "gemini-4-hydrogen-high", 30_000);
    const afterMark = runtime.cooldownsByModel.gemini;
    releaseSummary();
    await pollP;
    assert.equal(runtime.cooldownsByModel.gemini, afterMark);
    assert.ok(runtime.cooldownsByModel.gemini <= Date.now() + 35_000);

    // Case 2: pre-existing 30s cooldown before pollAccountQuota starts
    pauseSummary = false;
    await rotator.pollAccountQuota(runtime as never);
    assert.equal(runtime.cooldownsByModel.gemini, afterMark);
    assert.ok(runtime.cooldownsByModel.gemini <= Date.now() + 35_000);
  });
});
