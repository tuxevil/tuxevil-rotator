import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { buildUsageLimitsSnapshot, createUsageLimitsHandler, loadUsageInstanceId } from "../src/usage-limits.js";
import { buildPools } from "../src/quota-pools.js";
import { setPersistedAdminToken, isAdminTokenValid, isAdminAuthorized, createDashboardSession } from "../src/admin-auth.js";
import { fixtureOverview, NOW, INSTANCE } from "./fixtures/usage-limits/v1/input.js";

it("matches shared dashboard observations exactly and excludes individual/compatibility data", async () => {
  const overview = fixtureOverview();
  const result = buildUsageLimitsSnapshot(overview, INSTANCE, NOW);
  for (const pool of buildPools(overview, NOW)) {
    const row = result.pools.find(row => row.id === pool.id)!;
    assert.equal(row.remainingPercent, pool.observedCapacity);
    assert.equal(row.accountsWithQuota, pool.observedWithQuota);
    assert.equal(row.accountsEligible, pool.eligibleNow);
    assert.equal(row.accountsConsidered, pool.members.length);
    assert.equal(row.nextResetAt, pool.observedNextResetAt);
    assert.equal(row.freshness, pool.freshness);
  }
  const zen = result.pools.find(row => row.providerId === "opencode-zen")!;
  assert.equal(zen.remainingPercent, null);
  assert.equal(zen.knowledge, "unknown");
  assert.equal(zen.catalogAccessible, true);
  const ollama = result.pools.find(row => row.providerId === "ollama")!;
  assert.equal(ollama.resetBasis, "estimated");
  assert.deepEqual(ollama.credits, { balanceUsd: 5, allowanceUsd: 20, purchasedUsd: 3 });
  assert.equal(result.pools.find(row => row.name === "claude")!.remainingPercent, 73);
  assert.doesNotMatch(JSON.stringify(result), /secret.invalid|SECRET_|private-|refreshToken|apiKey|selectedEmail|lastError/);
  const fixture = JSON.parse(await readFile(new URL("./fixtures/usage-limits/v1/summary.json", import.meta.url), "utf8"));
  assert.deepEqual(result, fixture);
});

it("preserves stale and unknown observations without timestamp or percentage fallback", () => {
  const overview = fixtureOverview();
  const stale = buildUsageLimitsSnapshot(overview, INSTANCE, NOW + 3600000);
  assert.ok(stale.pools.every(row => row.freshness === "stale"));
  assert.equal(stale.pools.find(row => row.name === "claude")!.remainingPercent, 73);
  for (const account of overview.accounts) for (const q of account.quota) delete q.observation;
  const unknown = buildUsageLimitsSnapshot(overview, INSTANCE, NOW);
  assert.ok(unknown.pools.every(row => row.remainingPercent === null && row.observedAt === null && row.freshness === "unknown"));
});

