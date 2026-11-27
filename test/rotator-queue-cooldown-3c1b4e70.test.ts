import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const testDir = mkdtempSync(join(tmpdir(), "rotator-queue-3c1b4e70-"));
process.env.TUXEVIL_ROTATOR_DIR = testDir;
process.env.PI_ROTATOR_DIR = testDir;
delete process.env.DATABASE_URL;
delete process.env.TUXEVIL_ROTATOR_DATABASE_URL;
delete process.env.PI_ROTATOR_DATABASE_URL;
process.env.ANTIGRAVITY_CLIENT_ID = "test-client-id";
process.env.ANTIGRAVITY_CLIENT_SECRET = "test-client-secret";

let AccountRotator: typeof import("../src/rotator.js").AccountRotator;
let closeDb: typeof import("../src/db-store.js").closeDb;
let accessEvidenceStore: typeof import("../src/access-evidence.js").accessEvidenceStore;
let clearRequestWaiterWakeFn: (() => void) | undefined;

before(async () => {
  ({ AccountRotator } = await import("../src/rotator.js"));
  ({ accessEvidenceStore } = await import("../src/access-evidence.js"));
  const db = await import("../src/db-store.js");
  closeDb = db.closeDb;
  await db.initDb();
});

after(async () => {
  clearRequestWaiterWakeFn?.();
  await closeDb();
  rmSync(testDir, { recursive: true, force: true });
});

describe("request queue skips cooldown-parked head for healthy sibling pool (3c1b4e70)", () => {
  it("does not deadlock claude waiters behind a gemini waiter parked on pool cooldown", async () => {
    const rotator = new AccountRotator({
      proxyPort: 51200,
      requestsPerRotation: 5,
      rotateOnQuotaDrop: 20,
      quotaPollIntervalMs: 300_000,
      maxConcurrentRequestsPerAccount: 1,
      maxConcurrentRequestsPerProjectModel: 1,
      accounts: [
        {
          email: "a@example.com",
          tier: "pro",
          credentials: [{ provider: "google-antigravity", refreshToken: "r1", projectId: "project-a" }],
        },
      ],
    });
    rotator.stopQuotaPolling();
    const internal = rotator as unknown as {
      accounts: Array<{
        config: NonNullable<ConstructorParameters<typeof AccountRotator>[0]>["accounts"][number];
        accessToken: string;
        tokenExpires: number;
        inFlightRequests: number;
        cooldownsByModel: Record<string, number>;
        quota: Array<Record<string, unknown>>;
      }>;
      requestWaiters: unknown[];
      clearRequestWaiterWake?: () => void;
    };
    clearRequestWaiterWakeFn = () => internal.clearRequestWaiterWake?.();

    const acc = internal.accounts[0];
    acc.accessToken = "access-a";
    acc.tokenExpires = Date.now() + 60_000;
    acc.quota = ["gemini", "claude"].map((modelKey) => ({
      modelKey,
      displayName: modelKey,
      percentRemaining: 100,
      resetTime: null,
      timerType: "fresh",
      providerId: "google-antigravity",
    }));
    accessEvidenceStore().declarePlan(acc.config, "google-antigravity", "enterprise");

    const GEM = "gemini-3-flash";
    const CLA = "claude-opus-4-5-thinking";
    const req0 = await rotator.getActiveAccount(GEM);
    assert.ok(req0);
    const gemKey = rotator.resolveQuotaModelKeyForDisplay(GEM);
    const claKey = rotator.resolveQuotaModelKeyForDisplay(CLA);
    assert.notEqual(gemKey, claKey);

    const ac1 = new AbortController();
    let r1: unknown = "pending";
    const p1 = rotator.getActiveAccount(GEM, ac1.signal).then((a) => {
      r1 = a;
      return a;
    });
    const p2 = rotator.getActiveAccount(CLA);
    assert.equal(internal.requestWaiters.length, 2);

    rotator.markExhausted(req0, GEM, 60_000);
    rotator.finishRequest(req0, gemKey);

    const admitted2 = await p2;
    assert.ok(admitted2, "claude waiter must be admitted despite gemini cooldown head");
    assert.equal(r1, "pending", "gemini waiter remains parked on cooldown");
    rotator.finishRequest(admitted2, claKey);

    const admitted3 = await rotator.getActiveAccount(CLA);
    assert.ok(admitted3, "subsequent claude request must also be admitted");
    rotator.finishRequest(admitted3, claKey);

    ac1.abort();
    await p1;
    internal.clearRequestWaiterWake?.();
  });
});
