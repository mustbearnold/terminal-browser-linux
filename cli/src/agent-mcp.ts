import { createInterface } from "node:readline";

import {
  AgentClient,
  AgentError,
  AgentToolClient,
} from "terminal-browser-agent";
import type {
  AgentCallOptions,
  AgentEvent,
  AgentToolCall,
  AgentToolManifest,
} from "terminal-browser-agent";
import type { Backend } from "pixel-terminals";

import { agentSocketPath, selectBrowser } from "./agent";
import { superviseAgentConnection, type AgentConnectionLifecycle, type AgentConnectionSupervisor } from "./agent-recovery";

export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const MCP_SERVER_PROTOCOL_VERSION = MCP_PROTOCOL_VERSIONS[0];
export const MCP_CONNECTION_RECONNECT_METHOD = "terminal-browser/connection/reconnect";

type RpcId = string | number | null;

export interface McpToolProvider {
  manifest(options?: AgentCallOptions): Promise<AgentToolManifest>;
  startTool(
    name: string,
    argumentsValue?: unknown,
    options?: AgentCallOptions,
  ): Promise<AgentToolCall<unknown>>;
}

interface PendingCall {
  cancel: () => Promise<boolean>;
}

export interface McpServerSessionOptions {
  reconnect?: (options?: AgentCallOptions) => Promise<void>;
}

export class McpServerSession {
  private manifestValue: AgentToolManifest | null = null;
  private initialized = false;
  private readonly pending = new Map<string, PendingCall>();
  private readonly completions = new Set<Promise<void>>();

  constructor(
    private readonly tools: McpToolProvider,
    private readonly emit: (message: unknown) => void,
    private readonly options: McpServerSessionOptions = {},
  ) {}

  async handle(line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.emit(errorResponse(null, -32700, "invalid JSON"));
      return;
    }
    if (!isRecord(parsed) || parsed.jsonrpc !== "2.0" || typeof parsed.method !== "string") {
      this.emit(errorResponse(null, -32600, "invalid JSON-RPC request"));
      return;
    }
    const hasId = Object.prototype.hasOwnProperty.call(parsed, "id");
    if (!hasId) {
      await this.handleNotification(parsed.method, parsed.params);
      return;
    }
    const id = rpcId(parsed.id);
    if (id === undefined) {
      this.emit(errorResponse(null, -32600, "request id must be a string, number, or null"));
      return;
    }
    const completion = this.handleRequest(id, parsed.method, parsed.params);
    this.track(completion);
    if (parsed.method !== "tools/call") await completion;
  }

  notifyEvent(event: AgentEvent): void {
    this.emit({
      jsonrpc: "2.0",
      method: "notifications/message",
      params: {
        level: "info",
        logger: "terminal-browser.agent",
        data: event,
      },
    });
  }

  notifyConnection(lifecycle: AgentConnectionLifecycle): void {
    if (lifecycle.state === "disconnected" || lifecycle.state === "connected") {
      this.manifestValue = null;
    }
    this.emit({
      jsonrpc: "2.0",
      method: "notifications/message",
      params: {
        level: lifecycle.state === "failed" ? "error" : "info",
        logger: "terminal-browser.agent.connection",
        data: lifecycle,
      },
    });
  }

  async drain(): Promise<void> {
    while (this.completions.size > 0) {
      await Promise.all([...this.completions]);
    }
  }

  private async handleRequest(id: RpcId, method: string, params: unknown): Promise<void> {
    try {
      switch (method) {
        case "initialize":
          this.emit(successResponse(id, await this.initialize(params)));
          return;
        case "ping":
          this.emit(successResponse(id, {}));
          return;
        case MCP_CONNECTION_RECONNECT_METHOD:
          this.emit(successResponse(id, await this.reconnectConnection(params)));
          return;
        case "tools/list":
          this.emit(successResponse(id, await this.listTools(params)));
          return;
        case "tools/call":
          await this.callTool(id, params);
          return;
        default:
          this.emit(errorResponse(id, -32601, `method not found: ${method}`));
      }
    } catch (error) {
      this.emit(errorResponse(id, -32602, error instanceof Error ? error.message : String(error)));
    }
  }

  private async handleNotification(method: string, params: unknown): Promise<void> {
    if (method === "notifications/initialized") {
      this.initialized = true;
      return;
    }
    if (method === "notifications/cancelled") {
      const requestId = isRecord(params) ? rpcId(params.requestId) : undefined;
      if (requestId !== undefined) await this.pending.get(idKey(requestId))?.cancel();
    }
  }

  private async initialize(params: unknown): Promise<Record<string, unknown>> {
    if (this.initialized) throw new AgentError("INVALID_REQUEST", "MCP session is already initialized");
    const input = requireRecord(params, "initialize params");
    if (typeof input.protocolVersion !== "string" || input.protocolVersion.length === 0) {
      throw new AgentError("INVALID_REQUEST", "initialize params.protocolVersion must be a non-empty string");
    }
    this.manifestValue = await this.tools.manifest();
    this.initialized = true;
    const protocolVersion = MCP_PROTOCOL_VERSIONS.includes(input.protocolVersion as typeof MCP_PROTOCOL_VERSIONS[number])
      ? input.protocolVersion
      : MCP_SERVER_PROTOCOL_VERSION;
    return {
      protocolVersion,
      capabilities: {
        logging: {},
        tools: { listChanged: false },
      },
      serverInfo: {
        name: "terminal-browser",
        version: "0.1.0",
      },
      instructions: "Use semantic snapshots to locate controls, then use verified page actions with idempotencyKey for retryable work.",
    };
  }

  private async listTools(params: unknown): Promise<Record<string, unknown>> {
    this.requireInitialized();
    const input = params === undefined ? {} : requireRecord(params, "tools/list params");
    if (input.cursor !== undefined) throw new AgentError("INVALID_REQUEST", "tools/list pagination is not supported");
    const manifest = await this.manifest();
    return {
      tools: manifest.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    };
  }

  private async reconnectConnection(params: unknown): Promise<Record<string, unknown>> {
    this.requireInitialized();
    const input = params === undefined ? {} : requireRecord(params, "connection reconnect params");
    const deadlineMs = requestDeadline(input.deadlineMs);
    if (!this.options.reconnect) {
      throw new AgentError("TRANSPORT_CLOSED", "agent connection recovery is unavailable", { retryable: true });
    }
    await this.options.reconnect({
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
    });
    return { state: "connected" };
  }

  private async callTool(id: RpcId, params: unknown): Promise<void> {
    this.requireInitialized();
    const input = requireRecord(params, "tools/call params");
    if (typeof input.name !== "string" || input.name.length === 0) {
      throw new AgentError("INVALID_REQUEST", "tools/call params.name must be a non-empty string");
    }
    const manifest = await this.manifest();
    if (!manifest.tools.some((tool) => tool.name === input.name)) {
      this.emit(errorResponse(id, -32602, `unknown tool: ${input.name}`));
      return;
    }
    const key = idKey(id);
    if (this.pending.has(key)) {
      this.emit(errorResponse(id, -32600, "request id is already in flight"));
      return;
    }
    const pending: PendingCall = { cancel: async () => false };
    this.pending.set(key, pending);
    try {
      const call = await this.tools.startTool(input.name, input.arguments);
      pending.cancel = call.cancel;
      try {
        const result = await call.promise;
        this.emit(successResponse(id, toolResult(result)));
      } catch (error) {
        this.emit(successResponse(id, toolError(error)));
      }
    } catch (error) {
      this.emit(successResponse(id, toolError(error)));
    } finally {
      this.pending.delete(key);
    }
  }

  private async manifest(): Promise<AgentToolManifest> {
    if (!this.manifestValue) this.manifestValue = await this.tools.manifest();
    return this.manifestValue;
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new AgentError("INVALID_REQUEST", "MCP session is not initialized");
  }

  private track(completion: Promise<void>): void {
    const tracked = completion.catch(() => undefined);
    this.completions.add(tracked);
    void tracked.finally(() => this.completions.delete(tracked));
  }
}

