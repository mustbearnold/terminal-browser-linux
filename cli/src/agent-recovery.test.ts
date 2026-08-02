import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentCallOptions,
  AgentConnectionState,
  AgentHelloResult,
} from "terminal-browser-agent";

import {
  superviseAgentConnection,
  type AgentConnectionLifecycle,
  type RecoverableAgentTools,
} from "./agent-recovery";

class FakeRecoverableTools implements RecoverableAgentTools {
  private readonly listeners = new Set<(state: AgentConnectionState) => void>();
  private resolveReconnect: (() => void) | null = null;
  private rejectReconnect: ((error: unknown) => void) | null = null;
  reconnectCount = 0;

  onConnectionState(listener: (state: AgentConnectionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reconnect(_options?: AgentCallOptions): Promise<AgentHelloResult> {
    this.reconnectCount += 1;
    return new Promise<AgentHelloResult>((resolve, reject) => {
      this.resolveReconnect = () => resolve(undefined as unknown as AgentHelloResult);
      this.rejectReconnect = reject;
    });
  }

  emit(state: AgentConnectionState): void {
    for (const listener of this.listeners) listener(state);
  }

  resolve(): void {
    this.resolveReconnect?.();
  }

  reject(error: unknown): void {
    this.rejectReconnect?.(error);
  }
}

test("reconnects once per loss and reports recovery lifecycle", async () => {
  const tools = new FakeRecoverableTools();
  const lifecycle: AgentConnectionLifecycle[] = [];
  const supervisor = superviseAgentConnection(tools, (state) => lifecycle.push(state));

  tools.emit("disconnected");
  tools.emit("disconnected");
  assert.equal(tools.reconnectCount, 1);
  assert.deepEqual(lifecycle, [{ state: "disconnected" }, { state: "reconnecting" }]);

  const reconnect = supervisor.reconnect();
  tools.resolve();
  await reconnect;

  assert.deepEqual(lifecycle, [
    { state: "disconnected" },
    { state: "reconnecting" },
    { state: "connected" },
  ]);
  supervisor.dispose();
});

test("reports a reconnect failure without retrying in a loop", async () => {
  const tools = new FakeRecoverableTools();
  const lifecycle: AgentConnectionLifecycle[] = [];
  const supervisor = superviseAgentConnection(tools, (state) => lifecycle.push(state));

  tools.emit("disconnected");
  const reconnect = supervisor.reconnect();
  tools.reject(new Error("socket unavailable"));
  await assert.rejects(reconnect, /socket unavailable/);

  assert.equal(tools.reconnectCount, 1);
  assert.deepEqual(lifecycle, [
    { state: "disconnected" },
    { state: "reconnecting" },
    { state: "failed", error: { code: "INTERNAL_ERROR", message: "socket unavailable" } },
  ]);
  supervisor.dispose();
});

test("stops recovery after the connection is closed", () => {
  const tools = new FakeRecoverableTools();
  const lifecycle: AgentConnectionLifecycle[] = [];
  const supervisor = superviseAgentConnection(tools, (state) => lifecycle.push(state));

  tools.emit("closed");
  tools.emit("disconnected");

  assert.equal(tools.reconnectCount, 0);
  assert.deepEqual(lifecycle, [{ state: "closed" }]);
  supervisor.dispose();
});
