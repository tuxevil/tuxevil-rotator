// Convenience façade over the settings repository.
//
// Maintains full backward compatibility with the previous module API while
// delegating all persistence to an ISettingsRepository implementation.
// Both PostgresSettingsRepository and FileSettingsRepository are fully
// self-contained — callers no longer need to branch on isDbConfigured().

import type { Config, PersistedState, TokenUsageTiered } from "./types.js";
import type { PersistedResponsesStore } from "./responses-store.js";
import { validateConfig } from "./validators.js";
import { rotatorEnv } from "./env.js";
import { applyConfigDefaults } from "./config-defaults.js";
import {
  decryptAccountsInConfig,
  decryptTypeSafeRoutingInConfig,
  encryptAccountsInConfig,
  encryptTypeSafeRoutingInConfig,
} from "./token-encryption.js";
import {
  type ISettingsRepository,
  PostgresSettingsRepository,
  FileSettingsRepository,
} from "./settings-repository.js";

export type { PersistedResponsesStore } from "./responses-store.js";

// ----- Repository strategy -----

function createRepository(): ISettingsRepository {
  if (rotatorEnv("DATABASE_URL") || process.env.DATABASE_URL) {
    return new PostgresSettingsRepository();
  }
  return new FileSettingsRepository();
}

const repository: ISettingsRepository = createRepository();

let initialized = false;

function assertInitialized(): void {
  if (!initialized) {
    throw new Error(
      "db-store: repository not initialized. Call initDb() before accessing settings.",
    );
  }
}

// ----- Backward-compatible public API -----

/**
 * Whether persistence is backed by PostgreSQL (true) or disk files (false).
 * Callers that need to know the storage backend (e.g. for diagnostics or
 * doctor output) can use this, but most callers should NOT need to branch
 * on this — both repositories handle their own I/O.
 */
export function isDbConfigured(): boolean {
  return !!(rotatorEnv("DATABASE_URL") || process.env.DATABASE_URL);
}

export async function initDb(): Promise<void> {
  await repository.init();
  initialized = true;
}

export function getDbPool() {
  if (repository instanceof PostgresSettingsRepository) {
    return repository.getPool();
  }
  return null;
}

export async function queryDb<R extends import("pg").QueryResultRow = import("pg").QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<import("pg").QueryResult<R>> {
  assertInitialized();
  if (repository instanceof PostgresSettingsRepository) {
    return repository.query<R>(text, params);
  }
  throw new Error("PostgreSQL database is not configured");
}

export async function closeDb(): Promise<void> {
  await repository.close();
  initialized = false;
}

// --- Accounts config ---

export function getCachedConfig(): Config | null {
  assertInitialized();
  const raw = repository.get("accounts_json");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const validation = validateConfig(parsed);
    if (validation.ok && validation.value) {
      const withDefaults = applyConfigDefaults(validation.value);
      const accountsResult = decryptAccountsInConfig(withDefaults);
      const typesafeResult = decryptTypeSafeRoutingInConfig(accountsResult.config);
      const decryptedConfig = typesafeResult.config;
      if (accountsResult.migrated || typesafeResult.migrated) {
        void setCachedConfig(decryptedConfig).catch((err) => {
          console.error(`Failed to persist migrated accounts config: ${err}`);
        });
      }
      return decryptedConfig;
    }
  } catch (err) {
    console.error(`Failed to parse accounts config from repository: ${err}`);
  }
  return null;
}

export async function setCachedConfig(config: Config): Promise<void> {
  assertInitialized();
  const withDefaults = applyConfigDefaults(config);
  const encryptedConfig = encryptTypeSafeRoutingInConfig(
    encryptAccountsInConfig(withDefaults),
  );
  await repository.set("accounts_json", JSON.stringify(encryptedConfig, null, 2));
}

// --- Admin token ---

export function getCachedAdminToken(): string | null {
  assertInitialized();
  const raw = repository.get("admin_token");
  return raw ? raw.trim() : null;
}

export async function setCachedAdminToken(token: string): Promise<void> {
  assertInitialized();
  await repository.set("admin_token", token.trim());
}

// --- Rotator state ---

export function getCachedState(): PersistedState | null {
  assertInitialized();
  const raw = repository.get("rotator_state");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PersistedState;
  } catch (err) {
    console.error(`Failed to parse rotator state from repository: ${err}`);
    return null;
  }
}

export async function setCachedState(state: PersistedState): Promise<void> {
  assertInitialized();
  await repository.set("rotator_state", JSON.stringify(state));
}

// --- Token usage ---

export function getCachedTokenUsage(): TokenUsageTiered | null {
  assertInitialized();
  const raw = repository.get("token_usage");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TokenUsageTiered;
  } catch (err) {
    console.error(`Failed to parse token usage from repository: ${err}`);
    return null;
  }
}

export async function setCachedTokenUsage(usage: TokenUsageTiered): Promise<void> {
  assertInitialized();
  await repository.set("token_usage", JSON.stringify(usage));
}

// --- Responses store ---

export function getCachedResponsesStore(): PersistedResponsesStore | null {
  assertInitialized();
  const raw = repository.get("responses_store");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PersistedResponsesStore;
  } catch (err) {
    console.error(`Failed to parse responses store from repository: ${err}`);
    return null;
  }
}

export async function setCachedResponsesStore(
  store: PersistedResponsesStore,
): Promise<void> {
  assertInitialized();
  await repository.set("responses_store", JSON.stringify(store));
}
