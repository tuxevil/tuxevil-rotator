import { readFile, open } from "node:fs/promises";
import { evaluateRouting, parseRoutingEvalCases } from "../src/auto-routing-evaluation.js";

const [suitePath, baseline, outputPath] = process.argv.slice(2);
if (!suitePath || !baseline || baseline.toLowerCase() === "auto" || !outputPath) {
  throw new Error("Usage: npx tsx scripts/evaluate-auto-routing.ts SUITE.json BASELINE_MODEL OUTPUT.json");
}
const models = process.env.ROTATOR_EVAL_MODELS?.split(",").map(model => model.trim()) ?? ["auto", baseline];
if (!models.length || models.length > 8 || models.some(model => !model) || new Set(models).size !== models.length) throw new Error("Expected 1–8 distinct model IDs");
const maxTokens = Number(process.env.ROTATOR_EVAL_MAX_TOKENS ?? 256);
if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) throw new Error("Output limit must be an integer from 1 to 8192");
const cases = parseRoutingEvalCases(JSON.parse(await readFile(suitePath, "utf8")));
const base = new URL(process.env.ROTATOR_EVAL_BASE_URL ?? "http://127.0.0.1:51200/v1/");
if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new Error("Invalid evaluation base URL");
if (!base.pathname.endsWith("/")) base.pathname += "/";
const maxFailures = Number(process.env.ROTATOR_EVAL_MAX_FAILURES ?? 1);
if (!Number.isInteger(maxFailures) || maxFailures < 1 || maxFailures > 100) throw new Error("Failure limit must be an integer from 1 to 100");
const timeoutMs = Number(process.env.ROTATOR_EVAL_TIMEOUT_MS ?? 120000);
if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error("Timeout must be an integer from 1000 to 120000 ms");
const artifact: { evaluatedAt: string; check: string; maxTokens: number; models: string[]; maxFailures: number; timeoutMs: number; status: string; results: unknown[] } = { evaluatedAt: new Date().toISOString(), check: "trimmed-exact-match", maxTokens, models, maxFailures, timeoutMs, status: "running", results: [] };
const file = await open(outputPath, "wx", 0o600);
const persist = async () => {
  const content = JSON.stringify(artifact, null, 2);
  await file.write(content, 0, "utf8");
  await file.truncate(Buffer.byteLength(content));
};
try {
await persist();
await evaluateRouting(cases, models, async (model, prompt) => {
  const response = await fetch(new URL("chat/completions", base), {
    method: "POST",
    headers: { "content-type": "application/json", ...(process.env.ROTATOR_EVAL_API_KEY ? { authorization: `Bearer ${process.env.ROTATOR_EVAL_API_KEY}` } : {}) },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, stream: false }),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
  if (!response.ok) throw Object.assign(new Error("Completion failed"), { status: response.status });
  return response.json();
}, { maxFailuresPerModel: maxFailures, onResult: async row => { artifact.results.push(row); await persist(); } });
artifact.status = "complete";
await persist();
console.info(`Saved ${artifact.results.length} evaluations to ${outputPath}`);
} finally { await file.close(); }
