import assert from "node:assert/strict";
import { createServer } from "node:http";
import { it } from "node:test";
import { pcmToWav, RotatorAudioSession } from "../src/audio-transcription.js";
import { ANTIGRAVITY_ENDPOINTS } from "../src/types.js";

it("transcribes the bytes accepted before the caller reuses its PCM buffer", async () => {
  const originalEndpoint = ANTIGRAVITY_ENDPOINTS[0];
  const capturedBodies: Array<Record<string, any>> = [];
  const events: Array<Record<string, any>> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    capturedBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: {"candidates":[{"content":{"parts":[{"text":"accepted speech"}]},"finishReason":"STOP"}]}\n\n');
  });
  const account = {
    config: { email: "poc@example.invalid", projectId: "poc-project" },
    credentials: [{ provider: "google-antigravity" }],
    accessToken: "poc-token",
    tokenExpires: Date.now() + 60_000,
    requestsSinceRotation: 0,
    totalRequests: 0,
    cooldownsByModel: {},
    quotaExhaustedAt: 0,
    quota: [],
    lastQuotaPoll: 0,
    lastUsed: 0,
    lastError: null,
    consecutiveErrors: 0,
    disabled: false,
    flagged: false,
    inFlightRequests: 0,
    inFlightByModel: {},
    allowFreshWindowStartsOverride: false,
    dailyRequestCount: 0,
    dailyRequestDay: "",
    healthScore: 1,
    tokenBucket: { tokens: 1, lastRefillAt: Date.now() },
  };
  const rotator = {
    async getActiveAccount() { return account; },
    getConfig() { return { streamRecoveryMaxRetries: 0 }; },
    getSafetyJitterMs() { return 0; },
    getGlobalDelayMs() { return 0; },
    recordUpstreamAttempt() {},
    getOllamaModels() { return []; },
    getCodexModels() { return []; },
    recordRequest() { return false; },
    finishRequest() {},
    recordProxyEvent() {},
  };
  const session = new RotatorAudioSession(rotator as any, {
    onEvent: (event) => events.push(event),
    onError: (error) => events.push({ error: error.message }),
  });
  let serverListening = false;

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    serverListening = true;
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    (ANTIGRAVITY_ENDPOINTS as unknown as string[])[0] = `http://127.0.0.1:${address.port}`;

    await session.start();
    const acceptedPcm = Buffer.alloc(4096);
    for (let offset = 0; offset < acceptedPcm.length; offset += 2) {
      acceptedPcm.writeInt16LE(1000, offset);
    }
    const expectedPcm = Buffer.from(acceptedPcm);
    assert.equal(session.sendChunk(acceptedPcm), true);

    // Model a caller reusing its input buffer after sendChunk accepted it.
    acceptedPcm.fill(0);
    await session.endSession();

    assert.equal(capturedBodies.length, 1, `accepted speech must reach transcriber; events=${JSON.stringify(events)}`);
    const request = capturedBodies[0].request;
    const audioPart = request.contents[0].parts.find((part: any) => part.inlineData);
    assert.equal(audioPart.inlineData.data, pcmToWav(expectedPcm).toString("base64"));
    assert.ok(
      events.some((event) => event.transcription?.isFinal && event.transcription.text === "accepted speech"),
      `accepted speech must produce a final transcript; events=${JSON.stringify(events)}`,
    );
  } finally {
    session.destroy();
    (ANTIGRAVITY_ENDPOINTS as unknown as string[])[0] = originalEndpoint;
    if (serverListening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  }
});
