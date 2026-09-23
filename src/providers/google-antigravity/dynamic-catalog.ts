// Dynamic Google Antigravity model availability discovered during quota polling.

import {
  getStaticModelSpec,
  type ModelSpec,
} from "../../compat/model-specs.js";
import {
  QUOTA_MODEL_KEYS,
  type GoogleQuotaResponse,
  type PersistedDynamicModelOwnership,
} from "../../types.js";

export interface DynamicModelEntry {
  id: string;
  family: string;
  ctx: number;
  quotaPool: string;
  multimodal: boolean;
  tools: boolean;
  maxOutputTokens: number;
  thinkingBudget: number;
  minThinkingBudget?: number;
  isThinking: boolean;
  isTiered: boolean;
  displayName?: string;
}

const DEFAULT_ACCOUNT_KEY = "__default__";
const RESERVED_QUOTA_MODEL_IDS = new Set(
  Object.values(QUOTA_MODEL_KEYS).map(({ key }) => key.toLowerCase()),
);

type GoogleModelInfo = GoogleQuotaResponse["models"][string];
type ActiveAccount = string | { id: string; generation: string };
type PersistedOwnershipAccount = {
  id: string;
  credentialGenerationFingerprint: string;
};
interface ActiveAccountGeneration {
  credentialGeneration: string | null;
  epoch: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeModelId(value: string): boolean {
  const lower = value.toLowerCase();
  return value.length <= 256 &&
    /^[a-z0-9][a-z0-9._:/-]*$/i.test(value) &&
    lower !== "__proto__" &&
    lower !== "prototype" &&
    lower !== "constructor";
}

function isDiscoverableModelId(value: string): boolean {
  const id = value.trim();
  const lower = id.toLowerCase();
  return isSafeModelId(id) &&
    !RESERVED_QUOTA_MODEL_IDS.has(lower) &&
    !lower.startsWith("chat_") &&
    !lower.startsWith("tab_") &&
    (!lower.startsWith("gemini-3.5-") || lower === "gemini-3.5-flash-lite");
}

/** Validate and sanitize the untrusted runtime catalog response. */
export function parseGoogleQuotaResponse(
  value: unknown,
): GoogleQuotaResponse | null {
  if (!isRecord(value) || !isRecord(value.models)) return null;

  const models = Object.create(null) as GoogleQuotaResponse["models"];
  let rawEntryCount = 0;
  let validEntryCount = 0;
  for (const [rawId, rawInfo] of Object.entries(value.models)) {
    rawEntryCount++;
    const id = rawId.trim();
    if (!isSafeModelId(id) || !isRecord(rawInfo)) continue;
    validEntryCount++;

    const info: GoogleModelInfo = {};
    if (typeof rawInfo.displayName === "string" && rawInfo.displayName.trim()) {
      info.displayName = rawInfo.displayName.trim();
    }
    for (const field of ["maxTokens", "maxOutputTokens"] as const) {
      const candidate = rawInfo[field];
      if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
        info[field] = candidate;
      }
    }
    if (
      typeof rawInfo.thinkingBudget === "number" &&
      Number.isFinite(rawInfo.thinkingBudget) &&
      (rawInfo.thinkingBudget === -1 || rawInfo.thinkingBudget >= 0)
    ) {
      info.thinkingBudget = rawInfo.thinkingBudget;
    }
    if (
      typeof rawInfo.minThinkingBudget === "number" &&
      Number.isFinite(rawInfo.minThinkingBudget) &&
      rawInfo.minThinkingBudget >= 0
    ) {
      info.minThinkingBudget = rawInfo.minThinkingBudget;
    }
    for (
      const field of [
        "supportsThinking",
        "supportsImages",
        "supportsVideo",
      ] as const
    ) {
      if (typeof rawInfo[field] === "boolean") info[field] = rawInfo[field];
    }
    if (isRecord(rawInfo.quotaInfo)) {
      const quotaInfo: NonNullable<GoogleModelInfo["quotaInfo"]> = {};
      const remaining = rawInfo.quotaInfo.remainingFraction;
      if (
        typeof remaining === "number" &&
        Number.isFinite(remaining) &&
        remaining >= 0 &&
        remaining <= 1
      ) {
        quotaInfo.remainingFraction = remaining;
      }
      const resetTime = rawInfo.quotaInfo.resetTime;
      if (typeof resetTime === "string" && resetTime.trim()) {
        quotaInfo.resetTime = resetTime;
      }
      if (Object.keys(quotaInfo).length > 0) info.quotaInfo = quotaInfo;
    }
    models[id] = info;
  }

