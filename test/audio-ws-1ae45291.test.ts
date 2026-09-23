import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import net, { type Socket } from "node:net";
import https from "node:https";
import cp from "node:child_process";
import { after, it } from "node:test";
import { handleAudioWebSocket } from "../src/audio-transcription.js";

const originalHttpsRequest = https.request;
const originalExecSync = cp.execSync;

after(() => {
  https.request = originalHttpsRequest;
  cp.execSync = originalExecSync;
});

class HeldRequest extends EventEmitter {
  write(): boolean { return true; }
  end(): this { return this; }
  setTimeout(): this { return this; }
  destroy(): this { return this; }
}

function maskedFrame(opcode: number, payload: Buffer): Buffer {
  const mask = Buffer.from([0x39, 0x71, 0xa5, 0xc3]);
  const header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % mask.length];
  return Buffer.concat([header, mask, masked]);
}

function zeroBinaryFrames(count: number): Buffer {
  const batch = Buffer.alloc(count * 6);
  for (let i = 0; i < count; i++) {
    const offset = i * 6;
    batch[offset] = 0x82;
    batch[offset + 1] = 0x80;
    batch[offset + 2] = 0x39;
    batch[offset + 3] = 0x71;
    batch[offset + 4] = 0xa5;
    batch[offset + 5] = 0xc3;
  }
  return batch;
}

it("bounds queued zero-payload WebSocket frames while start is held (1ae45291)", async () => {
  delete process.env.DATABASE_URL;
  delete process.env.TUXEVIL_ROTATOR_DATABASE_URL;
  delete process.env.PI_ROTATOR_DATABASE_URL;
  process.env.TUXEVIL_ROTATOR_TELEMETRY = "off";
  process.env.PI_ROTATOR_TELEMETRY = "off";

  let markUpstreamStarted!: () => void;
  const upstreamStarted = new Promise<void>((resolve) => { markUpstreamStarted = resolve; });
  https.request = (() => {
    markUpstreamStarted();
    return new HeldRequest();
  }) as unknown as typeof https.request;
  cp.execSync = (() => { throw new Error("process discovery disabled by isolated test"); }) as unknown as typeof cp.execSync;

  const frameWaiters = new Set<{
    predicate: () => boolean;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const receivedFrames: Array<{ opcode: number; payload: Buffer }> = [];
  const serverSockets = new Set<Socket>();
  let peerClosed = false;
  let upgraded = false;
  let inbound = Buffer.alloc(0);
  let peer: net.Socket | undefined;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  const server = createServer();

  const notifyFrameWaiters = (): void => {
    for (const waiter of [...frameWaiters]) {
      if (!waiter.predicate()) continue;
      frameWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  };
  const waitFor = (predicate: () => boolean, description: string, timeoutMs = 4000): Promise<void> => {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          frameWaiters.delete(waiter);
          reject(new Error(`Timed out waiting for ${description}`));
        }, timeoutMs),
      };
      frameWaiters.add(waiter);
    });
  };
  const parseServerData = (data: Buffer): void => {
    inbound = Buffer.concat([inbound, data]);
    if (!upgraded) {
      const headerEnd = inbound.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      assert.match(inbound.toString("latin1", 0, headerEnd), /^HTTP\/1\.1 101 /);
      inbound = inbound.subarray(headerEnd + 4);
      upgraded = true;
    }
    while (inbound.length >= 2) {
      const opcode = inbound[0] & 0x0f;
      let length = inbound[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (inbound.length < 4) break;
        length = inbound.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (inbound.length < 10) break;
        length = Number(inbound.readBigUInt64BE(2));
        offset = 10;
      }
      if (inbound.length < offset + length) break;
      receivedFrames.push({ opcode, payload: Buffer.from(inbound.subarray(offset, offset + length)) });
      inbound = inbound.subarray(offset + length);
      notifyFrameWaiters();
    }
  };

  server.on("connection", (socket) => {
    serverSockets.add(socket);
    socket.once("close", () => serverSockets.delete(socket));
  });
  server.on("upgrade", (req, socket) => { void handleAudioWebSocket(req, socket); });

  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    peer = net.connect({ host: "127.0.0.1", port: address.port });
    peer.on("data", parseServerData);
    peer.on("error", () => {});
    peer.on("close", () => {
      peerClosed = true;
      notifyFrameWaiters();
    });
    await once(peer, "connect");
    peer.write(
      "GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n" +
      "Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
      "Sec-WebSocket-Version: 13\r\n\r\n",
    );
    await waitFor(() => receivedFrames.some((frame) => frame.opcode === 1), "system status");

    peer.write(maskedFrame(1, Buffer.from(JSON.stringify({ type: "start", model: "gemini-3.8-flash-low" }))));
    await Promise.race([
      upstreamStarted,
      new Promise<never>((_, reject) => {
        startupTimer = setTimeout(() => reject(new Error("upstream start was not held")), 4000);
      }),
    ]);
    clearTimeout(startupTimer);

    for (let batchNo = 0; batchNo < 8; batchNo++) peer.write(zeroBinaryFrames(50_000));
    peer.write(maskedFrame(9, Buffer.from("parsed-all-prior-batches")));
    await waitFor(
      () => peerClosed || receivedFrames.some((frame) => frame.opcode === 10 || frame.opcode === 8),
      "overflow close or final ping response",
    );

    const closeFrame = receivedFrames.find((frame) => frame.opcode === 8);
    assert.ok(
      closeFrame && closeFrame.payload.length >= 2 && closeFrame.payload.readUInt16BE(0) === 1009,
      "the server must close with 1009 instead of accepting unbounded zero-payload frame overhead",
    );
  } finally {
    if (peer && !peer.destroyed) peer.destroy();
    for (const socket of serverSockets) socket.destroy();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    https.request = originalHttpsRequest;
    cp.execSync = originalExecSync;
    clearTimeout(startupTimer);
    for (const waiter of frameWaiters) clearTimeout(waiter.timer);
    frameWaiters.clear();
  }
});
