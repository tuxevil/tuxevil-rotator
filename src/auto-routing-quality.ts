/**
 * Dated Artificial Analysis Intelligence Index snapshot used only to assess
 * routing decisions. It is deliberately separate from selection policy:
 * benchmark evidence must never grant access or change a selected model.
 */
export type AAScoreVersion = "v5.0" | "v4.3.2";
export type AAScoreAlignment = "model-effort-exact" | "effort-proxy" | "base-model-proxy" | "estimated" | "conflicted";

interface AAScoreRecord {
  name: string;
  effort: string | null;
  scores: Partial<Record<AAScoreVersion, number>>;
  source: string;
  note?: string;
}

interface AARouterAlias {
  scoreId: string;
  alignment: AAScoreAlignment;
}

export interface AARoutingCandidate {
  providerId: string;
  modelId: string;
}

export interface AARoutingAssessment {
  status: "ranked" | "insufficient-comparison" | "unscored" | "conflicted";
  metric: "artificial-analysis-intelligence-index";
  snapshot: string;
  scoreVersion?: AAScoreVersion;
  selectedModel: string;
  selectedScore?: number;
  benchmarkModel?: string;
  benchmarkEffort?: string | null;
  benchmarkSource?: string;
  benchmarkNote?: string;
  servingMatch?: "not-verified";
  alignment?: AAScoreAlignment;
  rank?: number;
  comparableCandidates: number;
  scoredCandidates: number;
  unscoredCandidates: number;
  estimatedCandidates: number;
  bestCandidate?: { providerId: string; modelId: string; score: number };
  gapToBest?: number;
  relativeToBest?: number;
}

export const AA_ROUTING_SCORE_SNAPSHOT = "2026-10-31";

