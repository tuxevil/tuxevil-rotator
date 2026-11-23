export type RateLimitReason = "rate-limit" | "quota-exhausted" | "model-capacity" | "server-error" | "unknown";

export const RESOURCE_EXHAUSTED_FALLBACK_MS = 30 * 60 * 1000;
// Matches Antigravity utils.classifyGenAIAPIErrorWithMode & classifyRateLimitExceededRetry (240s)
// and model_api/common/continuation.canResumeOnError (60s).
export const MAX_ANTIGRAVITY_RETRY_DELAY_MS = 240_000;
export const MAX_ANTIGRAVITY_CONTINUATION_DELAY_MS = 60_000;

export const ANTIGRAVITY_HARD_BILLING_REASONS = new Set([
	"MONETIZATION_DENIED",
	"USER_SPEND_CAP_EXCEEDED",
	"PREPAID_BALANCE_EXHAUSTED",
	"PROJECT_SPEND_CAP_EXCEEDED",
	"INSUFFICIENT_G1_CREDITS_BALANCE",
	"BILLING_ACCOUNT_SPEND_LIMIT_EXCEEDED",
	"GEMINI_ENTERPRISE_USER_QUOTA_EXHAUSTED",
]);

export const ANTIGRAVITY_NON_RETRYABLE_REASONS = new Set([
	"QUOTA_EXHAUSTED",
	"VALIDATION_REQUIRED",
	...ANTIGRAVITY_HARD_BILLING_REASONS,
]);

export const ANTIGRAVITY_RETRYABLE_GRPC_CODES = new Set([4, 8, 13, 14]);

export const ANTIGRAVITY_TRANSIENT_OVERLOAD_MARKERS = [
	"PREFILL_QUEUE_OVERLOADED",
	"Overloaded prefill queue",
	"PREFILL_QUEUE_PREEMPTED",
	"Overloaded local recovery queue",
	"OVERLOADED_TOO_MANY_RETRIES_PER_REQUEST",
	"OVERLOADED_TOO_MANY_RETRIES_PER_STUB",
	"Thread is cancelled before we get prefill results",
	"Pony address resolution failed",
	"DECODE_PREEMPTED",
	"Preempted out of decode queue",
	"TPU device returned error",
	"TPU_EXECUTE_ERROR",
	"THROTTLED_TASK_LIMIT",
	"incomplete envelope: unexpected EOF",
] as const;

