import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  maskAccountLabel,
  buildRotatorResponseHeaders,
} from "../src/response-headers.js";

describe("response headers", () => {
  describe("maskAccountLabel", () => {
    it("masks email addresses correctly", () => {
      assert.equal(maskAccountLabel("user@example.com"), "us***r@example.com");
      assert.equal(maskAccountLabel("al@domain.com"), "al***@domain.com");
      assert.equal(maskAccountLabel("a@domain.com"), "a***@domain.com");
    });

    it("masks account labels correctly", () => {
      assert.equal(maskAccountLabel("donated-account"), "do***nt");
      assert.equal(maskAccountLabel("acc1"), "acc1***");
      assert.equal(maskAccountLabel("test-label"), "te***el");
    });

    it("handles empty or null-ish inputs gracefully", () => {
      assert.equal(maskAccountLabel(""), "unknown");
    });
  });

  describe("buildRotatorResponseHeaders", () => {
    it("builds all X-Rotator-* headers when all options are provided", () => {
      const headers = buildRotatorResponseHeaders({
        accountLabel: "dev-account@gmail.com",
        model: "claude-sonnet-4-6",
        modelSelection: "typesafe",
        selectionConfidence: 0.92,
        selectionReason: "typesafe-selected",
        latencyMs: 1250,
        ttfbMs: 320,
        inputTokens: 1000,
        outputTokens: 500,
        healthScore: 0.95,
        routingPolicy: "timer-first",
        retries: 2,
      });

      assert.equal(headers["X-Rotator-Account"], "de***t@gmail.com");
      assert.equal(headers["X-Rotator-Model"], "claude-sonnet-4-6");
      assert.equal(headers["X-Rotator-Model-Selection"], "typesafe");
      assert.equal(headers["X-Rotator-Selection-Confidence"], "0.920");
      assert.equal(headers["X-Rotator-Selection-Reason"], "typesafe-selected");
      assert.equal(headers["X-Rotator-Latency-Ms"], "1250");
      assert.equal(headers["X-Rotator-TTFB-Ms"], "320");
      assert.equal(headers["X-Rotator-Tokens-Input"], "1000");
      assert.equal(headers["X-Rotator-Tokens-Output"], "500");
      assert.equal(headers["X-Rotator-Cost-Usd"], "0.010500");
      assert.equal(headers["X-Rotator-Health-Score"], "0.95");
      assert.equal(headers["X-Rotator-Routing-Policy"], "timer-first");
      assert.equal(headers["X-Rotator-Retries"], "2");
    });

    it("builds partial headers when only some options are provided", () => {
      const headers = buildRotatorResponseHeaders({
        accountLabel: "test-acc",
        model: "gemini-3.6-flash-high",
        ttfbMs: 150,
      });

      assert.equal(headers["X-Rotator-Account"], "te***cc");
      assert.equal(headers["X-Rotator-Model"], "gemini-3.6-flash-high");
      assert.equal(headers["X-Rotator-TTFB-Ms"], "150");
      assert.equal(headers["X-Rotator-Tokens-Input"], undefined);
      assert.equal(headers["X-Rotator-Cost-Usd"], undefined);
      assert.equal(headers["X-Rotator-Retries"], undefined);
    });

    it("identifies TypeSafe shadow routing separately from active Jev routing", () => {
      const headers = buildRotatorResponseHeaders({
        model: "local-fast",
        requestedModel: "auto",
        modelSelection: "shadow",
        selectionConfidence: 0.81,
        selectionReason: "typesafe-shadow",
      });
      assert.equal(headers["X-Rotator-Model"], "local-fast");
      assert.equal(headers["X-Rotator-Model-Selection"], "shadow");
      assert.equal(headers["X-Rotator-Selection-Reason"], "typesafe-shadow");
    });
  });
});
