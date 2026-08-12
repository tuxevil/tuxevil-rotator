// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Adapted from NVIDIA-NeMo/Switchyard commit 48b3b71d3cc629aa9eb011852f5a7da90957ba22.

import type { AutoConfig, AutoJudgeConfig, AutoStageConfig, AutoTrajectoryConfig } from "./types.js";

export function applyAutoConfigDefaults(config: AutoConfig): AutoConfig {
  const errors = validateAutoConfig(config);
  if (errors.length > 0) throw new Error(`Invalid config.auto: ${errors.join("; ")}`);
  return {
    ...config,
    candidates: config.candidates.map((candidate) => ({
      ...candidate,
      strengths: candidate.strengths ? [...candidate.strengths] : undefined,
      limitations: candidate.limitations ? [...candidate.limitations] : undefined,
    })),
    sessionPolicy: config.sessionPolicy ?? "per-request",
    selectionPolicy: config.selectionPolicy ?? "highest_score",
    affinityTtlMs: config.affinityTtlMs ?? 6 * 60 * 60 * 1000,
    judge: config.judge ? applyJudgeDefaults(config.judge) : undefined,
    stage: config.stage ? applyStageDefaults(config.stage) : undefined,
    trajectory: config.trajectory ? applyTrajectoryDefaults(config.trajectory) : undefined,
    escalationMode: config.escalationMode ?? (config.stage ? "stage" : "stage"),
  };
}

export function validateAutoConfig(value: unknown): string[] {
  if (!isRecord(value)) return ["auto must be an object"];
  const errors: string[] = [];
  if (!Array.isArray(value.candidates) || value.candidates.length === 0) errors.push("auto.candidates must contain at least one candidate");
  const models: string[] = [];
  for (const [index, candidate] of (Array.isArray(value.candidates) ? value.candidates : []).entries()) {
    if (!isRecord(candidate) || typeof candidate.model !== "string" || !candidate.model.trim() || candidate.model.toLowerCase() === "auto") {
      errors.push(`auto.candidates[${index}].model must be a non-empty model other than auto`);
      continue;
    }
    if (models.includes(candidate.model)) errors.push(`auto.candidates contains duplicate model ${candidate.model}`);
    models.push(candidate.model);
    if (candidate.stageRole !== undefined && candidate.stageRole !== "efficient" && candidate.stageRole !== "capable") errors.push(`auto.candidates[${index}].stageRole must be efficient or capable`);
    for (const key of ["strengths", "limitations"] as const) {
      if (candidate[key] !== undefined && (!Array.isArray(candidate[key]) || candidate[key].some((item) => typeof item !== "string"))) errors.push(`auto.candidates[${index}].${key} must be an array of strings`);
    }
  }
  if (typeof value.fallbackModel !== "string" || value.fallbackModel === "auto" || !models.includes(value.fallbackModel)) errors.push("auto.fallbackModel must reference one declared candidate and cannot be auto");
  if (value.sessionPolicy !== undefined && !["sticky", "per-request", "sticky-escalation"].includes(String(value.sessionPolicy))) errors.push("auto.sessionPolicy is invalid");
  if (value.selectionPolicy !== undefined && value.selectionPolicy !== "highest_score") errors.push("auto.selectionPolicy must be highest_score");
  if (value.escalationMode !== undefined && value.escalationMode !== "stage" && value.escalationMode !== "trajectory") errors.push("auto.escalationMode is invalid");
  if (value.affinityTtlMs !== undefined && !positiveFinite(value.affinityTtlMs)) errors.push("auto.affinityTtlMs must be positive");
  errors.push(...validateJudge(value.judge, "auto.judge"));
  errors.push(...validateStage(value.stage));
  errors.push(...validateTrajectory(value.trajectory));
  return errors;
}

function applyJudgeDefaults(config: AutoJudgeConfig): AutoJudgeConfig {
  return { ...config, timeoutMs: config.timeoutMs ?? 1500, maxOutputTokens: config.maxOutputTokens ?? 4096 };
}

function applyStageDefaults(config: AutoStageConfig): AutoStageConfig {
  return { ...config, picker: config.picker ?? "efficient_first", confidenceThreshold: config.confidenceThreshold ?? 0.5, signalRecentWindow: config.signalRecentWindow ?? 3 };
}

function applyTrajectoryDefaults(config: AutoTrajectoryConfig): AutoTrajectoryConfig {
  return { ...config, confirmations: config.confirmations ?? 2, recentTurnWindow: config.recentTurnWindow ?? 28, windowMessageChars: config.windowMessageChars ?? 500, failureMode: config.failureMode ?? "fail_open", threshold: config.threshold ?? 0.5 };
}

function validateJudge(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  if (!isRecord(value)) return [`${path} must be an object`];
  const errors: string[] = [];
  if (value.model === undefined && value.baseUrl === undefined) errors.push(`${path} requires model or baseUrl`);
  if (value.model !== undefined && (typeof value.model !== "string" || !value.model.trim() || value.model === "auto")) errors.push(`${path}.model must be a model other than auto`);
  if (value.baseUrl !== undefined && (typeof value.baseUrl !== "string" || !value.baseUrl.trim())) errors.push(`${path}.baseUrl must be a URL`);
  if (value.timeoutMs !== undefined && !positiveFinite(value.timeoutMs)) errors.push(`${path}.timeoutMs must be positive`);
  if (value.maxOutputTokens !== undefined && (!positiveFinite(value.maxOutputTokens) || !Number.isInteger(value.maxOutputTokens))) errors.push(`${path}.maxOutputTokens must be a positive integer`);
  return errors;
}

function validateStage(value: unknown): string[] {
  if (value === undefined) return [];
  if (!isRecord(value)) return ["auto.stage must be an object"];
  const errors: string[] = [];
  if (value.picker !== undefined && value.picker !== "efficient_first" && value.picker !== "capable_first") errors.push("auto.stage.picker is invalid");
  if (value.confidenceThreshold !== undefined && (typeof value.confidenceThreshold !== "number" || !Number.isFinite(value.confidenceThreshold) || value.confidenceThreshold < 0 || value.confidenceThreshold > 1)) errors.push("auto.stage.confidenceThreshold must be between 0 and 1");
  if (value.signalRecentWindow !== undefined && (!Number.isInteger(value.signalRecentWindow) || value.signalRecentWindow < 1)) errors.push("auto.stage.signalRecentWindow must be a positive integer");
  return errors;
}

function validateTrajectory(value: unknown): string[] {
  if (value === undefined) return [];
  if (!isRecord(value)) return ["auto.trajectory must be an object"];
  const errors: string[] = [];
  for (const [key, label] of [["confirmations", "confirmations"], ["recentTurnWindow", "recentTurnWindow"], ["windowMessageChars", "windowMessageChars"]] as const) {
    if (value[key] !== undefined && (!Number.isInteger(value[key]) || Number(value[key]) < 1)) errors.push(`auto.trajectory.${label} must be a positive integer`);
  }
  if (value.failureMode !== undefined && value.failureMode !== "fail_open" && value.failureMode !== "fallback_model") errors.push("auto.trajectory.failureMode is invalid");
  if (value.threshold !== undefined && (typeof value.threshold !== "number" || !Number.isFinite(value.threshold) || value.threshold < 0 || value.threshold > 1)) errors.push("auto.trajectory.threshold must be between 0 and 1");
  errors.push(...validateJudge(value.judge, "auto.trajectory.judge"));
  return errors;
}

function positiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
