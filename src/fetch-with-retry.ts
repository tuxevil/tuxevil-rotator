import type { Dispatcher } from "undici";
import {
	extractRetryDelayMs,
	isAntigravityRetryableError,
	MAX_ANTIGRAVITY_RETRY_DELAY_MS,
} from "./rate-limit-parser.js";

export interface FetchWithRetryOptions extends RequestInit {
	retries?: number;
	timeoutMs?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	exponentialMultiplier?: number;
	jitterRange?: number;
	maxServerRetryDelayMs?: number;
	retryStatuses?: number[];
	fetchImpl?: typeof fetch;
	sleepImpl?: (ms: number) => Promise<void>;
	/** Node/Undici dispatcher selected from the account's provider config. */
	dispatcher?: Dispatcher;
}

export type RequestInitWithDispatcher = RequestInit & { dispatcher?: Dispatcher };

// Twin to Antigravity utils.RetryableFromErrorDetails & classifyGenAIAPIErrorWithMode:
// 408, 429, 502, 503, 504 (HTTP 500 is NOT retried identically).
export const DEFAULT_RETRY_STATUSES = [408, 429, 502, 503, 504] as const;
// Matches Antigravity ccpahttp.New default stream idle timeout (600s).
export const DEFAULT_HEADERS_TIMEOUT_MS = 600_000;

/** Matches Antigravity defaultConversationalCascadeConfig ModelAPIRetryConfig + ModelAPIBackoff. */
export const ANTIGRAVITY_RETRY_CONFIG = {
	maxRetries: 8,
	initialSleepDurationMs: 4_000,
	maxSleepDurationMs: MAX_ANTIGRAVITY_RETRY_DELAY_MS,
	exponentialMultiplier: 2,
	jitterRange: 0.4,
} as const;

/** Matches Antigravity model_api/common/continuation.NewStream defaults. */
export const ANTIGRAVITY_CONTINUATION_RETRY_CONFIG = {
	baseDelayMs: 100,
	maxDelayMs: 5_000,
	maxRetries: 3,
	maxContinuations: 32,
	maxResumeDelayMs: 60_000,
} as const;

/** Raised when an upstream accepts a request but never sends response headers. */
export class UpstreamHeadersTimeoutError extends Error {
	readonly code = "UND_ERR_HEADERS_TIMEOUT";

	constructor(timeoutMs: number) {
		super(`upstream response headers timeout after ${timeoutMs}ms`);
		this.name = "UpstreamHeadersTimeoutError";
	}
}

export interface FetchWithHeadersTimeoutOptions extends RequestInit {
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
	dispatcher?: Dispatcher;
}

export function isRetryableStatus(status: number, retryStatuses: readonly number[] = DEFAULT_RETRY_STATUSES): boolean {
	return retryStatuses.includes(status);
}

export function isRetryableFetchError(error: unknown): boolean {
	if (error instanceof DOMException && error.name === "AbortError") return true;
	if (error instanceof UpstreamHeadersTimeoutError) return true;
	if (error instanceof TypeError) return true;
	const msg = error instanceof Error ? error.message.toLowerCase() : String(error ?? "").toLowerCase();
	if (msg.includes("x509") || msg.includes("certificate") || msg.includes("tls")) return false;
	return false;
}

/**
 * Matches Antigravity timeutil.backoff + core.backoff / generator.retrySleepDuration:
 * exponential growth capped at maxDelayMs with downward jitter `[clamped * (1 - jitterRange), clamped]`
 * floored at baseDelayMs, and when serverRetryDelayMs > 0, `max(backoff, serverRetryDelayMs + rand * backoff * jitterRange)`.
 */
export function calculateBackoffMs(
	attempt: number,
	baseDelayMs: number = ANTIGRAVITY_RETRY_CONFIG.initialSleepDurationMs,
	maxDelayMs: number = ANTIGRAVITY_RETRY_CONFIG.maxSleepDurationMs,
	random: () => number = Math.random,
	exponentialMultiplier: number = ANTIGRAVITY_RETRY_CONFIG.exponentialMultiplier,
	jitterRange: number = ANTIGRAVITY_RETRY_CONFIG.jitterRange,
	serverRetryDelayMs = 0,
): number {
	const raw = baseDelayMs * exponentialMultiplier ** Math.max(0, attempt);
	const clamped = Number.isFinite(raw) ? Math.min(maxDelayMs, raw) : maxDelayMs;
	const backoff = Math.max(
		baseDelayMs,
		Math.round(clamped - random() * clamped * jitterRange),
	);
	if (serverRetryDelayMs > 0) {
		const serverWithJitter =
			serverRetryDelayMs + Math.round(random() * backoff * jitterRange);
		return Math.max(backoff, serverWithJitter);
	}
	return backoff;
}

