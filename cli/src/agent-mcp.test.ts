import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_TOOL_DEFINITIONS,
  AGENT_TOOL_PROTOCOL,
  AGENT_TOOL_VERSION,
  AGENT_PROTOCOL,
  AGENT_PROTOCOL_VERSION,
  AgentError,
  asPageId,
} from "terminal-browser-agent";
import type {
  AgentCallOptions,
  AgentEvent,
  AgentToolCall,
  AgentToolManifest,
} from "terminal-browser-agent";

import { MCP_CONNECTION_RECONNECT_METHOD, McpServerSession, type McpToolProvider } from "./agent-mcp";
import type { AgentConnectionLifecycle } from "./agent-recovery";

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  canceled: boolean;
}

class FakeMcpTools implements McpToolProvider {
  readonly calls = new Map<string, PendingCall>();
  manifestCalls = 0;
  private sequence = 0;

  manifest(): Promise<AgentToolManifest> {
    this.manifestCalls += 1;
    return Promise.resolve({
      protocol: AGENT_TOOL_PROTOCOL,
      version: AGENT_TOOL_VERSION,
      capabilities: ["pages.list"],
      limits: {
        maxInFlightRequests: 128,
        maxQueuedActionsPerPage: 64,
        maxOutboundQueueMessages: 256,
        maxOutboundQueueBytes: 8 * 1024 * 1024,
      },
      tools: [AGENT_TOOL_DEFINITIONS[0]],
    });
  }

  startTool(name: string, _argumentsValue?: unknown, _options?: AgentCallOptions): Promise<AgentToolCall<unknown>> {
    const requestId = `fake:${name}:${++this.sequence}`;
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const pending: PendingCall = {
      resolve: (value) => resolve(value),
      reject: (error) => reject(error),
      canceled: false,
    };
    const promise = new Promise<unknown>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    this.calls.set(requestId, pending);
    return Promise.resolve({
      requestId,
      promise,
      cancel: async () => {
        if (pending.canceled) return false;
        pending.canceled = true;
        pending.reject(new AgentError("REQUEST_CANCELLED", "request was cancelled"));
        return true;
      },
    });
  }
}

test("speaks the MCP lifecycle and exposes the negotiated tool schema", async () => {
  const tools = new FakeMcpTools();
  const messages: Record<string, unknown>[] = [];
  const session = new McpServerSession(tools, (message) => messages.push(message as Record<string, unknown>));

  await session.handle(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1" },
    },
  }));
  await session.handle(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  await session.handle(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));

  assert.equal((messages[0].result as { protocolVersion: string }).protocolVersion, "2025-06-18");
  assert.deepEqual((messages[1].result as { tools: unknown[] }).tools, [{
    name: AGENT_TOOL_DEFINITIONS[0].name,
    description: AGENT_TOOL_DEFINITIONS[0].description,
    inputSchema: AGENT_TOOL_DEFINITIONS[0].inputSchema,
  }]);
});

test("runs concurrent MCP calls and cancels a pending tool", async () => {
  const tools = new FakeMcpTools();
  const messages: Record<string, unknown>[] = [];
  const session = new McpServerSession(tools, (message) => messages.push(message as Record<string, unknown>));
  await session.handle(JSON.stringify({
    jsonrpc: "2.0",
    id: "init",
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  }));

  await session.handle(JSON.stringify({
    jsonrpc: "2.0",
    id: "slow",
    method: "tools/call",
    params: { name: AGENT_TOOL_DEFINITIONS[0].name, arguments: {} },
  }));
  await session.handle(JSON.stringify({
    jsonrpc: "2.0",
    id: "fast",
    method: "tools/call",
    params: { name: AGENT_TOOL_DEFINITIONS[0].name, arguments: {} },
  }));
  const calls = [...tools.calls.values()];
  assert.equal(calls.length, 2);
  calls[1].resolve({ pages: [] });
  await session.handle(JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: "slow" },
  }));
  await session.drain();

  const fast = messages.find((message) => message.id === "fast") as { result: { structuredContent: unknown } };
  const slow = messages.find((message) => message.id === "slow") as { result: { isError: boolean; structuredContent: { error: { code: string } } } };
  assert.deepEqual(fast.result.structuredContent, { pages: [] });
  assert.equal(slow.result.isError, true);
  assert.equal(slow.result.structuredContent.error.code, "REQUEST_CANCELLED");
});

test("preserves agent events as MCP logging notifications", async () => {
  const tools = new FakeMcpTools();
  const messages: Record<string, unknown>[] = [];
  const session = new McpServerSession(tools, (message) => messages.push(message as Record<string, unknown>));
  const event: AgentEvent = {
    kind: "event",
    protocol: AGENT_PROTOCOL,
    version: AGENT_PROTOCOL_VERSION,
    event: "dom.changed",
    pageId: asPageId("page-1"),
    sequence: 2,
    data: { revision: 3 },
  };

  session.notifyEvent(event);

  assert.deepEqual(messages[0], {
    jsonrpc: "2.0",
    method: "notifications/message",
    params: { level: "info", logger: "terminal-browser.agent", data: event },
  });
});

test("publishes connection lifecycle notifications and refreshes the manifest", async () => {
  const tools = new FakeMcpTools();
  const messages: Record<string, unknown>[] = [];
  const session = new McpServerSession(tools, (message) => messages.push(message as Record<string, unknown>));

  await session.handle(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  }));
  session.notifyConnection({ state: "disconnected" });
  session.notifyConnection({ state: "reconnecting" });
  session.notifyConnection({ state: "connected" });
  await session.handle(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));

  const connections = messages
    .filter((message) => message.method === "notifications/message")
    .map((message) => (message.params as { data: AgentConnectionLifecycle }).data);
  assert.deepEqual(connections, [
    { state: "disconnected" },
    { state: "reconnecting" },
    { state: "connected" },
  ]);
  assert.equal(tools.manifestCalls, 2);
  assert.deepEqual((messages.at(-1)?.result as { tools: unknown[] }).tools, [{
    name: AGENT_TOOL_DEFINITIONS[0].name,
    description: AGENT_TOOL_DEFINITIONS[0].description,
    inputSchema: AGENT_TOOL_DEFINITIONS[0].inputSchema,
  }]);
});

test("supports an explicit MCP reconnect request outside the tool manifest", async () => {
  const tools = new FakeMcpTools();
  const messages: Record<string, unknown>[] = [];
  let reconnects = 0;
  const session = new McpServerSession(
    tools,
    (message) => messages.push(message as Record<string, unknown>),
    { reconnect: async () => { reconnects += 1; } },
  );

  await session.handle(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  }));
  await session.handle(JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: MCP_CONNECTION_RECONNECT_METHOD,
    params: { deadlineMs: 5000 },
  }));

  assert.equal(reconnects, 1);
  assert.deepEqual(messages[1], {
    jsonrpc: "2.0",
    id: 2,
    result: { state: "connected" },
  });
});