export interface AgentMcpOptions {
  browserKey?: string;
}

export async function agentMcpCommand(backend: Backend, options: AgentMcpOptions): Promise<number> {
  const browser = await selectBrowser(backend, options.browserKey);
  const client = await AgentClient.connect(agentSocketPath(browser), {
    clientId: "terminal-browser-cli-mcp",
  });
  const tools = new AgentToolClient(client);
  let supervisor: AgentConnectionSupervisor | null = null;
  const session = new McpServerSession(tools, write, {
    reconnect: (options) => supervisor?.reconnect(options) ?? Promise.reject(
      new AgentError("TRANSPORT_CLOSED", "agent connection supervisor is unavailable", { retryable: true }),
    ),
  });
  const unsubscribe = tools.onEvent((event) => session.notifyEvent(event));
  supervisor = superviseAgentConnection(tools, (lifecycle) => {
    session.notifyConnection(lifecycle);
  });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.trim() === "") continue;
      await session.handle(line);
    }
    await session.drain();
    return 0;
  } finally {
    lines.close();
    supervisor?.dispose();
    unsubscribe();
    await tools.close();
  }
}

function toolResult(result: unknown): Record<string, unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: isRecord(result) ? result : { value: result },
  };
}

function toolError(error: unknown): Record<string, unknown> {
  const payload = error instanceof AgentError
    ? error.payload()
    : { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: { error: payload },
    isError: true,
  };
}

function successResponse(id: RpcId, result: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id: RpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new AgentError("INVALID_REQUEST", `${field} must be an object`);
  return value;
}

function requestDeadline(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new AgentError("INVALID_REQUEST", "deadlineMs must be a non-negative safe integer");
  }
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rpcId(value: unknown): RpcId | undefined {
  return value === null || typeof value === "string" || typeof value === "number" ? value : undefined;
}

function idKey(id: RpcId): string {
  return `${typeof id}:${String(id)}`;
}

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
