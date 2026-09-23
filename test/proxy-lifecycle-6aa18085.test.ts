import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import net, { type Socket } from "node:net";
import { it } from "node:test";
import { startProxy } from "../src/proxy.js";
import { stopVersionChecker } from "../src/version-check.js";
import { stopNotificationPoller } from "../src/notification-poller.js";

function makeRotator() {
  return {
    saveState() {},
    getStatus() {
      return { accounts: [], security: { adminTokenConfigured: true } };
    },
    getSafetyJitterMs() { return 0; },
    getGlobalDelayMs() { return 0; },
    recordProxyEvent() {},
  };
}

interface WebSocketClient {
  socket: Socket;
  waitFor: (opcode: number) => Promise<Buffer>;
  waitForAny: (opcodes: number[]) => Promise<{ opcode: number; payload: Buffer }>;
}

async function openWebSocket(port: number): Promise<WebSocketClient> {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  let buffer = Buffer.alloc(0);
  let upgraded = false;
  const frames: Array<{ opcode: number; payload: Buffer }> = [];
  const waiters = new Map<number, Array<(payload: Buffer) => void>>();
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!upgraded) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      assert.match(buffer.subarray(0, end).toString("latin1"), /^HTTP\/1\.1 101 /);
      buffer = buffer.subarray(end + 4);
      upgraded = true;
    }
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 0x0f;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) break;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) break;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (buffer.length < offset + length) break;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      buffer = buffer.subarray(offset + length);
      const waiter = waiters.get(opcode)?.shift();
      if (waiter) waiter(payload);
      else frames.push({ opcode, payload });
    }
  });
  await once(socket, "connect");
  const key = randomBytes(16).toString("base64");
  socket.write(
    `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n` +
      `Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`,
  );
  return {
    socket,
    waitForAny(opcodes: number[]) {
      const existingIndex = frames.findIndex((frame) => opcodes.includes(frame.opcode));
      if (existingIndex >= 0) return Promise.resolve(frames.splice(existingIndex, 1)[0]);
      return new Promise<{ opcode: number; payload: Buffer }>((resolve) => {
        for (const opcode of opcodes) {
          const queue = waiters.get(opcode) ?? [];
          queue.push((payload) => resolve({ opcode, payload }));
          waiters.set(opcode, queue);
        }
      });
    },
    waitFor(opcode: number) {
      const existingIndex = frames.findIndex((frame) => frame.opcode === opcode);
      if (existingIndex >= 0) return Promise.resolve(frames.splice(existingIndex, 1)[0].payload);
      return new Promise<Buffer>((resolve) => {
        const queue = waiters.get(opcode) ?? [];
        queue.push(resolve);
        waiters.set(opcode, queue);
      });
    },
  };
}

it("closing a proxy leaves another proxy's WebSocket active (6aa18085)", async () => {
  const first = startProxy(makeRotator() as never, 0, "127.0.0.1");
  const second = startProxy(makeRotator() as never, 0, "127.0.0.1");
  let client: Awaited<ReturnType<typeof openWebSocket>> | undefined;
  try {
    await Promise.all([once(first, "listening"), once(second, "listening")]);
    client = await openWebSocket((second.address() as { port: number }).port);
    const initial = await client.waitFor(1);
    assert.equal(JSON.parse(initial.toString("utf8")).type, "system_status");
    await new Promise<void>((resolve, reject) => first.close((error) => error ? reject(error) : resolve()));

    assert.equal(client.socket.destroyed, false, "the WebSocket on the other proxy must remain connected after the first closes");
    const mask = randomBytes(4);
    const ping = Buffer.from([
      0x89, 0x84, ...mask,
      0x70 ^ mask[0], 0x69 ^ mask[1], 0x6e ^ mask[2], 0x67 ^ mask[3],
    ]);
    client.socket.write(ping);
    await new Promise<void>((resolve, reject) => {
      client!.socket.once("error", reject);
      client!.socket.once("close", () => reject(new Error("the second proxy WebSocket was closed")));
      setImmediate(() => resolve());
    });
    assert.equal(client.socket.destroyed, false);
  } finally {
    client?.socket.destroy();
    for (const server of [first, second]) {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    stopVersionChecker();
    stopNotificationPoller();
  }
});
