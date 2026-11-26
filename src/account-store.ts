import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAccountsPath } from "./paths.js";
import type { AccountConfig, ProviderCredential } from "./types.js";
import { writeJsonFileAtomic } from "./storage.js";
import {
  loadConfig,
  loadOrCreateAccountsConfig,
  saveAccountsConfig,
} from "./config-storage.js";
import { applyConfigDefaults, getDefaultConfig } from "./config-defaults.js";
import { hasCredential, sortAccountCredentials } from "./providers/credential-helpers.js";
import { normalizeAccountConfig } from "./config-normalize.js";
import { validateAccountConfig } from "./validators.js";

export {
  loadConfig,
  loadOrCreateAccountsConfig,
  saveAccountsConfig,
  applyConfigDefaults,
  getDefaultConfig,
};

export { normalizeAccountConfig } from "./config-normalize.js";

const ACCOUNTS_FILE = getAccountsPath();
const PI_DIR = join(homedir(), ".pi", "agent");
const PI_MODELS_FILE = join(PI_DIR, "models.json");
const PI_AUTH_FILE = join(PI_DIR, "auth.json");
const TOKEN_USAGE_FILE = join(join(ACCOUNTS_FILE, ".."), "token-usage.json");

export function getTokenUsagePath(): string {
  return TOKEN_USAGE_FILE;
}

// Reasonable upper bounds on per-account fields. These are defensive
// limits to prevent a malicious or buggy caller from growing
// accounts.json without bound, which would slow every subsequent
// saveState. The numbers are well above any realistic real value.
export const MAX_EMAIL_LENGTH = 254; // RFC 5321
export const MAX_LABEL_LENGTH = 100;
export const MAX_PROJECT_ID_LENGTH = 100;
export const MAX_REFRESH_TOKEN_LENGTH = 4096;
export const MAX_PROXY_URL_LENGTH = 2048;
export const MAX_PROVIDER_ACCOUNT_ID_LENGTH = 256;

function validateAccountConfigLengths(entry: AccountConfig): void {
  const checks: Array<[string, number]> = [
    ["email", MAX_EMAIL_LENGTH],
    ["label", MAX_LABEL_LENGTH],
    ["projectId", MAX_PROJECT_ID_LENGTH],
    ["refreshToken", MAX_REFRESH_TOKEN_LENGTH],
    ["codexRefreshToken", MAX_REFRESH_TOKEN_LENGTH],
    ["codexAccountId", MAX_PROVIDER_ACCOUNT_ID_LENGTH],
    ["proxyUrl", MAX_PROXY_URL_LENGTH],
  ];
  for (const [field, max] of checks) {
    const value = entry[field as keyof AccountConfig];
    if (typeof value === "string" && value.length > max) {
      throw new Error(
        `Account ${field} exceeds maximum length ${max} (got ${value.length}). ` +
          `This usually indicates a malformed input — refusing to write to accounts.json.`,
      );
    }
  }
  validateCredentialLengths(entry.credentials);
}

function validateCredentialLengths(
  credentials: AccountConfig["credentials"],
): void {
  if (!Array.isArray(credentials)) return;
  for (const cred of credentials) {
    if (typeof cred.apiKey === "string" && cred.apiKey.length > MAX_REFRESH_TOKEN_LENGTH) {
      throw new Error(`Credential apiKey for ${cred.provider} exceeds maximum length`);
    }
    if (typeof cred.projectId === "string" && cred.projectId.length > MAX_PROJECT_ID_LENGTH) {
      throw new Error(`Credential projectId for ${cred.provider} exceeds maximum length`);
    }
    if (typeof cred.refreshToken === "string" && cred.refreshToken.length > MAX_REFRESH_TOKEN_LENGTH) {
      throw new Error(`Credential refreshToken for ${cred.provider} exceeds maximum length`);
    }
    if (typeof cred.proxyUrl === "string" && cred.proxyUrl.length > MAX_PROXY_URL_LENGTH) {
      throw new Error(`Credential proxyUrl for ${cred.provider} exceeds maximum length`);
    }
    if (typeof cred.providerAccountId === "string" && cred.providerAccountId.length > MAX_PROVIDER_ACCOUNT_ID_LENGTH) {
      throw new Error(`Credential providerAccountId for ${cred.provider} exceeds maximum length`);
    }
  }
}

