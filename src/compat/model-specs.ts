import { dynamicCatalog } from "../providers/google-antigravity/dynamic-catalog.js";

export interface ModelSpec {
	maxOutputTokens: number;
	thinkingBudget: number; // -1 = adaptive (model decides), >=0 = fixed
	minThinkingBudget?: number;
	isThinking: boolean;
	/** Upstream-published context window (input tokens). Optional. */
	contextWindow?: number;
}

export type ModelSpecOverride = Partial<ModelSpec>;

export const DEFAULT_MODEL_SPECS: Record<string, ModelSpec> = {
	"gemini-pro-agent":          { maxOutputTokens: 65535, thinkingBudget: 10001, isThinking: true, contextWindow: 1_000_000 },
	"gemini-3-flash-agent":      { maxOutputTokens: 65536, thinkingBudget: 10000, isThinking: true, contextWindow: 1_000_000 },
	"gemini-3-pro-high":         { maxOutputTokens: 65535, thinkingBudget: 10001, isThinking: true, contextWindow: 1_000_000 },
	"gemini-3-pro-low":          { maxOutputTokens: 65535, thinkingBudget: 1001,  isThinking: true, contextWindow: 1_000_000 },
	"gemini-3.1-pro":            { maxOutputTokens: 65535, thinkingBudget: 10001, isThinking: true, contextWindow: 1_000_000 },
	"gemini-3.1-pro-high":       { maxOutputTokens: 65535, thinkingBudget: 10001, isThinking: true, contextWindow: 1_000_000 },
	"gemini-3.1-pro-low":        { maxOutputTokens: 65535, thinkingBudget: 1001,  isThinking: true, contextWindow: 1_000_000 },
	"gemini-3.1-pro-preview":    { maxOutputTokens: 65535, thinkingBudget: 10001, isThinking: true, contextWindow: 1_000_000 },
	"gemini-3.6-flash-high":     { maxOutputTokens: 65536, thinkingBudget: 10000, isThinking: true, contextWindow: 1_000_000 },
	"gemini-3.6-flash-medium":   { maxOutputTokens: 65536, thinkingBudget: 4000,  isThinking: true, contextWindow: 1_000_000 },
	"gemini-3.6-flash-low":      { maxOutputTokens: 65536, thinkingBudget: 1000,  isThinking: true, contextWindow: 1_000_000 },
	"gemini-3.6-flash-tiered":   { maxOutputTokens: 65536, thinkingBudget: -1,    isThinking: true, contextWindow: 1_000_000 },
	"gemini-3.7-flash-tiered":   { maxOutputTokens: 65536, thinkingBudget: -1,    isThinking: true, contextWindow: 1_000_000 },
	"gemini-3.8-flash-high":     { maxOutputTokens: 65536, thinkingBudget: -1,    isThinking: true, contextWindow: 1_000_000 },
	"gemini-3.8-flash-medium":   { maxOutputTokens: 65536, thinkingBudget: -1,    isThinking: true, contextWindow: 1_000_000 },
	"gemini-3.8-flash-low":      { maxOutputTokens: 65536, thinkingBudget: -1,    isThinking: true, contextWindow: 1_000_000 },
	"gemini-3.5-flash-lite":     { maxOutputTokens: 65536, thinkingBudget: -1,    isThinking: true, contextWindow: 1_000_000 },
	"gemini-3-flash":            { maxOutputTokens: 65536, thinkingBudget: 4000,  isThinking: true, contextWindow: 1_000_000 },
	"gemini-2.5-flash":          { maxOutputTokens: 65535, thinkingBudget: 24576, isThinking: true, contextWindow: 1_000_000 },
	"gemini-2.5-pro":            { maxOutputTokens: 65535, thinkingBudget: 1024,  isThinking: true, contextWindow: 1_000_000 },
	"claude-sonnet-4-6":         { maxOutputTokens: 64000, thinkingBudget: 32768, isThinking: true, contextWindow: 1_000_000 },
	"claude-sonnet-4-6-thinking":{ maxOutputTokens: 64000, thinkingBudget: 32768, isThinking: true, contextWindow: 1_000_000 },
	"claude-opus-4-6-thinking":  { maxOutputTokens: 64000, thinkingBudget: 32768, isThinking: true, contextWindow: 1_000_000 },
	"claude-opus-4-6":           { maxOutputTokens: 64000, thinkingBudget: 32768, isThinking: true, contextWindow: 1_000_000 },
	"claude-sonnet-4-5":         { maxOutputTokens: 64000, thinkingBudget: 32768, isThinking: true, contextWindow: 200_000 },
	"claude-sonnet-4-5-thinking":{ maxOutputTokens: 64000, thinkingBudget: 32768, isThinking: true, contextWindow: 200_000 },
	"claude-opus-4-5":           { maxOutputTokens: 64000, thinkingBudget: 32768, isThinking: true, contextWindow: 200_000 },
	"claude-opus-4-5-thinking":  { maxOutputTokens: 64000, thinkingBudget: 32768, isThinking: true, contextWindow: 200_000 },
	"gpt-oss-120b-medium":       { maxOutputTokens: 32768, thinkingBudget: 8192,  isThinking: true, contextWindow: 131_072 },
	"gpt-oss-120b":              { maxOutputTokens: 32768, thinkingBudget: 8192,  isThinking: true, contextWindow: 131_072 },
};

