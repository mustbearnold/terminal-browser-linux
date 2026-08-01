import { createInterface } from "node:readline";

import {
  AgentClient,
  AgentError,
  AgentToolClient,
} from "terminal-browser-agent";
import type { Backend } from "pixel-terminals";

import { agentSocketPath, selectBrowser } from "./agent";

export interface AgentToolsOptions {
  browserKey?: string;
  list?: boolean;
}

type ToolRequestId = string | number | null;

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
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (line.trim() === "") continue;
        await handleToolRequest(tools, line);
      }
    } finally {
      lines.close();
    }
    return 0;
  } finally {
    unsubscribe();
    await tools.close();
  }
}

async function handleToolRequest(tools: AgentToolClient, line: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    write({
      kind: "result",
      id: null,
      ok: false,
      error: { code: "INVALID_REQUEST", message: "tool request must be valid JSON" },
    });
    return;
  }
  if (!isRecord(parsed)) {
    write({
      kind: "result",
      id: null,
      ok: false,
      error: { code: "INVALID_REQUEST", message: "tool request must be an object" },
    });
    return;
  }
  const id = toolRequestId(parsed.id);
  if (typeof parsed.name !== "string") {
    write({
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
    const result = await tools.callTool(parsed.name, argumentsValue);
    write({ kind: "result", id, name: parsed.name, ok: true, result });
  } catch (error) {
    write({
      kind: "result",
      id,
      name: parsed.name,
      ok: false,
      error: errorPayload(error),
    });
  }
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
