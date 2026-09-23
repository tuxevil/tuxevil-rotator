import assert from "node:assert/strict";
import { test } from "node:test";

test("transcribes SSE events delimited by isolated carriage returns", async () => {
  const originalTelemetry = process.env.PI_ROTATOR_TELEMETRY;
  const originalDataDir = process.env.TUXEVIL_ROTATOR_DIR;
  process.env.PI_ROTATOR_TELEMETRY = "off";
  process.env.TUXEVIL_ROTATOR_DIR = "/tmp/tuxevil-poc-68088f8c";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const textEvent = (text: string, finishReason?: string) => ({
      response: {
        candidates: [{ content: { parts: text ? [{ text }] : [] }, ...(finishReason ? { finishReason } : {}) }],
      },
    });
    const stream = [textEvent("hola"), textEvent("", "STOP")]
      .map((event) => `data: ${JSON.stringify(event)}\r\r`)
      .join("");
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;

  try {
    const { transcribeAudioWithRotator } = await import("../src/audio-transcription.js");
    const account = {
      config: { email: "poc@example.invalid", refreshToken: "offline-poc-token" },
      accessToken: "offline-poc-access-token",
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
      getConfig: () => ({ streamRecoveryMaxRetries: 0 }),
      getActiveAccount: async () => account,
      rotateToNext: async () => account,
      finishRequest: () => {},
      recordUpstreamAttempt: () => {},
      recordRequest: () => false,
      markError: () => {},
      getRetryAfterMs: () => 0,
      recordProxyEvent: () => {},
    };

    assert.equal(
      await transcribeAudioWithRotator(rotator as never, Buffer.from([0, 0]), {
        mimeType: "audio/mpeg",
        timeoutMs: 2_000,
      }),
      "hola",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTelemetry === undefined) delete process.env.PI_ROTATOR_TELEMETRY;
    else process.env.PI_ROTATOR_TELEMETRY = originalTelemetry;
    if (originalDataDir === undefined) delete process.env.TUXEVIL_ROTATOR_DIR;
    else process.env.TUXEVIL_ROTATOR_DIR = originalDataDir;
  }
});
