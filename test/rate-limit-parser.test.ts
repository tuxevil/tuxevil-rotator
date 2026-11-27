import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyRateLimitReason, parseRetryAfterMs } from "../src/rate-limit-parser.js";

describe("rate limit parser", () => {
	it("parses retry-after header in seconds", () => {
		const headers = new Headers({ "retry-after": "7" });
		const ms = parseRetryAfterMs("", headers);
		assert.equal(ms, 7000);
	});

	it("parses x-ratelimit-reset-after header", () => {
		const headers = new Headers({ "x-ratelimit-reset-after": "2" });
		const ms = parseRetryAfterMs("", headers);
		assert.equal(ms, 2000);
	});

	it("parses quotaResetDelay from error text", () => {
		const ms = parseRetryAfterMs('quotaResetDelay: "1.5s"', new Headers());
		assert.equal(ms, 1500);
	});

	it("parses retryDelay and duration strings", () => {
		const ms = parseRetryAfterMs('{"retryDelay":"45s"} reset after 1h2m3s', new Headers());
		assert.equal(ms, 45000);
	});

	it("parses the full Antigravity reset duration", () => {
		const ms = parseRetryAfterMs("RESOURCE_EXHAUSTED. Resets in 1h20m14s", new Headers());
		assert.equal(ms, 4_814_000);
	});

	it("falls back to the default retry window", () => {
		const ms = parseRetryAfterMs("unstructured error", new Headers());
		assert.equal(ms, 60000);
	});

	it("accepts the caller's configured fallback when no reset is parseable", () => {
		const ms = parseRetryAfterMs("unstructured error", new Headers(), 1_800_000);
		assert.equal(ms, 1_800_000);
	});

	it("classifies quota exhaustion and capacity distinctly", () => {
		assert.equal(classifyRateLimitReason("RESOURCE_EXHAUSTED quotaResetDelay: 5s", 429), "quota-exhausted");
		assert.equal(classifyRateLimitReason("service temporarily unavailable", 503), "model-capacity");
		assert.equal(classifyRateLimitReason("internal server error", 500), "server-error");
		assert.equal(classifyRateLimitReason("too many requests", 429), "rate-limit");
		assert.equal(classifyRateLimitReason("weird", 429), "unknown");
	});

	it("classifies the Codex usage limit payload as quota exhaustion", () => {
		assert.equal(
			classifyRateLimitReason(
				'{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached"}}',
				429,
			),
			"quota-exhausted",
		);
	});

	it("parses Codex resets_in_seconds from a 429 body", () => {
		const ms = parseRetryAfterMs(
			'{"error":{"resets_in_seconds":2447511}}',
			new Headers(),
		);
		assert.equal(ms, 2_447_511_000);
	});

	it("parses Codex resets_at epoch seconds from a 429 body", () => {
		const resetAt = Math.floor(Date.now() / 1000) + 120;
		const ms = parseRetryAfterMs(
			`{"error":{"resets_at":${resetAt}}}`,
			new Headers(),
		);
		assert.ok(ms >= 119_000 && ms <= 121_000, `unexpected reset duration: ${ms}`);
	});
});
