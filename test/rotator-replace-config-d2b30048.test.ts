import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "rotator-replace-d2b30048-"));
process.env.TUXEVIL_ROTATOR_DIR = tmp;
process.env.PI_ROTATOR_DIR = tmp;
process.env.TUXEVIL_ROTATOR_TELEMETRY = "off";
process.env.PI_ROTATOR_TELEMETRY = "off";
delete process.env.DATABASE_URL;
delete process.env.TUXEVIL_ROTATOR_DATABASE_URL;
delete process.env.PI_ROTATOR_DATABASE_URL;

let AccountRotator: typeof import("../src/rotator.js").AccountRotator;
let closeDb: typeof import("../src/db-store.js").closeDb;

before(async () => {
  ({ AccountRotator } = await import("../src/rotator.js"));
  const db = await import("../src/db-store.js");
  closeDb = db.closeDb;
  await db.initDb();
});

after(async () => {
  await closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe("AccountRotator.replaceConfig modelState & defaultIndex remapping (d2b30048)", () => {
  it("remaps activeAccountIndex, stickyAccountIndex, and defaultIndex when accounts are reordered or removed", async () => {
    const mk = (email: string) => ({
      email,
      credentials: [{ provider: "google-antigravity" as const, projectId: `p-${email}`, refreshToken: `fake-${email}` }],
    });
    const A = mk("a@example.com");
    const B = mk("b@example.com");

    const rotator = new AccountRotator({
      proxyPort: 51200,
      requestsPerRotation: 5,
      rotateOnQuotaDrop: 20,
      quotaPollIntervalMs: 300_000,
      routingPolicy: "sticky-quota",
      accounts: structuredClone([A, B]),
    });
    rotator.stopQuotaPolling();

    const internal = rotator as unknown as {
      accounts: Array<{ config: { email: string } }>;
      modelState: Map<string, { activeAccountIndex: number; stickyAccountIndex?: number; quotaAtRotationStart: number; requestsOnActiveAccount: number }>;
      defaultIndex: number;
    };

    const seed = (idx: number) => {
      internal.modelState.clear();
      internal.modelState.set("gemini", {
        activeAccountIndex: idx,
        stickyAccountIndex: idx,
        quotaAtRotationStart: 1,
        requestsOnActiveAccount: 0,
      });
      internal.defaultIndex = idx;
    };

    // Case 1: pinned to A (index 0), reorder to [B, A]
    seed(0);
    assert.equal(internal.accounts[0]?.config.email, A.email);
    await rotator.replaceConfig({ ...rotator.getConfig(), accounts: structuredClone([B, A]) });
    const s1 = internal.modelState.get("gemini")!;
    assert.equal(internal.accounts[s1.activeAccountIndex]?.config.email, A.email);
    assert.equal(internal.accounts[s1.stickyAccountIndex!]?.config.email, A.email);
    assert.equal(internal.accounts[internal.defaultIndex]?.config.email, A.email);

    // Case 2: pinned to B at index 1, remove A -> [B]
    await rotator.replaceConfig({ ...rotator.getConfig(), accounts: structuredClone([A, B]) });
    seed(1);
    assert.equal(internal.accounts[1]?.config.email, B.email);
    await rotator.replaceConfig({ ...rotator.getConfig(), accounts: structuredClone([B]) });
    const s2 = internal.modelState.get("gemini")!;
    assert.equal(internal.accounts[s2.activeAccountIndex]?.config.email, B.email);
    assert.equal(internal.accounts[s2.stickyAccountIndex!]?.config.email, B.email);
    assert.equal(internal.accounts[internal.defaultIndex]?.config.email, B.email);
  });
});
