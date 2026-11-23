// Google Antigravity provider catalog: per-model context windows.
//
// Sources (verified at fetch time):
//   - Google DeepMind model pages (https://deepmind.google/models/gemini/*)
//   - Google AI Studio / Gemini API docs (https://ai.google.dev/gemini-api/docs/models)
//   - Anthropic Claude models overview (https://docs.anthropic.com/en/docs/about-claude/models/overview)
//   - OpenAI model docs (https://platform.openai.com/docs/models, https://platform.openai.com/docs/models/gpt-oss-120b)
//
// Values reflect input/context window only. Output max tokens are tracked
// separately in `src/compat/model-specs.ts` via `maxOutputTokens`.

import { dynamicCatalog } from "./dynamic-catalog.js";
import { getModelSpec, getModelSpecOverride } from "../../compat/model-specs.js";
import { applyModelAlias } from "../../types.js";

export interface AntigravityModelSpec {
  id: string;
  contextWindow: number;
}

/**
 * Exact context windows per Antigravity (Cloud Code Assist) model id, as
 * published by the upstream providers.
 *
 * The keys are normalized to the lower-cased id used by the request path so
 * `getAntigravityContextWindow` can do an O(1) lookup.
 */
export const ANTIGRAVITY_CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic Claude 5.5 family — 1M context window per Anthropic docs.
  "claude-opus-5-5": 1_000_000,
  "claude-opus-5-5-high": 1_000_000,
  "claude-opus-5-5-medium": 1_000_000,
  "claude-opus-5-5-low": 1_000_000,
  "claude-sonnet-5-5": 1_000_000,
  "claude-sonnet-5-5-high": 1_000_000,
  "claude-sonnet-5-5-medium": 1_000_000,
  "claude-sonnet-5-5-low": 1_000_000,
  // Anthropic Claude 4.6 family — 1M context window per Anthropic docs.
  "claude-opus-4-6": 1_000_000,
  "claude-opus-4-6-thinking": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-sonnet-4-6-thinking": 1_000_000,
  // Anthropic Claude 4.5 family — 200K context window per Anthropic docs.
  "claude-opus-4-5": 200_000,
  "claude-opus-4-5-thinking": 200_000,
  "claude-sonnet-4-5": 200_000,
  "claude-sonnet-4-5-thinking": 200_000,
  // OpenAI gpt-oss-120b — 131,072 per platform.openai.com/docs/models/gpt-oss-120b.
  "gpt-oss-120b": 131_072,
  "gpt-oss-120b-medium": 131_072,
  // Google Gemini 4 family — 1M unified context window per Google Gemini API docs.
  "gemini-4-carbon": 1_000_000,
  "gemini-4-carbon-disabled": 1_000_000,
  "gemini-4-carbon-high": 1_000_000,
  "gemini-4-carbon-medium": 1_000_000,
  "gemini-4-carbon-low": 1_000_000,
  "gemini-4-argon": 1_000_000,
  "gemini-4-argon-disabled": 1_000_000,
  "gemini-4-argon-high": 1_000_000,
  "gemini-4-argon-medium": 1_000_000,
  "gemini-4-argon-low": 1_000_000,
  "gemini-4-neon": 1_000_000,
  "gemini-4-neon-disabled": 1_000_000,
  "gemini-4-neon-xhigh": 1_000_000,
  "gemini-4-neon-high": 1_000_000,
  "gemini-4-neon-medium": 1_000_000,
  "gemini-4-neon-low": 1_000_000,
  "gemini-4-hydrogen": 1_000_000,
  "gemini-4-hydrogen-disabled": 1_000_000,
  "gemini-4-hydrogen-xhigh": 1_000_000,
  "gemini-4-hydrogen-high": 1_000_000,
  "gemini-4-hydrogen-medium": 1_000_000,
  "gemini-4-hydrogen-low": 1_000_000,
  "gemini-4-hydrogen-tiered": 1_000_000,
  "gemini-4-hydrogen-tiered-high": 1_000_000,
  "gemini-4-hydrogen-tiered-xhigh": 1_000_000,
  "gemini-4-hydrogen-sonar": 1_000_000,
  // Google Gemini 3.x — 1M context window per deepmind.google/models/gemini/*.
  "gemini-3.8-flash": 1_000_000,
  "gemini-3.8-flash-tiered": 1_000_000,
  "gemini-3.8-flash-high": 1_000_000,
  "gemini-3.8-flash-medium": 1_000_000,
  "gemini-3.8-flash-low": 1_000_000,
  "gemini-3.7-flash": 1_000_000,
  "gemini-3.7-flash-tiered": 1_000_000,
  "gemini-3.6-flash": 1_000_000,
  "gemini-3.6-flash-high": 1_000_000,
  "gemini-3.6-flash-medium": 1_000_000,
  "gemini-3.6-flash-low": 1_000_000,
  "gemini-3.6-flash-tiered": 1_000_000,
  "gemini-3-flash": 1_000_000,
  "gemini-3-flash-agent": 1_000_000,
  "gemini-3-pro": 1_000_000,
  "gemini-3-pro-high": 1_000_000,
  "gemini-3-pro-low": 1_000_000,
  "gemini-3.1-pro": 1_000_000,
  "gemini-3.1-pro-high": 1_000_000,
  "gemini-3.1-pro-low": 1_000_000,
  "gemini-3.1-pro-preview": 1_000_000,
  // Google Gemini 2.5 — 1M context window per Google docs.
  "gemini-2.5-pro": 1_000_000,
  "gemini-2.5-flash": 1_000_000,
  // Antigravity-internal alias mapped to the Gemini Pro family.
  "gemini-pro-agent": 1_000_000,
};