/**
 * Matches Antigravity continuation.sleepForMidStreamRetry:
 * `min(baseDelay << min(max(retry - 1, 0), 6), maxDelay)` with half-jitter `[0.5, 1.0)`.
 */
export function calculateContinuationBackoffMs(
	attempt: number,
	random = Math.random,
	serverRetryDelayMs = 0,
	baseDelayMs = ANTIGRAVITY_CONTINUATION_RETRY_CONFIG.baseDelayMs,
	maxDelayMs = ANTIGRAVITY_CONTINUATION_RETRY_CONFIG.maxDelayMs,
): number {
	const shift = Math.min(Math.max(attempt - 1, 0), 6);
	const exp = Math.min(baseDelayMs * 2 ** shift, maxDelayMs);
	const jittered = Math.round(exp * (0.5 + random() * 0.5));
	return serverRetryDelayMs > 0 ? Math.max(serverRetryDelayMs, jittered) : jittered;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTimeoutSignal(timeoutMs: number | undefined, inputSignal: AbortSignal | null | undefined): AbortSignal | undefined {
	if (!timeoutMs || timeoutMs <= 0) return inputSignal ?? undefined;
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	if (!inputSignal) return timeoutSignal;
	return AbortSignal.any([inputSignal, timeoutSignal]);
}

/**
 * Fetch a response while bounding only the time spent waiting for its headers.
 * Once headers arrive, the caller owns the response body and its stream-level
 * idle/backpressure guards continue to apply.
 */
export async function fetchWithHeadersTimeout(
	input: RequestInfo | URL,
	options: FetchWithHeadersTimeoutOptions = {},
): Promise<Response> {
	const {
		timeoutMs = DEFAULT_HEADERS_TIMEOUT_MS,
		fetchImpl = fetch,
		dispatcher,
		signal: inputSignal,
		...init
	} = options;

	if (!timeoutMs || timeoutMs <= 0) {
		return fetchImpl(input, {
			...init,
			dispatcher,
			signal: inputSignal,
		} as RequestInitWithDispatcher);
	}

	const timeoutController = new AbortController();
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		timeoutController.abort();
	}, timeoutMs);
	const requestSignal = inputSignal
		? AbortSignal.any([inputSignal, timeoutController.signal])
		: timeoutController.signal;

	try {
		return await fetchImpl(input, {
			...init,
			dispatcher,
			signal: requestSignal,
		} as RequestInitWithDispatcher);
	} catch (error) {
		// A client cancellation must retain its original error and must not cause
		// the rotator to retry work the client no longer wants.
		if (timedOut && !inputSignal?.aborted) {
			throw new UpstreamHeadersTimeoutError(timeoutMs);
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Fetch wrapper for non-streaming calls. Retries only transport failures and explicit retryable statuses.
 * Do not use for streaming responses: retrying streams can duplicate upstream work.
 */
export async function fetchWithRetry(input: RequestInfo | URL, options: FetchWithRetryOptions = {}): Promise<Response> {
	const {
		retries = 2,
		timeoutMs = 10_000,
		baseDelayMs = ANTIGRAVITY_RETRY_CONFIG.initialSleepDurationMs,
		maxDelayMs = ANTIGRAVITY_RETRY_CONFIG.maxSleepDurationMs,
		exponentialMultiplier = ANTIGRAVITY_RETRY_CONFIG.exponentialMultiplier,
		jitterRange = ANTIGRAVITY_RETRY_CONFIG.jitterRange,
		maxServerRetryDelayMs = MAX_ANTIGRAVITY_RETRY_DELAY_MS,
		retryStatuses = [...DEFAULT_RETRY_STATUSES],
		fetchImpl = fetch,
		sleepImpl = sleep,
		dispatcher,
		...init
	} = options;

	let lastError: unknown;
	for (let attempt = 0; attempt <= retries; attempt++) {
		let serverRetryDelayMs = 0;
		try {
			const requestInit: RequestInitWithDispatcher = {
				...init,
				dispatcher,
				signal: createTimeoutSignal(timeoutMs, init.signal),
			};
			const response = await fetchImpl(input, requestInit);

			if (!isRetryableStatus(response.status, retryStatuses) || attempt === retries) {
				return response;
			}

			let errorText = "";
			if (response.status === 429 || response.status === 402 || response.status >= 500) {
				errorText = await response.clone().text().catch(() => "");
			}
			const serverDelay = extractRetryDelayMs(errorText, response.headers);
			if (serverDelay !== null) {
				if (serverDelay > maxServerRetryDelayMs) {
					return response;
				}
				serverRetryDelayMs = serverDelay;
			}
			if (
				response.status === 429 &&
				!isAntigravityRetryableError({
					status: response.status,
					errorText,
					headers: response.headers,
				})
			) {
				return response;
			}

			await response.body?.cancel().catch(() => undefined);
		} catch (err) {
			lastError = err;
			if (!isRetryableFetchError(err) || attempt === retries) {
				throw err;
			}
		}

		await sleepImpl(
			calculateBackoffMs(
				attempt,
				baseDelayMs,
				maxDelayMs,
				Math.random,
				exponentialMultiplier,
				jitterRange,
				serverRetryDelayMs,
			),
		);
	}

	throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "fetch failed"));
}

