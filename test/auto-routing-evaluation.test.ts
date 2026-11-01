import { it } from "node:test";
import assert from "node:assert/strict";
import { evaluateRouting, parseRoutingEvalCases } from "../src/auto-routing-evaluation.js";

it("compares identical tasks, alternates model order and records failures without leaking errors", async () => {
  const cases = parseRoutingEvalCases([{ id: "a", prompt: "one", expected: "1" }, { id: "b", prompt: "two", expected: "2" }]);
  const calls: string[] = [];
  const rows = await evaluateRouting(cases, ["auto", "baseline"], async (model, prompt) => {
    calls.push(`${model}:${prompt}`);
    if (model === "baseline" && prompt === "two") throw new Error("private-key");
    return { model: "served", choices: [{ message: { content: prompt === "one" ? " 1\n" : "wrong" } }], usage: { prompt_tokens: 10 } };
  });
  assert.deepEqual(calls, ["auto:one", "baseline:one", "baseline:two", "auto:two"]);
  assert.deepEqual(rows.map(row => row.passed), [true, true, false, false]);
  assert.equal(rows[2].error, "completion-failed");
  assert.equal(rows[0].inputTokens, 10);
  assert.equal(rows[0].outputTokens, null);
  assert.doesNotMatch(JSON.stringify(rows), /private-key/);
  assert.throws(() => parseRoutingEvalCases([]));
  assert.throws(() => parseRoutingEvalCases([cases[0], cases[0]]));
});

it("records partial results and skips a model after its operational failure budget", async () => {
  const tasks = parseRoutingEvalCases([{ id: "one", prompt: "p", expected: "ok" }, { id: "two", prompt: "q", expected: "ok" }]);
  let calls = 0;
  const persisted: string[] = [];
  const rows = await evaluateRouting(tasks, ["unavailable"], async () => {
    calls += 1;
    throw Object.assign(new Error("private-provider-error"), { status: 402 });
  }, { maxFailuresPerModel: 1, onResult: async row => { persisted.push(row.error ?? ""); } });
  assert.equal(calls, 1);
  assert.deepEqual(persisted, ["http-402", "model-skipped-after-failure"]);
  assert.deepEqual(rows.map(row => row.passed), [false, false]);
  assert.doesNotMatch(JSON.stringify(rows), /private-provider-error/);
});

it("flags empty HTTP-success completions as operational failures instead of reasoning errors", async () => {
  const cases = parseRoutingEvalCases([{ id: "a", prompt: "p", expected: "1" }, { id: "b", prompt: "q", expected: "2" }]);
  const rows = await evaluateRouting(cases, ["model"], async () => ({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }), { maxFailuresPerModel: 1 });
  assert.equal(rows[0].error, "empty-completion");
  assert.equal(rows[0].answerChars, 0);
  assert.equal(rows[0].finishReason, "stop");
  assert.equal(rows[1].error, "model-skipped-after-failure");
});