const CLAUDE_DEFAULT_CONTEXT_WINDOW = 1_000_000;
const GEMINI_DEFAULT_CONTEXT_WINDOW = 1_000_000;
const GPT_OSS_DEFAULT_CONTEXT_WINDOW = 131_072;
const FALLBACK_CONTEXT_WINDOW = 128_000;

/**
 * Resolve the upstream-published context window for an Antigravity model id.
 *
 * Lookup order:
 *   1. Operator exact/substring override.
 *   2. Dynamic catalog entry from an account snapshot.
 *   3. Exact id match in static table (lowercased).
 *   4. Substring match across the table (longest key wins via the order here).
 *   5. Family defaults: claude -> 1M, gemini -> 1M, gpt-oss -> 131_072.
 *   6. Defensive fallback: 128_000.
 */
export function getAntigravityContextWindow(model: string): number {
  if (!model) return FALLBACK_CONTEXT_WINDOW;
  const lower = model.toLowerCase().trim();
  if (!lower) return FALLBACK_CONTEXT_WINDOW;
  const overrideCtx = getModelSpecOverride(lower)?.contextWindow;
  if (typeof overrideCtx === "number" && Number.isFinite(overrideCtx) && overrideCtx > 0) {
    return overrideCtx;
  }
  const dynamicCtx = dynamicCatalog.getContextWindow(lower);
  if (typeof dynamicCtx === "number") return dynamicCtx;
  const exact = ANTIGRAVITY_CONTEXT_WINDOWS[lower];
  if (typeof exact === "number") return exact;
  // Substring fallback: pick the longest registered key that appears in lower.
  let best: { key: string; value: number } | null = null;
  for (const [key, value] of Object.entries(ANTIGRAVITY_CONTEXT_WINDOWS)) {
    if (lower.includes(key)) {
      if (!best || key.length > best.key.length) best = { key, value };
    }
  }
  if (best) return best.value;
  if (lower.includes("claude")) return CLAUDE_DEFAULT_CONTEXT_WINDOW;
  if (lower.includes("gemini")) return GEMINI_DEFAULT_CONTEXT_WINDOW;
  if (lower.includes("gpt-oss")) return GPT_OSS_DEFAULT_CONTEXT_WINDOW;
  return FALLBACK_CONTEXT_WINDOW;
}

export interface CompatModelEntry {
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
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
}

export function getEffectiveAntigravityModels(): CompatModelEntry[] {
  const dynamic = dynamicCatalog.getAllModels();
  const byId = new Map(dynamic.map((model) => [model.id.toLowerCase(), model]));
  const toCompatModel = (
    model: (typeof dynamic)[number],
    id = model.id,
    tools = model.tools,
  ): CompatModelEntry => {
    const spec = getModelSpec(model.id);
    return {
      id,
      family: model.family,
      ctx: spec.contextWindow ?? model.ctx,
      quotaPool: model.quotaPool,
      multimodal: model.multimodal,
      tools,
      maxOutputTokens: spec.maxOutputTokens,
      thinkingBudget: spec.thinkingBudget,
      minThinkingBudget: spec.minThinkingBudget,
      isThinking: spec.isThinking,
    };
  };
  const result = dynamic.map((model) => toCompatModel(model));

  // Keep the OpenAI audio compatibility name only while its configured target
  // appears in a current Antigravity account snapshot.
  if (!byId.has("whisper-1")) {
    const target = applyModelAlias("whisper-1")
      .trim()
      .replace(/^models\//i, "")
      .toLowerCase();
    const backingModel = byId.get(target);
    if (backingModel) result.push(toCompatModel(backingModel, "whisper-1", false));
  }

  return result;
}

/** Whether an id or configured operator alias resolves to a current snapshot model. */
export function isDynamicallyAvailableAntigravityModel(model: string): boolean {
  const normalize = (value: string) => value.trim().replace(/^models\//i, "").toLowerCase();
  const normalized = normalize(model);
  const aliased = normalize(applyModelAlias(model));
  return Boolean(
    dynamicCatalog.getModel(normalized) ??
      dynamicCatalog.getModel(aliased),
  );
}