it("publishes one stable identity under concurrency and across new readers, failing closed on corruption", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-identity-"));
  try {
    const ids = await Promise.all(Array.from({ length: 20 }, () => loadUsageInstanceId(directory)));
    assert.equal(new Set(ids).size, 1);
    assert.equal(await loadUsageInstanceId(directory), ids[0]);
    await writeFile(join(directory, "usage-limits-instance-id"), "corrupt");
    await assert.rejects(loadUsageInstanceId(directory));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("authenticates independently, coalesces readers and sanitizes failure responses", async t => {
  const directory = await mkdtemp(join(tmpdir(), "usage-handler-"));
  const previous = process.env.TUXEVIL_ROTATOR_USAGE_READ_TOKEN;
  process.env.TUXEVIL_ROTATOR_USAGE_READ_TOKEN = "reader-secret";
  t.after(() => { if (previous === undefined) delete process.env.TUXEVIL_ROTATOR_USAGE_READ_TOKEN; else process.env.TUXEVIL_ROTATOR_USAGE_READ_TOKEN = previous; });
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  setPersistedAdminToken("admin-secret");
  let reads = 0;
  const state = fixtureOverview();
  const handler = createUsageLimitsHandler(() => { reads++; return state; }, () => directory);
  const server = createServer((req, res) => { void handler(req, res); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api/usage-limits/v1`;
  const read = (token = "reader-secret", method = "GET", suffix = "") => fetch(base + suffix, { method, headers: { Authorization: `Bearer ${token}` } });
  try {
    assert.equal((await fetch(base)).status, 401);
    assert.equal((await read("admin-secret")).status, 401);
    assert.equal((await read("wrong")).status, 401);
    assert.equal((await read("reader-secret", "POST")).status, 405);
    assert.equal((await read("reader-secret", "GET", "?token=reader-secret")).status, 401);
    const responses = await Promise.all(Array.from({ length: 20 }, () => read()));
    const snapshots = await Promise.all(responses.map(async response => {
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
      assert.equal(response.headers.get("cache-control"), "no-store");
      return response.json();
    }));
    assert.equal(reads, 1);
    assert.ok(snapshots.every(snapshot => snapshot.instanceId === snapshots[0].instanceId));
    state.accounts[0].quota[0].observation!.remainingPercent = 0;
    t.mock.timers.tick(1001);
    const refreshed = await (await read()).json();
    assert.equal(reads, 2);
    assert.notEqual(refreshed.pools[0].remainingPercent, snapshots[0].pools[0].remainingPercent);
    assert.equal(refreshed.instanceId, snapshots[0].instanceId);
    assert.equal(isAdminTokenValid("reader-secret", null), false);
    assert.equal(isAdminAuthorized({ headers: { authorization: "Bearer reader-secret" } }, null), false);
    const signed = createDashboardSession("reader-secret");
    assert.equal(isAdminAuthorized({ headers: { cookie: `tuxevil_session=${signed.value}` } }, "reader-secret"), false);
    const failed = createUsageLimitsHandler(() => { throw new Error("SECRET_ERROR"); }, () => directory);
    const failureServer = createServer((req, res) => { void failed(req, res); });
    failureServer.listen(0, "127.0.0.1"); await once(failureServer, "listening");
    try {
      const response = await fetch(`http://127.0.0.1:${(failureServer.address() as import("node:net").AddressInfo).port}/`, { headers: { Authorization: "Bearer reader-secret" } });
      assert.equal(response.status, 503); assert.equal(await response.text(), '{"error":"snapshot_unavailable"}');
    } finally { await new Promise<void>(resolve => failureServer.close(() => resolve())); }
  } finally {
    setPersistedAdminToken(null);
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});


it("keeps provider-qualified pools distinct and unpolled providers explicitly unknown", () => {
  const overview = fixtureOverview();
  const extra = structuredClone(overview.accounts[0]);
  extra.provider = "other";
  extra.quota[0].providerId = "other";
  extra.quota[0].observation!.remainingPercent = 40;
  overview.accounts.push(extra);
  const unpolled = structuredClone(extra);
  unpolled.provider = "unpolled"; unpolled.quota = [];
  overview.accounts.push(unpolled);
  const result = buildUsageLimitsSnapshot(overview, INSTANCE, NOW);
  const claude = result.pools.filter(pool => pool.name === "claude");
  assert.equal(claude.length, 2);
  assert.equal(new Set(claude.map(pool => pool.id)).size, 2);
  assert.ok(claude.every(pool => pool.accountsEligible === null));
  const unknown = result.pools.find(pool => pool.providerId === "unpolled")!;
  assert.equal(unknown.scope, "provider");
  assert.equal(unknown.remainingPercent, null);
  assert.equal(unknown.accountsConsidered, 1);
});


it("exports partial coverage separately from unknown fleet capacity", async () => {
  const overview = fixtureOverview();
  delete overview.accounts[1].quota[0].observation;
  const response = buildUsageLimitsSnapshot(overview, INSTANCE, NOW);
  const claude = response.pools.find(pool => pool.name === "claude")!;
  assert.equal(claude.knowledge, "unknown");
  assert.equal(claude.remainingPercent, null);
  assert.equal(claude.accountsWithQuota, null);
  assert.deepEqual(claude.quotaCoverage, { knownAccounts: 1, totalAccounts: 2 });
  assert.equal(claude.partialObservation?.remainingPercent, 80);
  assert.equal(claude.partialObservation?.accountsWithQuota, 1);
  const fixture = JSON.parse(await readFile(new URL("./fixtures/usage-limits/v1/partial.json", import.meta.url), "utf8"));
  assert.deepEqual(response, fixture);
  assert.doesNotMatch(JSON.stringify(response), /secret.invalid|SECRET_|private-/);
});
