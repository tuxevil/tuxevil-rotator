import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assessAARoutingSelection,
  type AARoutingCandidate,
} from "../src/auto-routing-quality.js";
import {
  selectAutoRoutingTarget,
  type AutoRoutingCatalogEntry,
  type AutoRoutingRotator,
} from "../src/auto-routing.js";

describe("Artificial Analysis routing assessment", () => {
  it("uses one same-version index and ranks against only the supplied candidate pool", () => {
    const gemini38 = { providerId: "google-antigravity", modelId: "gemini-3.8-flash-high" };
    const gemini4 = { providerId: "google-antigravity", modelId: "gemini-4-argon-high" };
    const assessment = assessAARoutingSelection(gemini38, [gemini38, gemini4]);

    assert.equal(assessment.scoreVersion, "v5.0");
    assert.equal(assessment.selectedScore, 31);
    assert.equal(assessment.rank, 2);
    assert.equal(assessment.bestCandidate?.modelId, "gemini-4-argon-high");
    assert.equal(assessment.gapToBest, 19);
    assert.equal(assessment.relativeToBest, 0.62);
    assert.equal(assessment.comparableCandidates, 2);
    assert.equal(assessment.alignment, "model-effort-exact");
    assert.equal(assessment.servingMatch, "not-verified");
  });

  it("falls back to V4.3.2 when that is the only version for the selected model", () => {
    const sonnet46 = { providerId: "google-antigravity", modelId: "claude-sonnet-4-6" };
    const sonnet55 = { providerId: "google-antigravity", modelId: "claude-sonnet-5-5-high" };
    const gemini38 = { providerId: "google-antigravity", modelId: "gemini-3.8-flash-high" };
    const assessment = assessAARoutingSelection(sonnet46, [sonnet46, sonnet55, gemini38]);

    assert.equal(assessment.scoreVersion, "v4.3.2");
    assert.equal(assessment.selectedScore, 30);
    assert.equal(assessment.rank, 3);
    assert.equal(assessment.comparableCandidates, 3);
  });

  it("keeps a V5-only selected model on V5 even when alternatives also have V4 scores", () => {
    const terra = { providerId: "openai-codex", modelId: "gpt-6.1-terra" };
    const astra = { providerId: "openai-codex", modelId: "gpt-6-astra" };
    const luna = { providerId: "openai-codex", modelId: "gpt-6-luna" };
    const assessment = assessAARoutingSelection(terra, [terra, astra, luna]);

    assert.equal(assessment.scoreVersion, "v5.0");
    assert.equal(assessment.selectedScore, 51);
    assert.equal(assessment.rank, 2);
    assert.equal(assessment.comparableCandidates, 3);
  });

  it("leaves unknown and conflicted model mappings explicit", () => {
    const candidates: AARoutingCandidate[] = [
      { providerId: "opencode-zen", modelId: "nemotron-3.5-lightning-free" },
    ];
    const conflicted = assessAARoutingSelection(candidates[0]!, candidates);
    const unknown = assessAARoutingSelection(
      { providerId: "dynamic", modelId: "not-in-snapshot" },
      [{ providerId: "dynamic", modelId: "not-in-snapshot" }],
    );

    assert.equal(conflicted.status, "conflicted");
    assert.equal(conflicted.scoreVersion, undefined);
    assert.equal(conflicted.selectedScore, undefined);
    assert.equal(unknown.status, "unscored");
    assert.equal(unknown.scoreVersion, undefined);
  });

  it("assesses shadow and normal decisions without changing the selected model", async () => {
    const catalog: AutoRoutingCatalogEntry[] = [
      {
        providerId: "google-antigravity",
        modelId: "gemini-3.8-flash-high",
        contextWindow: 1_000_000,
        multimodal: true,
        tools: true,
        reasoning: true,
      },
      {
        providerId: "google-antigravity",
        modelId: "gemini-4-argon-high",
        contextWindow: 1_000_000,
        multimodal: true,
        tools: true,
        reasoning: true,
      },
    ];
    const config = { typesafeRouting: { enabled: false, shadowMode: true } };
    const rotator = {
      getConfig: () => config,
      hasActiveProvider: () => true,
      getAutoRoutingCandidateStatus: (modelId: string) => ({
        available: true,
        operationalScore: modelId.includes("gemini-4") ? 0.9 : 0.5,
      }),
    } as unknown as AutoRoutingRotator;
    const logArgs: unknown[][] = [];
    const originalInfo = console.info;
    console.info = (...args: unknown[]) => { logArgs.push(args); };
    let selectedModel: string | undefined;
    try {
      const selection = await selectAutoRoutingTarget(rotator, catalog, {
        route: "openai-chat",
        requestedModel: "auto",
        input: { messages: [{ role: "user", content: "Add two numbers" }] },
      });
      selectedModel = selection?.candidate.modelId;
    } finally {
      console.info = originalInfo;
    }

    assert.equal(selectedModel, "gemini-4-argon-high");
    const shadowLog = logArgs.find(args => String(args[1]).includes("auto-routing-decision"));
    assert.ok(shadowLog);
    const shadowEvent = JSON.parse(String(shadowLog[1])) as {
      aa_quality_assessment?: { served?: { scoreVersion?: string; selectedScore?: number; rank?: number } };
    };
    assert.equal(shadowEvent.aa_quality_assessment?.served?.scoreVersion, "v5.0");
    assert.equal(shadowEvent.aa_quality_assessment?.served?.selectedScore, 50);
    assert.equal(shadowEvent.aa_quality_assessment?.served?.rank, 1);

    const normalLog: unknown[][] = [];
    const normalRotator = {
      ...rotator,
      getConfig: () => ({ typesafeRouting: { enabled: false, shadowMode: false } }),
    } as unknown as AutoRoutingRotator;
    let normalSelectedModel: string | undefined;
    console.info = (...args: unknown[]) => { normalLog.push(args); };
    try {
      const selection = await selectAutoRoutingTarget(normalRotator, catalog, {
        route: "openai-chat",
        requestedModel: "auto",
        input: { messages: [{ role: "user", content: "Add two numbers" }] },
      });
      normalSelectedModel = selection?.candidate.modelId;
    } finally {
      console.info = originalInfo;
    }
    const normalEvent = JSON.parse(String(normalLog.find(args => String(args[1]).includes("auto-routing-decision"))?.[1])) as {
      model?: string;
      aa_quality_assessment?: { served?: { scoreVersion?: string; selectedScore?: number; rank?: number } };
    };
    assert.equal(normalSelectedModel, selectedModel);
    assert.equal(normalEvent.model, selectedModel);
    assert.equal(normalEvent.aa_quality_assessment?.served?.scoreVersion, "v5.0");
    assert.equal(normalEvent.aa_quality_assessment?.served?.selectedScore, 50);
    assert.equal(normalEvent.aa_quality_assessment?.served?.rank, 1);
  });
});