export interface ParsedErrorDetails {
	statusText?: string;
	reasons: string[];
	metadataReasons: string[];
	retryDelaysMs: number[];
	grpcCode?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDurationToMs(errorText: string): number | null {
	const durationMatch = errorText.match(/(?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i);
	if (!durationMatch) return null;
	const hours = durationMatch[1] ? parseInt(durationMatch[1], 10) : 0;
	const minutes = durationMatch[2] ? parseInt(durationMatch[2], 10) : 0;
	const seconds = parseFloat(durationMatch[3]);
	if (!Number.isFinite(seconds)) return null;
	const durationMs = ((hours * 60 + minutes) * 60 + seconds) * 1000;
	return Number.isFinite(durationMs) ? Math.ceil(durationMs) : null;
}

export function parseErrorJsonDetails(errorText: string): ParsedErrorDetails {
	const result: ParsedErrorDetails = {
		reasons: [],
		metadataReasons: [],
		retryDelaysMs: [],
	};
	const trimmed = errorText.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return result;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return result;
	}
	const root = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : parsed;
	if (!isRecord(root)) return result;
	if (typeof root.status === "string") result.statusText = root.status;
	if (typeof root.code === "number" && Number.isInteger(root.code)) {
		result.grpcCode = root.code;
	}
	if (Array.isArray(root.details)) {
		for (const detail of root.details) {
			if (!isRecord(detail)) continue;
			if (typeof detail.reason === "string" && detail.reason.trim()) {
				result.reasons.push(detail.reason.trim());
			}
			if (isRecord(detail.metadata) && typeof detail.metadata.reason === "string" && detail.metadata.reason.trim()) {
				result.metadataReasons.push(detail.metadata.reason.trim());
			}
			if (typeof detail.retryDelay === "string") {
				const ms = parseDurationToMs(detail.retryDelay);
				if (ms && ms > 0) result.retryDelaysMs.push(ms);
			}
		}
	}
	return result;
}

export function isHardQuotaExhaustedMessage(errorText: string): boolean {
	const lower = errorText.toLowerCase();
	return (
		lower.includes("per day") ||
		lower.includes("daily") ||
		lower.includes("billing account") ||
		lower.includes("individual quota reached")
	);
}

export function isHardBillingOrSpendCapReason(reason: string): boolean {
	return ANTIGRAVITY_HARD_BILLING_REASONS.has(reason.trim().toUpperCase());
}

export function hasTransientBackendOverloadMarker(errorText: string): boolean {
	return ANTIGRAVITY_TRANSIENT_OVERLOAD_MARKERS.some((marker) => errorText.includes(marker));
}

export function isModelCapacityExhaustedError(errorText: string): boolean {
	const parsed = parseErrorJsonDetails(errorText);
	if (parsed.metadataReasons.some((r) => r.toUpperCase() === "MODEL_CAPACITY_EXHAUSTED")) {
		return true;
	}
	return errorText.toLowerCase().includes("model_capacity_exhausted");
}

export function classifyRateLimitReason(errorText: string, status?: number): RateLimitReason {
	const parsed = parseErrorJsonDetails(errorText);
	if (
		status === 402 ||
		parsed.reasons.some((r) => ANTIGRAVITY_NON_RETRYABLE_REASONS.has(r.toUpperCase()))
	) {
		return "quota-exhausted";
	}
	if (status === 503 || status === 529) return "model-capacity";
	if (status === 500 || status === 504 || status === 408) return "server-error";

	const lower = errorText.toLowerCase();
	if (
		lower.includes("quota_exhausted") ||
		lower.includes("validation_required") ||
		lower.includes("monetization_denied") ||
		lower.includes("user_spend_cap_exceeded") ||
		lower.includes("prepaid_balance_exhausted") ||
		lower.includes("project_spend_cap_exceeded") ||
		lower.includes("insufficient_g1_credits_balance") ||
		lower.includes("billing_account_spend_limit_exceeded") ||
		lower.includes("gemini_enterprise_user_quota_exhausted") ||
		lower.includes("quotaresetdelay") ||
		lower.includes("quotaresettimestamp") ||
		lower.includes("resource_exhausted") ||
		lower.includes("resource exhausted") ||
		lower.includes("usage_limit_reached") ||
		lower.includes("usage limit reached") ||
		lower.includes("daily limit") ||
		lower.includes("quota exceeded") ||
		isHardQuotaExhaustedMessage(errorText)
	) {
		return "quota-exhausted";
	}
	if (
		isModelCapacityExhaustedError(errorText) ||
		lower.includes("capacity_exhausted") ||
		lower.includes("currently overloaded") ||
		lower.includes("service temporarily unavailable")
	) {
		return "model-capacity";
	}
	if (
		lower.includes("rate_limit_exceeded") ||
		lower.includes("rate limit") ||
		lower.includes("too many requests") ||
		lower.includes("throttl") ||
		lower.includes("freeusagelimit")
	) {
		return "rate-limit";
	}
	if (
		lower.includes("internal server error") ||
		lower.includes("server error") ||
		lower.includes("bad gateway") ||
		lower.includes("gateway timeout")
	) {
		return "server-error";
	}
	return "unknown";
}

export function extractRetryDelayMs(
	errorText: string,
	headers: Headers = new Headers(),
): number | null {
	const retryAfter = headers.get("retry-after");
	if (retryAfter) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
		const retryDate = new Date(retryAfter);
		if (!Number.isNaN(retryDate.getTime())) {
			const delta = retryDate.getTime() - Date.now();
			if (delta > 0) return Math.ceil(delta);
		}
	}

	const resetHeader = headers.get("x-ratelimit-reset");
	if (resetHeader) {
		const resetTs = Number(resetHeader);
		if (Number.isFinite(resetTs) && resetTs > 0) {
			const delta = resetTs * 1000 - Date.now();
			if (delta > 0) return Math.ceil(delta);
		}
	}

	const resetAfter = headers.get("x-ratelimit-reset-after");
	if (resetAfter) {
		const seconds = Number(resetAfter);
		if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
	}

	const parsed = parseErrorJsonDetails(errorText);
	if (parsed.retryDelaysMs.length > 0) {
		return parsed.retryDelaysMs[0];
	}

	const codexResetSecondsMatch = errorText.match(
		/["']?resets_in_seconds["']?\s*:\s*["']?(\d+(?:\.\d+)?)/i,
	);
	if (codexResetSecondsMatch?.[1]) {
		const seconds = Number(codexResetSecondsMatch[1]);
		if (Number.isFinite(seconds) && seconds > 0) {
			return Math.ceil(seconds * 1000);
		}
	}

