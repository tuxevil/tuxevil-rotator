/** Small deterministic checks for bounded tasks; not a substitute for human review. */
export interface RoutingEvalCase {
  id: string;
  prompt: string;
  expected: string;
}
export interface RoutingEvalResult {
  caseId: string;
  requestedModel: string;
  servedModel: string | null;
  passed: boolean;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  answerChars?: number;
  finishReason?: string | null;
  error?: string;
}

export function parseRoutingEvalCases(input: unknown): RoutingEvalCase[] {
  if (!Array.isArray(input) || !input.length || input.length > 100) throw new Error("Expected 1–100 evaluation cases");
  const ids = new Set<string>();
  return input.map(value => {
    if (!value || typeof value !== "object") throw new Error("Invalid evaluation case");
    const item = value as Record<string, unknown>;
    for (const field of ["id", "prompt", "expected"]) {
      if (typeof item[field] !== "string" || !(item[field] as string).trim()) throw new Error(`Missing ${field}`);
    }
    if (ids.has(item.id as string)) throw new Error("Duplicate case ID");
    ids.add(item.id as string);
    return { id: item.id as string, prompt: item.prompt as string, expected: item.expected as string };
  });
}

export async function evaluateRouting(
  cases: RoutingEvalCase[],
  models: string[],
  complete: (model: string, prompt: string) => Promise<unknown>,
  options: { maxFailuresPerModel?: number; onResult?: (row: RoutingEvalResult) => Promise<void> } = {},
): Promise<RoutingEvalResult[]> {
  const results: RoutingEvalResult[] = [];
  const failures = new Map<string, number>();
  const tokens = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  for (const [index, task] of cases.entries()) {
    // Alternate order to reduce consistent warmup/order bias.
    for (const model of index % 2 ? [...models].reverse() : models) {
      const started = performance.now();
      const row: RoutingEvalResult = { caseId: task.id, requestedModel: model, servedModel: null, passed: false, latencyMs: 0, inputTokens: null, outputTokens: null };
      if ((failures.get(model) ?? 0) >= (options.maxFailuresPerModel ?? Infinity)) {
        row.error = "model-skipped-after-failure";
        results.push(row);
        await options.onResult?.(row);
        continue;
      }
      try {
        const response = await complete(model, task.prompt) as { model?: unknown; choices?: { message?: { content?: unknown }; finish_reason?: unknown }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
        const content = response?.choices?.[0]?.message?.content;
        if (typeof content !== "string") throw new Error("Missing text completion");
        row.answerChars = content.length;
        const finish = response.choices?.[0]?.finish_reason;
        row.finishReason = typeof finish === "string" && ["stop", "length", "tool_calls", "content_filter"].includes(finish) ? finish : null;
        if (!content.trim()) throw Object.assign(new Error("Empty completion"), { evalError: "empty-completion" });
        row.passed = content.trim() === task.expected.trim();
        row.servedModel = typeof response.model === "string" ? response.model : null;
        row.inputTokens = tokens(response.usage?.prompt_tokens);
        row.outputTokens = tokens(response.usage?.completion_tokens);
      } catch (error) {
        // Do not copy provider errors that could contain request text or secrets.
        const status = (error as { status?: unknown } | null)?.status;
        row.error = (error as { evalError?: unknown } | null)?.evalError === "empty-completion" ? "empty-completion" : typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599
          ? `http-${status}` : "completion-failed";
        failures.set(model, (failures.get(model) ?? 0) + 1);
      }
      row.latencyMs = Math.round((performance.now() - started) * 100) / 100;
      results.push(row);
      await options.onResult?.(row);
    }
  }
  return results;
}