const SCORE_RECORDS: Record<string, AAScoreRecord> = {
  "gemini-3.8-flash-high": {
    name: "Gemini 3.8 Flash", effort: "High", scores: { "v4.3.2": 41, "v5.0": 31 },
    source: "https://artificialanalysis.ai/models/comparisons/gemini-4-argon-vs-gemini-3-8-flash",
  },
  "gemini-4-argon-high": {
    name: "Gemini 4 Argon", effort: "High", scores: { "v4.3.2": 53, "v5.0": 50 },
    source: "https://artificialanalysis.ai/models/comparisons/gemini-4-argon-vs-gemini-3-8-flash",
  },
  "claude-sonnet-5-5-max": {
    name: "Claude Sonnet 5.5", effort: "Max", scores: { "v4.3.2": 56, "v5.0": 54 },
    source: "https://artificialanalysis.ai/models/comparisons/claude-opus-5-5-vs-claude-sonnet-5-5",
  },
  "claude-opus-5-5-max": {
    name: "Claude Opus 5.5", effort: "Max", scores: { "v4.3.2": 58, "v5.0": 58 },
    source: "https://artificialanalysis.ai/models/comparisons/claude-opus-5-5-vs-claude-sonnet-5-5",
  },
  "gpt-6-luna-max": {
    name: "GPT-6 Luna", effort: "Max", scores: { "v4.3.2": 38, "v5.0": 28 },
    source: "https://artificialanalysis.ai/models/releases/comparisons/gpt-6-1-terra-vs-gpt-6-luna",
  },
  beam: {
    name: "Beam", effort: null, scores: { "v4.3.2": 30, "v5.0": 18 },
    source: "https://artificialanalysis.ai/models/comparisons/reflection-beam-vs-step-5",
  },
  "gpt-6-astra-max": {
    name: "GPT-6 Astra", effort: "Max", scores: { "v4.3.2": 53, "v5.0": 57 },
    source: "https://artificialanalysis.ai/models/gpt-6-astra/",
  },
  "gpt-6-sol-max": {
    name: "GPT-6 Sol", effort: "Max", scores: { "v4.3.2": 48 },
    source: "https://artificialanalysis.ai/models/gpt-6-sol/",
  },
  "gpt-5.6-sol-max": {
    name: "GPT-5.6 Sol", effort: "Max", scores: { "v4.3.2": 47 },
    source: "https://artificialanalysis.ai/models/gpt-5-6-sol",
  },
  "gpt-5.6-terra-max": {
    name: "GPT-5.6 Terra", effort: "Max", scores: { "v4.3.2": 42 },
    source: "https://artificialanalysis.ai/models/gpt-5-6-terra",
  },
  "gpt-5.6-luna-max": {
    name: "GPT-5.6 Luna", effort: "Max", scores: { "v4.3.2": 37 },
    source: "https://artificialanalysis.ai/models/gpt-5-6-luna",
  },
  "gpt-6.1-terra-max": {
    name: "GPT-6.1 Terra", effort: "Max", scores: { "v5.0": 51 },
    source: "https://artificialanalysis.ai/models/gpt-6-1-terra",
  },
  "claude-sonnet-4-6-max": {
    name: "Claude Sonnet 4.6", effort: "Max", scores: { "v4.3.2": 30 },
    source: "https://artificialanalysis.ai/models/releases/claude-sonnet-4-6",
    note: "La ficha actual también expone una variante no-reasoning con otro resultado.",
  },
  "claude-opus-4-6-max": {
    name: "Claude Opus 4.6", effort: "Max", scores: { "v4.3.2": 32 },
    source: "https://artificialanalysis.ai/models/claude-opus-4-6-adaptive/",
    note: "Artificial Analysis marca esta observación como estimada.",
  },
  "gemma-4-31b-reasoning": {
    name: "Gemma 4 31B", effort: "Reasoning", scores: { "v4.3.2": 15 },
    source: "https://artificialanalysis.ai/models/gemma-4-31b/",
  },
  "gpt-oss-20b-high": {
    name: "gpt-oss-20b", effort: "High", scores: { "v4.3.2": 9 },
    source: "https://artificialanalysis.ai/models/gpt-oss-20b",
    note: "La variante Low figura con 10*; la ruta del router no fija ese esfuerzo.",
  },
  "gpt-oss-120b-high": {
    name: "gpt-oss-120b", effort: "High", scores: { "v4.3.2": 12 },
    source: "https://artificialanalysis.ai/models/gpt-oss-120b",
    note: "La variante Low figura con 10*; la ruta del router no fija ese esfuerzo.",
  },
  "nemotron-3-nano-30b-reasoning": {
    name: "Nemotron 3 Nano 30B A3B", effort: "Reasoning", scores: { "v4.3.2": 9 },
    source: "https://artificialanalysis.ai/models/nvidia-nemotron-3-nano-30b-a3b",
    note: "La variante no-reasoning figura con 7.",
  },
  "nemotron-3-super-reasoning": {
    name: "Nemotron 3 Super", effort: "Reasoning", scores: { "v4.3.2": 13 },
    source: "https://artificialanalysis.ai/models/nvidia-nemotron-3-super-120b-a12b",
  },
  "nemotron-3-ultra-reasoning": {
    name: "Nemotron 3 Ultra", effort: "Reasoning", scores: { "v4.3.2": 23, "v5.0": 12 },
    source: "https://artificialanalysis.ai/models/nvidia-nemotron-3-ultra-550b-a55b",
  },
  "nemotron-3.5-lightning-conflicted": {
    name: "Nemotron 3.5 Lightning", effort: "Reasoning", scores: {},
    source: "https://artificialanalysis.ai/models/comparisons/nemotron-3-5-lightning-vs-mimo-v2-5-0424",
    note: "Se excluye del ranking: comparaciones actuales muestran 13 y el artículo de lanzamiento 24.",
  },
  "mimo-v2.5": {
    name: "MiMo-V2.5", effort: "Reasoning", scores: { "v4.3.2": 22 },
    source: "https://artificialanalysis.ai/models/mimo-v2-5-0424",
    note: "El endpoint Zen es un alias gratuito; no se confirmó que sirva la misma configuración.",
  },
  "ling-3.0-flash-fin": {
    name: "Ling-3.0-flash-Fin", effort: "Reasoning", scores: { "v4.3.2": 23 },
    source: "https://artificialanalysis.ai/models/ling-3-0-flash-fin",
    note: "El endpoint Zen puede diferir de la configuración evaluada por Artificial Analysis.",
  },
  "muse-spark-1.3-max": {
    name: "Muse Spark 1.3", effort: "Max", scores: { "v4.3.2": 48, "v5.0": 36 },
    source: "https://artificialanalysis.ai/models/muse-spark-1-3",
    note: "El endpoint Zen Contributor puede diferir de la variante Max medida.",
  },
};