export { validateAccountConfigLengths };

function stripUndefinedFields<T extends object>(obj: T): Partial<T> {
  const clean: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      (clean as Record<string, unknown>)[key] = value;
    }
  }
  return clean;
}

export function mergeCredentials(
  existing: AccountConfig["credentials"] | undefined,
  incoming: AccountConfig["credentials"] | undefined,
): AccountConfig["credentials"] {
  const out: NonNullable<AccountConfig["credentials"]> = [];
  const incomingByProvider = new Map((incoming ?? []).map((cred) => [cred.provider, cred]));
  const seen = new Set<string>();
  for (const cred of existing ?? []) {
    if (seen.has(cred.provider)) continue;
    seen.add(cred.provider);
    const incomingCredential = incomingByProvider.get(cred.provider);
    out.push(incomingCredential ? { ...cred, ...stripUndefinedFields(incomingCredential) } : cred);
    incomingByProvider.delete(cred.provider);
  }
  for (const cred of incomingByProvider.values()) {
    out.push(stripUndefinedFields(cred) as NonNullable<AccountConfig["credentials"]>[number]);
  }
  return sortAccountCredentials(out);
}

function assertCodexIdentityCompatible(
  existing: AccountConfig,
  incoming: AccountConfig,
): void {
  const existingCredential = normalizeAccountConfig(existing).credentials?.find(
    (credential) => credential.provider === "openai-codex",
  );
  const incomingCredential = incoming.credentials?.find(
    (credential) => credential.provider === "openai-codex",
  );
  const oldId = existingCredential?.providerAccountId;
  const newId = incomingCredential?.providerAccountId;
  if (oldId && newId && oldId !== newId) {
    throw new Error(
      `Codex credential conflict for ${incoming.email}: the email is already bound to a different providerAccountId; refusing to overwrite it`,
    );
  }
}

export async function addAccountToConfig(
  entry: AccountConfig,
): Promise<{ isNew: boolean }> {
  validateAccountConfigLengths(entry);
  const entryNorm = normalizeAccountConfig(entry);
  const config = loadOrCreateAccountsConfig();
  const existing = config.accounts.find(
    (a) => a.email === entryNorm.email || a.email.toLowerCase() === entryNorm.email.toLowerCase(),
  );
  if (existing) {
    assertCodexIdentityCompatible(existing, entryNorm);
    validateCredentialLengths(entryNorm.credentials);
    const existingNorm = normalizeAccountConfig(existing);
    config.accounts[config.accounts.indexOf(existing)] = {
      ...existingNorm,
      ...entryNorm,
      credentials: mergeCredentials(existingNorm.credentials, entryNorm.credentials),
    };
    await saveAccountsConfig(config);
    return { isNew: false };
  }

  config.accounts.push(entryNorm);
  await saveAccountsConfig(config);
  return { isNew: true };
}

export interface AccountImportResult {
  added: number;
  updated: number;
  unchanged: number;
  skipped: number;
  total: number;
  errors: string[];
}

function isImportRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function importEntries(input: unknown): unknown[] {
  if (Array.isArray(input)) return input;
  if (isImportRecord(input) && Array.isArray(input.accounts)) {
    return input.accounts;
  }
  if (isImportRecord(input) && "email" in input) return [input];
  throw new Error(
    "Invalid accounts import format: expected a JSON array or an object with an accounts array",
  );
}

function firstImportString(
  record: Record<string, unknown>,
  keys: string[],
  path: string,
  errors: string[],
): string | undefined {
  for (const key of keys) {
    if (!(key in record)) continue;
    const value = record[key];
    if (typeof value !== "string" || value.trim() === "") {
      errors.push(`${path}.${key} must be a non-empty string`);
      return undefined;
    }
    return value.trim();
  }
  return undefined;
}

