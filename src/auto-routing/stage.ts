// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Adapted from NVIDIA-NeMo/Switchyard commit 48b3b71d3cc629aa9eb011852f5a7da90957ba22.

import { CRITICAL_SEVERITY, HARD_SEVERITY, type ToolSignals } from "./tool-signals.js";

const STALL_MIN_TURN_DEPTH = 8;
const SCORE_GAIN = 5;
const SIGNAL_UNIT = 0.1;

export type Tier = "efficient" | "capable";
export type PickerMode = "efficient_first" | "capable_first";

export type DecisionSource =
  | "override"
  | "tests_passed"
  | "dimensions"
  | "ambiguous"
  | "llm-classifier"
  | "fall_open";

export interface CodingAgentDimensions {
  severity: number;
  spinning: number;
  exploring: number;
  productionIntensity: number;
}

export interface ScoreResult {
  score: number;
  confidence: number;
}

export type PickOutcome =
  | { kind: "resolved"; tier: Tier; source: DecisionSource; score: number; confidence?: number }
  | { kind: "consult-classifier"; score: number; confidence: number; defaultTier: Tier };

export function dimensionsFromSignals(signal: ToolSignals): CodingAgentDimensions {
  const recentOps = signal.recentWriteCount + signal.recentEditCount + signal.recentReadCount + signal.recentPlanCount;
  const deepEnough = signal.turnDepth >= STALL_MIN_TURN_DEPTH;
  const noProduction = signal.recentWriteCount === 0 && signal.recentEditCount === 0;
  const investigating = signal.recentReadCount >= 1 || signal.recentPlanCount >= 1;
  return {
    severity: signal.severity,
    spinning: deepEnough && noProduction && !investigating ? 1 : 0,
    exploring: deepEnough && noProduction && investigating ? 1 : 0,
    productionIntensity: recentOps === 0 ? 0 : (signal.recentWriteCount + signal.recentEditCount) / recentOps,
  };
}

export function scoreSignal(signal: ToolSignals): ScoreResult {
  const dimensions = dimensionsFromSignals(signal);
  const raw = SIGNAL_UNIT * (
    dimensions.severity / HARD_SEVERITY +
    dimensions.spinning +
    dimensions.exploring -
    dimensions.productionIntensity
  );
  const score = Math.tanh(SCORE_GAIN * raw);
  return { score, confidence: Math.abs(score) };
}

export function pickTier(
  signal: ToolSignals,
  mode: PickerMode,
  confidenceThreshold: number,
): PickOutcome {
  if (signal.compacted || signal.severity >= CRITICAL_SEVERITY) {
    return { kind: "resolved", tier: "capable", source: "override", score: 0, confidence: 1 };
  }
  if (signal.testsPassed && signal.recentWriteCount + signal.recentEditCount >= 1 && signal.severity <= 0) {
    return { kind: "resolved", tier: "efficient", source: "tests_passed", score: 0 };
  }
  const scored = scoreSignal(signal);
  if (scored.confidence >= confidenceThreshold) {
    return {
      kind: "resolved",
      tier: scored.score > 0 ? "capable" : "efficient",
      source: "dimensions",
      score: scored.score,
      confidence: scored.confidence,
    };
  }
  return {
    kind: "consult-classifier",
    score: scored.score,
    confidence: scored.confidence,
    defaultTier: mode === "capable_first" ? "capable" : "efficient",
  };
}

export function handoffNote(
  notes: { escalation?: string; deescalation?: string; onlyOnSignalEscalation?: boolean } | undefined,
  tier: Tier,
  source: DecisionSource,
): string | undefined {
  if (!notes) return undefined;
  if (tier === "efficient") return notes.deescalation;
  const isSignalEscalation = source === "override" || source === "dimensions";
  if (notes.onlyOnSignalEscalation !== false && !isSignalEscalation) return undefined;
  return notes.escalation;
}
