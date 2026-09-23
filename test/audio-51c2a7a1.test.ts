import assert from "node:assert/strict";
import { test } from "node:test";
import { RotatorAudioSession } from "../src/audio-transcription.js";

test("empty PCM chunks are not accepted or retained", async () => {
  const empty = Buffer.alloc(0);
  const session = new RotatorAudioSession({} as never);

  try {
    await session.start();
    let accepted = 0;
    for (let i = 0; i < 10_000; i++) {
      if (session.sendChunk(empty)) accepted++;
    }
    const { activeBytes, activeChunks } = session as unknown as {
      activeBytes: number;
      activeChunks: Buffer[];
    };
    assert.equal(activeBytes, 0, "empty PCM chunks must not count as active bytes");
    assert.equal(
      activeChunks.length,
      0,
      `empty PCM chunks should not accumulate; accepted=${accepted}, retained=${activeChunks.length}`,
    );
  } finally {
    session.destroy();
  }
});
