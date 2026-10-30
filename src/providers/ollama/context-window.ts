// Ollama Cloud model info: read the upstream-published context window for an
// Ollama model from `POST /api/show`.
//
// `/api/show` returns `model_info.<arch>.context_length` for the active
// quantisation (and several other arch-specific lengths for older builds).
// We pick the largest positive value across the `model_info` keys. If the
// endpoint is unavailable (e.g. anonymous `/api/tags` cache when no Ollama
// account is configured) we fall back to the operator-provided
// `OLLAMA_NUM_CTX` env var, defaulting to 8192 (Ollama's own `num_ctx`
// default per https://github.com/ollama/ollama/blob/main/docs/faq.md).

import {
  OLLAMA_API_BASE,
  TAGS_CACHE_TTL_MS,
} from "../../types.js";
import type { AccountRuntime } from "../../types.js";
import { rotatorEnv } from "../../env.js";
import { getOllamaApiKey } from "./credentials.js";
import { getAccountProxyDispatcher } from "../proxy-dispatcher.js";

const DEFAULT_OLLAMA_NUM_CTX = 8_192;

interface CacheEntry {
  contextWindow: number;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function defaultNumCtx(): number {
  const raw = rotatorEnv("OLLAMA_NUM_CTX") ?? rotatorEnv("OLLAMA_CONTEXT_LENGTH");
  if (!raw) return DEFAULT_OLLAMA_NUM_CTX;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_OLLAMA_NUM_CTX;
  return parsed;
}

/**
 * Read `POST /api/show` from Ollama Cloud. Returns an empty object when the
 * model cannot be fetched (offline, missing creds, missing field).
 */
async function fetchOllamaShowPayload(
  account: AccountRuntime | undefined,
  model: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const apiKey = account ? getOllamaApiKey(account.config) : undefined;
  if (!apiKey) return {};
  const dispatcher = account
    ? getAccountProxyDispatcher(account, "ollama")
    : undefined;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  const init: RequestInit & { dispatcher?: unknown; signal?: AbortSignal } = {
    method: "POST",
    headers,
    body: JSON.stringify({ name: model, verbose: false }),
    signal: signal ?? AbortSignal.timeout(4_000),
  };
  if (dispatcher) init.dispatcher = dispatcher;
  try {
    const res = await fetch(`${OLLAMA_API_BASE}/show`, init);
    if (!res.ok) return {};
    const data = await res.json() as Record<string, unknown>;
    return data ?? {};
  } catch {
    return {};
  }
}

/**
 * Pull a positive integer context length out of `model_info`. The Ollama
 * Go server publishes per-arch keys like `llama.context_length`,
 * `qwen2.context_length`, `gptoss.context_length`, etc. We pick the
 * largest positive candidate as the upper bound.
 */
function extractContextWindow(modelInfo: unknown): number | undefined {
  if (!modelInfo || typeof modelInfo !== "object") return undefined;
  let best: number | undefined;
  for (const [key, value] of Object.entries(modelInfo as Record<string, unknown>)) {
    if (!key.endsWith(".context_length")) continue;
    if (typeof value !== "number") continue;
    if (!Number.isFinite(value) || value <= 0) continue;
    if (best === undefined || value > best) best = value;
  }
  return best;
}

/**
 * Resolve the Ollama Cloud context window for a model id. Cached for
 * `TAGS_CACHE_TTL_MS` (currently 5 minutes — same TTL as `/api/tags`).
 *
 * Returns the operator `OLLAMA_NUM_CTX` fallback when `/api/show` is not
 * reachable or does not include a `context_length`.
 */
export async function getOllamaContextWindow(
  model: string,
  account?: AccountRuntime,
): Promise<number> {
  if (!model) return defaultNumCtx();
  const now = Date.now();
  const cached = cache.get(model);
  if (cached && cached.expiresAt > now) return cached.contextWindow;
  const payload = await fetchOllamaShowPayload(account, model);
  const modelInfo = (payload as { model_info?: unknown }).model_info;
  const detected = extractContextWindow(modelInfo);
  const contextWindow = typeof detected === "number" ? detected : defaultNumCtx();
  cache.set(model, { contextWindow, expiresAt: now + TAGS_CACHE_TTL_MS });
  return contextWindow;
}

export function clearOllamaContextCache(): void {
  cache.clear();
}

/** Read without network I/O on the routing path. Expired discoveries are not trusted. */
export function getCachedOllamaContextWindow(model: string): number {
  const entry = cache.get(model);
  return entry && entry.expiresAt > Date.now() ? entry.contextWindow : defaultNumCtx();
}

/** Bounded discovery outside request selection. Failures retain the safe fallback. */
export async function primeOllamaContextWindows(models: string[], account: AccountRuntime): Promise<void> {
  for (let index = 0; index < models.length; index += 4) {
    await Promise.allSettled(models.slice(index, index + 4).map(model => getOllamaContextWindow(model, account)));
  }
}
