import assert from "node:assert/strict";
import { test } from "node:test";
import { RotatorAudioSession } from "../src/audio-transcription.js";

test("synchronous endSession reentry emits complete exactly once", async () => {
  const session = new RotatorAudioSession({} as never, {
    onEvent(event) {
      if (event.complete) {
        completeCount++;
        if (!reentered) {
          reentered = true;
          reentrantEnd = session.endSession();
        }
      }
    },
  });
  let completeCount = 0;
  let reentered = false;
  let reentrantEnd: Promise<void> | undefined;

  try {
    await session.start();
    const end = session.endSession();
    await end;
    if (reentrantEnd) await reentrantEnd;

    assert.equal(
      completeCount,
      1,
      `expected exactly one complete event after synchronous endSession reentry; got ${completeCount}`,
    );
  } finally {
    session.destroy();
  }
});