/** Exact provider/model allowlist; unknown dynamic catalog entries remain unscored. */
const ROUTER_ALIASES: Record<string, AARouterAlias> = {
  "google-antigravity/gemini-3.8-flash-low": { scoreId: "gemini-3.8-flash-high", alignment: "effort-proxy" },
  "google-antigravity/gemini-3.8-flash-medium": { scoreId: "gemini-3.8-flash-high", alignment: "effort-proxy" },
  "google-antigravity/gemini-3.8-flash-high": { scoreId: "gemini-3.8-flash-high", alignment: "model-effort-exact" },
  "google-antigravity/gemini-4-argon-medium": { scoreId: "gemini-4-argon-high", alignment: "effort-proxy" },
  "google-antigravity/gemini-4-argon-high": { scoreId: "gemini-4-argon-high", alignment: "model-effort-exact" },
  "google-antigravity/gemini-4-argon": { scoreId: "gemini-4-argon-high", alignment: "effort-proxy" },
  "google-antigravity/claude-sonnet-5-5": { scoreId: "claude-sonnet-5-5-max", alignment: "effort-proxy" },
  "google-antigravity/claude-sonnet-5-5-medium": { scoreId: "claude-sonnet-5-5-max", alignment: "effort-proxy" },
  "google-antigravity/claude-sonnet-5-5-high": { scoreId: "claude-sonnet-5-5-max", alignment: "effort-proxy" },
  "google-antigravity/claude-opus-5-5": { scoreId: "claude-opus-5-5-max", alignment: "effort-proxy" },
  "google-antigravity/claude-opus-5-5-high": { scoreId: "claude-opus-5-5-max", alignment: "effort-proxy" },
  "google-antigravity/claude-sonnet-4-6": { scoreId: "claude-sonnet-4-6-max", alignment: "effort-proxy" },
  "google-antigravity/claude-sonnet-4-6-thinking": { scoreId: "claude-sonnet-4-6-max", alignment: "effort-proxy" },
  "google-antigravity/claude-opus-4-6": { scoreId: "claude-opus-4-6-max", alignment: "estimated" },
  "google-antigravity/claude-opus-4-6-thinking": { scoreId: "claude-opus-4-6-max", alignment: "estimated" },
  "google-antigravity/claude-sonnet-4-6-high": { scoreId: "claude-sonnet-4-6-max", alignment: "effort-proxy" },
  "google-antigravity/claude-opus-4-6-high": { scoreId: "claude-opus-4-6-max", alignment: "estimated" },
  "openai-codex/gpt-6-astra": { scoreId: "gpt-6-astra-max", alignment: "effort-proxy" },
  "openai-codex/gpt-6-sol": { scoreId: "gpt-6-sol-max", alignment: "effort-proxy" },
  "openai-codex/gpt-6-luna": { scoreId: "gpt-6-luna-max", alignment: "effort-proxy" },
  "openai-codex/gpt-5.6-sol": { scoreId: "gpt-5.6-sol-max", alignment: "effort-proxy" },
  "openai-codex/gpt-5.6-terra": { scoreId: "gpt-5.6-terra-max", alignment: "effort-proxy" },
  "openai-codex/gpt-5.6-luna": { scoreId: "gpt-5.6-luna-max", alignment: "effort-proxy" },
  "openai-codex/gpt-6.1-terra": { scoreId: "gpt-6.1-terra-max", alignment: "effort-proxy" },
  "ollama/beam": { scoreId: "beam", alignment: "base-model-proxy" },
  "ollama/gemma4:31b": { scoreId: "gemma-4-31b-reasoning", alignment: "base-model-proxy" },
  "ollama/gpt-oss:20b": { scoreId: "gpt-oss-20b-high", alignment: "base-model-proxy" },
  "ollama/gpt-oss:120b": { scoreId: "gpt-oss-120b-high", alignment: "base-model-proxy" },
  "ollama/nemotron-3-nano:30b": { scoreId: "nemotron-3-nano-30b-reasoning", alignment: "base-model-proxy" },
  "ollama/nemotron-3-super": { scoreId: "nemotron-3-super-reasoning", alignment: "base-model-proxy" },
  "ollama/nemotron-3-ultra": { scoreId: "nemotron-3-ultra-reasoning", alignment: "base-model-proxy" },
  "opencode-zen/mimo-v2.5-free": { scoreId: "mimo-v2.5", alignment: "base-model-proxy" },
  "opencode-zen/ling-3.0-flash-fin-free": { scoreId: "ling-3.0-flash-fin", alignment: "base-model-proxy" },
  "opencode-zen/nemotron-3-ultra-free": { scoreId: "nemotron-3-ultra-reasoning", alignment: "base-model-proxy" },
  "opencode-zen/nemotron-3.5-lightning-free": { scoreId: "nemotron-3.5-lightning-conflicted", alignment: "conflicted" },
  "opencode-zen/muse-spark-1.3-contributor-free": { scoreId: "muse-spark-1.3-max", alignment: "base-model-proxy" },
};

