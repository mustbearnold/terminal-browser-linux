import { AgentClient, type AgentClientOptions } from "../client";
import { AgentRequestRouter, type AgentConnectionContext } from "../core/router";
import { MemoryTrace, TraceRecorder } from "../core/trace";
import type { AgentMessage } from "../protocol/types";
import { FixtureRuntime } from "../test/fixture";
import type { AgentTransport } from "../transport/types";

export interface FixtureAgentHarness {
  client: AgentClient;
  router: AgentRequestRouter;
  trace: MemoryTrace;
}

class RouterLoopbackTransport implements AgentTransport {
  private readonly messageListeners = new Set<(message: AgentMessage) => void>();
  private readonly errorListeners = new Set<(error: unknown) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly cleanups = new Set<() => void>();
  private readonly context: AgentConnectionContext;
  private closed = false;

  constructor(private readonly router: AgentRequestRouter) {
    this.context = {
      clientId: "loopback",
      emit: (message) => this.emit(message),
      addSubscription: (cleanup) => {
        this.cleanups.add(cleanup);
        return () => this.cleanups.delete(cleanup);
      },
    };
  }

  send(message: AgentMessage): Promise<void> {
    if (this.closed) return Promise.reject(new Error("loopback transport is closed"));
    if (message.kind !== "request") return Promise.resolve();
    queueMicrotask(() => {
      void this.router.handle(message, this.context)
        .then((response) => {
          if (!this.closed) this.emit(response);
        })
        .catch((error) => this.reportError(error));
    });
    return Promise.resolve();
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
    this.router.close(this.context);
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.clear();
    for (const listener of this.closeListeners) listener();
  }

  private emit(message: AgentMessage): void {
    for (const listener of this.messageListeners) listener(message);
  }

  private reportError(error: unknown): void {
    for (const listener of this.errorListeners) listener(error);
  }
}

export function createFixtureAgentClient(options: AgentClientOptions = {}): AgentClient {
  return createFixtureAgentHarness(options).client;
}

export function createFixtureAgentHarness(options: AgentClientOptions = {}): FixtureAgentHarness {
  const trace = new MemoryTrace();
  const router = new AgentRequestRouter(new FixtureRuntime(), new TraceRecorder(trace));
  return {
    client: new AgentClient(new RouterLoopbackTransport(router), options),
    router,
    trace,
  };
}
