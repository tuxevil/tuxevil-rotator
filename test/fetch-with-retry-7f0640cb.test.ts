import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchWithRetry, runWithAntigravityApiRetry } from "../src/fetch-with-retry.js";

describe("caller AbortSignal cancellation (7f0640cb)", () => {
	it("does not sleep or retry in fetchWithRetry after caller signal aborts", async () => {
		const ac = new AbortController();
		let fetchCalls = 0;
		const sleeps: number[] = [];
		let release!: () => void;
		const started = new Promise<void>((r) => {
			release = r;
		});

		const fetchImpl = ((_input: unknown, init?: RequestInit) => {
			fetchCalls++;
			const sig = init?.signal as AbortSignal;
			return new Promise<Response>((_res, rej) => {
				if (sig.aborted) {
					rej(sig.reason);
					return;
				}
				sig.addEventListener("abort", () => rej(sig.reason), { once: true });
				if (fetchCalls === 1) release();
			});
		}) as typeof fetch;

		const p = fetchWithRetry("https://example.test", {
			signal: ac.signal,
			retries: 2,
			fetchImpl,
			sleepImpl: async (ms: number) => {
				sleeps.push(ms);
			},
		});

		await started;
		ac.abort(new DOMException("Client cancelled", "AbortError"));
		await assert.rejects(p, (err: unknown) => err instanceof DOMException && err.name === "AbortError");
		assert.equal(fetchCalls, 1);
		assert.deepEqual(sleeps, []);
	});

	it("does not invoke onRetry or sleepImpl in runWithAntigravityApiRetry after caller signal aborts", async () => {
		const ac = new AbortController();
		const retries: unknown[] = [];
		const sleeps: number[] = [];
		let fnCalls = 0;

		const p = runWithAntigravityApiRetry({
			maxRetries: 2,
			signal: ac.signal,
			random: () => 0,
			sleepImpl: async (ms: number) => {
				sleeps.push(ms);
			},
			onRetry: (info) => retries.push(info),
			fn: async () => {
				fnCalls++;
				ac.abort(new DOMException("Client cancelled", "AbortError"));
				throw ac.signal.reason;
			},
		});

		await assert.rejects(p, (err: unknown) => err instanceof DOMException && err.name === "AbortError");
		assert.equal(fnCalls, 1);
		assert.equal(retries.length, 0);
		assert.deepEqual(sleeps, []);
	});
});
