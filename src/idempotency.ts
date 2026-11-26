import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";

export interface IdempotencyOptions {
  enabled?: boolean;
  windowMs?: number;
}

interface InFlightEntry<T> {
  promise: Promise<T>;
  timestamp: number;
}

export class IdempotencyManager {
  private inFlight = new Map<string, InFlightEntry<unknown>>();

  /**
   * Compute fingerprint for a request body and optional client idempotency key.
   */
  computeKey(model: string, body: unknown, clientKey?: string | null): string {
    if (clientKey && clientKey.trim().length > 0) {
      return createHash("sha256")
        .update(`idkey:${clientKey.trim()}`)
        .digest("hex");
    }
    // SHA-256 is intentional: this is a deterministic HTTP request payload fingerprint
    // for in-flight deduplication / idempotency caching, not a password hash.
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    return createHash("sha256")
      .update(`body:${model}:${raw}`)
      .digest("hex"); // codeql[js/insufficient-password-hash]
  }

  /**
   * Check if a request has opt-out headers.
   */
  isOptedOut(req: IncomingMessage): boolean {
    const headers = req.headers;
    const noDedup =
      headers["x-rotator-no-deduplicate"] ||
      headers["x-no-deduplicate"] ||
      headers["x-no-cache"];
    return Boolean(
      noDedup &&
        noDedup !== "false" &&
        noDedup !== "0" &&
        Array.isArray(noDedup) === false,
    );
  }

  /**
   * Extract client-provided idempotency key from request headers.
   */
  extractClientKey(req: IncomingMessage): string | null {
    const key =
      req.headers["idempotency-key"] ||
      req.headers["x-idempotency-key"] ||
      req.headers["x-rotator-idempotency-key"];
    if (typeof key === "string" && key.trim().length > 0) {
      return key.trim();
    }
    return null;
  }

  /**
   * Execute an operation idempotently. If an identical operation is currently
   * in-flight or completed within windowMs, await the in-flight promise.
   */
  async execute<T>(
    key: string,
    windowMs: number,
    fn: () => Promise<T>,
  ): Promise<{ result: T; isDeduplicated: boolean }> {
    if (windowMs <= 0) {
      const result = await fn();
      return { result, isDeduplicated: false };
    }

    this.cleanup(windowMs);

    const existing = this.inFlight.get(key);
    if (existing) {
      try {
        const result = (await existing.promise) as T;
        return { result, isDeduplicated: true };
      } catch {
        // If the original failed, remove and proceed with fresh execution
        this.inFlight.delete(key);
      }
    }

    const promise = fn();
    const entry: InFlightEntry<T> = {
      promise,
      timestamp: Date.now(),
    };

    this.inFlight.set(key, entry as InFlightEntry<unknown>);

    try {
      const result = await promise;
      // Schedule removal after windowMs
      const timer = setTimeout(() => {
        if (this.inFlight.get(key) === entry) {
          this.inFlight.delete(key);
        }
      }, windowMs);
      if (timer && typeof timer.unref === "function") {
        timer.unref();
      }
      return { result, isDeduplicated: false };
    } catch (err) {
      // Remove immediately on error so retries can proceed
      this.inFlight.delete(key);
      throw err;
    }
  }

  /**
   * Evict stale entries.
   */
  private cleanup(windowMs: number): void {
    const now = Date.now();
    for (const [k, v] of this.inFlight.entries()) {
      if (now - v.timestamp > windowMs * 2) {
        this.inFlight.delete(k);
      }
    }
  }

  /**
   * Reset all in-flight entries (for testing).
   */
  clear(): void {
    this.inFlight.clear();
  }
}

export const idempotencyManager = new IdempotencyManager();
