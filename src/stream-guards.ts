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

export const DEFAULT_SSE_KEEPALIVE_INTERVAL_MS = 15 * 1000;

type KeepaliveResponse = Pick<ServerResponse, "write"> & {
  destroyed?: boolean;
  writableEnded?: boolean;
  writableNeedDrain?: boolean;
  once?: (event: "close" | "finish", listener: () => void) => unknown;
  off?: (event: "close" | "finish", listener: () => void) => unknown;
};

function chunkTail(chunk: unknown): string {
  if (typeof chunk === "string") return chunk.slice(-4);
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.subarray(Math.max(0, chunk.length - 4))).toString("latin1");
  }
  return "";
}

/**
 * Write `: ping` SSE comments while the response has been idle for
 * `intervalMs`, so intermediaries do not reap a stream whose upstream is
 * still thinking. Pings are only written when the bytes sent so far end on
 * an event boundary. Returns an idempotent stop function; the keepalive
 * also stops on response close/finish. `intervalMs <= 0` disables it.
 */
export function startSseKeepalive(
  res: KeepaliveResponse,
  intervalMs: number = DEFAULT_SSE_KEEPALIVE_INTERVAL_MS,
  onBeforePing?: () => void,
): () => void {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return () => {};
  const originalWrite = res.write;
  let tail = "\n\n";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const atEventBoundary = (): boolean =>
    tail.endsWith("\n\n") || tail.endsWith("\r\n\r\n");
  const arm = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onTick, intervalMs);
    timer.unref?.();
  };
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    if (res.write === wrappedWrite) res.write = originalWrite;
    res.off?.("close", stop);
    res.off?.("finish", stop);
  };
  const onTick = (): void => {
    timer = null;
    if (stopped) return;
    if (res.destroyed || res.writableEnded) {
      stop();
      return;
    }
    if (atEventBoundary() && !res.writableNeedDrain) {
      onBeforePing?.();
      if (stopped || res.destroyed || res.writableEnded) {
        stop();
        return;
      }
      (originalWrite as (chunk: string) => boolean).call(res, ": ping\n\n");
    }
    arm();
  };
  const wrappedWrite = function (this: unknown, ...args: unknown[]): boolean {
    if (!stopped) {
      const piece = chunkTail(args[0]);
      if (piece) tail = (tail + piece).slice(-4);
      arm();
    }
    return (originalWrite as (...a: unknown[]) => boolean).apply(this, args);
  } as ServerResponse["write"];

  res.write = wrappedWrite;
  res.once?.("close", stop);
  res.once?.("finish", stop);
  arm();
  return stop;
}
