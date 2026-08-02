import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentError } from "../protocol/errors";
import {
  AGENT_PROTOCOL,
  AGENT_PROTOCOL_VERSION,
  type AgentMessage,
} from "../protocol/types";
import { LineJsonDecoder } from "../transport/line-json";
import { UnixSocketAgentServer, UnixSocketTransport } from "../transport/unix";

class DelayedSocket extends EventEmitter {
  destroyed = false;
  activeWrites = 0;
  maxActiveWrites = 0;
  frames: string[] = [];

  write(frame: string, callback?: (error?: Error | null) => void): boolean {
    this.frames.push(frame);
    this.activeWrites += 1;
    this.maxActiveWrites = Math.max(this.maxActiveWrites, this.activeWrites);
    setTimeout(() => {
      this.activeWrites -= 1;
      callback?.();
    }, 5);
    return true;
  }

  end(): this {
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}

test("reports an incomplete frame when a Unix transport closes", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-browser-agent-"));
  const socketPath = path.join(directory, "agent.sock");
  const server = new UnixSocketAgentServer(socketPath);
  let transportError: unknown;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  try {
    server.accept((transport) => {
      transport.onError((error) => {
        transportError = error;
      });
      transport.onClose(resolveClosed);
    });
    await server.listen();

    const socket = net.createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.end('{"kind":"request"');
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("transport did not close")), 1000)),
    ]);

    assert.ok(transportError instanceof AgentError);
    assert.equal(transportError.code, "INVALID_MESSAGE");
    assert.equal(transportError.message, "transport ended mid-frame");
  } finally {
    await server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("serializes concurrent Unix transport writes", async () => {
  const socket = new DelayedSocket();
  const unixTransport = new UnixSocketTransport(socket as unknown as net.Socket);
  const first: AgentMessage = {
    kind: "response",
    protocol: AGENT_PROTOCOL,
    version: AGENT_PROTOCOL_VERSION,
    requestId: "first",
    ok: true,
    result: { index: 1 },
  };
  const second: AgentMessage = {
    kind: "response",
    protocol: AGENT_PROTOCOL,
    version: AGENT_PROTOCOL_VERSION,
    requestId: "second",
    ok: true,
    result: { index: 2 },
  };

  await Promise.all([unixTransport.send(first), unixTransport.send(second)]);

  assert.equal(socket.maxActiveWrites, 1);
  const decoder = new LineJsonDecoder();
  assert.deepEqual(decoder.push(Buffer.from(socket.frames.join(""))), [first, second]);
  decoder.flush();
  await unixTransport.close();
});