function indexValue(record: AAScoreRecord, version: AAScoreVersion): number | undefined {
  const value = record.scores[version];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resolveCandidate(candidate: AARoutingCandidate): { record: AAScoreRecord; alignment: AAScoreAlignment } | null {
  const alias = ROUTER_ALIASES[`${candidate.providerId}/${candidate.modelId}`];
  if (!alias) return null;
  const record = SCORE_RECORDS[alias.scoreId];
  return record ? { record, alignment: alias.alignment } : null;
}

/**
 * Rank a selected route against only the candidates available in that decision.
 * Version choice is based on coverage, with V5 preferred on ties; V4 and V5
 * scores are never compared numerically or converted into one another.
 */
export function assessAARoutingSelection(
  selected: AARoutingCandidate,
  candidates: AARoutingCandidate[],
): AARoutingAssessment {
  const selectedResolved = resolveCandidate(selected);
  const base: AARoutingAssessment = {
    status: "unscored",
    metric: "artificial-analysis-intelligence-index",
    snapshot: AA_ROUTING_SCORE_SNAPSHOT,
    selectedModel: `${selected.providerId}/${selected.modelId}`,
    comparableCandidates: candidates.length,
    scoredCandidates: 0,
    unscoredCandidates: candidates.length,
    estimatedCandidates: 0,
  };
  if (!selectedResolved) return base;
  if (selectedResolved.alignment === "conflicted") return {
    ...base,
    status: "conflicted",
    alignment: "conflicted",
    benchmarkModel: selectedResolved.record.name,
    benchmarkEffort: selectedResolved.record.effort,
    benchmarkSource: selectedResolved.record.source,
    servingMatch: "not-verified",
    ...(selectedResolved.record.note ? { benchmarkNote: selectedResolved.record.note } : {}),
  };

  const selectedVersions = (["v5.0", "v4.3.2"] as const)
    .filter(version => indexValue(selectedResolved.record, version) !== undefined);
  if (!selectedVersions.length) return { ...base, status: "conflicted", alignment: selectedResolved.alignment };

  const resolved = candidates.map(candidate => ({
    candidate,
    model: resolveCandidate(candidate),
  }));
  const versions = selectedVersions
    .map(version => ({
      version,
      coverage: resolved.filter(item => item.model && indexValue(item.model.record, version) !== undefined).length,
      priority: version === "v5.0" ? 1 : 0,
    }))
    .sort((a, b) => b.coverage - a.coverage || b.priority - a.priority);
  const scoreVersion = versions[0]?.version;
  if (!scoreVersion) return { ...base, status: "conflicted", alignment: selectedResolved.alignment };

  const selectedScore = indexValue(selectedResolved.record, scoreVersion);
  if (selectedScore === undefined) return { ...base, status: "conflicted", alignment: selectedResolved.alignment };
  const scored = resolved.flatMap(item => {
    if (!item.model) return [];
    const score = indexValue(item.model.record, scoreVersion);
    if (score === undefined) return [];
    return [{
      providerId: item.candidate.providerId,
      modelId: item.candidate.modelId,
      score,
      alignment: item.model.alignment,
    }];
  });
  const selectedId = `${selected.providerId}/${selected.modelId}`;
  const selectedComparable = scored.find(item => `${item.providerId}/${item.modelId}` === selectedId);
  if (!selectedComparable) return { ...base, status: "conflicted", alignment: selectedResolved.alignment };
  const best = [...scored].sort((a, b) => b.score - a.score || a.providerId.localeCompare(b.providerId) || a.modelId.localeCompare(b.modelId))[0];
  const greater = scored.filter(item => item.score > selectedScore).length;
  const estimatedCandidates = scored.filter(item => item.alignment === "estimated").length;
  const unscoredCandidates = Math.max(0, candidates.length - scored.length);
  return {
    ...base,
    status: scored.length >= 2 ? "ranked" : "insufficient-comparison",
    scoreVersion,
    selectedScore,
    benchmarkModel: selectedResolved.record.name,
    benchmarkEffort: selectedResolved.record.effort,
    benchmarkSource: selectedResolved.record.source,
    servingMatch: "not-verified",
    ...(selectedResolved.record.note ? { benchmarkNote: selectedResolved.record.note } : {}),
    alignment: selectedResolved.alignment,
    rank: greater + 1,
    comparableCandidates: scored.length,
    scoredCandidates: scored.length,
    unscoredCandidates,
    estimatedCandidates,
    bestCandidate: best ? { providerId: best.providerId, modelId: best.modelId, score: best.score } : undefined,
    gapToBest: best ? Number((best.score - selectedScore).toFixed(2)) : undefined,
    relativeToBest: best && best.score > 0 ? Number((selectedScore / best.score).toFixed(4)) : undefined,
  };
}

/** Resolve a public AA source and note for support tools and offline reports. */
export function getAAScoreSource(candidate: AARoutingCandidate): { name: string; source: string; note?: string } | null {
  const resolved = resolveCandidate(candidate);
  return resolved ? { name: resolved.record.name, source: resolved.record.source, ...(resolved.record.note ? { note: resolved.record.note } : {}) } : null;
}
