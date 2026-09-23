import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function evaluateRetiredModelAssertion(): boolean {
  const source = readFileSync("test/model-catalog.test.ts", "utf8");
  const title = 'it("does not advertise retired gemini-3.5-flash ids"';
  const testStart = source.indexOf(title);
  assert.notEqual(testStart, -1, "catalog regression test is missing");
  const testEndCandidate = source.indexOf("\nit(\"", testStart + title.length);
  const testEnd = testEndCandidate === -1 ? source.length : testEndCandidate;
  const assertionStart = source.indexOf("assert.ok(", testStart);
  assert.ok(assertionStart !== -1 && assertionStart < testEnd, "target assertion is missing");

  const expressionStart = assertionStart + "assert.ok(".length;
  let parens = 0;
  let brackets = 0;
  let braces = 0;
  let quote: string | null = null;
  let escaped = false;
  let expressionEnd = -1;
  for (let index = expressionStart; index < testEnd; index++) {
    const character = source[index];
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") quote = character;
    else if (character === "(") parens++;
    else if (character === ")") {
      if (parens === 0 && brackets === 0 && braces === 0) {
        expressionEnd = index;
        break;
      }
      parens--;
    } else if (character === "[") brackets++;
    else if (character === "]") brackets--;
    else if (character === "{") braces++;
    else if (character === "}") braces--;
    else if (character === "," && parens === 0 && brackets === 0 && braces === 0) {
      expressionEnd = index;
      break;
    }
  }
  assert.notEqual(expressionEnd, -1, "target assertion could not be parsed");
  const payload = { data: [{ id: "gemini-3.5-pro" }] };
  return Function("payload", `"use strict"; return (${source.slice(expressionStart, expressionEnd)});`)(payload) as boolean;
}

test("catalog assertion rejects retired gemini-3.5-pro (4469ac04)", () => {
  assert.equal(evaluateRetiredModelAssertion(), false);
});
