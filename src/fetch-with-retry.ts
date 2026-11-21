import type { Dispatcher } from "undici";

export interface FetchWithRetryOptions extends RequestInit {
	retries?: number;
	timeoutMs?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	retryStatuses?: number[];
	fetchImpl?: typeof fetch;
	sleepImpl?: (ms: number) => Promise<void>;
	/** Node/Undici dispatcher selected from the account's provider config. */
	dispatcher?: Dispatcher;
}

export type RequestInitWithDispatcher = RequestInit & { dispatcher?: Dispatcher };

export const DEFAULT_RETRY_STATUSES = [408, 429, 500, 502, 503, 504] as const;
// Match STREAM_IDLE_TIMEOUT_MS (120s): thinking/large-context models can hold
// upstream HTTP response headers until prefill and initial generation begin.
export const DEFAULT_HEADERS_TIMEOUT_MS = 120_000;

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
	return error instanceof TypeError;
}

export function calculateBackoffMs(
	attempt: number,
	baseDelayMs = 250,
	maxDelayMs = 5_000,
	random = Math.random,
): number {
	const exponential = baseDelayMs * 2 ** Math.max(0, attempt);
	const jitter = exponential * 0.2 * random();
	return Math.min(maxDelayMs, Math.round(exponential + jitter));
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
		baseDelayMs = 250,
		maxDelayMs = 5_000,
		retryStatuses = [...DEFAULT_RETRY_STATUSES],
		fetchImpl = fetch,
		sleepImpl = sleep,
		dispatcher,
		...init
	} = options;

	let lastError: unknown;
	for (let attempt = 0; attempt <= retries; attempt++) {
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

			await response.body?.cancel().catch(() => undefined);
		} catch (err) {
			lastError = err;
			if (!isRetryableFetchError(err) || attempt === retries) {
				throw err;
			}
		}

		await sleepImpl(calculateBackoffMs(attempt, baseDelayMs, maxDelayMs));
	}

	throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "fetch failed"));
}
