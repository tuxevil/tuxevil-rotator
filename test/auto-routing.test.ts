import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { argmax, classificationArgmax, validateScores, ClassifierAlgorithmError } from "../src/auto-routing/classifier.js";
import { buildClassifierContract } from "../src/auto-routing/classifier-contract.js";
import { buildJudgeRequest, decodeJudgeResponse, decodeScores } from "../src/auto-routing/llm-judge.js";
import { extractToolSignals, classifyText, HARD_SEVERITY, CRITICAL_SEVERITY } from "../src/auto-routing/tool-signals.js";
import { dimensionsFromSignals, pickTier, scoreSignal } from "../src/auto-routing/stage.js";
import { SessionAffinity } from "../src/auto-routing/affinity.js";
import { summarizeTrajectory, truncateWithAnchors } from "../src/auto-routing/trajectory.js";
import { AutoRouter } from "../src/auto-routing/auto-router.js";
import { applyAutoConfigDefaults, validateAutoConfig } from "../src/auto-routing/config.js";

describe("Switchyard-derived classifier contract", () => {
  it("keeps argmax ties stable and rejects NaN", () => {
    assert.equal(argmax([{ target: "first", confidence: 0.7 }, { target: "second", confidence: 0.7 }])?.target, "first");
    assert.throws(() => argmax([{ target: "bad", confidence: Number.NaN }]), ClassifierAlgorithmError);
    assert.equal(classificationArgmax({ kind: "ambiguous", scores: [{ target: "a", confidence: 1 }] }), null);
  });

  it("requires all eligible candidates to receive independent scores", () => {
    assert.throws(() => validateScores([{ target: "a", confidence: 0.5 }], ["a", "b"]));
    assert.throws(() => validateScores([{ target: "a", confidence: 1.1 }, { target: "b", confidence: 0 }], ["a", "b"]));
    assert.equal(validateScores([{ target: "b", confidence: 0.5 }, { target: "a", confidence: 0.5 }], ["a", "b"])[0].target, "a");
    const contract = buildClassifierContract([{ model: "a" }, { model: "b" }]);
    assert.equal(contract.responseFormat.json_schema && typeof contract.responseFormat.json_schema, "object");
    assert.equal(contract.systemPrompt.includes("{{RESPONSE_SCHEMA}}"), false);
    const judgeRequest = buildJudgeRequest(
      { model: "auto", messages: [{ role: "user", content: "task" }], tools: [{ type: "function" }], input: "task", stream: false },
      [{ model: "a" }, { model: "b" }],
    );
    assert.deepEqual(judgeRequest.tools, [{ type: "function" }]);
    assert.equal(judgeRequest.input, "task");
  });

  it("decodes structured OpenAI judge responses and rejects malformed verdicts", () => {
    const response = decodeJudgeResponse({ choices: [{ message: { content: '{"scores":{"a":0.2,"b":0.8}}' } }] });
    assert.deepEqual(decodeScores(response, ["a", "b"]), [
      { target: "a", confidence: 0.2 },
      { target: "b", confidence: 0.8 },
    ]);
    assert.throws(() => decodeScores({ scores: [{ target: "a", confidence: 1 }] }, ["a", "b"]));
  });
});

describe("Switchyard-derived tool signals and stage picker", () => {
  it("classifies errors and tool intent with a recent window", () => {
    assert.equal(classifyText("Out of memory").severity, CRITICAL_SEVERITY);
    assert.equal(classifyText("Traceback (most recent call last):\nValueError").severity, HARD_SEVERITY);
    const signal = extractToolSignals([
      { role: "assistant", tool_calls: [{ function: { name: "Read", arguments: "{}" } }] },
      { role: "tool", content: "ok" },
      { role: "assistant", tool_calls: [{ function: { name: "Bash", arguments: JSON.stringify({ command: "printf > /tmp/x" }) } }] },
      { role: "tool", content: "Traceback (most recent call last):" },
    ]);
    assert.equal(signal.readCount, 1);
    assert.equal(signal.writeCount, 1);
    assert.equal(signal.severity, HARD_SEVERITY);
  });

  it("applies critical override, tests-pass de-escalation and tanh score", () => {
    const base = extractToolSignals([{ role: "user", content: "hi" }]);
    assert.equal(pickTier({ ...base, severity: 1 }, "efficient_first", 0.5).kind, "resolved");
    const settled = { ...base, testsPassed: true, recentWriteCount: 1 };
    const settledPick = pickTier(settled, "capable_first", 0.5);
    assert.equal(settledPick.kind, "resolved");
    if (settledPick.kind === "resolved") assert.equal(settledPick.tier, "efficient");
    const scored = scoreSignal({ ...base, severity: 0.7 });
    assert.ok(scored.confidence > 0 && scored.confidence < 0.5);
    assert.equal(dimensionsFromSignals({ ...base, recentReadCount: 1, turnDepth: 10 }).exploring, 1);
  });
});

