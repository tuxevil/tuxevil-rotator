// Repository pattern for rotator settings persistence.
//
// Two implementations:
//   PostgresSettingsRepository — backed by a `rotator_settings` table
//   FileSettingsRepository     — backed by JSON files on disk

import pg from "pg";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { getConfigDir } from "./paths.js";
import { rotatorEnv } from "./env.js";
import {
  backupFile,
  readTextFile,
  writeJsonFileAtomic,
  writeTextFileAtomic,
} from "./storage.js";

const { Pool } = pg;

/**
 * Generic key-value settings repository.
 *
 * Callers use string keys; the values are opaque strings (typically
 * JSON-serialized objects). Both implementations guarantee that `get()`
 * always returns the latest value set via `set()` (in-process consistency).
 */
/**
 * Runs writes for one key one at a time. Each write persists the newest cached
 * value when it runs, so an older write can never land after a newer one (for
 * example two quick toggles whose disk backups finish out of order).
 */
class KeyedWriteQueue {
  private tails = new Map<string, Promise<void>>();

  run(key: string, write: () => Promise<void>): Promise<void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(write);
    const tail = next.catch(() => {});
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}

export interface ISettingsRepository {
  /** Initialize the repository (create table / load from disk) */
  init(): Promise<void>;

  /** Get a value by key */
  get(key: string): string | null;

  /** Persist a value by key */
  set(key: string, value: string): Promise<void>;

  /** Close connections / flush pending writes */
  close(): Promise<void>;
}

// ----- Key → disk-file mapping -----

interface DiskFileSpec {
  filename: string;
  /** Whether to back up the file before overwriting */
  backup: boolean;
  /** Whether to trim whitespace on read (e.g. admin_token) */
  trim: boolean;
  /** File mode to set after writing (e.g. 0o600 for secrets) */
  mode?: number;
}

const DISK_FILES: Record<string, DiskFileSpec> = {
  accounts_json: { filename: "accounts.json", backup: true, trim: false },
  admin_token: {
    filename: ".admin-token",
    backup: false,
    trim: true,
    mode: 0o600,
  },
  dashboard_revoked_sessions: {
    filename: ".dashboard-revoked-sessions",
    backup: false,
    trim: false,
    mode: 0o600,
  },
  model_access_evidence: { filename: "model-access-evidence.json", backup: false, trim: false, mode: 0o600 },
  rotator_state: { filename: "state.json", backup: true, trim: false },
  token_usage: { filename: "token-usage.json", backup: false, trim: false },
  responses_store: { filename: "responses.json", backup: false, trim: false },
};

function diskPath(key: string): string | null {
  const spec = DISK_FILES[key];
  if (!spec) return null;
  return join(getConfigDir(), spec.filename);
}

// ----- PostgresSettingsRepository -----

const RETRY_DELAY_MS = 5_000;
const MAX_RETRIES = 3;

interface PendingWrite {
  value: string;
  attempts: number;
}

export class PostgresSettingsRepository implements ISettingsRepository {
  private pool: pg.Pool | null = null;
  private cache = new Map<string, string>();
  private writes = new KeyedWriteQueue();
  private initialized = false;
  private pendingRetries = new Map<string, PendingWrite>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  async init(): Promise<void> {
    if (this.initialized) return;

    const connectionString =
      rotatorEnv("DATABASE_URL") || process.env.DATABASE_URL;
    this.pool = new Pool({
      connectionString,
      ssl:
        connectionString?.includes("sslmode=require") ||
        connectionString?.includes("ssl=")
          ? { rejectUnauthorized: false }
          : undefined,
    });

    // Create table if it doesn't exist
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS rotator_settings (
        key VARCHAR(255) PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Load all rows into cache
    const result = await this.pool.query(
      "SELECT key, value FROM rotator_settings",
    );
    for (const row of result.rows) {
      this.cache.set(row.key, row.value);
    }

    // Migrate non-account settings from disk for any keys not already in DB.
    // accounts.json is deliberately excluded: when PostgreSQL is configured,
    // it must be the sole source of account credentials.
    for (const [key, spec] of Object.entries(DISK_FILES)) {
      if (key === "accounts_json") continue;
      if (this.cache.has(key)) continue;
      try {
        const path = join(getConfigDir(), spec.filename);
        const content = await readTextFile(path);
        if (!content) continue;
        const value = spec.trim ? content.trim() : content;
        if (!value) continue;
        this.cache.set(key, value);
        // Persist migration to DB (blocking on init is intentional)
        await this.pool.query(
          `INSERT INTO rotator_settings (key, value, updated_at)
           VALUES ($1, $2, CURRENT_TIMESTAMP)
           ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
          [key, value],
        );
        console.log(`Migrated ${spec.filename} from disk to database`);
      } catch (err) {
        console.error(`Failed to migrate ${spec.filename} from disk: ${err}`);
      }
    }

    this.initialized = true;
  }

  getPool(): pg.Pool | null {
    return this.pool;
  }

  async query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<R>> {
    if (!this.pool) {
      throw new Error("Database pool is not initialized");
    }
    return this.pool.query<R>(text, params);
  }

  get(key: string): string | null {
    return this.cache.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.cache.set(key, value);
    if (!this.pool) return;
    await this.writes.run(key, async () => {
      const pool = this.pool;
      const latest = this.cache.get(key) ?? value;
      if (!pool) return;
      try {
        // Account changes must be durable before the API reports success.
        // A background-only write could be lost when the service restarts.
        await pool.query(
          `INSERT INTO rotator_settings (key, value, updated_at)
            VALUES ($1, $2, CURRENT_TIMESTAMP)
            ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
          [key, latest],
        );
      } catch (err) {
        console.error(`Failed to save ${key} to database: ${err}`);
        this.enqueueRetry(key, latest);
        throw err;
      }
    });
  }

