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