function importedGoogleCredential(
  record: Record<string, unknown>,
  path: string,
  errors: string[],
): ProviderCredential | null {
  const nested = Array.isArray(record.credentials)
    ? record.credentials.find(
        (value) =>
          isImportRecord(value) &&
          (value.provider === "google-antigravity" || value.provider === "google"),
      )
    : undefined;
  const nestedRecord = isImportRecord(nested) ? nested : undefined;
  const source = nestedRecord ? { ...nestedRecord, ...record } : record;
  const refreshToken = firstImportString(
    source,
    ["refreshToken", "refresh_token"],
    path,
    errors,
  );
  const projectId = firstImportString(
    source,
    ["projectId", "project_id"],
    path,
    errors,
  );
  if (!refreshToken) errors.push(`${path}.refreshToken is required`);
  if (!projectId) {
    errors.push(
      `${path}.projectId is required; refusing to invent a shared default project`,
    );
  }
  if (!refreshToken || !projectId) return null;

  const projectSource = source.projectSource ?? source.project_source;
  if (
    projectSource !== undefined &&
    projectSource !== "google" &&
    projectSource !== "manual"
  ) {
    errors.push(`${path}.projectSource must be "google" or "manual"`);
    return null;
  }
  const proxyUrl = firstImportString(
    source,
    ["proxyUrl", "proxy_url", "proxy"],
    path,
    errors,
  );
  return {
    provider: "google-antigravity",
    refreshToken,
    projectId,
    ...(proxyUrl !== undefined ? { proxyUrl } : {}),
    ...(projectSource !== undefined ? { projectSource } : {}),
  };
}

function parseImportedGoogleAccount(
  value: unknown,
  index: number,
): { account: AccountConfig | null; errors: string[] } {
  const path = `accounts[${index}]`;
  if (!isImportRecord(value)) {
    return { account: null, errors: [`${path} must be an object`] };
  }
  const errors: string[] = [];
  const email = firstImportString(value, ["email"], path, errors);
  if (value.label !== undefined && typeof value.label !== "string") {
    errors.push(`${path}.label must be a string`);
  }
  const provider = value.provider;
  if (
    provider !== undefined &&
    provider !== "google-antigravity" &&
    provider !== "google"
  ) {
    errors.push(`${path}.provider must identify Google Antigravity`);
  }
  const credential = importedGoogleCredential(value, path, errors);
  if (!email || !credential || errors.length > 0) {
    return { account: null, errors };
  }

  const account: AccountConfig = {
    email,
    provider: "google-antigravity",
    refreshToken: credential.refreshToken,
    projectId: credential.projectId,
    ...(credential.projectSource
      ? { projectSource: credential.projectSource }
      : {}),
    credentials: [credential],
    label:
      typeof value.label === "string" && value.label.trim() !== ""
        ? value.label.trim()
        : email.split("@")[0],
  };
  for (const key of ["type", "tier", "familyManager"] as const) {
    if (value[key] !== undefined) {
      (account as unknown as Record<string, unknown>)[key] = value[key];
    }
  }

  const validation = validateAccountConfig(account, path);
  if (!validation.ok) return { account: null, errors: validation.errors };
  try {
    validateAccountConfigLengths(account);
  } catch (err) {
    return {
      account: null,
      errors: [err instanceof Error ? err.message : `${path} is invalid`],
    };
  }
  return { account, errors: [] };
}

