import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
import type { Config } from "./types.js";
import { isEncryptedSecret, isRedactedSecret } from "./token-encryption.js";
import { rotatorEnv } from "./env.js";

export type AutoRoutingRoute =
  | "openai-chat"
  | "openai-responses"
  | "anthropic"
  | "gemini";

export interface AutoRoutingCatalogEntry {
  providerId: string;
  modelId: string;
  contextWindow: number;
  multimodal: boolean;
  tools: boolean;
  reasoning: boolean;
  /** Whether this catalog entry is valid for the OpenAI Responses wire path. */
  responses?: boolean;
  family?: string;
}

export interface AutoRoutingCandidateStatus {
  available: boolean;
  operationalScore: number;
  poolKey?: string;
  reason?: string;
}

export interface AutoRoutingCandidate extends AutoRoutingCatalogEntry {
  id: string;
  operationalScore: number;
  poolKey: string;
}

export interface AutoRoutingRotator {
  getConfig?: () => Config;
  hasActiveProvider?: (providerId: string) => boolean;
  getAutoRoutingCandidateStatus?: (
    model: string,
    providerId: string,
  ) => AutoRoutingCandidateStatus;
}

export interface AutoRoutingSelection {
  candidate: AutoRoutingCandidate;
  mode: "typesafe" | "deterministic";
  confidence?: number;
  reason: string;
}

export interface AutoRoutingRequest {
  route: AutoRoutingRoute;
  input: unknown;
  requestedModel?: string;
  maxContextWindow?: number;
}

interface RoutingRequirements {
  hasImages: boolean;
  hasTools: boolean;
  requiresReasoning: boolean;
  estimatedInputChars: number;
}

const PROVIDER_ORDER: Record<string, number> = {
  "google-antigravity": 1,
  ollama: 2,
  "opencode-zen": 3,
  "openai-codex": 4,
};

const DEFAULT_MAX_CANDIDATES = 32;
const DEFAULT_SHORTLIST_SIZE = 12;
const MAX_SHORTLIST_SIZE = 32;
const DEFAULT_MAX_EXCERPT_CHARS = 12_000;
const DEFAULT_MIN_CONFIDENCE = 0.45;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function containsKey(value: unknown, keys: Set<string>): boolean {
  if (Array.isArray(value)) return value.some((item) => containsKey(item, keys));
  const record = asRecord(value);
  if (!record) return false;
  for (const [key, child] of Object.entries(record)) {
    if (keys.has(key.toLowerCase())) return true;
    if (containsKey(child, keys)) return true;
  }
  return false;
}

function containsImage(value: unknown): boolean {
  if (typeof value === "string") return value.startsWith("data:image/");
  if (Array.isArray(value)) return value.some(containsImage);
  const record = asRecord(value);
  if (!record) return false;
  for (const [key, child] of Object.entries(record)) {
    const lower = key.toLowerCase();
    if (lower === "image" || lower === "image_url" || lower === "input_image") return true;
    if ((lower === "type" && typeof child === "string" && child.toLowerCase().includes("image")) || containsImage(child)) {
      return true;
    }
  }
  return false;
}

function requiresReasoning(value: unknown): boolean {
  const record = asRecord(value);
  if (Array.isArray(value)) return value.some(requiresReasoning);
  if (!record) return false;
  const effort = record.reasoning_effort;
  if (typeof effort === "string" && ["high", "xhigh", "max"].includes(effort.toLowerCase())) return true;
  if (asRecord(record.reasoning)?.effort &&
      ["high", "xhigh", "max"].includes(String(asRecord(record.reasoning)?.effort).toLowerCase())) return true;
  if (asRecord(record.thinking)?.type === "enabled") return true;
  return Object.entries(record).some(([key, child]) =>
    key !== "reasoning" && key !== "thinking" && requiresReasoning(child),
  );
}

function collectText(value: unknown, output: string[], seen: Set<unknown>, depth = 0): void {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || /^data:(image|audio|video)\//i.test(trimmed) || /^https?:\/\//i.test(trimmed)) return;
    output.push(trimmed);
    return;
  }
  if (typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, output, seen, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    const lower = key.toLowerCase();
    if (["image", "image_url", "audio", "video", "data", "url"].includes(lower)) continue;
    collectText(child, output, seen, depth + 1);
  }
}