  // An explicitly empty catalog is a valid snapshot. A non-empty catalog
  // containing no usable entries is ambiguous, so retain the last good one.
  if (rawEntryCount > 0 && validEntryCount === 0) return null;

  const parsed: GoogleQuotaResponse = { models };
  if (
    typeof value.defaultAgentModelId === "string" &&
    isSafeModelId(value.defaultAgentModelId.trim())
  ) {
    parsed.defaultAgentModelId = value.defaultAgentModelId.trim();
  }
  if (isRecord(value.tieredModelIds)) {
    const tieredModelIds = Object.create(null) as Record<string, string[]>;
    for (const [tier, rawIds] of Object.entries(value.tieredModelIds)) {
      if (!Array.isArray(rawIds)) continue;
      const ids = rawIds
        .filter((id): id is string => typeof id === "string")
        .map((id) => id.trim())
        .filter(isSafeModelId);
      if (ids.length > 0) tieredModelIds[tier] = ids;
    }
    if (Object.keys(tieredModelIds).length > 0) {
      parsed.tieredModelIds = tieredModelIds;
    }
  }
  return parsed;
}

function accountKey(value: string): string {
  return value.trim();
}

function familyDefaults(
  family: string,
): Pick<
  DynamicModelEntry,
  "ctx" | "multimodal" | "tools" | "maxOutputTokens" | "thinkingBudget" | "isThinking"
> {
  if (family === "gpt-oss") {
    return {
      ctx: 131_072,
      multimodal: false,
      tools: true,
      maxOutputTokens: 32_768,
      thinkingBudget: 8_192,
      isThinking: true,
    };
  }
  if (family.includes("claude")) {
    return {
      ctx: 1_000_000,
      multimodal: true,
      tools: true,
      maxOutputTokens: 64_000,
      thinkingBudget: 32_768,
      isThinking: true,
    };
  }
  if (family.includes("gemini")) {
    return {
      ctx: 1_000_000,
      multimodal: true,
      tools: true,
      maxOutputTokens: 65_536,
      thinkingBudget: 24_576,
      isThinking: true,
    };
  }
  return {
    ctx: 128_000,
    multimodal: false,
    tools: true,
    maxOutputTokens: 65_536,
    thinkingBudget: 24_576,
    isThinking: false,
  };
}

export class DynamicModelRegistry {
  private static instance: DynamicModelRegistry | null = null;
  private accountModels = new Map<string, Map<string, DynamicModelEntry>>();
  private defaultAgentModelIds = new Map<string, string>();
  private discoveredModels = new Map<
    string,
    Pick<DynamicModelEntry, "id" | "quotaPool">
  >();
  private accountModelOwnership = new Map<string, Set<string>>();
  private ownershipScopedModels = new Set<string>();
  private activeAccountGenerations: Map<
    string,
    ActiveAccountGeneration
  > | null = null;
  private nextAccountEpoch = 0;

  static getInstance(): DynamicModelRegistry {
    DynamicModelRegistry.instance ??= new DynamicModelRegistry();
    return DynamicModelRegistry.instance;
  }

  /** Reset dynamic account state (primarily for tests). */
  reset(): void {
    this.accountModels.clear();
    this.defaultAgentModelIds.clear();
    this.discoveredModels.clear();
    this.accountModelOwnership.clear();
    this.ownershipScopedModels.clear();
    this.activeAccountGenerations = null;
    this.nextAccountEpoch = 0;
  }

