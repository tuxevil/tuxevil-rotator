// Persistent in-memory store for OpenAI Responses API (Codex) chain state.
//
// The store maps `response_id` to the conversation state needed to continue
// a previous turn via `previous_response_id`. It is persisted via the
// settings repository (PostgreSQL or disk files) so a rotator restart does
// not break active Codex sessions.
//
// Writes are debounced to avoid excessive persistence calls under load.
// The store is flushed asynchronously during graceful shutdown (see index.ts)
// to minimise data loss without blocking the event loop.

import {
  getCachedResponsesStore,
  setCachedResponsesStore,
} from "./db-store.js";

export interface StoredResponseEntry {
  response: Record<string, unknown>;
  inputItems: Array<Record<string, unknown>>;
  conversationMessages: Array<Record<string, unknown>>;
  // Maps call_id -> function name. Serialized as plain object on disk
  // because Map cannot be JSON.stringified directly. Convert to Map at use sites.
  callIdToName: Record<string, string>;
  expiresAt: number;
}

export interface PersistedResponsesStore {
  version: 1;
  entries: Array<[string, StoredResponseEntry]>;
}

const FLUSH_DEBOUNCE_MS = 1_500;
const MAX_ENTRIES = 500;
const MAX_STORE_BYTES = 32 * 1024 * 1024;

function now(): number {
  return Date.now();
}

/**
 * Persistent in-memory store for OpenAI Responses API (Codex) chain state.
 *
 * Maps `response_id` to the conversation state needed to continue a previous
 * turn via `previous_response_id`. Persisted via the settings repository.
 * Writes are debounced to 1.5s and coalesced if a flush is already in flight.
 * Entries expire after 6h. Oldest entries are evicted above 500 entries
 * or 32 MiB of serialized entries, including response and history payloads.
 */
export class ResponsesStore {
  private cache = new Map<string, { entry: StoredResponseEntry; bytes: number }>();
  private bytes = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private pendingFlush = false;
  private dirty = false;

  /**
   * Load the persisted store from the repository. Missing or corrupt data
   * is treated as an empty store. Stale entries (older than TTL) are pruned.
   */
  async load(): Promise<void> {
    const dbStore = getCachedResponsesStore();
    if (!dbStore || dbStore.version !== 1 || !Array.isArray(dbStore.entries)) {
      return;
    }
    const cutoff = now();
    for (const [id, entry] of dbStore.entries) {
      if (!entry || typeof entry !== "object") continue;
      if (typeof entry.expiresAt !== "number" || entry.expiresAt < cutoff)
        continue;
      this.insert(id, entry);
    }
    if (this.cache.size < dbStore.entries.length) this.scheduleFlush();
  }

  get(id: string): StoredResponseEntry | null {
    const entry = this.cache.get(id)?.entry;
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      this.remove(id);
      this.scheduleFlush();
      return null;
    }
    return entry;
  }

  set(id: string, entry: StoredResponseEntry): void {
    this.insert(id, entry);
    this.scheduleFlush();
  }

  delete(id: string): boolean {
    const existed = this.remove(id);
    if (existed) this.scheduleFlush();
    return existed;
  }

  clear(): void {
    this.cache.clear();
    this.bytes = 0;
    this.scheduleFlush();
  }

  size(): number {
    return this.cache.size;
  }

  private insert(id: string, entry: StoredResponseEntry): void {
    const bytes = Buffer.byteLength(JSON.stringify([id, entry])) + 1;
    this.remove(id);
    const cutoff = now();
    if (bytes > MAX_STORE_BYTES || entry.expiresAt <= cutoff) return;
    for (const [key, cached] of this.cache) {
      if (cached.entry.expiresAt <= cutoff) this.remove(key);
    }
    while (this.cache.size >= MAX_ENTRIES || this.bytes + bytes > MAX_STORE_BYTES) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.remove(oldest.value);
    }
    this.cache.set(id, { entry, bytes });
    this.bytes += bytes;
  }

  private remove(id: string): boolean {
    const cached = this.cache.get(id);
    if (!cached) return false;
    this.bytes -= cached.bytes;
    return this.cache.delete(id);
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_DEBOUNCE_MS);
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  /**
   * Flush pending writes to the repository. Safe to call multiple times
   * concurrently; callers will see the same in-flight promise.
   */
  async flush(): Promise<void> {
    if (this.flushing) {
      this.pendingFlush = true;
      return this.flushing;
    }
    this.flushing = (async () => {
      try {
        if (!this.dirty) return;
        const data: PersistedResponsesStore = {
          version: 1,
          entries: Array.from(this.cache, ([id, { entry }]) => [id, entry]),
        };
        this.dirty = false;
        await setCachedResponsesStore(data);
      } catch {
        this.dirty = true;
        // Best effort — will retry on next schedule.
      } finally {
        this.flushing = null;
        if (this.pendingFlush) {
          this.pendingFlush = false;
          void this.flush();
        }
      }
    })();
    return this.flushing;
  }

}
