import { readFile, writeFile } from "node:fs/promises";
import { evaluateRouting, parseRoutingEvalCases } from "../src/auto-routing-evaluation.js";

const [suitePath, baseline, outputPath] = process.argv.slice(2);
if (!suitePath || !baseline || baseline.toLowerCase() === "auto" || !outputPath) {
  throw new Error("Usage: npx tsx scripts/evaluate-auto-routing.ts SUITE.json BASELINE_MODEL OUTPUT.json");
}
const cases = parseRoutingEvalCases(JSON.parse(await readFile(suitePath, "utf8")));
const base = new URL(process.env.ROTATOR_EVAL_BASE_URL ?? "http://127.0.0.1:51200/v1/");
if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new Error("Invalid evaluation base URL");
if (!base.pathname.endsWith("/")) base.pathname += "/";
const results = await evaluateRouting(cases, ["auto", baseline], async (model, prompt) => {
  const response = await fetch(new URL("chat/completions", base), {
    method: "POST",
    headers: { "content-type": "application/json", ...(process.env.ROTATOR_EVAL_API_KEY ? { authorization: `Bearer ${process.env.ROTATOR_EVAL_API_KEY}` } : {}) },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 256, stream: false }),
    signal: AbortSignal.timeout(120_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error("Completion failed");
  return response.json();
});
await writeFile(outputPath, JSON.stringify({ evaluatedAt: new Date().toISOString(), check: "trimmed-exact-match", results }, null, 2), { flag: "wx", mode: 0o600 });
console.info(`Saved ${results.length} evaluations to ${outputPath}`);
