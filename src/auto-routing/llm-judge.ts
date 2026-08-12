// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Adapted from NVIDIA-NeMo/Switchyard commit 48b3b71d3cc629aa9eb011852f5a7da90957ba22.

import { validateScores, type Score } from "./classifier.js";
import { buildClassifierContract } from "./classifier-contract.js";
import type { AutoCandidate, AutoJudgeConfig, AutoRequestEnvelope } from "./types.js";
import { summarizeTrajectory } from "./trajectory.js";

export interface JudgeResult {
  scores: Score[];
  latencyMs: number;
  outputTokens: number;
}

export interface JudgeFailure {
  error: Error;
  latencyMs: number;
}

export type JudgeExecutor = (
  request: Record<string, unknown>,
  config: AutoJudgeConfig,
  signal: AbortSignal,
) => Promise<unknown>;

export interface JudgeOptions {
  candidates: readonly AutoCandidate[];
  config?: AutoJudgeConfig;
  execute?: JudgeExecutor;
  onCall?: (latencyMs: number, outputTokens: number) => void;
  onFailure?: (latencyMs: number, error: Error) => void;
}

export interface TrajectoryJudgeResult {
  escalate: boolean;
  reason?: string;
  latencyMs: number;
  outputTokens: number;
}

export async function runSelectionJudge(
  envelope: AutoRequestEnvelope,
  options: JudgeOptions,
): Promise<JudgeResult | JudgeFailure> {
  const started = Date.now();
  const config = options.config ?? {};
  const contract = buildClassifierContract(options.candidates, config.prompt);
  const request = buildJudgeRequest(envelope, options.candidates, contract, config);
  const timeoutMs = config.timeoutMs ?? 1500;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const execution = options.execute
      ? options.execute(request, config, controller.signal)
      : executeRemote(request, config, controller.signal);
    const raw = await withTimeout(execution, timeoutMs, controller);
    const parsed = decodeJudgeResponse(raw);
    const scores = decodeScores(parsed, contract.targets);
    const latencyMs = Date.now() - started;
    const outputTokens = estimateTokens(raw);
    options.onCall?.(latencyMs, outputTokens);
    return { scores, latencyMs, outputTokens };
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    const latencyMs = Date.now() - started;
    options.onFailure?.(latencyMs, error);
    return { error, latencyMs };
  } finally {
    clearTimeout(timeout);
  }
}

/** Structured trajectory verdict. The efficient answer is included in the summary. */
export async function runTrajectoryJudge(
  envelope: AutoRequestEnvelope,
  config: AutoJudgeConfig = {},
  options: Pick<JudgeOptions, "execute" | "onCall" | "onFailure"> = {},
  trajectory: { recentTurnWindow?: number; windowMessageChars?: number } = {},
): Promise<TrajectoryJudgeResult | JudgeFailure> {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 1500);
  const request: Record<string, unknown> = {
    model: config.model ?? "auto-trajectory-judge",
    messages: [
      {
        role: "system",
        content: config.prompt ??
          "Decide whether the efficient model's latest trajectory should escalate. Return JSON with boolean escalate and a short reason.",
      },
      {
        role: "user",
        content: summarizeTrajectory(envelope.messages, {
          recentTurnWindow: trajectory.recentTurnWindow ?? 28,
          windowMessageChars: trajectory.windowMessageChars ?? 500,
        }),
      },
    ],
    max_tokens: config.maxOutputTokens ?? 4096,
    temperature: 0,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "rotator_auto_trajectory_response",
        strict: true,
        schema: {
          type: "object",
          properties: { escalate: { type: "boolean" }, reason: { type: "string" } },
          required: ["escalate", "reason"],
          additionalProperties: false,
        },
      },
    },
  };
  try {
    const execution = options.execute
      ? options.execute(request, config, controller.signal)
      : executeRemote(request, config, controller.signal);
    const raw = await withTimeout(execution, config.timeoutMs ?? 1500, controller);
    const parsed = unwrapObject(decodeJudgeResponse(raw));
    if (!parsed || typeof parsed.escalate !== "boolean") throw new Error("trajectory judge returned an invalid verdict");
    const latencyMs = Date.now() - started;
    const outputTokens = estimateTokens(raw);
    options.onCall?.(latencyMs, outputTokens);
    return { escalate: parsed.escalate, reason: typeof parsed.reason === "string" ? parsed.reason : undefined, latencyMs, outputTokens };
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    const latencyMs = Date.now() - started;
    options.onFailure?.(latencyMs, error);
    return { error, latencyMs };
  } finally {
    clearTimeout(timeout);
  }
}

export function buildJudgeRequest(
  envelope: AutoRequestEnvelope,
  candidates: readonly AutoCandidate[],
  contract = buildClassifierContract(candidates),
  config: AutoJudgeConfig = {},
): Record<string, unknown> {
  const candidateContext = candidates.map((candidate) => ({
    model: candidate.model,
    description: candidate.description,
    strengths: candidate.strengths,
    limitations: candidate.limitations,
  }));
  const messages = [
    { role: "system", content: `${contract.systemPrompt}\nCandidates:\n${JSON.stringify(candidateContext)}` },
    ...envelope.messages,
  ];
  return {
    model: config.model ?? "auto-judge",
    messages,
    ...(envelope.tools !== undefined ? { tools: envelope.tools } : {}),
    ...(envelope.instructions !== undefined ? { instructions: envelope.instructions } : {}),
    ...(envelope.input !== undefined ? { input: envelope.input } : {}),
    ...(envelope.stream !== undefined ? { stream: envelope.stream } : {}),
    ...(envelope.previousResponseId !== undefined ? { previous_response_id: envelope.previousResponseId } : {}),
    max_tokens: config.maxOutputTokens ?? 4096,
    temperature: 0,
    response_format: contract.responseFormat,
  };
}

export function decodeScores(value: unknown, targets: readonly string[]): Score[] {
  const object = unwrapObject(value);
  const rawScores = object && "scores" in object ? object.scores : value;
  if (isRecord(rawScores) && !Array.isArray(rawScores)) {
    return validateScores(targets.map((target) => ({ target, confidence: rawScores[target] })), targets);
  }
  return validateScores(rawScores, targets);
}

export function decodeJudgeResponse(raw: unknown): unknown {
  if (typeof raw !== "string") {
    if (isRecord(raw) && "choices" in raw) {
      const choices = raw.choices;
      if (Array.isArray(choices) && isRecord(choices[0])) {
        const message = choices[0].message;
        if (isRecord(message)) return parseJsonText(message.content);
      }
    }
    if (isRecord(raw) && typeof raw.output_text === "string") return parseJsonText(raw.output_text);
    return raw;
  }
  return parseJsonText(raw);
}

function parseJsonText(text: unknown): unknown {
  if (typeof text !== "string") return text;
  const trimmed = text.trim();
  try { return JSON.parse(trimmed) as unknown; } catch { /* try fenced output below */ }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
  if (fenced) return JSON.parse(fenced) as unknown;
  throw new Error("judge response was not valid JSON");
}

async function executeRemote(
  request: Record<string, unknown>,
  config: AutoJudgeConfig,
  signal: AbortSignal,
): Promise<unknown> {
  if (!config.baseUrl) throw new Error("auto judge requires baseUrl or an injected executor");
  const endpoint = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify(request),
    signal,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`judge returned HTTP ${response.status}`);
  return JSON.parse(text) as unknown;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`auto judge timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function unwrapObject(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.scores) || Array.isArray(value.scores)) return value;
  if (isRecord(value.result)) return unwrapObject(value.result);
  return value;
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
