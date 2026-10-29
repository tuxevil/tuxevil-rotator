import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export function usageReadToken(): string | null {
  return process.env.TUXEVIL_ROTATOR_USAGE_READ_TOKEN?.trim() || null;
}
export function isUsageReadToken(value: unknown): boolean {
  const token = usageReadToken();
  return !!token && typeof value === "string" && timingSafeEqual(
    createHash("sha256").update(token).digest(), createHash("sha256").update(value).digest(),
  );
}
/** Reserve the read credential across conventional HTTP credential carriers. */
export function carriesUsageReadToken(req: Pick<IncomingMessage, "url" | "headers">): boolean {
  for (const value of Object.values(req.headers)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === "string" && (isUsageReadToken(item.trim()) || isUsageReadToken(item.trim().replace(/^Bearer\s+/i, "").trim()))) return true;
    }
  }
  try {
    return [...new URL(req.url || "/", "http://localhost").searchParams.values()].some(value => isUsageReadToken(value.trim()));
  } catch { return false; }
}
