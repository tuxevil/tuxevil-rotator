import assert from "node:assert/strict";
import { test } from "node:test";

test("does not install the periodic interval after ready callback closes the session", async () => {
  const { RotatorAudioSession } = await import("../src/audio-transcription.js");
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const activeIntervals = new Set<object>();
  let readyEndPromise: Promise<void> | undefined;

  try {
    globalThis.setInterval = ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
      const handle = { callback, delay, args, unref() {} };
      activeIntervals.add(handle);
      return handle as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    globalThis.clearInterval = ((handle: ReturnType<typeof setInterval>) => {
      activeIntervals.delete(handle as unknown as object);
    }) as typeof clearInterval;

    const session = new RotatorAudioSession({} as never, {
      onEvent(event: any) {
        if (event.ready) readyEndPromise = session.endSession();
      },
    });

    await session.start();
    await readyEndPromise;
    assert.equal(activeIntervals.size, 0, `closed session leaked ${activeIntervals.size} periodic interval(s)`);
  } finally {
    for (const handle of activeIntervals) globalThis.clearInterval(handle as unknown as ReturnType<typeof setInterval>);
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});
