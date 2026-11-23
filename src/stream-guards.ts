import type { ServerResponse } from "node:http";

// Matches Antigravity ccpahttp.New default stream idle timeout (600s).
export const STREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
export const STREAM_BACKPRESSURE_TIMEOUT_MS = 30 * 1000;

export class StreamIdleTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`upstream stream idle timeout after ${Math.round(timeoutMs / 1000)}s`);
    this.name = "StreamIdleTimeoutError";
  }
}

/** Resettable guard used to release upstream streams that stop producing data. */
export function createStreamIdleGuard(
  onTimeout: (error: StreamIdleTimeoutError) => void,
  timeoutMs = STREAM_IDLE_TIMEOUT_MS,
): { reset: () => void; clear: () => void } {
  const effectiveTimeoutMs = Number.isFinite(timeoutMs)
    ? Math.max(1, timeoutMs)
    : STREAM_IDLE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const reset = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onTimeout(new StreamIdleTimeoutError(effectiveTimeoutMs));
    }, effectiveTimeoutMs);
  };

  const clear = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  reset();
  return { reset, clear };
}

/**
 * Respect the HTTP response's high-water mark so a client that stopped
 * reading cannot make the proxy buffer an unbounded streamed response.
 */
export function waitForResponseDrain(
  res: ServerResponse,
  timeoutMs = STREAM_BACKPRESSURE_TIMEOUT_MS,
): Promise<void> {
  if (res.destroyed || res.writableEnded || !res.writableNeedDrain) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onError);
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onDrain = (): void => finish();
    const onClose = (): void =>
      finish(new Error("client response closed while draining backpressure"));
    const onError = (error: Error): void => finish(error);

    res.once("drain", onDrain);
    res.once("close", onClose);
    res.once("error", onError);
    timer = setTimeout(() => {
      finish(
        new Error(
          `client backpressure timeout after ${Math.round(timeoutMs / 1000)}s`,
        ),
      );
    }, Math.max(1, timeoutMs));
  });
}
