// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Adapted from NVIDIA-NeMo/Switchyard commit 48b3b71d3cc629aa9eb011852f5a7da90957ba22.

import type { AutoConfig, AutoDecision, AutoRequestEnvelope, AutoRoutingStats, AutoCandidate } from "./types.js";
import { argmax } from "./classifier.js";
import { eligibleTargets, selectFallback } from "./target-selector.js";
import { runSelectionJudge, runTrajectoryJudge, type JudgeExecutor } from "./llm-judge.js";
import { extractToolSignals } from "./tool-signals.js";
import { handoffNote, pickTier, type DecisionSource } from "./stage.js";
import { SessionAffinity } from "./affinity.js";

export interface AutoRouterOptions {
  judgeExecute?: JudgeExecutor;
  now?: () => number;
}

export interface AutoRouteOptions {
  allowedModels?: readonly string[];
  excludeModels?: readonly string[];
}

export class AutoRouteError extends Error {}

export class AutoRouter {
  private readonly affinity: SessionAffinity;
  private readonly stats: AutoRoutingStats = {
    decisions: 0,
    bySource: {},
    byTarget: {},
    fallbacks: 0,
    judgeCalls: 0,
    judgeFailures: 0,
    judgeLatencyMs: 0,
    judgeTokens: 0,
    modelTokens: 0,
    escalations: 0,
  };
  private readonly trajectoryStreaks = new Map<string, number>();

  private judgeExecute?: JudgeExecutor;

  constructor(private readonly config: AutoConfig, private readonly options: AutoRouterOptions = {}) {
    this.judgeExecute = options.judgeExecute;
    this.affinity = new SessionAffinity(config.affinityTtlMs ?? 6 * 60 * 60 * 1000);
  }

  setJudgeExecutor(executor: JudgeExecutor): void {
    this.judgeExecute = executor;
  }

  async route(envelope: AutoRequestEnvelope, options: AutoRouteOptions = {}): Promise<AutoDecision> {
    const candidates = this.authorizedCandidates(options.allowedModels, options.excludeModels);
    if (candidates.length === 0) throw new AutoRouteError("no auto candidate is authorized for this Virtual Key");
    const models = candidates.map((candidate) => candidate.model);
    const fallback = selectFallback(this.config.fallbackModel, models, options.allowedModels);
    const sessionPolicy = this.config.sessionPolicy ?? "per-request";
    const sessionKey = sessionPolicy === "per-request" ? undefined : this.affinity.keyFor(envelope);
    if (sessionKey) {
      const retained = this.affinity.lookup(sessionKey);
      if (retained && (sessionPolicy === "sticky" || retained.model === this.capableModel(candidates))) {
        if (models.includes(retained.model)) {
          return this.finish({
            requestedModel: "auto",
            selectedModel: retained.model,
            source: "affinity",
            rationale: `session affinity retained ${retained.model}`,
            fallback: retained.fallback,
            sessionKey,
          });
        }
        this.affinity.forget(sessionKey, retained.model);
      }
    }

    let decision: AutoDecision;
    const stagePair = this.stagePair(candidates);
    const trajectoryConfigured = (this.config.escalationMode ?? "stage") === "trajectory";
    const trajectoryMode = trajectoryConfigured && envelope.stream !== true;
    if (stagePair && trajectoryConfigured) {
      decision = {
        requestedModel: "auto",
        selectedModel: stagePair.efficient.model,
        source: "trajectory-efficient",
        rationale: trajectoryMode
          ? "trajectory mode starts with the efficient tier and buffers its response"
          : "trajectory mode uses the efficient tier for streaming because the response cannot be buffered",
        confidence: 1,
        sessionKey,
        systemPrompt: this.config.stage?.systemPrompts?.efficient,
      };
    } else if (stagePair && (this.config.escalationMode ?? "stage") === "stage") {
      decision = await this.routeStage(envelope, stagePair, candidates, fallback, sessionKey);
    } else if (candidates.length === 1) {
      decision = {
        requestedModel: "auto",
        selectedModel: candidates[0].model,
        source: "single-candidate",
        rationale: "only one authorized auto candidate is available",
        confidence: 1,
        sessionKey,
      };
    } else {
      decision = await this.routeByJudge(envelope, candidates, fallback, sessionKey);
    }
    if (sessionKey && (sessionPolicy === "sticky" || (sessionPolicy === "sticky-escalation" && this.isCapable(decision.selectedModel, candidates)))) {
      this.affinity.remember(sessionKey, decision.selectedModel, decision.fallback);
    }
    return this.finish(decision);
  }