	const codexResetAtMatch = errorText.match(
		/["']?resets_at["']?\s*:\s*(?:["']([^"']+)["']|(\d{10,13}))/i,
	);
	if (codexResetAtMatch) {
		const rawResetAt = codexResetAtMatch[1] ?? codexResetAtMatch[2];
		const numericResetAt = Number(rawResetAt);
		const resetAt = Number.isFinite(numericResetAt)
			? numericResetAt < 1_000_000_000_000
				? numericResetAt * 1000
				: numericResetAt
			: Date.parse(rawResetAt ?? "");
		if (Number.isFinite(resetAt)) {
			const delta = resetAt - Date.now();
			if (delta > 0) return Math.ceil(delta);
		}
	}

	const quotaDelayMatch = errorText.match(/quotaResetDelay[:\s"]+(\d+(?:\.\d+)?)(ms|s)/i);
	if (quotaDelayMatch) {
		const value = parseFloat(quotaDelayMatch[1]);
		if (Number.isFinite(value) && value > 0) {
			const ms = quotaDelayMatch[2].toLowerCase() === "s" ? value * 1000 : value;
			return Math.ceil(ms);
		}
	}

	const quotaTimestampMatch = errorText.match(/quotaResetTimeStamp[:\s"]+(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/i);
	if (quotaTimestampMatch) {
		const resetTime = new Date(quotaTimestampMatch[1]).getTime();
		if (!Number.isNaN(resetTime)) {
			const delta = resetTime - Date.now();
			if (delta > 0) return Math.ceil(delta);
		}
	}

	const retryDelayMatch = errorText.match(/(?:retry[-_]?after[-_]?ms|retryDelay|Please retry in)[:\s"]+([0-9.]+)(ms|s)/i);
	if (retryDelayMatch?.[1]) {
		const value = parseFloat(retryDelayMatch[1]);
		if (Number.isFinite(value) && value > 0) {
			const ms = retryDelayMatch[2].toLowerCase() === "ms" ? value : value * 1000;
			return Math.ceil(ms);
		}
	}

	const naturalRetryMatch = errorText.match(/retry\s+(?:after\s+)?(\d+)\s*(?:sec|secs|seconds|s\b)/i);
	if (naturalRetryMatch?.[1]) {
		const seconds = Number(naturalRetryMatch[1]);
		if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
	}

	const resetAfterMatch = errorText.match(/reset after (?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i);
	if (resetAfterMatch) {
		const duration = parseDurationToMs(resetAfterMatch[0]);
		if (duration && duration > 0) return Math.ceil(duration);
	}

	const duration = parseDurationToMs(errorText);
	if (duration && duration > 0) return Math.ceil(duration);

	return null;
}

export function parseRetryAfterMs(
	errorText: string,
	headers: Headers,
	fallbackMs = 60_000,
): number {
	const extracted = extractRetryDelayMs(errorText, headers);
	if (extracted !== null && extracted > 0) return extracted;
	return Number.isFinite(fallbackMs) && fallbackMs > 0
		? Math.ceil(fallbackMs)
		: 60_000;
}

export interface AntigravityErrorClassificationInput {
	status?: number;
	grpcCode?: number;
	errorText: string;
	headers?: Headers;
	isMidStream?: boolean;
	retryInternalGrpc?: boolean;
}

/**
 * Twin decision procedure matching Antigravity utils.isRetryableAPIError +
 * utils.classifyGenAIAPIErrorWithMode + utils.RetryableFromErrorDetails.
 */
export function isAntigravityRetryableError(
	input: AntigravityErrorClassificationInput,
): boolean {
	const {
		status,
		errorText,
		headers = new Headers(),
		isMidStream = false,
		retryInternalGrpc = true,
	} = input;

	const parsed = parseErrorJsonDetails(errorText);
	if (
		parsed.reasons.some((r) => ANTIGRAVITY_NON_RETRYABLE_REASONS.has(r.toUpperCase())) ||
		isModelCapacityExhaustedError(errorText)
	) {
		return false;
	}

	if (status === 402 || (status === 429 && isHardQuotaExhaustedMessage(errorText))) {
		return false;
	}

	if (errorText.toLowerCase().includes("quota_exhausted")) {
		return false;
	}

	const retryDelayMs = extractRetryDelayMs(errorText, headers);
	const ceilingMs = isMidStream
		? MAX_ANTIGRAVITY_CONTINUATION_DELAY_MS
		: MAX_ANTIGRAVITY_RETRY_DELAY_MS;
	if (retryDelayMs !== null && retryDelayMs > ceilingMs) {
		return false;
	}

	if (hasTransientBackendOverloadMarker(errorText)) {
		return true;
	}

	if (status !== undefined) {
		if (status === 408 || status === 429 || status === 502 || status === 503 || status === 504) {
			return true;
		}
		if (status === 500 || (status >= 400 && status < 500)) {
			return false;
		}
	}

	const grpcCode = input.grpcCode ?? parsed.grpcCode;
	if (grpcCode !== undefined) {
		if (grpcCode === 13) return retryInternalGrpc;
		return ANTIGRAVITY_RETRYABLE_GRPC_CODES.has(grpcCode);
	}

	return false;
}