export interface AntigravityApiRetryOptions<T> {
	maxRetries?: number;
	initialSleepDurationMs?: number;
	maxSleepDurationMs?: number;
	exponentialMultiplier?: number;
	jitterRange?: number;
	maxServerRetryDelayMs?: number;
	random?: () => number;
	sleepImpl?: (ms: number) => Promise<void>;
	signal?: AbortSignal;
	classifyError?: (error: unknown) => {
		retryable: boolean;
		serverRetryDelayMs?: number;
	};
	fn: (attempt: number) => Promise<T>;
}

/**
 * Twin retry loop to Antigravity core.CallWithRetry / oneharness RunWithAPIRetry:
 * MaxAttempts = maxRetries + 1 (default 8 + 1 = 9), backoff via ModelAPIBackoff
 * (4000ms -> 240s, 2.0x, downward jitter 0.4, + server delay additive jitter),
 * failing fast when server delay > 240s or non-retryable.
 */
export async function runWithAntigravityApiRetry<T>(
	options: AntigravityApiRetryOptions<T>,
): Promise<T> {
	const {
		maxRetries = ANTIGRAVITY_RETRY_CONFIG.maxRetries,
		initialSleepDurationMs = ANTIGRAVITY_RETRY_CONFIG.initialSleepDurationMs,
		maxSleepDurationMs = ANTIGRAVITY_RETRY_CONFIG.maxSleepDurationMs,
		exponentialMultiplier = ANTIGRAVITY_RETRY_CONFIG.exponentialMultiplier,
		jitterRange = ANTIGRAVITY_RETRY_CONFIG.jitterRange,
		maxServerRetryDelayMs = MAX_ANTIGRAVITY_RETRY_DELAY_MS,
		random = Math.random,
		sleepImpl = sleep,
		signal,
		classifyError = (error: unknown) => {
			if (isRetryableFetchError(error)) return { retryable: true };
			const status =
				typeof error === "object" && error !== null && "status" in error && typeof (error as { status: unknown }).status === "number"
					? (error as { status: number }).status
					: undefined;
			const errorText = error instanceof Error ? error.message : String(error ?? "");
			const serverRetryDelayMs = extractRetryDelayMs(errorText) ?? undefined;
			return {
				retryable: isAntigravityRetryableError({ status, errorText }),
				serverRetryDelayMs,
			};
		},
		fn,
	} = options;

	const maxAttempts = Math.max(1, maxRetries + 1);
	let lastError: unknown;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (signal?.aborted) {
			throw signal.reason ?? new DOMException("Aborted", "AbortError");
		}
		try {
			return await fn(attempt);
		} catch (error) {
			lastError = error;
			const verdict = classifyError(error);
			const serverDelayMs = verdict.serverRetryDelayMs ?? 0;
			if (
				!verdict.retryable ||
				serverDelayMs > maxServerRetryDelayMs ||
				attempt + 1 >= maxAttempts
			) {
				throw error;
			}
			const delayMs = calculateBackoffMs(
				attempt,
				initialSleepDurationMs,
				maxSleepDurationMs,
				random,
				exponentialMultiplier,
				jitterRange,
				serverDelayMs,
			);
			await sleepImpl(delayMs);
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "retry exhausted"));
}
