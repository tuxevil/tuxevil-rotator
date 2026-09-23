import assert from "node:assert/strict";
import { test } from "node:test";
import { RotatorAudioSession } from "../src/audio-transcription.js";

test("c50e7f14: a failed audio segment emits one error across session completion", async () => {
  const errors: Array<{ message: string; terminal: boolean | undefined }> = [];
  let signalEntered!: () => void;
  let releaseUpstream!: () => void;
  const upstreamEntered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  const upstreamGate = new Promise<void>((resolve) => {
    releaseUpstream = resolve;
  });
  const rotator = {
    async getActiveAccount() {
      signalEntered();
      await upstreamGate;
      return null;
    },
    getRetryAfterMs() {
      return 0;
    },
    recordProxyEvent() {},
  };
  const session = new RotatorAudioSession(rotator as never, {
    onError(error, info) {
      errors.push({ message: error.message, terminal: info?.terminal });
    },
  });

  try {
    await session.start();
    const pcm = Buffer.alloc(16_000);
    for (let i = 0; i < pcm.length / 2; i++) {
      pcm.writeInt16LE(Math.round(1500 * Math.sin(i * 0.1)), i * 2);
    }
    assert.equal(session.sendChunk(pcm), true, "voiced PCM should be accepted");
    const ending = session.endSession();
    await upstreamEntered;
    releaseUpstream();
    await ending;

    assert.equal(
      errors.length,
      1,
      `one failed segment must produce one visible error; got ${JSON.stringify(errors)}`,
    );
    assert.equal(errors[0]?.terminal, false, "the segment error remains non-terminal for session accounting");
  } finally {
    releaseUpstream();
    session.destroy();
  }
});