function upsertImportedGoogleAccount(
  config: ReturnType<typeof loadOrCreateAccountsConfig>,
  incoming: AccountConfig,
): "added" | "updated" | "unchanged" {
  const existing = config.accounts.find((entry) => entry.email === incoming.email);
  if (!existing) {
    config.accounts.push(incoming);
    return "added";
  }

  const normalized = normalizeAccountConfig(existing);
  const incomingCredential = incoming.credentials![0];
  const existingCredentials = normalized.credentials ?? [];
  const existingGoogle = existingCredentials.findIndex(
    (credential) => credential.provider === "google-antigravity",
  );
  const mergedCredential =
    existingGoogle >= 0
      ? {
          ...existingCredentials[existingGoogle],
          ...incomingCredential,
        }
      : incomingCredential;
  const mergedCredentials =
    existingGoogle >= 0
      ? existingCredentials.map((credential, index) =>
          index === existingGoogle ? mergedCredential : credential,
        )
      : [incomingCredential, ...existingCredentials];
  const next: AccountConfig = {
    ...normalized,
    provider: normalized.provider ?? "google-antigravity",
    refreshToken: incoming.refreshToken,
    projectId: incoming.projectId,
    ...(incoming.projectSource
      ? { projectSource: incoming.projectSource }
      : {}),
    credentials: mergedCredentials,
    ...(incoming.label ? { label: incoming.label } : {}),
    ...(incoming.type !== undefined ? { type: incoming.type } : {}),
    ...(incoming.tier !== undefined ? { tier: incoming.tier } : {}),
    ...(incoming.familyManager !== undefined
      ? { familyManager: incoming.familyManager }
      : {}),
  };
  validateAccountConfigLengths(next);
  const changed = JSON.stringify(existing) !== JSON.stringify(next);
  config.accounts[config.accounts.indexOf(existing)] = next;
  return changed ? "updated" : "unchanged";
}

/**
 * Import Google Antigravity/Pi account exports into the parent-account model.
 * The importer accepts camelCase and snake_case token/project fields, keeps
 * Google credentials ahead of an existing Ollama credential, and never
 * invents a project id when the source omits one.
 */
export async function importAccountsToConfig(
  input: unknown,
): Promise<AccountImportResult> {
  const entries = importEntries(input);
  const config = loadOrCreateAccountsConfig();
  const result: AccountImportResult = {
    added: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    total: entries.length,
    errors: [],
  };

  for (let index = 0; index < entries.length; index++) {
    const parsed = parseImportedGoogleAccount(entries[index], index);
    if (!parsed.account) {
      result.skipped++;
      result.errors.push(...parsed.errors);
      continue;
    }
    const outcome = upsertImportedGoogleAccount(config, parsed.account);
    result[outcome]++;
  }

  if (result.added + result.updated > 0) {
    await saveAccountsConfig(config);
  }
  return result;
}

export async function removeAccountFromConfig(email: string): Promise<boolean> {
  const config = loadOrCreateAccountsConfig();
  const idx = config.accounts.findIndex((a) => a.email === email);
  if (idx < 0) return false;
  config.accounts.splice(idx, 1);
  await saveAccountsConfig(config);
  return true;
}

function legacyOllamaRotatorAccountsFile(): string {
  const envDir = process.env.OLLAMA_ROTATOR_DIR;
  return join(envDir ?? homedir(), envDir ? "" : ".ollama-rotator", "accounts.json");
}

/**
 * Import Ollama Cloud accounts from a legacy ~/ollama-rotator accounts.json
 * (the predecessor product) into the parent-account model: each entry's
 * API key becomes an `ollama` credential, merged onto the account with the
 * same email (the account itself is created when the email is unknown).
 *
 * Returns the number of credentials imported (0 when no legacy config exists).
 */