let modelSpecsOverride: Record<string, ModelSpecOverride> | null = null;

/**
 * Apply operator-provided partial overrides over effective model specs.
 * Pass `null` to restore defaults. Called once at startup from index.ts.
 */
export function setModelSpecsOverride(specs: Record<string, ModelSpecOverride> | null): void {
	modelSpecsOverride = specs && Object.keys(specs).length > 0
		? Object.fromEntries(
			Object.entries(specs).map(([key, spec]) => [key.toLowerCase(), spec]),
		)
		: null;
}

export function getActiveModelSpecs(): Record<string, ModelSpec> {
	if (!modelSpecsOverride) return DEFAULT_MODEL_SPECS;
	return Object.fromEntries(
		Object.keys(modelSpecsOverride).map((model) => [model, getModelSpec(model)]),
	);
}

const GEMINI_MAX_OUTPUT_TOKENS = 65536;
const CLAUDE_MAX_OUTPUT_TOKENS = 64000;
const FALLBACK_THINKING_BUDGET = 24576;
const CLAUDE_DEFAULT_THINKING_BUDGET = 32768;

export function getModelFamily(model: string): "claude" | "gemini" | "unknown" {
	const l = model.toLowerCase();
	if (l.includes("claude")) return "claude";
	if (l.includes("gemini")) return "gemini";
	return "unknown";
}

/** Resolve bundled static metadata without consulting the dynamic registry. */
export function getStaticModelSpec(model: string): ModelSpec | undefined {
	const lower = model.toLowerCase();
	if (DEFAULT_MODEL_SPECS[lower]) return DEFAULT_MODEL_SPECS[lower];
	let best: { key: string; spec: ModelSpec } | undefined;
	for (const [key, spec] of Object.entries(DEFAULT_MODEL_SPECS)) {
		if (lower.includes(key) && (!best || key.length > best.key.length)) {
			best = { key, spec };
		}
	}
	return best?.spec;
}

export function getModelSpecOverride(model: string): ModelSpecOverride | undefined {
	if (!modelSpecsOverride) return undefined;
	const lower = model.toLowerCase();
	if (modelSpecsOverride[lower]) return modelSpecsOverride[lower];
	for (const [key, spec] of Object.entries(modelSpecsOverride)) {
		if (lower.includes(key)) return spec;
	}
	return undefined;
}

function mergeModelSpec(
	defaults: ModelSpec,
	override: ModelSpecOverride,
): ModelSpec {
	const minThinkingBudget = typeof override.minThinkingBudget === "number" &&
		Number.isFinite(override.minThinkingBudget) &&
		override.minThinkingBudget >= 0
		? override.minThinkingBudget
		: defaults.minThinkingBudget;
	const contextWindow = typeof override.contextWindow === "number" &&
		Number.isFinite(override.contextWindow) &&
		override.contextWindow > 0
		? override.contextWindow
		: defaults.contextWindow;
	return {
		maxOutputTokens: typeof override.maxOutputTokens === "number" &&
			Number.isFinite(override.maxOutputTokens) &&
			override.maxOutputTokens > 0
			? override.maxOutputTokens
			: defaults.maxOutputTokens,
		thinkingBudget: typeof override.thinkingBudget === "number" &&
			Number.isFinite(override.thinkingBudget)
			? override.thinkingBudget
			: defaults.thinkingBudget,
		...(minThinkingBudget !== undefined ? { minThinkingBudget } : {}),
		isThinking: typeof override.isThinking === "boolean"
			? override.isThinking
			: defaults.isThinking,
		...(contextWindow !== undefined ? { contextWindow } : {}),
	};
}

export function getModelSpec(model: string): ModelSpec {
	const lower = model.toLowerCase();
	const dynamicSpec = dynamicCatalog.getModelSpec(lower);
	const staticSpec = getStaticModelSpec(lower);
	const family = getModelFamily(model);
	const defaults = dynamicSpec ?? staticSpec ??
		(family === "claude"
			? { maxOutputTokens: CLAUDE_MAX_OUTPUT_TOKENS, thinkingBudget: CLAUDE_DEFAULT_THINKING_BUDGET, isThinking: true, contextWindow: 1_000_000 }
			: family === "gemini"
				? { maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS, thinkingBudget: FALLBACK_THINKING_BUDGET, isThinking: true, contextWindow: 1_000_000 }
				: { maxOutputTokens: 65536, thinkingBudget: FALLBACK_THINKING_BUDGET, isThinking: false, contextWindow: 128_000 });
	const override = getModelSpecOverride(lower);
	return override ? mergeModelSpec(defaults, override) : defaults;
}

export function isThinkingModel(model: string): boolean {
	return getModelSpec(model).isThinking;
}
