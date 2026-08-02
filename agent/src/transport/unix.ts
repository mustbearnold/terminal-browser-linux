import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { LineJsonDecoder, encodeAgentMessage } from "./line-json";
import type { AgentMessage } from "../protocol/types";
import type { AgentTransport, AgentTransportServer } from "./types";

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
  private decoderFailed = false;

  constructor(private readonly socket: net.Socket) {
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
    if (this.closed || this.socket.destroyed) return Promise.reject(new Error("transport is closed"));
    return new Promise((resolve, reject) => {
      this.socket.write(encodeAgentMessage(message), (error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    });
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

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.end();
  }

  private reportError(error: unknown): void {
    for (const listener of this.errorListeners) listener(error);
  }
}

export class UnixSocketAgentServer implements AgentTransportServer {
  private readonly listeners = new Set<(transport: AgentTransport) => void>();
  private readonly transports = new Set<UnixSocketTransport>();
  private server: net.Server | null = null;

  constructor(private readonly socketPath: string) {}

  async listen(): Promise<void> {
    if (this.server) return;
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    fs.rmSync(this.socketPath, { force: true });
    const server = net.createServer((socket) => {
      const transport = new UnixSocketTransport(socket);
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
    for (const transport of this.transports) transport.close();
    this.transports.clear();
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    fs.rmSync(this.socketPath, { force: true });
  }
}