export async function importLegacyOllamaRotatorAccounts(
  legacyFile = legacyOllamaRotatorAccountsFile(),
): Promise<number> {
  let raw: string;
  try {
    raw = await readFile(legacyFile, "utf-8");
  } catch {
    // No legacy config — nothing to do.
    return 0;
  }

  let entries: unknown;
  try {
    entries = JSON.parse(raw);
  } catch {
    console.warn(`Skipping legacy ${legacyFile}: not valid JSON`);
    return 0;
  }
  // The predecessor's accounts.json is the full Config object
  // ({proxyPort, routingPolicy, ..., accounts: [...]}); a bare array of
  // accounts is accepted too for simplicity.
  const rawAccounts = Array.isArray(entries)
    ? entries
    : typeof entries === "object" &&
        entries !== null &&
        Array.isArray((entries as { accounts?: unknown }).accounts)
      ? (entries as { accounts: unknown[] }).accounts
      : [];
  if (rawAccounts.length === 0) return 0;

  const config = loadOrCreateAccountsConfig();
  let imported = 0;
  let merged = 0;
  let added = 0;

  for (const entry of rawAccounts) {
    if (typeof entry !== "object" || entry === null) continue;
    const { email, apiKey, label, tier, type } = entry as Record<string, unknown>;
    if (typeof email !== "string" || email.length === 0) continue;
    if (typeof apiKey !== "string" || apiKey.trim() === "") {
      console.warn(`  Skipping legacy account ${email}: missing apiKey`);
      continue;
    }

    const credential: ProviderCredential = {
      provider: "ollama",
      apiKey: apiKey.trim(),
    };
    const account: AccountConfig = {
      email,
      credentials: [credential],
    };
    if (typeof label === "string" && label !== "") account.label = label;
    if (typeof tier === "string") account.tier = tier as AccountConfig["tier"];
    if (typeof type === "string") account.type = type as AccountConfig["type"];
    try {
      validateAccountConfigLengths(account);
    } catch {
      console.warn(`  Skipping legacy account ${email}: invalid fields`);
      continue;
    }

    const existing = config.accounts.find((a) => a.email === email);
    if (existing) {
      const normalized = normalizeAccountConfig(existing);
      if (hasCredential(normalized, "ollama")) {
        // Credential already present (e.g. re-import after a previous run).
        continue;
      }
      const idx = config.accounts.indexOf(existing);
      config.accounts[idx] = {
        ...normalized,
        credentials: [...(normalized.credentials ?? []), credential],
      };
      merged += 1;
    } else {
      config.accounts.push(account);
      added += 1;
    }
    imported += 1;
  }

  if (imported > 0) {
    await saveAccountsConfig(config);
    console.log(
      `Imported ${imported} Ollama Cloud credential(s) from legacy ${legacyFile} ` +
        `(${added} new account(s), ${merged} merged into existing account(s))`,
    );
  }
  return imported;
}

export async function ensurePiModelsConfig(): Promise<void> {
  await mkdir(PI_DIR, { recursive: true });

  let models: Record<string, unknown> = {};
  try {
    models = JSON.parse(await readFile(PI_MODELS_FILE, "utf-8"));
  } catch {
    // Missing or corrupted, will overwrite.
  }

  const providers = (models.providers || {}) as Record<
    string,
    Record<string, unknown>
  >;
  const antigravity = providers["google-antigravity"] || {};

  if (antigravity.baseUrl === "http://localhost:51200") {
    return;
  }

  antigravity.baseUrl = "http://localhost:51200";
  providers["google-antigravity"] = antigravity;
  models.providers = providers;

  await writeJsonFileAtomic(PI_MODELS_FILE, models);
  console.log(`  Updated ${PI_MODELS_FILE}`);
}

export async function ensurePiAuthConfig(): Promise<void> {
  await mkdir(PI_DIR, { recursive: true });

  let auth: Record<string, unknown> = {};
  try {
    auth = JSON.parse(await readFile(PI_AUTH_FILE, "utf-8"));
  } catch {
    // Missing or corrupted, will overwrite.
  }

  const existing = auth["google-antigravity"] as
    | Record<string, unknown>
    | undefined;
  if (existing?.type === "oauth" && existing?.refresh === "proxy-managed") {
    return;
  }

  auth["google-antigravity"] = {
    type: "oauth",
    refresh: "proxy-managed",
    access: "proxy-managed",
    expires: 32503680000000,
    projectId: "proxy-managed",
  };

  await writeJsonFileAtomic(PI_AUTH_FILE, auth);
  console.log(`  Updated ${PI_AUTH_FILE}`);
}
