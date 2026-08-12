// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Adapted from NVIDIA-NeMo/Switchyard at commit
// 48b3b71d3cc629aa9eb011852f5a7da90957ba22.

/** A candidate model that may serve an `auto` request. */
export interface AutoCandidate {
  model: string;
  description?: string;
  strengths?: string[];
  limitations?: string[];
  stageRole?: "efficient" | "capable";
}

export interface AutoJudgeConfig {
  /** A model candidate used as an in-rotator judge. */
  model?: string;
  /** An OpenAI-compatible endpoint used as the judge. */
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
  prompt?: string;
}

export interface AutoStageConfig {
  picker?: "efficient_first" | "capable_first";
  confidenceThreshold?: number;
  signalRecentWindow?: number;
  handoffNotes?: {
    escalation?: string;
    deescalation?: string;
    onlyOnSignalEscalation?: boolean;
  };
  systemPrompts?: Partial<Record<"efficient" | "capable", string>>;
}

export interface AutoTrajectoryConfig {
  confirmations?: number;
  recentTurnWindow?: number;
  windowMessageChars?: number;
  judge?: AutoJudgeConfig;
  failureMode?: "fail_open" | "fallback_model";
  threshold?: number;
}

export type AutoSessionPolicy = "sticky" | "per-request" | "sticky-escalation";

export interface AutoConfig {
  candidates: AutoCandidate[];
  fallbackModel: string;
  sessionPolicy?: AutoSessionPolicy;
  selectionPolicy?: "highest_score";
  judge?: AutoJudgeConfig;
  stage?: AutoStageConfig;
  trajectory?: AutoTrajectoryConfig;
  escalationMode?: "stage" | "trajectory";
  affinityTtlMs?: number;
}

export interface AutoRoutingStats {
  decisions: number;
  bySource: Record<string, number>;
  byTarget: Record<string, number>;
  fallbacks: number;
  judgeCalls: number;
  judgeFailures: number;
  judgeLatencyMs: number;
  judgeTokens: number;
  modelTokens: number;
  escalations: number;
  lastDecision?: AutoDecision;
}

export interface AutoDecision {
  requestedModel: "auto";
  selectedModel: string;
  source:
    | "single-candidate"
    | "llm-classifier"
    | "stage-override"
    | "stage-tests-passed"
    | "stage-dimensions"
    | "stage-fall-open"
    | "affinity"
    | "fallback"
    | "trajectory-efficient"
    | "trajectory-capable";
  rationale: string;
  confidence?: number;
  scores?: Array<{ target: string; confidence: number }>;
  fallback?: boolean;
  sessionKey?: string;
  handoffNote?: string;
  systemPrompt?: string;
}

export interface AutoRequestEnvelope {
  model: string;
  messages: Array<Record<string, unknown>>;
  stream?: boolean;
  tools?: unknown;
  instructions?: unknown;
  input?: unknown;
  previousResponseId?: string | null;
  sessionId?: string | null;
}
