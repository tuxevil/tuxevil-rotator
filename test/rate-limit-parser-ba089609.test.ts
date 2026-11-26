import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isAntigravityRetryableError, parseErrorJsonDetails } from "../src/rate-limit-parser.js";

describe("array-wrapped Google error parsing (ba089609)", () => {
	it("extracts reasons and retryDelay from array-wrapped payloads and marks billing caps non-retryable", () => {
		const payload = [
			{
				error: {
					code: 429,
					status: "RESOURCE_EXHAUSTED",
					message: "Billing cap reached",
					details: [{ reason: "USER_SPEND_CAP_EXCEEDED", retryDelay: "300s" }],
				},
			},
		];
		const text = JSON.stringify(payload);
		const parsed = parseErrorJsonDetails(text);
		assert.deepEqual(parsed.reasons, ["USER_SPEND_CAP_EXCEEDED"]);
		assert.deepEqual(parsed.retryDelaysMs, [300_000]);
		assert.equal(isAntigravityRetryableError({ status: 429, errorText: text }), false);
	});
});
