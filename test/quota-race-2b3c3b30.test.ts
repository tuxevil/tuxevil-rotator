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

describe("in-flight quota poll vs concurrent 429 cooldown with short upstream reset (2b3c3b30)", () => {
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

  it("does not overwrite a concurrently written 12h cooldown with a shorter upstream 0% resetTime", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rotator-2b3c3b30-"));
    dirs.push(dir);
    process.env.TUXEVIL_ROTATOR_DIR = dir;

    await initDb();
    await setCachedState({ modelAccounts: {}, accounts: {} });
    dynamicCatalog.reset();

    const H = 3_600_000;
    const now = Date.now();
    const shortReset = new Date(now + 10_000).toISOString();

    let summaryReached!: () => void;
    const summaryReachedP = new Promise<void>((r) => (summaryReached = r));
    let releaseSummary!: () => void;
    const releaseP = new Promise<void>((r) => (releaseSummary = r));

    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url === QUOTA_SUMMARY_API_URL) {
        summaryReached();
        await releaseP;
        return new Response(
          JSON.stringify({
            groups: [
              {
                displayName: "Gemini Models",
                description: "Models within this group: Gemini 4 Hydrogen",
                buckets: [
                  { bucketId: "gemini-5h", window: "5h", remainingFraction: 0, resetTime: shortReset },
                  { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0, resetTime: shortReset },
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
                quotaInfo: { remainingFraction: 0, resetTime: shortReset },
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
          email: "test-clobber@example.com",
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

    const pollP = rotator.pollAccountQuota(runtime as never);
    await summaryReachedP;

    rotator.markExhausted(runtime as never, "gemini-4-hydrogen-high", 12 * H);
    const cooldownBefore = runtime.cooldownsByModel.gemini;
    assert.ok(typeof cooldownBefore === "number" && cooldownBefore - Date.now() >= 6 * H);

    releaseSummary();
    await pollP;

    assert.equal(runtime.cooldownsByModel.gemini, cooldownBefore);
  });
});
