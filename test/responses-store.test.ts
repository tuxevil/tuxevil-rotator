import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ResponsesStore,
  type StoredResponseEntry,
} from "../src/responses-store.js";
import {
  initDb,
  setCachedResponsesStore,
  getCachedResponsesStore,
} from "../src/db-store.js";

function makeEntry(
  id: string,
  expiresAt: number,
): [string, StoredResponseEntry] {
  return [
    id,
    {
      response: { id, status: "completed" },
      inputItems: [],
      conversationMessages: [],
      callIdToName: { [`call_${id}`]: "toolA" },
      expiresAt,
    },
  ];
}

describe("ResponsesStore", () => {
  let store: ResponsesStore;

  before(async () => {
    if (!process.env.TUXEVIL_ROTATOR_DIR) {
      process.env.TUXEVIL_ROTATOR_DIR = mkdtempSync(join(tmpdir(), "tuxevil-responses-"));
    }
    await initDb();
    store = new ResponsesStore();
  });

  it("returns null for an unknown id", () => {
    assert.equal(store.get("missing"), null);
  });

  it("set + get round-trips", () => {
    const [id, entry] = makeEntry("round-trip", Date.now() + 60_000);
    store.set(id, entry);
    const got = store.get(id);
    assert.ok(got);
    assert.equal(got?.response.id, "round-trip");
  });

  it("delete removes the entry", () => {
    const [id, entry] = makeEntry("to-delete", Date.now() + 60_000);
    store.set(id, entry);
    assert.equal(store.delete(id), true);
    assert.equal(store.get(id), null);
    assert.equal(store.delete(id), false);
  });

  it("clear removes all entries", () => {
    store.set("a", makeEntry("a", Date.now() + 60_000)[1]);
    store.set("b", makeEntry("b", Date.now() + 60_000)[1]);
    store.clear();
    assert.equal(store.get("a"), null);
    assert.equal(store.get("b"), null);
  });

  it("get returns null for expired entries and removes them", () => {
    const id = "expired";
    const past = Date.now() - 1;
    store.set(id, makeEntry(id, past)[1]);
    assert.equal(store.get(id), null);
  });

  it("evicts old image responses by serialized size and skips oversized entries", () => {
    store.clear();
    const image = `![image](data:image/png;base64,${"A".repeat(6 * 1024 * 1024)})`;
    const expiresAt = Date.now() + 60_000;
    for (const id of ["first", "second", "third"]) {
      const [, entry] = makeEntry(id, expiresAt);
      entry.response.output_text = image;
      entry.conversationMessages = [{ role: "assistant", content: image }];
      store.set(id, entry);
    }

    assert.equal(store.get("first"), null);
    assert.ok(store.get("second"));
    assert.ok(store.get("third"));

    const [, oversized] = makeEntry("oversized", expiresAt);
    oversized.conversationMessages = Array.from({ length: 6 }, () => ({ content: image }));
    store.set("oversized", oversized);
    assert.equal(store.get("oversized"), null);
    assert.equal(store.size(), 2);
    store.clear();
  });

  it("flush persists to the repository", async () => {
    store.clear();
    store.set("disk-1", makeEntry("disk-1", Date.now() + 60_000)[1]);
    store.set("disk-2", makeEntry("disk-2", Date.now() + 60_000)[1]);
    await store.flush();
    const cached = getCachedResponsesStore();
    assert.ok(cached);
    assert.equal(cached.version, 1);
    assert.equal(cached.entries.length, 2);
    assert.ok(cached.entries.find((e: [string, unknown]) => e[0] === "disk-1"));
    assert.ok(cached.entries.find((e: [string, unknown]) => e[0] === "disk-2"));
  });

  it("load restores entries from the repository", async () => {
    // Ensure previous test flushed data
    const fresh = new ResponsesStore();
    await fresh.load();
    assert.ok(fresh.get("disk-1"));
    assert.ok(fresh.get("disk-2"));
  });

  it("load prunes expired entries from repository", async () => {
    const expiredId = "expired-on-repo";
    const freshId = "fresh-on-repo";
    await setCachedResponsesStore({
      version: 1,
      entries: [
        makeEntry(expiredId, Date.now() - 1),
        makeEntry(freshId, Date.now() + 60_000),
      ],
    });
    const fresh = new ResponsesStore();
    await fresh.load();
    assert.equal(fresh.get(expiredId), null);
    assert.ok(fresh.get(freshId));
  });

  it("load handles empty repository gracefully", async () => {
    // Don't set anything — getCachedResponsesStore returns null for unknown key
    const fresh = new ResponsesStore();
    await fresh.load();
    // Should not crash, just be empty (may pick up previously set values)
    assert.equal(typeof fresh.size(), "number");
  });
});

describe("ResponsesStore.flush", () => {
  before(async () => {
    await initDb();
  });

  it("writes to repository asynchronously when dirty", async () => {
    const store = new ResponsesStore();
    store.set("sync-1", makeEntry("sync-1", Date.now() + 60_000)[1]);
    await store.flush();
    const cached = getCachedResponsesStore();
    assert.ok(cached);
    assert.ok(cached.entries.find((e: [string, unknown]) => e[0] === "sync-1"));
  });

  it("no-op when not dirty", async () => {
    const store = new ResponsesStore();
    // flush on a clean store should not crash
    await store.flush();
  });
});
