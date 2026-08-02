import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { AgentError } from "../protocol/errors";
import { LineJsonDecoder, encodeAgentMessage } from "./line-json";
import {
  MAX_AGENT_OUTBOUND_QUEUE_BYTES,
  MAX_AGENT_OUTBOUND_QUEUE_MESSAGES,
  type AgentMessage,
  type AgentOutboundQueueLimits,
} from "../protocol/types";
import type { AgentTransport, AgentTransportServer } from "./types";

export interface UnixSocketTransportOptions {
  maxPendingWrites?: number;
  maxPendingBytes?: number;
}

export async function connectUnixSocket(socketPath: string): Promise<UnixSocketTransport> {
  const socket = net.createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    socket.once("connect", () => {
      socket.removeListener("error", onError);
      resolve();
    });
    socket.once("error", onError);
  });
  return new UnixSocketTransport(socket);
}

export class UnixSocketTransport implements AgentTransport {
  private readonly decoder = new LineJsonDecoder();
  private readonly messageListeners = new Set<(message: AgentMessage) => void>();
  private readonly errorListeners = new Set<(error: unknown) => void>();
  private readonly closeListeners = new Set<() => void>();
  private closed = false;
  private closing = false;
  private decoderFailed = false;
  private writeTail: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | null = null;
  private pendingWrites = 0;
  private pendingBytes = 0;
  private readonly maxPendingWrites: number;
  private readonly maxPendingBytes: number;

  constructor(
    private readonly socket: net.Socket,
    options: UnixSocketTransportOptions = {},
  ) {
    this.maxPendingWrites = options.maxPendingWrites ?? MAX_AGENT_OUTBOUND_QUEUE_MESSAGES;
    this.maxPendingBytes = options.maxPendingBytes ?? MAX_AGENT_OUTBOUND_QUEUE_BYTES;
    validateQueueLimit(this.maxPendingWrites, "max pending writes");
    validateQueueLimit(this.maxPendingBytes, "max pending bytes");
    socket.on("data", (chunk) => {
      try {
        for (const message of this.decoder.push(chunk)) {
          for (const listener of this.messageListeners) listener(message);
        }
      } catch (error) {
        this.decoderFailed = true;
        this.reportError(error);
        socket.destroy();
      }
    });
    socket.on("error", (error) => this.reportError(error));
    socket.on("close", () => {
      if (!this.decoderFailed) {
        try {
          this.decoder.flush();
        } catch (error) {
          this.decoderFailed = true;
          this.reportError(error);
        }
      }
      this.closed = true;
      for (const listener of this.closeListeners) listener();
    });
  }

  send(message: AgentMessage): Promise<void> {
    if (this.closed || this.closing || this.socket.destroyed) return Promise.reject(new Error("transport is closed"));
    let frame: string;
    try {
      frame = encodeAgentMessage(message);
    } catch (error) {
      return Promise.reject(error);
    }
    const bytes = Buffer.byteLength(frame, "utf8");
    if (this.pendingWrites >= this.maxPendingWrites || bytes > this.maxPendingBytes - this.pendingBytes) {
      return Promise.reject(new AgentError("RESOURCE_EXHAUSTED", "agent transport outbound queue is full", {
        retryable: true,
        details: {
          scope: "transport-outbound",
          maxOutboundQueueMessages: this.maxPendingWrites,
          maxOutboundQueueBytes: this.maxPendingBytes,
          pendingMessages: this.pendingWrites,
          pendingBytes: this.pendingBytes,
          frameBytes: bytes,
        },
      }));
    }
    this.pendingWrites += 1;
    this.pendingBytes += bytes;
    const write = this.writeTail.then(() => this.writeFrame(frame));
    this.writeTail = write.catch(() => {});
    return write.then(
      () => {
        this.releaseWrite(bytes);
      },
      (error) => {
        this.releaseWrite(bytes);
        throw error;
      },
    );
  }

  get outboundQueueLimits(): AgentOutboundQueueLimits {
    return {
      maxOutboundQueueMessages: this.maxPendingWrites,
      maxOutboundQueueBytes: this.maxPendingBytes,
    };
  }

  onMessage(listener: (message: AgentMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onError(listener: (error: unknown) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.closed || this.socket.destroyed) return Promise.resolve();
    this.closing = true;
    this.closePromise = this.writeTail.then(() => new Promise<void>((resolve) => {
      if (this.socket.destroyed) {
        resolve();
        return;
      }
      this.socket.once("close", resolve);
      this.socket.end();
    }));
    return this.closePromise;
  }

  private writeFrame(frame: string): Promise<void> {
    if (this.closed || this.socket.destroyed) return Promise.reject(new Error("transport is closed"));
    return new Promise((resolve, reject) => {
      this.socket.write(frame, (error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private releaseWrite(bytes: number): void {
    this.pendingWrites -= 1;
    this.pendingBytes -= bytes;
  }

  private reportError(error: unknown): void {
    for (const listener of this.errorListeners) listener(error);
  }
}

export class UnixSocketAgentServer implements AgentTransportServer {
  private readonly listeners = new Set<(transport: AgentTransport) => void>();
  private readonly transports = new Set<UnixSocketTransport>();
  private server: net.Server | null = null;

  constructor(
    private readonly socketPath: string,
    private readonly transportOptions: UnixSocketTransportOptions = {},
  ) {}

  async listen(): Promise<void> {
    if (this.server) return;
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    fs.rmSync(this.socketPath, { force: true });
    const server = net.createServer((socket) => {
      const transport = new UnixSocketTransport(socket, this.transportOptions);
      this.transports.add(transport);
      transport.onClose(() => this.transports.delete(transport));
      for (const listener of this.listeners) listener(transport);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    fs.chmodSync(this.socketPath, 0o600);
    this.server = server;
  }

  accept(listener: (transport: AgentTransport) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    await Promise.all([...this.transports].map((transport) => transport.close()));
    this.transports.clear();
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    fs.rmSync(this.socketPath, { force: true });
  }
}

function validateQueueLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
}