  /** Derive the model family and quota pool from a model ID string. */
  static inferFamilyAndPool(modelId: string): { family: string; quotaPool: string } {
    const lower = modelId.toLowerCase();
    if (lower.includes("claude") || lower.includes("sonnet") || lower.includes("opus")) {
      const match = lower.match(/(claude-[a-z0-9.-]+)/);
      return { family: match?.[1] ?? "claude", quotaPool: "claude" };
    }
    if (lower.includes("gpt-oss")) {
      return { family: "gpt-oss", quotaPool: "claude" };
    }
    if (lower.includes("gemini")) {
      const match = lower.match(/(gemini-[0-9.]+-?[a-z]*)/);
      return { family: match?.[1] ?? "gemini", quotaPool: "gemini" };
    }
    return { family: lower, quotaPool: "gemini" };
  }

  /** Replace one account's advertised models with its latest successful response. */
  updateFromEndpointResponse(
    value: unknown,
    accountId = DEFAULT_ACCOUNT_KEY,
    credentialGeneration?: string,
    accountEpoch?: number,
  ): number {
    const data = parseGoogleQuotaResponse(value);
    if (!data) return 0;

    const key = accountKey(accountId);
    if (
      !this.isAccountGenerationActive(
        key,
        credentialGeneration,
        accountEpoch,
      )
    ) return 0;
    const previous = this.accountModels.get(key);
    const knownBefore = new Set(this.getAllModels().map((model) => model.id.toLowerCase()));
    const next = new Map<string, DynamicModelEntry>();
    const tieredIds = new Set(
      Object.values(data.tieredModelIds ?? {}).flat().map((id) => id.trim().toLowerCase()),
    );
    let newModelsCount = 0;

    if (data.defaultAgentModelId) {
      this.defaultAgentModelIds.delete(key);
      this.defaultAgentModelIds.set(key, data.defaultAgentModelId);
    } else {
      this.defaultAgentModelIds.delete(key);
    }

    for (const [rawId, info] of Object.entries(data.models)) {
      const normalizedId = rawId.trim();
      const lowerId = normalizedId.toLowerCase();
      if (!isDiscoverableModelId(normalizedId)) continue;

      const { family, quotaPool } = DynamicModelRegistry.inferFamilyAndPool(normalizedId);
      const familySpec = familyDefaults(family);
      const staticSpec = getStaticModelSpec(normalizedId);
      const defaults = previous?.get(lowerId) ?? {
        ...familySpec,
        ...(staticSpec
          ? {
              ctx: staticSpec.contextWindow ?? familySpec.ctx,
              maxOutputTokens: staticSpec.maxOutputTokens,
              thinkingBudget: staticSpec.thinkingBudget,
              minThinkingBudget: staticSpec.minThinkingBudget,
              isThinking: staticSpec.isThinking,
            }
          : {}),
      };
      const isTiered = lowerId.includes("-tiered") || tieredIds.has(lowerId);
      const hasThinkingBudget = typeof info.thinkingBudget === "number";
      const thinkingBudget = hasThinkingBudget
        ? info.thinkingBudget!
        : isTiered
          ? -1
          : defaults.thinkingBudget;
      const isThinking = typeof info.supportsThinking === "boolean"
        ? info.supportsThinking
        : hasThinkingBudget
          ? thinkingBudget !== 0
          : defaults.isThinking;
      const hasMultimodalMetadata =
        typeof info.supportsImages === "boolean" || typeof info.supportsVideo === "boolean";

      next.set(lowerId, {
        id: normalizedId,
        family,
        ctx: typeof info.maxTokens === "number" && info.maxTokens > 0
          ? info.maxTokens
          : defaults.ctx,
        quotaPool,
        multimodal: hasMultimodalMetadata
          ? Boolean(info.supportsImages || info.supportsVideo)
          : defaults.multimodal,
        tools: defaults.tools,
        maxOutputTokens:
          typeof info.maxOutputTokens === "number" && info.maxOutputTokens > 0
            ? info.maxOutputTokens
            : defaults.maxOutputTokens,
        thinkingBudget,
        minThinkingBudget:
          typeof info.minThinkingBudget === "number"
            ? info.minThinkingBudget
            : defaults.minThinkingBudget,
        isThinking,
        isTiered,
        displayName: info.displayName ?? previous?.get(lowerId)?.displayName ?? normalizedId,
      });
      this.discoveredModels.set(lowerId, { id: normalizedId, quotaPool });
      this.ownershipScopedModels.add(lowerId);
      if (!knownBefore.has(lowerId)) newModelsCount++;
    }

    this.accountModels.set(key, next);
    this.accountModelOwnership.set(key, new Set(next.keys()));
    return newModelsCount;
  }

