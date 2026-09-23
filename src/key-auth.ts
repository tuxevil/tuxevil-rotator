import type { IncomingMessage, ServerResponse } from "node:http";
import { applyModelAlias, type VirtualKey } from "./types.js";
import {
  hasAnyVirtualKeys,
  lookupVirtualKey,
  touchVirtualKeyLastActive,
} from "./virtual-keys.js";
import { isDbConfigured } from "./db-store.js";

export interface KeyAuthResult {
  authenticated: boolean;
  key: VirtualKey | null;
  rawKey?: string;
  error?: string;
  statusCode?: number;
}

/** Checks a resolved model against the optional virtual-key model scope. */
export function isVirtualKeyModelAllowed(
  key: VirtualKey | null,
  targetModel: string,
): boolean {
  if (!key?.models || key.models.length === 0 || key.models.includes("*")) return true;
  const normalizedTarget = targetModel.toLowerCase();
  return key.models.some(
    (model) =>
      model.toLowerCase() === normalizedTarget ||
      normalizedTarget.includes(model.toLowerCase()),
  );
}

/**
 * Extracts virtual key raw string from headers or query parameters.
 */
export function extractVirtualKey(req: IncomingMessage): string | null {
  // 1. Authorization: Bearer rk-...
  const authHeader = req.headers["authorization"];
  if (authHeader) {
    const parts = authHeader.split(" ");
    if (parts.length === 2 && /^bearer$/i.test(parts[0])) {
      const val = parts[1].trim();
      if (val.startsWith("rk-")) return val;
    }
  }

  // 2. Custom headers: x-rotator-key, x-api-key
  const rotatorKeyHeader =
    req.headers["x-rotator-key"] || req.headers["x-api-key"];
  if (typeof rotatorKeyHeader === "string") {
    const val = rotatorKeyHeader.trim();
    if (val.startsWith("rk-")) return val;
  }

  // 3. Query string: ?rotator_key=rk-... or ?key=rk-...
  if (req.url && req.url.includes("rk-")) {
    try {
      const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const param =
        parsedUrl.searchParams.get("rotator_key") ||
        parsedUrl.searchParams.get("key") ||
        parsedUrl.searchParams.get("api_key");
      if (param && param.startsWith("rk-")) return param.trim();
    } catch {
      // Ignore URL parse error
    }
  }

  return null;
}

export interface VirtualKeyScopeOptions {
  /** Scope entries that authorize the equivalent model only, for backward compatibility. */
  equivalentScopes?: readonly string[];
  equivalentModel?: string;
  normalizeModel?: (model: string) => string;
}

function isModelAllowedByScope(models: string[], targetModel: string): boolean {
  const normalizedTarget = targetModel.toLowerCase();
  const aliasedTarget = applyModelAlias(targetModel).toLowerCase();
  const canonicalTarget =
    normalizedTarget === "whisper-1" || normalizedTarget === "whisper"
      ? "gemini-3.8-flash-low"
      : aliasedTarget;

  return models.some((m) => {
    const normalizedM = m.toLowerCase();
    const aliasedM = applyModelAlias(m).toLowerCase();
    const canonicalM =
      normalizedM === "whisper-1" || normalizedM === "whisper"
        ? "gemini-3.8-flash-low"
        : aliasedM;

    return (
      normalizedM === normalizedTarget ||
      normalizedTarget.includes(normalizedM) ||
      aliasedM === aliasedTarget ||
      aliasedTarget.includes(aliasedM) ||
      canonicalM === canonicalTarget ||
      canonicalM === normalizedTarget ||
      normalizedM === canonicalTarget ||
      canonicalM === aliasedTarget ||
      aliasedM === canonicalTarget ||
      normalizedM === aliasedTarget ||
      aliasedM === normalizedTarget
    );
  });
}

/**
 * Validates request authentication against virtual keys.
 *
 * Rules:
 * - If DB is not configured OR no virtual keys exist in DB, auth is not enforced.
 * - If keys exist, valid key is mandatory for proxy routes.
 * - Key must not be blocked.
 * - If target models are provided and key has model scope, every target must be allowed,
 *   unless the key is scoped to an equivalent id for `options.equivalentModel`.
 */
export async function authenticateVirtualKey(
  req: IncomingMessage,
  targetModel?: string | readonly string[],
  options: VirtualKeyScopeOptions = {},
): Promise<KeyAuthResult> {
  const isEnforced = isDbConfigured() && (await hasAnyVirtualKeys());

  const rawKey = extractVirtualKey(req);

  if (!isEnforced) {
    // If a key was sent anyway, try looking it up to associate spend log with key if valid
    let key: VirtualKey | null = null;
    if (rawKey) {
      key = await lookupVirtualKey(rawKey);
    }
    return { authenticated: true, key, rawKey: rawKey || undefined };
  }

  if (!rawKey) {
    return {
      authenticated: false,
      key: null,
      error: "Virtual API Key required. Pass header 'Authorization: Bearer rk-...' or 'x-rotator-key: rk-...'",
      statusCode: 401,
    };
  }

  const key = await lookupVirtualKey(rawKey);
  if (!key) {
    return {
      authenticated: false,
      key: null,
      error: "Invalid Virtual API Key",
      statusCode: 401,
    };
  }

  if (key.blocked) {
    return {
      authenticated: false,
      key,
      rawKey,
      error: "Virtual API Key is blocked/disabled",
      statusCode: 403,
    };
  }

  // Model access restrictions
  const targets = (typeof targetModel === "string" ? [targetModel] : (targetModel ?? [])).filter(
    (target) => target.length > 0,
  );
  const scopedModels = key.models ?? [];
  if (targets.length > 0 && scopedModels.length > 0 && !scopedModels.includes("*")) {
    const scopes = scopedModels.map((m) => m.toLowerCase());
    const hasEquivalentScope = (options.equivalentScopes ?? []).some((scope) =>
      scopes.includes(scope.toLowerCase()),
    );
    const normalizeModel = (model: string): string =>
      (options.normalizeModel?.(model) ?? applyModelAlias(model)).toLowerCase().replace(/^models\//, "");
    const equivalentModel = options.equivalentModel ? normalizeModel(options.equivalentModel) : undefined;
    const deniedTarget =
      hasEquivalentScope && equivalentModel === undefined
        ? undefined
        : targets.find((target) => {
            if (isModelAllowedByScope(scopedModels, target)) return false;
            const isEquivalentModel =
              equivalentModel !== undefined && normalizeModel(target) === equivalentModel;
            return !(hasEquivalentScope && isEquivalentModel);
          });

    if (deniedTarget !== undefined) {
      return {
        authenticated: false,
        key,
        rawKey,
        error: `Model '${deniedTarget}' is not allowed for this Virtual Key`,
        statusCode: 403,
      };
    }
  }

  touchVirtualKeyLastActive(key.tokenHash);
  return { authenticated: true, key, rawKey };
}

/**
 * Helper to write HTTP error response for failed auth.
 */
export function sendAuthErrorResponse(
  res: ServerResponse,
  authResult: KeyAuthResult,
): void {
  const statusCode = authResult.statusCode || 401;
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      error: {
        message: authResult.error || "Authentication failed",
        type: statusCode === 403 ? "permission_error" : "authentication_error",
        code: statusCode === 403 ? "forbidden" : "invalid_api_key",
      },
    }),
  );
}
