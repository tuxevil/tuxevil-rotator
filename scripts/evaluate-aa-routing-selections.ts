import { readFile } from "node:fs/promises";

type Assessment = {
  status?: string;
  scoreVersion?: string;
  selectedScore?: number;
  rank?: number;
  comparableCandidates?: number;
  relativeToBest?: number;
  alignment?: string;
  selectedModel?: string;
};

type Decision = {
  event?: unknown;
  mode?: unknown;
  classifier_effort?: unknown;
  aa_quality_assessment?: {
    snapshot?: unknown;
    served?: Assessment;
    classifier_recommendation?: Assessment;
    effort_pool_recommendation?: Assessment;
  };
};

type Aggregate = {
  kind: string;
  scoreVersion: string;
  effort: string;
  mode: string;
  selectedModel: string;
  decisions: number;
  rankCount: number;
  topRank: number;
  rankSum: number;
  relativeSum: number;
  relativeCount: number;
  alignmentCounts: Record<string, number>;
};

const [logPath] = process.argv.slice(2);
if (!logPath) throw new Error("Usage: npx tsx scripts/evaluate-aa-routing-selections.ts ROTATOR_LOG.jsonl");

const text = await readFile(logPath, "utf8");
const groups = new Map<string, Aggregate>();
let decisionEvents = 0;
let assessments = 0;
let malformedLines = 0;

function parseLine(line: string): unknown {
  const start = line.indexOf("{");
  if (start < 0) throw new Error("No JSON object");
  return JSON.parse(line.slice(start));
}

function record(kind: string, effort: string, mode: string, assessment: Assessment | undefined): void {
  if (!assessment) return;
  const version = assessment.scoreVersion ?? "unscored";
  const selectedModel = typeof assessment.selectedModel === "string"
    ? assessment.selectedModel
    : "unknown";
  const key = `${kind}\u0000${version}\u0000${effort}\u0000${mode}\u0000${selectedModel}`;
  const aggregate = groups.get(key) ?? {
    kind,
    scoreVersion: version,
    effort,
    mode,
    selectedModel,
    decisions: 0,
    rankCount: 0,
    topRank: 0,
    rankSum: 0,
    relativeSum: 0,
    relativeCount: 0,
    alignmentCounts: {},
  };
  aggregate.decisions += 1;
  if (typeof assessment.rank === "number" && Number.isFinite(assessment.rank)) {
    aggregate.rankCount += 1;
    aggregate.rankSum += assessment.rank;
    if (assessment.rank === 1) aggregate.topRank += 1;
  }
  if (typeof assessment.relativeToBest === "number" && Number.isFinite(assessment.relativeToBest)) {
    aggregate.relativeSum += assessment.relativeToBest;
    aggregate.relativeCount += 1;
  }
  const alignment = assessment.alignment ?? "unknown";
  aggregate.alignmentCounts[alignment] = (aggregate.alignmentCounts[alignment] ?? 0) + 1;
  groups.set(key, aggregate);
  assessments += 1;
}

for (const line of text.split(/\r?\n/)) {
  if (!line.trim()) continue;
  let parsed: Decision;
  try {
    parsed = parseLine(line) as Decision;
  } catch {
    malformedLines += 1;
    continue;
  }
  if (parsed.event !== "auto-routing-decision") continue;
  decisionEvents += 1;
  const assessment = parsed.aa_quality_assessment;
  if (!assessment) continue;
  const effort = typeof parsed.classifier_effort === "string" ? parsed.classifier_effort : "unknown";
  const mode = typeof parsed.mode === "string" ? parsed.mode : "unknown";
  record("served", effort, mode, assessment.served);
  record("classifier_recommendation", effort, mode, assessment.classifier_recommendation);
  record("effort_pool_recommendation", effort, mode, assessment.effort_pool_recommendation);
}

const results = [...groups.values()]
  .sort((a, b) => a.kind.localeCompare(b.kind) || a.scoreVersion.localeCompare(b.scoreVersion) || a.effort.localeCompare(b.effort) || a.selectedModel.localeCompare(b.selectedModel))
  .map(group => ({
    kind: group.kind,
    scoreVersion: group.scoreVersion,
    effort: group.effort,
    mode: group.mode,
    selectedModel: group.selectedModel,
    decisions: group.decisions,
    scored: group.rankCount,
    topRankRate: group.rankCount ? Number((group.topRank / group.rankCount).toFixed(4)) : null,
    meanRank: group.rankCount ? Number((group.rankSum / group.rankCount).toFixed(2)) : null,
    meanRelativeToBest: group.relativeCount ? Number((group.relativeSum / group.relativeCount).toFixed(4)) : null,
    alignmentCounts: group.alignmentCounts,
  }));

console.log(JSON.stringify({
  evaluatedAt: new Date().toISOString(),
  source: logPath,
  metric: "Artificial Analysis Intelligence Index alignment; not measured completion correctness",
  decisionEvents,
  assessments,
  malformedLines,
  groups: results,
}, null, 2));