describe("Switchyard-derived affinity and trajectory", () => {
  it("uses explicit session before previous response and expires assignments", () => {
    const affinity = new SessionAffinity(10);
    const key = affinity.keyFor({ sessionId: "s1", previousResponseId: "r1" });
    assert.equal(key, "session:s1");
    affinity.remember(key!, "capable", true, 0);
    assert.equal(affinity.lookup(key!, 9)?.model, "capable");
    assert.equal(affinity.lookup(key!, 11), undefined);
    assert.equal(affinity.keyFor({ previousResponseId: "r1" }), "response:r1");
  });

  it("keeps the opening task and bounded recent trajectory anchors", () => {
    const summary = summarizeTrajectory([
      { role: "user", content: "original task" },
      { role: "assistant", content: "x".repeat(40) },
      { role: "user", content: "latest" },
    ], { recentTurnWindow: 1, windowMessageChars: 100, maxRequestChars: 80 });
    assert.match(summary, /original task/);
    assert.match(summary, /latest/);
    assert.match(truncateWithAnchors("1234567890", 5), /trajectory truncated/);
  });
});

describe("AutoRouter", () => {
  it("selects a single authorized candidate without a judge", async () => {
    const router = new AutoRouter(applyAutoConfigDefaults({ candidates: [{ model: "only" }], fallbackModel: "only" }));
    const decision = await router.route({ model: "auto", messages: [{ role: "user", content: "hi" }] });
    assert.equal(decision.selectedModel, "only");
    assert.equal(decision.source, "single-candidate");
  });

  it("scores every candidate, preserves declaration-order ties, and falls back on judge errors", async () => {
    const config = applyAutoConfigDefaults({
      candidates: [{ model: "first" }, { model: "second" }],
      fallbackModel: "first",
      judge: { model: "judge" },
    });
    const router = new AutoRouter(config, {
      judgeExecute: async () => ({ choices: [{ message: { content: JSON.stringify({ scores: { first: 0.5, second: 0.5 } }) } }] }),
    });
    assert.equal((await router.route({ model: "auto", messages: [] })).selectedModel, "first");
    const failing = new AutoRouter(config, { judgeExecute: async () => { throw new Error("timeout"); } });
    const fallback = await failing.route({ model: "auto", messages: [] });
    assert.equal(fallback.selectedModel, "first");
    assert.equal(fallback.fallback, true);
  });

  it("enforces the judge timeout for injected executors", async () => {
    const config = applyAutoConfigDefaults({
      candidates: [{ model: "first" }, { model: "second" }],
      fallbackModel: "first",
      judge: { model: "judge", timeoutMs: 5 },
    });
    const router = new AutoRouter(config, {
      judgeExecute: async () => await new Promise<never>(() => {}),
    });
    const decision = await router.route({ model: "auto", messages: [] });
    assert.equal(decision.selectedModel, "first");
    assert.equal(router.getStats().judgeFailures, 1);
  });

  it("filters candidates and fallback through Virtual Key model scope", async () => {
    const router = new AutoRouter(applyAutoConfigDefaults({ candidates: [{ model: "efficient" }, { model: "capable" }], fallbackModel: "capable" }));
    const decision = await router.route({ model: "auto", messages: [] }, { allowedModels: ["efficient"] });
    assert.equal(decision.selectedModel, "efficient");
  });

  it("activates stage routing only when both roles are present", async () => {
    const router = new AutoRouter(applyAutoConfigDefaults({
      candidates: [{ model: "efficient", stageRole: "efficient" }, { model: "capable", stageRole: "capable" }],
      fallbackModel: "capable",
      stage: { confidenceThreshold: 0.5 },
    }));
    const decision = await router.route({ model: "auto", messages: [{ role: "user", content: "hi" }] });
    assert.equal(decision.selectedModel, "efficient");
  });

  it("carries tier system prompts and handoff notes from StageRouter decisions", async () => {
    const router = new AutoRouter(applyAutoConfigDefaults({
      candidates: [{ model: "efficient", stageRole: "efficient" }, { model: "capable", stageRole: "capable" }],
      fallbackModel: "efficient",
      stage: {
        systemPrompts: { capable: "Use the capable tier carefully." },
        handoffNotes: { escalation: "Escalate with the failure context." },
      },
    }));
    const decision = await router.route({
      model: "auto",
      messages: [{ role: "tool", content: "Out of memory" }],
    });
    assert.equal(decision.selectedModel, "capable");
    assert.equal(decision.systemPrompt, "Use the capable tier carefully.");
    assert.equal(decision.handoffNote, "Escalate with the failure context.");
  });

  it("holds efficient output, confirms trajectory twice, then latches capable", async () => {
    let calls = 0;
    const router = new AutoRouter(applyAutoConfigDefaults({
      candidates: [{ model: "efficient", stageRole: "efficient" }, { model: "capable", stageRole: "capable" }],
      fallbackModel: "capable",
      escalationMode: "trajectory",
      trajectory: { confirmations: 2, judge: { model: "trajectory-judge" } },
    }), {
      judgeExecute: async () => {
        calls++;
        return { output_text: JSON.stringify({ escalate: true, reason: "loop" }) };
      },
    });
    const envelope = { model: "auto", sessionId: "session-1", messages: [{ role: "user", content: "fix it" }] };
    const first = await router.route(envelope);
    assert.equal(first.selectedModel, "efficient");
    const pending = await router.evaluateTrajectory(envelope, "still working");
    assert.equal(pending.selectedModel, "efficient");
    const escalated = await router.evaluateTrajectory(envelope, "still working");
    assert.equal(escalated.selectedModel, "capable");
    assert.equal(calls, 2);
  });

  it("validates auto defaults and rejects auto as fallback", () => {
    assert.ok(validateAutoConfig({ candidates: [{ model: "a" }], fallbackModel: "auto" }).length > 0);
  });
});
