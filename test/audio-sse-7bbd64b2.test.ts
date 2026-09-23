import assert from "node:assert/strict";
import { test } from "node:test";

test("rejects malformed JSON in an upstream SSE data event", async () => {
  const originalTelemetry = process.env.PI_ROTATOR_TELEMETRY;
  process.env.PI_ROTATOR_TELEMETRY = "off";
  const originalFetch = globalThis.fetch;
  const malformedThenStop =
    'data: {"response":{"candidates":[{"content":{"parts":[{"text":"palabra perdida"}]}}]\n\n' +
    `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [] }, finishReason: "STOP" }] } })}\n\n`;
  globalThis.fetch = (async () =>
    new Response(malformedThenStop, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;

  try {
    const { transcribeAudioWithRotator, AudioTranscriptionError } = await import("../src/audio-transcription.js");
    const account = {
      config: { email: "poc@example.invalid", label: "poc", refreshToken: "unused-valid-token" },
      accessToken: "poc-access-token",
      tokenExpires: Date.now() + 60_000,
      disabled: false,
      flagged: false,
      requestsSinceRotation: 0,
      totalRequests: 0,
      cooldownsByModel: {},
      inFlightRequests: 0,
      inFlightByModel: {},
      healthScore: 1,
    };
    const rotator = {
      saveState() {},
      getStatus() { return { accounts: [], security: { adminTokenConfigured: true } }; },
      async getActiveAccount() { return account; },
      async rotateToNext() { return account; },
      finishRequest() {},
      recordUpstreamAttempt() {},
      recordRequest() { return false; },
      recordTokenUsage() {},
      markError() {},
      markRateLimited() {},
      markExhausted() {},
      markFlagged() {},
      recordFailure() {},
      recordSuccess() {},
      recordProvider429() {},
      getSafetyJitterMs() { return 0; },
      getGlobalDelayMs() { return 0; },
      getRetryAfterMs() { return 0; },
      recordProxyEvent() {},
      getFlagContext() {
        return {
          timerType: "fresh", accountQuotaPercent: 0, wasProAccount: false,
          accountRequestsLastHour: 0, poolSize: 1, poolHealthyCount: 1, uptimeSeconds: 0,
        };
      },
    };

    await assert.rejects(
      transcribeAudioWithRotator(rotator as never, Buffer.alloc(32_000), { mimeType: "audio/pcm" }),
      (error: unknown) => error instanceof AudioTranscriptionError && error.status === 502,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTelemetry === undefined) delete process.env.PI_ROTATOR_TELEMETRY;
    else process.env.PI_ROTATOR_TELEMETRY = originalTelemetry;
  }
});
