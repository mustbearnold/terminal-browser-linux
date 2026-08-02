import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentError } from "../protocol/errors";
import { AgentRequestRouter } from "../core/router";
import {
  AGENT_PROTOCOL,
  AGENT_PROTOCOL_VERSION,
  type AgentMessage,
} from "../protocol/types";
import { attachAgentConnection } from "../transport/connection";
import { encodeAgentMessage, LineJsonDecoder } from "../transport/line-json";
import type { AgentTransport } from "../transport/types";
import { UnixSocketAgentServer, UnixSocketTransport } from "../transport/unix";
import { FIXTURE_PAGE_ID, FixtureRuntime } from "./fixture";

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

class BackpressuredTransport implements AgentTransport {
  readonly sent: AgentMessage[] = [];
  closed = false;
  readonly outboundQueueLimits = {
    maxOutboundQueueMessages: 2,
    maxOutboundQueueBytes: 4096,
  };
  private readonly messageListeners = new Set<(message: AgentMessage) => void>();
  private readonly closeListeners = new Set<() => void>();

  send(message: AgentMessage): Promise<void> {
    this.sent.push(message);
    if (message.kind === "event") {
      return Promise.reject(new AgentError("RESOURCE_EXHAUSTED", "test outbound queue is full", { retryable: true }));
    }
    return Promise.resolve();
  }

  onMessage(listener: (message: AgentMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onError(_listener: (error: unknown) => void): () => void {
    return () => {};
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener();
  }

  emitMessage(message: AgentMessage): void {
    for (const listener of this.messageListeners) listener(message);
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

test("rejects outbound writes when the transport queue is full", async () => {
  const socket = new DelayedSocket();
  const unixTransport = new UnixSocketTransport(socket as unknown as net.Socket, {
    maxPendingWrites: 1,
    maxPendingBytes: 1024,
  });
  const message: AgentMessage = {
    kind: "response",
    protocol: AGENT_PROTOCOL,
    version: AGENT_PROTOCOL_VERSION,
    requestId: "queued",
    ok: true,
    result: { index: 1 },
  };
  const rejected = { ...message, requestId: "rejected" };
  const pendingBytes = Buffer.byteLength(encodeAgentMessage(message), "utf8");
  const frameBytes = Buffer.byteLength(encodeAgentMessage(rejected), "utf8");
  const first = unixTransport.send(message);
  await assert.rejects(
    unixTransport.send(rejected),
    (error: unknown) => {
      assert.ok(error instanceof AgentError);
      assert.equal(error.code, "RESOURCE_EXHAUSTED");
      assert.equal(error.retryable, true);
      assert.deepEqual(error.details, {
        scope: "transport-outbound",
        maxOutboundQueueMessages: 1,
        maxOutboundQueueBytes: 1024,
        pendingMessages: 1,
        pendingBytes,
        frameBytes,
      });
      return true;
    },
  );
  await first;
  await unixTransport.close();
});

test("closes an event connection after outbound backpressure", async () => {
  const transport = new BackpressuredTransport();
  const cleanup = attachAgentConnection(transport, new AgentRequestRouter(new FixtureRuntime()));
  const closed = new Promise<void>((resolve) => transport.onClose(resolve));
  try {
    transport.emitMessage({
      kind: "request",
      protocol: AGENT_PROTOCOL,
      version: AGENT_PROTOCOL_VERSION,
      requestId: "hello",
      op: "hello",
      clientId: "backpressure-test",
    } as AgentMessage);
    await new Promise((resolve) => setImmediate(resolve));
    const hello = transport.sent.find((message) => message.kind === "response" && message.requestId === "hello");
    assert.ok(hello && hello.kind === "response");
    assert.deepEqual((hello.result as { limits: unknown }).limits, {
      maxInFlightRequests: 128,
      maxQueuedActionsPerPage: 64,
      maxOutboundQueueMessages: 2,
      maxOutboundQueueBytes: 4096,
    });

    transport.emitMessage({
      kind: "request",
      protocol: AGENT_PROTOCOL,
      version: AGENT_PROTOCOL_VERSION,
      requestId: "observe",
      op: "page.observe",
      pageId: FIXTURE_PAGE_ID,
      events: ["dom.changed"],
    } as AgentMessage);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(transport.sent.some((message) => message.kind === "response" && message.requestId === "observe"), true);

    transport.emitMessage({
      kind: "request",
      protocol: AGENT_PROTOCOL,
      version: AGENT_PROTOCOL_VERSION,
      requestId: "click",
      op: "page.act",
      pageId: FIXTURE_PAGE_ID,
      action: {
        type: "click",
        target: { locator: { kind: "role", role: "button", name: "Continue", exact: true } },
      },
    } as AgentMessage);
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("transport did not close after backpressure")), 1000)),
    ]);
    assert.equal(transport.closed, true);
    assert.equal(transport.sent.some((message) => message.kind === "event"), true);
  } finally {
    cleanup();
  }
});
