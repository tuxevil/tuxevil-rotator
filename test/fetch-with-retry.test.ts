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

	it("retries a transient HTTP 500 under the default generic policy (non-Antigravity callers)", async () => {
		const sleeps: number[] = [];
		const statuses = [500, 200];
		let calls = 0;
		const response = await fetchWithRetry("https://example.test", {
			fetchImpl: async () => new Response(calls === 0 ? "internal" : "ok", { status: statuses[calls++] }),
			sleepImpl: async (ms) => {
				sleeps.push(ms);
			},
		});
		assert.equal(calls, 2);
		assert.equal(response.status, 200);
		assert.equal(sleeps.length, 1);
		assert.ok(sleeps[0] >= 250 && sleeps[0] <= 5_000, `generic backoff stays short: ${sleeps[0]}ms`);
	});

	it("treats 500 and 502 alike under the generic policy", async () => {
		for (const status of [500, 502]) {
			let calls = 0;
			const response = await fetchWithRetry("https://example.test", {
				fetchImpl: async () => new Response("x", { status: calls++ === 0 ? status : 200 }),
				sleepImpl: async () => {},
			});
			assert.equal(calls, 2, `HTTP ${status} is retried`);
			assert.equal(response.status, 200);
		}
	});

	it("keeps Antigravity HTTP 500 and hard-429 classification scoped to retryPolicy antigravity", async () => {
		let calls500 = 0;
		const r500 = await fetchWithRetry("https://example.test", {
			retryPolicy: "antigravity",
			fetchImpl: async () => new Response(calls500++ === 0 ? "internal" : "ok", { status: calls500 === 1 ? 500 : 200 }),
			sleepImpl: async () => {},
		});
		assert.equal(calls500, 1, "Antigravity does not retry HTTP 500");
		assert.equal(r500.status, 500);

		let calls502 = 0;
		const r502 = await fetchWithRetry("https://example.test", {
			retryPolicy: "antigravity",
			fetchImpl: async () => new Response("x", { status: calls502++ === 0 ? 502 : 200 }),
			sleepImpl: async () => {},
		});
		assert.equal(calls502, 2, "Antigravity still retries 502");
		assert.equal(r502.status, 200);

		const hard429Body = JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", details: [{ reason: "QUOTA_EXHAUSTED" }] } });
		let genericCalls = 0;
		await fetchWithRetry("https://example.test", {
			fetchImpl: async () => new Response(hard429Body, { status: genericCalls++ === 0 ? 429 : 200 }),
			sleepImpl: async () => {},
		});
		assert.equal(genericCalls, 2, "generic policy keeps retrying 429 without Antigravity body parsing");
		let antigravityCalls = 0;
		const hard = await fetchWithRetry("https://example.test", {
			retryPolicy: "antigravity",
			fetchImpl: async () => {
				antigravityCalls++;
				return new Response(hard429Body, { status: 429 });
			},
			sleepImpl: async () => {},
		});
		assert.equal(antigravityCalls, 1, "Antigravity fails fast on a hard quota 429");
		assert.equal(hard.status, 429);
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
