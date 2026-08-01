import { createInterface } from "node:readline";

import {
  AgentClient,
  AgentError,
  AgentToolClient,
} from "terminal-browser-agent";
import type { AgentCallOptions, AgentToolCall } from "terminal-browser-agent";
import type { Backend } from "pixel-terminals";

import { agentSocketPath, selectBrowser } from "./agent";

export interface AgentToolsOptions {
  browserKey?: string;
  list?: boolean;
}

type ToolRequestId = string | number | null;

interface PendingToolCall {
  call: AgentToolCall<unknown>;
  completion: Promise<void>;
}

export interface AgentToolInvoker {
  startTool(
    name: string,
    argumentsValue?: unknown,
    options?: AgentCallOptions,
  ): Promise<AgentToolCall<unknown>>;
}

export async function agentToolsCommand(backend: Backend, options: AgentToolsOptions): Promise<number> {
  const browser = await selectBrowser(backend, options.browserKey);
  const client = await AgentClient.connect(agentSocketPath(browser), {
    clientId: "terminal-browser-cli-tools",
  });
  const tools = new AgentToolClient(client);
  let unsubscribe = () => {};
  try {
    const manifest = await tools.manifest();
    if (options.list) {
      write(manifest);
      return 0;
    }

    unsubscribe = tools.onEvent((event) => write({ kind: "event", event }));
    const session = new AgentToolLineSession(tools, write);
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (line.trim() === "") continue;
        await session.handle(line);
      }
    } finally {
      lines.close();
      await session.drain();
    }
    return 0;
  } finally {
    unsubscribe();
    await tools.close();
  }
}

export class AgentToolLineSession {
  private readonly pending = new Map<string, PendingToolCall>();

  constructor(
    private readonly tools: AgentToolInvoker,
    private readonly emit: (value: unknown) => void,
  ) {}

  async handle(line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.emit({
        kind: "result",
        id: null,
        ok: false,
        error: { code: "INVALID_REQUEST", message: "tool request must be valid JSON" },
      });
      return;
    }
    if (!isRecord(parsed)) {
      this.emit({
        kind: "result",
        id: null,
        ok: false,
        error: { code: "INVALID_REQUEST", message: "tool request must be an object" },
      });
      return;
    }
    const id = toolRequestId(parsed.id);
    if (Object.prototype.hasOwnProperty.call(parsed, "cancelRequestId")) {
      await this.cancel(parsed, id);
      return;
    }
    if (typeof parsed.name !== "string") {
      this.emit({
        kind: "result",
        id,
        ok: false,
        error: { code: "INVALID_REQUEST", message: "tool request name must be a string" },
      });
      return;
    }
    const argumentsValue = Object.prototype.hasOwnProperty.call(parsed, "arguments")
      ? parsed.arguments
      : {};
    try {
      const deadlineMs = requestDeadline(parsed.deadlineMs);
      const call = await this.tools.startTool(parsed.name, argumentsValue, {
        ...(deadlineMs === undefined ? {} : { deadlineMs }),
      });
      const completion = call.promise
        .then((result) => {
          this.emit({ kind: "result", id, name: parsed.name, requestId: call.requestId, ok: true, result });
        })
        .catch((error: unknown) => {
          this.emit({
            kind: "result",
            id,
            name: parsed.name,
            requestId: call.requestId,
            ok: false,
            error: errorPayload(error),
          });
        })
        .finally(() => this.pending.delete(call.requestId));
      this.pending.set(call.requestId, {
        call,
        completion,
      });
      this.emit({ kind: "accepted", id, name: parsed.name, requestId: call.requestId });
    } catch (error) {
      this.emit({
        kind: "result",
        id,
        name: parsed.name,
        ok: false,
        error: errorPayload(error),
      });
    }
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending.values()].map((entry) => entry.completion));
  }

  private async cancel(request: Record<string, unknown>, id: ToolRequestId): Promise<void> {
    if (typeof request.cancelRequestId !== "string") {
      this.emit({
        kind: "cancel",
        id,
        canceled: false,
        error: { code: "INVALID_REQUEST", message: "cancelRequestId must be a string" },
      });
      return;
    }
    const entry = this.pending.get(request.cancelRequestId);
    if (!entry) {
      this.emit({
        kind: "cancel",
        id,
        requestId: request.cancelRequestId,
        canceled: false,
        error: { code: "INVALID_REQUEST", message: `unknown pending request: ${request.cancelRequestId}` },
      });
      return;
    }
    try {
      this.emit({
        kind: "cancel",
        id,
        requestId: request.cancelRequestId,
        canceled: await entry.call.cancel(),
      });
    } catch (error) {
      this.emit({
        kind: "cancel",
        id,
        requestId: request.cancelRequestId,
        canceled: false,
        error: errorPayload(error),
      });
    }
  }
}

function requestDeadline(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new AgentError("INVALID_REQUEST", "deadlineMs must be a non-negative safe integer");
  }
  return value as number;
}

function errorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof AgentError) return error.payload();
  return {
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolRequestId(value: unknown): ToolRequestId {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
