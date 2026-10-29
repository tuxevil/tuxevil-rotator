import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DashboardOverview } from "./dashboard-types.js";
import { buildProviderGroups } from "./quota-pools.js";
import { isUsageReadToken, usageReadToken } from "./usage-limits-auth.js";
import { getConfiguredAdminToken } from "./admin-auth.js";
import { getConfigDir } from "./paths.js";

export const USAGE_LIMITS_PATH = "/api/usage-limits/v1";

/** Atomic publication avoids partial identities across simultaneous processes. */
export async function loadUsageInstanceId(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, "usage-limits-instance-id");
  try { return validateIdentity(await readFile(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const id = randomUUID();
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, id + "\n", { mode: 0o600, flag: "wx" });
  try {
    try { await link(temporary, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { await unlink(temporary); }
  return validateIdentity(await readFile(path, "utf8"));
}
function validateIdentity(text: string): string {
  const id = text.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error("Invalid installation identity");
  return id;
}

export interface UsageLimitsPoolV1 {
  id: string;
  scope: "pool" | "provider";
  name: string;
  providerId: string;
  knowledge: "known" | "unknown" | "not-applicable";
  remainingPercent: number | null;
  percentageBasis: "tier-estimate" | "included-credits" | "unknown";
  accountsWithQuota: number | null;
  accountsEligible: number | null;
  accountsConsidered: number;
  availability: "available" | "unavailable" | "unknown";
  nextResetAt: number | null;
  resetBasis: "reported" | "estimated" | "unknown";
  observedAt: number | null;
  freshness: "fresh" | "stale" | "unknown";
  quotaUnit: "usd" | "percent" | "unknown";
  credits: { balanceUsd: number; allowanceUsd: number; purchasedUsd: number } | null;
  catalogAccessible: boolean | null;
}

/** Explicit aggregate allowlist. Never serialize a ModelPool or ModelQuota. */
export function buildUsageLimitsSnapshot(overview: DashboardOverview, instanceId: string, now: number) {
  return {
    schemaVersion: 1 as const,
    instanceId,
    generatedAt: now,
    pools: buildProviderGroups(overview, now).flatMap<UsageLimitsPoolV1>(group => group.pools.length ? group.pools.map(pool => ({
      id: pool.id,
      scope: "pool" as const,
      name: pool.name,
      providerId: pool.provider,
      knowledge: pool.observedCapacity === null ? "unknown" as const : "known" as const,
      remainingPercent: pool.observedCapacity,
      percentageBasis: pool.capacityBasis,
      accountsWithQuota: pool.observedWithQuota,
      accountsEligible: pool.eligibleNow,
      accountsConsidered: pool.members.length,
      availability: pool.eligibleNow === null ? "unknown" as const : pool.eligibleNow > 0 ? "available" as const : "unavailable" as const,
      nextResetAt: pool.observedNextResetAt,
      resetBasis: pool.resetBasis,
      observedAt: pool.observedAt,
      freshness: pool.freshness,
      quotaUnit: pool.credits ? "usd" as const : pool.observedCapacity === null ? "unknown" as const : "percent" as const,
      credits: pool.observedCapacity !== null && pool.credits ? {
        balanceUsd: pool.credits.balanceUsd,
        allowanceUsd: pool.credits.allowanceUsd,
        purchasedUsd: pool.credits.purchasedUsd,
      } : null,
      catalogAccessible: pool.catalogAccessible,
    })) : [{
      scope: "provider" as const,
      id: JSON.stringify([group.provider, null]), name: group.provider, providerId: group.provider,
      knowledge: "unknown" as const, remainingPercent: null, percentageBasis: "unknown" as const,
      accountsWithQuota: null, accountsEligible: null, accountsConsidered: group.accounts.length,
      availability: "unknown" as const, nextResetAt: null, resetBasis: "unknown" as const,
      observedAt: null, freshness: "unknown" as const, quotaUnit: "unknown" as const,
      credits: null, catalogAccessible: null,
    }]),
  };
}
export type UsageLimitsSnapshotV1 = ReturnType<typeof buildUsageLimitsSnapshot>;

/** Per-server short cache coalesces readers. Reads local state only; never polls. */
export function createUsageLimitsHandler(readOverview: () => DashboardOverview, directory = () => getConfigDir()) {
  let pending: Promise<string> | null = null;
  let cached: { expires: number; body: string } | null = null;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const send = (status: number, body: string) => {
      if (res.destroyed) return;
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(body);
    };
    const auth = req.headers.authorization;
    if (!usageReadToken() || usageReadToken() === getConfiguredAdminToken() || typeof auth !== "string" ||
      !/^Bearer /i.test(auth) || !isUsageReadToken(auth.slice(7)) || (req.url || "").includes("?")) {
      send(401, '{"error":"unauthorized"}'); return;
    }
    if (req.method !== "GET") { res.setHeader("Allow", "GET"); send(405, '{"error":"method_not_allowed"}'); return; }
    try {
      pending ??= loadUsageInstanceId(directory()).catch(error => { pending = null; throw error; });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let id: string;
      try {
        id = await Promise.race([pending, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Identity timeout")), 5000);
        })]);
      } finally { clearTimeout(timer); }
      const now = Date.now();
      if (!cached || now >= cached.expires) {
        const body = JSON.stringify(buildUsageLimitsSnapshot(readOverview(), id, now));
        if (Buffer.byteLength(body) > 1024 * 1024) throw new Error("Snapshot too large");
        cached = { expires: now + 1000, body };
      }
      send(200, cached.body);
    } catch { send(503, '{"error":"snapshot_unavailable"}'); }
  };
}