  /** Expire catalogs belonging to accounts that are no longer active. */
  retainAccounts(accounts: Iterable<ActiveAccount>): void {
    const previous = this.activeAccountGenerations;
    const active = new Map<string, ActiveAccountGeneration>();
    for (const account of accounts) {
      const key = accountKey(typeof account === "string" ? account : account.id);
      const credentialGeneration = typeof account === "string"
        ? null
        : account.generation;
      const prior = previous?.get(key);
      active.set(
        key,
        prior?.credentialGeneration === credentialGeneration
          ? prior
          : { credentialGeneration, epoch: ++this.nextAccountEpoch },
      );
    }
    for (const key of this.accountModels.keys()) {
      const nextGeneration = active.get(key)?.credentialGeneration;
      const previousGeneration = previous?.get(key)?.credentialGeneration;
      if (
        !active.has(key) ||
        (previousGeneration !== undefined && previousGeneration !== nextGeneration)
      ) {
        this.accountModels.delete(key);
      }
    }
    for (const key of this.accountModelOwnership.keys()) {
      const nextGeneration = active.get(key)?.credentialGeneration;
      const previousGeneration = previous?.get(key)?.credentialGeneration;
      if (
        !active.has(key) ||
        (previousGeneration !== undefined && previousGeneration !== nextGeneration)
      ) {
        this.accountModelOwnership.delete(key);
      }
    }
    for (const key of this.defaultAgentModelIds.keys()) {
      if (!this.accountModels.has(key)) this.defaultAgentModelIds.delete(key);
    }
    this.activeAccountGenerations = active;
  }

  captureAccountEpoch(
    accountId: string,
    credentialGeneration: string,
  ): number | null | undefined {
    if (!this.activeAccountGenerations) return undefined;
    const active = this.activeAccountGenerations.get(accountKey(accountId));
    if (
      !active ||
      (active.credentialGeneration !== null &&
        active.credentialGeneration !== credentialGeneration)
    ) {
      return null;
    }
    return active.epoch;
  }

  isAccountGenerationActive(
    accountId: string,
    credentialGeneration?: string,
    accountEpoch?: number,
  ): boolean {
    if (!this.activeAccountGenerations) return true;
    const key = accountKey(accountId);
    const active = this.activeAccountGenerations.get(key);
    if (!active) return false;
    if (accountEpoch !== undefined && active.epoch !== accountEpoch) return false;
    return credentialGeneration === undefined ||
      active.credentialGeneration === null ||
      active.credentialGeneration === credentialGeneration;
  }

  getAllModels(): DynamicModelEntry[] {
    const models = new Map<string, DynamicModelEntry>();
    for (const accountCatalog of this.accountModels.values()) {
      for (const [id, model] of accountCatalog) models.set(id, model);
    }
    return Array.from(models.values());
  }

  getModel(id: string): DynamicModelEntry | undefined {
    let match: DynamicModelEntry | undefined;
    const lowerId = id.toLowerCase();
    for (const accountCatalog of this.accountModels.values()) {
      match = accountCatalog.get(lowerId) ?? match;
    }
    return match;
  }

  hasModelForAccount(accountId: string, id: string): boolean {
    return this.accountModelOwnership
      .get(accountKey(accountId))
      ?.has(id.trim().toLowerCase()) ?? false;
  }

  hasOwnershipForModel(id: string): boolean {
    return this.ownershipScopedModels.has(id.trim().toLowerCase());
  }

  wasDiscovered(id: string): boolean {
    return this.discoveredModels.has(id.trim().toLowerCase());
  }

  getObservedModelId(id: string): string | undefined {
    return this.getModel(id)?.id ??
      this.discoveredModels.get(id.trim().toLowerCase())?.id;
  }

  getDiscoveredQuotaPools(): Record<string, string> {
    const pools = Object.create(null) as Record<string, string>;
    for (const { id, quotaPool } of this.discoveredModels.values()) {
      pools[id] = quotaPool;
    }
    return pools;
  }