function boundedExcerpt(input: unknown, maxChars: number): string {
  const parts: string[] = [];
  collectText(input, parts, new Set<unknown>());
  const joined = parts.join("\n");
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}\n[truncated]` : joined;
}

function getRequirements(input: unknown): RoutingRequirements {
  let serializedLength: number;
  try {
    serializedLength = JSON.stringify(input)?.length ?? 0;
  } catch {
    serializedLength = 0;
  }
  return {
    hasImages: containsImage(input),
    hasTools: containsKey(input, new Set(["tools", "functions", "tool_choice"])),
    requiresReasoning: requiresReasoning(input),
    estimatedInputChars: Math.min(serializedLength, 1_000_000),
  };
}

function deterministicCompare(a: AutoRoutingCandidate, b: AutoRoutingCandidate): number {
  const score = b.operationalScore - a.operationalScore;
  if (Math.abs(score) > 0.0001) return score;
  const provider = (PROVIDER_ORDER[a.providerId] ?? 99) - (PROVIDER_ORDER[b.providerId] ?? 99);
  if (provider !== 0) return provider;
  return a.modelId.localeCompare(b.modelId);
}

/**
 * Keep Jev's question small without allowing the best operational provider to
 * crowd every other provider/family out of the semantic decision. Candidates
 * arrive sorted by operational health, so round-robin buckets preserve that
 * ordering inside each provider/family group while still showing Jev variety.
 */
function diverseShortlist(
  candidates: AutoRoutingCandidate[],
  limit: number,
): AutoRoutingCandidate[] {
  if (candidates.length <= limit) return candidates;

  const buckets = new Map<string, { items: AutoRoutingCandidate[]; index: number }>();
  for (const candidate of candidates) {
    const family = candidate.family?.trim() || candidate.modelId;
    const key = `${candidate.providerId}\u0000${family}`;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.items.push(candidate);
    } else {
      buckets.set(key, { items: [candidate], index: 0 });
    }
  }

  const selected: AutoRoutingCandidate[] = [];
  let progressed = true;
  while (selected.length < limit && progressed) {
    progressed = false;
    for (const bucket of buckets.values()) {
      const candidate = bucket.items[bucket.index];
      if (!candidate) continue;
      bucket.index += 1;
      selected.push(candidate);
      progressed = true;
      if (selected.length >= limit) break;
    }
  }
  return selected;
}

export function buildAutoRoutingCandidates(
  rotator: AutoRoutingRotator,
  catalog: AutoRoutingCatalogEntry[],
  request: AutoRoutingRequest,
): { candidates: AutoRoutingCandidate[]; requirements: RoutingRequirements } {
  const requirements = getRequirements(request.input);
  const candidates: AutoRoutingCandidate[] = [];
  for (const entry of catalog) {
    if (request.route === "gemini" && entry.providerId !== "google-antigravity") continue;
    if (request.route === "openai-responses" && entry.responses === false) continue;
    if (request.maxContextWindow !== undefined && entry.contextWindow < request.maxContextWindow) continue;
    if (requirements.hasImages && !entry.multimodal) continue;
    if (requirements.hasTools && !entry.tools) continue;
    if (requirements.requiresReasoning && !entry.reasoning) continue;
    if (rotator.hasActiveProvider && !rotator.hasActiveProvider(entry.providerId)) continue;

    const status = rotator.getAutoRoutingCandidateStatus?.(entry.modelId, entry.providerId) ?? {
      available: true,
      operationalScore: 0.5,
    };
    if (!status.available) continue;
    candidates.push({
      ...entry,
      id: `candidate_${candidates.length}`,
      operationalScore: Math.max(0, Math.min(1, status.operationalScore)),
      poolKey: status.poolKey ?? entry.modelId,
    });
  }
  candidates.sort(deterministicCompare);
  const routingConfig = rotator.getConfig?.().typesafeRouting;
  const maxCandidates = Math.max(
    1,
    Math.min(128, routingConfig?.maxCandidates ?? DEFAULT_MAX_CANDIDATES),
  );
  const shortlistSize = Math.max(
    1,
    Math.min(
      MAX_SHORTLIST_SIZE,
      maxCandidates,
      routingConfig?.shortlistSize ?? DEFAULT_SHORTLIST_SIZE,
    ),
  );
  const candidatePool = diverseShortlist(candidates, maxCandidates);
  return {
    candidates: diverseShortlist(candidatePool, shortlistSize),
    requirements,
  };
}

function deterministicSelection(
  candidates: AutoRoutingCandidate[],
  reason: string,
): AutoRoutingSelection | null {
  const candidate = candidates[0];
  return candidate ? { candidate, mode: "deterministic", reason } : null;
}

export async function selectAutoRoutingTarget(
  rotator: AutoRoutingRotator,
  catalog: AutoRoutingCatalogEntry[],
  request: AutoRoutingRequest,
): Promise<AutoRoutingSelection | null> {
  const config = rotator.getConfig?.().typesafeRouting;
  const excerptLimit = Math.max(256, Math.min(50_000, config?.maxExcerptChars ?? DEFAULT_MAX_EXCERPT_CHARS));
  const { candidates, requirements } = buildAutoRoutingCandidates(rotator, catalog, request);
  if (candidates.length === 0) return null;

  const deterministic = (reason: string): AutoRoutingSelection | null =>
    deterministicSelection(candidates, reason);
  const environmentApiKey = rotatorEnv("TYPESAFE_API_KEY") || process.env.TYPESAFE_API_KEY;
  const apiKey = config?.apiKey?.trim() || environmentApiKey?.trim();
  if (config?.enabled === false || !apiKey || isEncryptedSecret(apiKey) || isRedactedSecret(apiKey)) {
    return deterministic("typesafe-disabled");
  }

  const criteria: Record<string, string | null> = {};
  for (const candidate of candidates) {
    criteria[candidate.id] = `${candidate.providerId}/${candidate.modelId}; family=${candidate.family ?? "unknown"}; context=${candidate.contextWindow}; multimodal=${candidate.multimodal}; tools=${candidate.tools}; reasoning=${candidate.reasoning}; operational_score=${candidate.operationalScore.toFixed(2)}`;
  }

  const state = {
    route: request.route,
    requested_model: request.requestedModel ?? "auto",
    selection_policy: "Choose exactly one listed candidate. Hard capability requirements have already been filtered; use operational_score as a tie-breaker.",
    requirements: {
      has_images: requirements.hasImages,
      has_tools: requirements.hasTools,
      requires_reasoning: requirements.requiresReasoning,
      estimated_input_chars: requirements.estimatedInputChars,
    },
    prompt_excerpt: boundedExcerpt(request.input, excerptLimit),
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      provider: candidate.providerId,
      model: candidate.modelId,
      family: candidate.family ?? null,
      context_window: candidate.contextWindow,
      multimodal: candidate.multimodal,
      tools: candidate.tools,
      reasoning: candidate.reasoning,
      operational_score: candidate.operationalScore,
    })),
  };

  try {
    const client = new TypeSafeClient({
      apiKey,
      baseURL: config?.baseURL,
      defaultModel: config?.model ?? "jev-latest",
      timeout: config?.timeoutMs ?? 3_000,
      retry: { maxRetries: 0 },
      logLevel: "off",
    });
    const answer = await client.systemOne({
      state,
      questions: {
        selected_model: choice(
          "Choose exactly one of the listed candidates for this request. Prefer the candidate that best fits the request; use operational score as a tie-breaker.",
          criteria,
        ),
      },
    });
    const selected = asRecord(answer.answers.selected_model);
    const selectedId = typeof selected?.choice === "string" ? selected.choice : String(selected?.choice ?? "");
    const confidence = Number(selected?.confidence);
    const minConfidence = Math.max(0, Math.min(1, config?.minConfidence ?? DEFAULT_MIN_CONFIDENCE));
    if (selectedId === "none") return deterministic("typesafe-no-match");
    if (!candidates.some((candidate) => candidate.id === selectedId)) {
      return deterministic("typesafe-invalid-choice");
    }
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1 || confidence < minConfidence) {
      return deterministic("typesafe-low-confidence");
    }
    const probabilities = asRecord(selected?.probabilities) ?? {};
    const probabilityFor = (candidate: AutoRoutingCandidate): number => {
      const probability = Number(probabilities[candidate.id]);
      return Number.isFinite(probability) && probability >= 0 && probability <= 1 ? probability : 0;
    };
    const ranked = [...candidates].sort((a, b) => {
      const aScore = 0.7 * probabilityFor(a) + 0.3 * a.operationalScore;
      const bScore = 0.7 * probabilityFor(b) + 0.3 * b.operationalScore;
      return bScore - aScore || deterministicCompare(a, b);
    });
    const chosen = ranked[0];
    return chosen
      ? { candidate: chosen, mode: "typesafe", confidence, reason: "typesafe-selected" }
      : deterministic("typesafe-invalid-choice");
  } catch {
    // Jev is an optional semantic layer. A transport, timeout, or malformed
    // answer must never make an otherwise routable request fail closed.
    return deterministic("typesafe-error");
  }
}