  private enqueueRetry(key: string, value: string): void {
    const existing = this.pendingRetries.get(key);
    // If the key is already pending, keep the higher attempt count
    // but always use the latest value.
    this.pendingRetries.set(key, {
      value,
      attempts: existing ? existing.attempts + 1 : 1,
    });
    this.scheduleRetryFlush();
  }

  private scheduleRetryFlush(): void {
    if (this.retryTimer) return; // already scheduled
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flushPendingRetries();
    }, RETRY_DELAY_MS);
    // Don't keep the process alive just for retries
    this.retryTimer.unref();
  }

  private async flushPendingRetries(): Promise<void> {
    if (!this.pool || this.pendingRetries.size === 0) return;

    const entries = [...this.pendingRetries.entries()];
    this.pendingRetries.clear();

    for (const [key, pending] of entries) {
      try {
        await this.pool.query(
          `INSERT INTO rotator_settings (key, value, updated_at)
           VALUES ($1, $2, CURRENT_TIMESTAMP)
           ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
          [key, pending.value],
        );
      } catch (err) {
        if (pending.attempts >= MAX_RETRIES) {
          console.error(
            `Giving up on persisting ${key} after ${pending.attempts} failed attempts: ${err}`,
          );
        } else {
          console.error(
            `Retry ${pending.attempts}/${MAX_RETRIES} failed for ${key}: ${err}`,
          );
          this.pendingRetries.set(key, {
            value: pending.value,
            attempts: pending.attempts + 1,
          });
        }
      }
    }

    // If there are still entries that failed, schedule another round
    if (this.pendingRetries.size > 0) {
      this.scheduleRetryFlush();
    }
  }

  async close(): Promise<void> {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.pool) {
      // Final attempt to drain any pending retries before shutdown
      await this.flushPendingRetries();
      await this.pool.end();
      this.pool = null;
    }
    this.initialized = false;
  }
}

// ----- FileSettingsRepository -----
//
// Reads and writes directly to disk files.  Keeps an in-memory cache so
// repeated `get()` calls within the same process don't re-parse from disk.

export class FileSettingsRepository implements ISettingsRepository {
  private cache = new Map<string, string>();
  private writes = new KeyedWriteQueue();

  async init(): Promise<void> {
    // Pre-load all known keys from their disk files into cache
    for (const [key, spec] of Object.entries(DISK_FILES)) {
      try {
        const path = join(getConfigDir(), spec.filename);
        const content = await readTextFile(path);
        if (!content) continue;
        this.cache.set(key, spec.trim ? content.trim() : content);
      } catch {
        // Ignore unreadable files — callers handle missing data
      }
    }
  }

  get(key: string): string | null {
    return this.cache.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.cache.set(key, value);

    // Persist to disk
    const path = diskPath(key);
    if (!path) return;
    await this.writes.run(key, () => this.writeToDisk(key, path));
  }

  private async writeToDisk(key: string, path: string): Promise<void> {
    const value = this.cache.get(key);
    if (value === undefined) return;
    const spec = DISK_FILES[key];
    try {
      if (spec?.backup) {
        await backupFile(path, spec.filename.replace(".json", ""));
      }
      if (spec?.trim) {
        // Plain text file (e.g. admin_token)
        await writeTextFileAtomic(path, value);
      } else {
        // JSON files — try to pretty-print, fall back to raw string
        try {
          const parsed = JSON.parse(value);
          await writeJsonFileAtomic(path, parsed);
        } catch {
          await writeTextFileAtomic(path, value);
        }
      }
      // Apply restricted permissions when specified (e.g. secrets)
      if (spec?.mode) {
        try {
          await chmod(path, spec.mode);
        } catch {
          // Best effort: some filesystems (e.g. Windows) don't support POSIX perms.
        }
      }
    } catch (err) {
      console.error(`Failed to save ${key} to disk (${path}): ${err}`);
      throw err;
    }
  }

  async close(): Promise<void> {
    // no-op — callers await each write before closing
  }
}
