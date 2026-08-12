// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Adapted from NVIDIA-NeMo/Switchyard commit 48b3b71d3cc629aa9eb011852f5a7da90957ba22.

import type { AutoCandidate } from "./types.js";

export const DEFAULT_CLASSIFIER_PROMPT =
  "Choose the model that is most capable of completing the request. Return independent confidence scores for every candidate.";

export interface ClassifierContract {
  systemPrompt: string;
  responseFormat: Record<string, unknown>;
  targets: string[];
}

export function buildClassifierContract(
  candidates: readonly AutoCandidate[],
  prompt?: string,
): ClassifierContract {
  const systemPrompt = prompt ?? DEFAULT_CLASSIFIER_PROMPT;
  if (!systemPrompt.trim()) throw new Error("classifier prompt must not be empty");
  if (systemPrompt.includes("{{RESPONSE_SCHEMA}}")) {
    throw new Error("classifier prompt must not include {{RESPONSE_SCHEMA}}");
  }
  const targets = candidates.map((candidate) => candidate.model);
  const properties: Record<string, unknown> = {};
  for (const target of targets) properties[target] = { type: "number", minimum: 0, maximum: 1 };
  return {
    systemPrompt,
    targets,
    responseFormat: {
      type: "json_schema",
      json_schema: {
        name: "rotator_auto_classifier_response",
        strict: true,
        schema: {
          type: "object",
          properties: { scores: { type: "object", properties, required: targets, additionalProperties: false } },
          required: ["scores"],
          additionalProperties: false,
        },
      },
    },
  };
}
