// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Adapted from NVIDIA-NeMo/Switchyard commit 48b3b71d3cc629aa9eb011852f5a7da90957ba22.

export interface Score {
  confidence: number;
  target: string;
}

export type Classification =
  | { kind: "scores"; scores: Score[] }
  | { kind: "ambiguous"; scores: Score[] };

export class ClassifierAlgorithmError extends Error {}

/** Highest score; stable because equal scores never replace the first item. */
export function argmax(scores: readonly Score[]): Score | null {
  let best: Score | null = null;
  for (const score of scores) {
    if (Number.isNaN(score.confidence)) {
      throw new ClassifierAlgorithmError(
        `classifier returned NaN confidence for target "${score.target}"`,
      );
    }
    if (best === null || score.confidence > best.confidence) best = score;
  }
  return best;
}

export function classificationArgmax(
  classification: Classification,
  ignoreAmbiguous = false,
): Score | null {
  if (classification.kind === "ambiguous" && !ignoreAmbiguous) return null;
  return argmax(classification.scores);
}

export function validateScores(
  scores: unknown,
  targets: readonly string[],
): Score[] {
  if (!Array.isArray(scores)) throw new ClassifierAlgorithmError("scores must be an array");
  const targetSet = new Set(targets);
  const seen = new Set<string>();
  const result: Score[] = [];
  for (const value of scores) {
    if (!isRecord(value) || typeof value.target !== "string" || typeof value.confidence !== "number") {
      throw new ClassifierAlgorithmError("each score must contain target and confidence");
    }
    if (!targetSet.has(value.target)) {
      throw new ClassifierAlgorithmError(`classifier returned unknown target "${value.target}"`);
    }
    if (seen.has(value.target)) {
      throw new ClassifierAlgorithmError(`classifier returned duplicate target "${value.target}"`);
    }
    if (!Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) {
      throw new ClassifierAlgorithmError(`classifier confidence for "${value.target}" must be between 0 and 1`);
    }
    seen.add(value.target);
    result.push({ target: value.target, confidence: value.confidence });
  }
  if (result.length !== targets.length || targets.some((target) => !seen.has(target))) {
    throw new ClassifierAlgorithmError("classifier must score every eligible target exactly once");
  }
  // Normalize arbitrary judge response ordering to declaration order so ties
  // are resolved deterministically by argmax.
  return targets.map((target) => result.find((score) => score.target === target)!);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
