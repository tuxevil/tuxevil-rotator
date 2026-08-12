import { calculateCost } from "./spend-logger.js";

/**
 * Masks an account email or label for PII protection in headers.
 * Example: "user@example.com" -> "us***r@example.com"
 * Example: "donated-account" -> "do***nt"
 * Example: "acc" -> "ac***"
 */
export function maskAccountLabel(account: string): string {
  if (!account) return "unknown";
  if (account.includes("@")) {
    const [user, domain] = account.split("@");
    if (user.length <= 2) {
      return `${user}***@${domain}`;
    }
    return `${user.slice(0, 2)}***${user.slice(-1)}@${domain}`;
  }
  if (account.length <= 4) return `${account}***`;
  return `${account.slice(0, 2)}***${account.slice(-2)}`;
}

export interface CompressionHeaderOptions {
  mode: string;
  savedChars: number;
  savingsPercent: number;
}

export interface RotatorResponseHeaderOptions {
  accountLabel?: string;
  model?: string;
  latencyMs?: number;
  ttfbMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  healthScore?: number;
  routingPolicy?: string;
  idempotencyHit?: boolean;
  retries?: number;
  compression?: CompressionHeaderOptions;
  selectedModel?: string;
  routingRationale?: string;
}

/**
 * Builds standard X-Rotator-* response headers for observability.
 */
export function buildRotatorResponseHeaders(
  opts: RotatorResponseHeaderOptions,
): Record<string, string> {
  const headers: Record<string, string> = {};

  if (opts.idempotencyHit) {
    headers["X-Rotator-Idempotency-Hit"] = "true";
  }

  if (opts.retries !== undefined && opts.retries > 0) {
    headers["X-Rotator-Retries"] = String(Math.floor(opts.retries));
  }

  if (opts.accountLabel) {
    headers["X-Rotator-Account"] = maskAccountLabel(opts.accountLabel);
  }
  if (opts.model) {
    headers["X-Rotator-Model"] = opts.model;
  }
  if (opts.selectedModel) {
    headers["X-Model-Router-Selected-Model"] = opts.selectedModel;
    headers["X-Rotator-Selected-Model"] = opts.selectedModel;
  }
  if (opts.routingRationale) {
    headers["X-Model-Router-Rationale"] = opts.routingRationale.slice(0, 512);
  }
  if (opts.latencyMs !== undefined && opts.latencyMs >= 0) {
    headers["X-Rotator-Latency-Ms"] = String(Math.round(opts.latencyMs));
  }
  if (opts.ttfbMs !== undefined && opts.ttfbMs >= 0) {
    headers["X-Rotator-TTFB-Ms"] = String(Math.round(opts.ttfbMs));
  }
  if (opts.inputTokens !== undefined && opts.inputTokens >= 0) {
    headers["X-Rotator-Tokens-Input"] = String(opts.inputTokens);
  }
  if (opts.outputTokens !== undefined && opts.outputTokens >= 0) {
    headers["X-Rotator-Tokens-Output"] = String(opts.outputTokens);
  }
  if (
    (opts.inputTokens !== undefined && opts.inputTokens >= 0) ||
    (opts.outputTokens !== undefined && opts.outputTokens >= 0)
  ) {
    const input = opts.inputTokens && opts.inputTokens >= 0 ? opts.inputTokens : 0;
    const output = opts.outputTokens && opts.outputTokens >= 0 ? opts.outputTokens : 0;
    const cost = calculateCost(opts.model || "", input, output);
    headers["X-Rotator-Cost-Usd"] = cost.toFixed(6);
  }
  if (opts.healthScore !== undefined) {
    headers["X-Rotator-Health-Score"] = opts.healthScore.toFixed(2);
  }
  if (opts.routingPolicy) {
    headers["X-Rotator-Routing-Policy"] = opts.routingPolicy;
  }
  if (opts.compression) {
    headers["X-Rotator-Compression-Mode"] = opts.compression.mode;
    headers["X-Rotator-Compression-Saved-Chars"] = String(opts.compression.savedChars);
    headers["X-Rotator-Compression-Savings-Percent"] = String(opts.compression.savingsPercent);
  }

  return headers;
}