  getPersistedModelOwnership(
    accounts: Iterable<PersistedOwnershipAccount>,
  ): PersistedDynamicModelOwnership {
    const persistedAccounts = Object.create(null) as PersistedDynamicModelOwnership["accounts"];
    for (const account of accounts) {
      const id = accountKey(account.id);
      const models = this.accountModelOwnership.get(id);
      if (!models) continue;
      persistedAccounts[id] = {
        credentialGenerationFingerprint:
          account.credentialGenerationFingerprint,
        models: Array.from(models).sort(),
      };
    }
    return {
      scopedModels: Array.from(this.ownershipScopedModels).sort(),
      accounts: persistedAccounts,
    };
  }

  restorePersistedModelOwnership(
    value: unknown,
    accounts: Iterable<PersistedOwnershipAccount>,
  ): void {
    if (
      !isRecord(value) ||
      !Array.isArray(value.scopedModels) ||
      !isRecord(value.accounts)
    ) return;

    const expectedGenerations = new Map(
      Array.from(accounts, (account) => [
        accountKey(account.id),
        account.credentialGenerationFingerprint,
      ]),
    );
    const scopedModels = new Set<string>();
    for (const rawModel of value.scopedModels) {
      if (typeof rawModel !== "string") continue;
      const model = rawModel.trim().toLowerCase();
      if (
        isDiscoverableModelId(model) &&
        this.discoveredModels.has(model)
      ) scopedModels.add(model);
    }

    const restoredAccounts = new Map<string, Set<string>>();
    for (const [rawAccountId, rawSnapshot] of Object.entries(value.accounts)) {
      const accountId = accountKey(rawAccountId);
      const expectedGeneration = expectedGenerations.get(accountId);
      if (
        !expectedGeneration ||
        !isRecord(rawSnapshot) ||
        rawSnapshot.credentialGenerationFingerprint !== expectedGeneration ||
        !Array.isArray(rawSnapshot.models)
      ) continue;
      const models = new Set<string>();
      for (const rawModel of rawSnapshot.models) {
        if (typeof rawModel !== "string") continue;
        const model = rawModel.trim().toLowerCase();
        if (scopedModels.has(model)) models.add(model);
      }
      restoredAccounts.set(accountId, models);
    }

    for (const model of scopedModels) this.ownershipScopedModels.add(model);
    for (const [accountId, models] of restoredAccounts) {
      this.accountModelOwnership.set(accountId, models);
    }
  }

  restoreDiscoveredQuotaPools(value: unknown): void {
    if (!isRecord(value)) return;
    for (const [rawId, rawPool] of Object.entries(value)) {
      const id = rawId.trim();
      const quotaPool = typeof rawPool === "string"
        ? rawPool.trim().toLowerCase()
        : "";
      if (
        !isDiscoverableModelId(id) ||
        (quotaPool !== "gemini" && quotaPool !== "claude")
      ) continue;
      this.discoveredModels.set(id.toLowerCase(), { id, quotaPool });
    }
  }

  getModelSpec(id: string): ModelSpec | undefined {
    const entry = this.getModel(id);
    if (!entry) return undefined;
    return {
      maxOutputTokens: entry.maxOutputTokens,
      thinkingBudget: entry.thinkingBudget,
      ...(entry.minThinkingBudget !== undefined
        ? { minThinkingBudget: entry.minThinkingBudget }
        : {}),
      isThinking: entry.isThinking,
      contextWindow: entry.ctx,
    };
  }

  getContextWindow(id: string): number | undefined {
    return this.getModel(id)?.ctx;
  }

  isTiered(id: string): boolean {
    const lowerId = id.toLowerCase();
    return lowerId.includes("-tiered") || (this.getModel(lowerId)?.isTiered ?? false);
  }

  resolveQuotaPool(id: string): string | undefined {
    const lowerId = id.trim().toLowerCase();
    return this.getModel(lowerId)?.quotaPool ??
      this.discoveredModels.get(lowerId)?.quotaPool;
  }

  getDefaultAgentModelId(): string | null {
    return Array.from(this.defaultAgentModelIds.values()).at(-1) ?? null;
  }
}

export const dynamicCatalog = DynamicModelRegistry.getInstance();
