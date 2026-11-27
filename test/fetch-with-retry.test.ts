import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	ANTIGRAVITY_HEADERS_TIMEOUT_MS,
	calculateBackoffMs,
	DEFAULT_HEADERS_TIMEOUT_MS,
	fetchWithHeadersTimeout,
	fetchWithRetry,
	isRetryableFetchError,
	isRetryableStatus,
	UpstreamHeadersTimeoutError,
} from "../src/fetch-with-retry.js";

describe("fetchWithRetry", () => {
	it("classifies retryable statuses", () => {
		assert.equal(isRetryableStatus(429), true);
		assert.equal(isRetryableStatus(503), true);
		assert.equal(isRetryableStatus(401), false);
		assert.equal(isRetryableStatus(403), false);
	});

	it("classifies transport errors as retryable", () => {
		assert.equal(isRetryableFetchError(new TypeError("fetch failed")), true);
		assert.equal(isRetryableFetchError(new UpstreamHeadersTimeoutError(30_000)), true);
		assert.equal(isRetryableFetchError(new Error("bad input")), false);
	});

	it("keeps a 120s default headers timeout and scopes 600s to Antigravity", () => {
		assert.equal(DEFAULT_HEADERS_TIMEOUT_MS, 120_000);
		assert.equal(ANTIGRAVITY_HEADERS_TIMEOUT_MS, 600_000);
	});

	it("bounds time waiting for response headers without timing out the body", async () => {
		let aborted = false;
		await assert.rejects(
			fetchWithHeadersTimeout("https://example.test", {
				timeoutMs: 10,
				fetchImpl: async (_input, init) => new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						aborted = true;
						reject(new DOMException("aborted", "AbortError"));
					}, { once: true });
				}),
				}),
			UpstreamHeadersTimeoutError,
		);
		assert.equal(aborted, true);
	});

	it("preserves caller cancellation instead of converting it to a header timeout", async () => {
		const controller = new AbortController();
		const request = fetchWithHeadersTimeout("https://example.test", {
			timeoutMs: 100,
				signal: controller.signal,
			fetchImpl: async (_input, init) => new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					reject(new DOMException("aborted", "AbortError"));
				}, { once: true });
			}),
		});
		controller.abort();
		await assert.rejects(request, (error: unknown) => {
			assert.equal(error instanceof DOMException, true);
			assert.equal((error as DOMException).name, "AbortError");
			return true;
		});
	});

	it("calculates bounded exponential backoff with downward Antigravity jitter", () => {
		assert.equal(calculateBackoffMs(0, 100, 1_000, () => 0), 100);
		assert.equal(calculateBackoffMs(1, 100, 1_000, () => 0), 200);
		assert.equal(calculateBackoffMs(10, 100, 500, () => 0), 500);
		assert.equal(calculateBackoffMs(10, 100, 500, () => 1), 300);
	});

	it("returns first successful response", async () => {
		let calls = 0;
		const response = await fetchWithRetry("https://example.test", {
			fetchImpl: async () => {
				calls++;
				return new Response("ok", { status: 200 });
			},
			sleepImpl: async () => {},
		});
		assert.equal(calls, 1);
		assert.equal(response.status, 200);
		assert.equal(await response.text(), "ok");
	});

	it("passes an account-selected dispatcher through without replacing it", async () => {
		const dispatcher = { dispatch() { return true; } } as never;
		let received: unknown;
		await fetchWithRetry("https://example.test", {
			dispatcher,
			fetchImpl: async (_input, init) => {
				received = (init as RequestInit & { dispatcher?: unknown }).dispatcher;
				return new Response("ok", { status: 200 });
			},
		});
		assert.strictEqual(received, dispatcher);
	});

	it("retries retryable statuses then returns success", async () => {
		let calls = 0;
		const response = await fetchWithRetry("https://example.test", {
			fetchImpl: async () => {
				calls++;
				return calls === 1 ? new Response("busy", { status: 503 }) : new Response("ok", { status: 200 });
			},
			sleepImpl: async () => {},
			retries: 2,
		});
		assert.equal(calls, 2);
		assert.equal(response.status, 200);
	});

	it("does not retry non-retryable statuses", async () => {
		let calls = 0;
		const response = await fetchWithRetry("https://example.test", {
			fetchImpl: async () => {
				calls++;
				return new Response("no", { status: 401 });
			},
			sleepImpl: async () => {},
			retries: 2,
		});
		assert.equal(calls, 1);
		assert.equal(response.status, 401);
	});

	it("retries transport errors then returns success", async () => {
		let calls = 0;
		const response = await fetchWithRetry("https://example.test", {
			fetchImpl: async () => {
				calls++;
				if (calls === 1) throw new TypeError("fetch failed");
				return new Response("ok", { status: 200 });
			},
			sleepImpl: async () => {},
			retries: 2,
		});
		assert.equal(calls, 2);
		assert.equal(response.status, 200);
	});

	it("throws final transport error after retry budget", async () => {
		let calls = 0;
		await assert.rejects(
			fetchWithRetry("https://example.test", {
				fetchImpl: async () => {
					calls++;
					throw new TypeError("fetch failed");
				},
				sleepImpl: async () => {},
				retries: 1,
			}),
			TypeError,
		);
		assert.equal(calls, 2);
	});
});
