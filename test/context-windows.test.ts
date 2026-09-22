import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getAntigravityContextWindow } from "../src/providers/google-antigravity/catalog.js";
import { CODEX_BASE_MODELS } from "../src/providers/openai-codex/catalog.js";
import {
  OPENCODE_ZEN_CATALOG,
  OPENCODE_ZEN_FREE_MODELS,
  getOpenCodeZenContextWindow,
} from "../src/providers/opencode-zen/catalog.js";
import {
	getModelSpec,
	setModelSpecsOverride,
} from "../src/compat/model-specs.js";

/**
 * Verify each catalog model has a positive, finite context window.
 *
 * Where the source maps to a known upstream we hardcode the expected value
 * (kept in sync with the doc URLs cited in each provider's catalog file).
 */
describe("official context windows", () => {
	describe("google antigravity", () => {
		const knownPairs: ReadonlyArray<readonly [string, number]> = [
			["claude-opus-4-6-thinking", 1_000_000],
			["claude-opus-4-6", 1_000_000],
			["claude-sonnet-4-6", 1_000_000],
			["claude-sonnet-4-6-thinking", 1_000_000],
			["claude-opus-4-5", 200_000],
			["claude-sonnet-4-5", 200_000],
			["gpt-oss-120b", 131_072],
			["gpt-oss-120b-medium", 131_072],
			["gemini-3.1-pro", 1_000_000],
			["gemini-3.1-pro-high", 1_000_000],
			["gemini-3.1-pro-low", 1_000_000],
			["gemini-3.7-flash", 1_000_000],
			["gemini-3.7-flash-tiered", 1_000_000],
			["gemini-3.8-flash-high", 1_000_000],
			["gemini-3.8-flash-medium", 1_000_000],
			["gemini-3.8-flash-low", 1_000_000],
			["gemini-3.6-flash", 1_000_000],
			["gemini-3-flash", 1_000_000],
			["gemini-3-flash-agent", 1_000_000],
			["gemini-2.5-pro", 1_000_000],
			["gemini-2.5-flash", 1_000_000],
			["gemini-pro-agent", 1_000_000],
		];

		for (const [model, expected] of knownPairs) {
			it(`resolves ${model} to ${expected}`, () => {
				assert.equal(getAntigravityContextWindow(model), expected);
			});
		}

		it("falls back to 1M for new Claude family ids not in the table", () => {
			assert.equal(getAntigravityContextWindow("claude-future-model"), 1_000_000);
		});

		it("falls back to 1M for new Gemini family ids not in the table", () => {
			assert.equal(getAntigravityContextWindow("gemini-9-ultra"), 1_000_000);
		});

		it("returns the defensive fallback for unrelated ids", () => {
			assert.equal(getAntigravityContextWindow("totally-unknown-model"), 128_000);
		});

		it("returns the defensive fallback for empty input", () => {
			assert.equal(getAntigravityContextWindow(""), 128_000);
		});

		it("propagates contextWindow through getModelSpec for Antigravity ids", () => {
			assert.equal(getModelSpec("claude-sonnet-4-6").contextWindow, 1_000_000);
			assert.equal(getModelSpec("gemini-3.1-pro-low").contextWindow, 1_000_000);
			assert.equal(getModelSpec("gpt-oss-120b-medium").contextWindow, 131_072);
		});

		it("honors an exact operator context window override", () => {
			setModelSpecsOverride({
				"gemini-3.8-flash-high": { contextWindow: 222_222 },
			});
			try {
				assert.equal(getModelSpec("gemini-3.8-flash-high").contextWindow, 222_222);
				assert.equal(getAntigravityContextWindow("gemini-3.8-flash-high"), 222_222);
			} finally {
				setModelSpecsOverride(null);
			}
		});

		it("honors a substring operator context window override", () => {
			setModelSpecsOverride({
				"gemini-3.8": { contextWindow: 333_333 },
			});
			try {
				assert.equal(getModelSpec("gemini-3.8-flash-high").contextWindow, 333_333);
				assert.equal(getAntigravityContextWindow("gemini-3.8-flash-high"), 333_333);
			} finally {
				setModelSpecsOverride(null);
			}
		});
	});

	describe("openai codex", () => {
		it("uses 1.05M context for GPT-6 and GPT-5.6 IDs", () => {
			assert.equal(CODEX_BASE_MODELS.length, 6);
			for (const model of CODEX_BASE_MODELS) {
				assert.equal(model.contextWindow, 1_050_000);
			}
		});
	});

	describe("opencode zen", () => {
		it("exposes a 128K context window for every curated free model", () => {
			assert.equal(OPENCODE_ZEN_FREE_MODELS.length, OPENCODE_ZEN_CATALOG.length);
			for (const spec of OPENCODE_ZEN_CATALOG) {
				assert.equal(spec.contextWindow, 128_000);
				assert.equal(getOpenCodeZenContextWindow(spec.id), 128_000);
			}
		});
	});
});