  /** Judge a completed efficient turn and apply consecutive-confirmation latching. */
  async evaluateTrajectory(
    envelope: AutoRequestEnvelope,
    efficientResponse: string,
    options: AutoRouteOptions = {},
  ): Promise<AutoDecision> {
    const candidates = this.authorizedCandidates(options.allowedModels);
    const pair = this.stagePair(candidates);
    if (!pair) throw new AutoRouteError("trajectory mode requires efficient and capable candidates");
    const sessionKey = this.affinity.keyFor(envelope);
    const key = sessionKey ?? `unkeyed:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
    const judgedEnvelope: AutoRequestEnvelope = {
      ...envelope,
      messages: [...envelope.messages, { role: "assistant", content: efficientResponse }],
    };
    const trajectory = this.config.trajectory ?? {};
    const judgeConfig = trajectory.judge ?? this.config.judge;
    const result = await runTrajectoryJudge(
      judgedEnvelope,
      judgeConfig,
      {
        execute: this.judgeExecute,
        onCall: (latencyMs, tokens) => {
          this.stats.judgeCalls++;
          this.stats.judgeLatencyMs += latencyMs;
          this.stats.judgeTokens += tokens;
        },
        onFailure: () => { this.stats.judgeFailures++; },
      },
      trajectory,
    );
    if (!("escalate" in result)) {
      if ((trajectory.failureMode ?? "fail_open") === "fallback_model") {
        const fallback = selectFallback(this.config.fallbackModel, candidates.map((candidate) => candidate.model), options.allowedModels);
        if (!fallback) throw new AutoRouteError("trajectory judge failed and fallbackModel is not authorized");
        return this.finish({ requestedModel: "auto", selectedModel: fallback, source: "fallback", rationale: "trajectory judge failed; used fallbackModel", fallback: true, sessionKey });
      }
      return this.finish({ requestedModel: "auto", selectedModel: pair.efficient.model, source: "trajectory-efficient", rationale: "trajectory judge unavailable; fail_open retained efficient response", sessionKey, systemPrompt: this.config.stage?.systemPrompts?.efficient });
    }
    const confirmations = trajectory.confirmations ?? 2;
    const nextStreak = result.escalate ? (this.trajectoryStreaks.get(key) ?? 0) + 1 : 0;
    if (nextStreak >= confirmations) {
      this.trajectoryStreaks.set(key, nextStreak);
      if (sessionKey) this.affinity.remember(sessionKey, pair.capable.model);
      return this.finish({ requestedModel: "auto", selectedModel: pair.capable.model, source: "trajectory-capable", rationale: `trajectory judge confirmed escalation ${nextStreak}/${confirmations}${result.reason ? `: ${result.reason}` : ""}`, confidence: 1, sessionKey, systemPrompt: this.config.stage?.systemPrompts?.capable });
    }
    this.trajectoryStreaks.set(key, nextStreak);
    return this.finish({ requestedModel: "auto", selectedModel: pair.efficient.model, source: "trajectory-efficient", rationale: `trajectory judge did not reach escalation confirmation ${nextStreak}/${confirmations}`, confidence: 1, sessionKey, systemPrompt: this.config.stage?.systemPrompts?.efficient });
  }

  linkResponseId(responseId: string, decision: AutoDecision): void {
    if (decision.sessionKey) this.affinity.linkResponse(responseId, decision.sessionKey);
  }

  getStats(): AutoRoutingStats {
    const snapshot = structuredClone(this.stats);
    if (snapshot.lastDecision) delete snapshot.lastDecision.sessionKey;
    return snapshot;
  }

  recordModelTokens(tokens: number): void {
    if (Number.isFinite(tokens) && tokens > 0) this.stats.modelTokens += Math.floor(tokens);
  }

  static envelopeFromChat(request: { model: string; messages: unknown[]; tools?: unknown; [key: string]: unknown }, previousResponseId?: string | null, sessionId?: string | null): AutoRequestEnvelope {
    return {
      model: request.model,
      messages: request.messages.map((message) => (isRecord(message) ? message : { role: "user", content: String(message) })),
      stream: typeof request.stream === "boolean" ? request.stream : undefined,
      tools: request.tools,
      previousResponseId,
      sessionId,
    };
  }

  private async routeStage(
    envelope: AutoRequestEnvelope,
    pair: { efficient: AutoCandidate; capable: AutoCandidate },
    allCandidates: readonly AutoCandidate[],
    fallback: string | null,
    sessionKey?: string,
  ): Promise<AutoDecision> {
    const stage = this.config.stage ?? {};
    const signal = extractToolSignals(envelope.messages, stage.signalRecentWindow ?? 3);
    const outcome = pickTier(signal, stage.picker ?? "efficient_first", stage.confidenceThreshold ?? 0.5);
    if (outcome.kind === "resolved") {
      const candidate = outcome.tier === "capable" ? pair.capable : pair.efficient;
      return this.stageDecision(candidate.model, outcome.source, outcome.score, signal, stage, sessionKey);
    }
    // Under threshold: Switchyard falls through to its capability judge. The
    // request is still sent in full, while the stage candidate set stays narrow.
    const judged = await this.runJudge(envelope, [pair.efficient, pair.capable]);
    if (judged) {
      const winner = argmax(judged.scores);
      if (winner) {
        return {
          requestedModel: "auto",
          selectedModel: winner.target,
          source: "llm-classifier",
          rationale: `stage score ${outcome.score.toFixed(3)} was below threshold; judge selected ${winner.target}`,
          confidence: winner.confidence,
          scores: judged.scores,
          sessionKey,
        };
      }
    }
    const judgeConfigured = Boolean(this.config.judge || this.judgeExecute);
    const selected = judgeConfigured && fallback && allCandidates.some((candidate) => candidate.model === fallback)
      ? fallback
      : outcome.defaultTier === "capable" ? pair.capable.model : pair.efficient.model;
    return {
      requestedModel: "auto",
      selectedModel: selected,
      source: "stage-fall-open",
      rationale: "stage signals and judge were inconclusive; used configured fallback",
      fallback: judgeConfigured,
      sessionKey,
    };
  }

  private async routeByJudge(
    envelope: AutoRequestEnvelope,
    candidates: readonly AutoCandidate[],
    fallback: string | null,
    sessionKey?: string,
  ): Promise<AutoDecision> {
    if (candidates.length === 1) {
      return { requestedModel: "auto", selectedModel: candidates[0].model, source: "single-candidate", rationale: "only one authorized auto candidate is available", confidence: 1, sessionKey };
    }
    const judged = await this.runJudge(envelope, candidates);
    if (judged) {
      const winner = argmax(judged.scores);
      if (winner) {
        return { requestedModel: "auto", selectedModel: winner.target, source: "llm-classifier", rationale: `highest judge score selected ${winner.target}`, confidence: winner.confidence, scores: judged.scores, sessionKey };
      }
    }
    if (!fallback) throw new AutoRouteError("auto judge failed and fallbackModel is unavailable to this Virtual Key");
    return { requestedModel: "auto", selectedModel: fallback, source: "fallback", rationale: "auto judge failed or returned an invalid verdict", fallback: true, sessionKey };
  }

  private async runJudge(envelope: AutoRequestEnvelope, candidates: readonly AutoCandidate[]) {
    if (!this.config.judge && !this.judgeExecute) return null;
    const result = await runSelectionJudge(envelope, {
      candidates,
      config: this.config.judge,
      execute: this.judgeExecute,
      onCall: (latencyMs, tokens) => {
        this.stats.judgeCalls++;
        this.stats.judgeLatencyMs += latencyMs;
        this.stats.judgeTokens += tokens;
      },
      onFailure: () => { this.stats.judgeFailures++; },
    });
    return "scores" in result ? result : null;
  }

  private stageDecision(
    model: string,
    source: DecisionSource,
    score: number,
    signal: ReturnType<typeof extractToolSignals>,
    stage: NonNullable<AutoConfig["stage"]>,
    sessionKey?: string,
  ): AutoDecision {
    const sourceMap: Record<DecisionSource, AutoDecision["source"]> = {
      override: "stage-override",
      tests_passed: "stage-tests-passed",
      dimensions: "stage-dimensions",
      ambiguous: "stage-fall-open",
      "llm-classifier": "llm-classifier",
      fall_open: "stage-fall-open",
    };
    const note = handoffNote(stage.handoffNotes, model === this.capableModel(this.config.candidates) ? "capable" : "efficient", source);
    const tier = model === this.capableModel(this.config.candidates) ? "capable" : "efficient";
    return {
      requestedModel: "auto",
      selectedModel: model,
      source: sourceMap[source],
      rationale: `stage ${source}; severity=${signal.severity.toFixed(2)} writes=${signal.recentWriteCount} edits=${signal.recentEditCount}${note ? `; handoff=${note}` : ""}`,
      confidence: source === "override" ? 1 : Math.abs(score),
      sessionKey,
      handoffNote: note,
      systemPrompt: stage.systemPrompts?.[tier],
    };
  }

  private authorizedCandidates(
    allowedModels?: readonly string[],
    excludeModels?: readonly string[],
  ): AutoCandidate[] {
    const models = eligibleTargets(this.config.candidates.map((candidate) => candidate.model), allowedModels);
    const excluded = new Set(excludeModels ?? []);
    return this.config.candidates.filter((candidate) => models.includes(candidate.model) && !excluded.has(candidate.model));
  }

  private stagePair(candidates: readonly AutoCandidate[]): { efficient: AutoCandidate; capable: AutoCandidate } | null {
    const efficient = candidates.find((candidate) => candidate.stageRole === "efficient");
    const capable = candidates.find((candidate) => candidate.stageRole === "capable");
    return efficient && capable ? { efficient, capable } : null;
  }

  private capableModel(candidates: readonly AutoCandidate[]): string | undefined {
    return candidates.find((candidate) => candidate.stageRole === "capable")?.model;
  }

  private isCapable(model: string, candidates: readonly AutoCandidate[]): boolean {
    return candidates.some((candidate) => candidate.model === model && candidate.stageRole === "capable");
  }

  private finish(decision: AutoDecision): AutoDecision {
    this.stats.decisions++;
    this.stats.bySource[decision.source] = (this.stats.bySource[decision.source] ?? 0) + 1;
    this.stats.byTarget[decision.selectedModel] = (this.stats.byTarget[decision.selectedModel] ?? 0) + 1;
    if (decision.fallback) this.stats.fallbacks++;
    if (decision.source === "stage-override" || decision.source === "trajectory-capable") this.stats.escalations++;
    this.stats.lastDecision = decision;
    return decision;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
