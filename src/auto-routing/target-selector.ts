// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Adapted from NVIDIA-NeMo/Switchyard commit 48b3b71d3cc629aa9eb011852f5a7da90957ba22.

import { argmax, type Score } from "./classifier.js";

export function selectTarget(scores: readonly Score[]): Score | null {
  return argmax(scores);
}

export function eligibleTargets(
  candidates: readonly string[],
  allowedModels?: readonly string[],
): string[] {
  if (!allowedModels || allowedModels.length === 0 || allowedModels.includes("*")) return [...candidates];
  return candidates.filter((candidate) =>
    allowedModels.some((allowed) => candidate.toLowerCase() === allowed.toLowerCase() || candidate.toLowerCase().includes(allowed.toLowerCase())),
  );
}

export function selectFallback(
  fallbackModel: string,
  candidates: readonly string[],
  allowedModels?: readonly string[],
): string | null {
  if (fallbackModel === "auto") return null;
  return eligibleTargets([fallbackModel], allowedModels).length > 0 && candidates.includes(fallbackModel)
    ? fallbackModel
    : null;
}
