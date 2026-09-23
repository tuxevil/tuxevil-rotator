import assert from "node:assert/strict";
import { test } from "node:test";
import { transcribeAudioWithRotator } from "../src/audio-transcription.js";

process.env.LOG_LEVEL = "silent";
process.env.PI_ROTATOR_TELEMETRY = "off";

test("0e11b325: transcription WAV sample rate matches the PCM MIME rate", async () => {
  const originalFetch = globalThis.fetch;
  const upstreamBodies: Array<Record<string, any>> = [];
  const account = {
    config: {
      email: "pcm-rate-test@example.invalid",
      label: "pcm-rate-test",
      credentials: [{ provider: "google-antigravity", projectId: "test-project" }],
    },
    accessToken: "test-access-token",
    tokenExpires: Date.now() + 60_000,
  };
  const rotator = {
    getActiveAccount: async () => account,
    rotateToNext: async () => account,
    finishRequest() {},
    recordUpstreamAttempt() {},
    recordRequest: () => false,
    recordProxyEvent() {},
    getSafetyJitterMs: () => 0,
    getGlobalDelayMs: () => 0,
    getRetryAfterMs: () => 0,
    getConfig: () => ({ streamRecoveryMaxRetries: 0 }),
  };
  const responseBody =
    `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] } })}\n\n`;

  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://daily-cloudcode-pa.googleapis.com/")) {
      throw new Error(`Unexpected network request blocked by test: ${url}`);
    }
    upstreamBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, any>);
    return new Response(responseBody, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  try {
    const pcm = Buffer.from([0x10, 0x00, 0x20, 0x00, 0x30, 0x00, 0x40, 0x00]);
    await transcribeAudioWithRotator(rotator as never, pcm, { mimeType: "audio/pcm;rate=48000" });

    assert.equal(upstreamBodies.length, 1, "the offline upstream double should capture exactly one request");
    const parts = upstreamBodies[0]?.request?.contents?.[0]?.parts;
    const inlineData = parts?.find((part: any) => part.inlineData)?.inlineData;
    assert.ok(inlineData, "transcription request should include inline audio data");
    const wav = Buffer.from(inlineData.data, "base64");
    assert.equal(wav.toString("ascii", 0, 4), "RIFF", "PCM should be wrapped in a WAV container");
    const declaredRate = wav.readUInt32LE(24);
    assert.equal(
      declaredRate,
      48_000,
      `WAV sample rate should match the audio/pcm;rate=48000 input (got ${declaredRate} Hz)`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
