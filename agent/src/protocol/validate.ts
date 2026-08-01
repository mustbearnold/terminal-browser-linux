import { AgentError } from "./errors";
import {
  AGENT_PROTOCOL,
  AGENT_PROTOCOL_VERSION,
  type AgentMessage,
} from "./types";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AgentError("INVALID_MESSAGE", `${field} must be a non-empty string`);
  }
  return value;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  const object = record(value);
  if (!object) throw new AgentError("INVALID_MESSAGE", `${field} must be an object`);
  return object;
}

function requireStringArray(value: unknown, field: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new AgentError("INVALID_MESSAGE", `${field} must be an array of non-empty strings`);
  }
}

function requireNonNegativeInteger(value: unknown, field: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new AgentError("INVALID_MESSAGE", `${field} must be a non-negative safe integer`);
  }
}

function validateRequest(message: Record<string, unknown>): void {
  const op = requireString(message.op, "op");
  if (message.deadlineMs !== undefined) requireNonNegativeInteger(message.deadlineMs, "deadlineMs");
  switch (op) {
    case "hello":
      requireString(message.clientId, "clientId");
      if (message.capabilities !== undefined) requireStringArray(message.capabilities, "capabilities");
      return;
    case "request.cancel":
      requireString(message.targetRequestId, "targetRequestId");
      return;
    case "pages.list":
      return;
    case "pages.open":
      requireString(message.url, "url");
      return;
    case "pages.close":
    case "page.frames":
    case "page.snapshot":
    case "page.read":
    case "page.act":
    case "page.wait":
    case "page.observe":
      requireString(message.pageId, "pageId");
      break;
    default:
      throw new AgentError("INVALID_MESSAGE", `unsupported request operation: ${op}`);
  }

  if (op === "page.snapshot" && message.options !== undefined) requireObject(message.options, "options");
  if (op === "page.read") requireObject(message.target, "target");
  if (op === "page.act") requireObject(message.action, "action");
  if (op === "page.wait") requireObject(message.condition, "condition");
  if (op === "page.observe") {
    requireStringArray(message.events, "events");
    if (message.afterSequence !== undefined) requireNonNegativeInteger(message.afterSequence, "afterSequence");
  }
}

export function parseAgentMessage(value: unknown): AgentMessage {
  const message = record(value);
  if (!message) throw new AgentError("INVALID_MESSAGE", "message must be a JSON object");
  if (message.protocol !== AGENT_PROTOCOL || message.version !== AGENT_PROTOCOL_VERSION) {
    throw new AgentError("PROTOCOL_MISMATCH", "unsupported agent protocol version", {
      details: {
        expectedProtocol: AGENT_PROTOCOL,
        expectedVersion: AGENT_PROTOCOL_VERSION,
        receivedProtocol: typeof message.protocol === "string" ? message.protocol : null,
        receivedVersion: typeof message.version === "number" ? message.version : null,
      },
    });
  }

  const kind = requireString(message.kind, "kind");
  if (kind === "request") {
    requireString(message.requestId, "requestId");
    validateRequest(message);
  } else if (kind === "response") {
    requireString(message.requestId, "requestId");
    if (typeof message.ok !== "boolean") {
      throw new AgentError("INVALID_MESSAGE", "response.ok must be a boolean");
    }
  } else if (kind === "event") {
    requireString(message.event, "event");
    requireString(message.pageId, "pageId");
    if (typeof message.sequence !== "number" || !Number.isInteger(message.sequence)) {
      throw new AgentError("INVALID_MESSAGE", "event.sequence must be an integer");
    }
  } else {
    throw new AgentError("INVALID_MESSAGE", `unknown message kind: ${kind}`);
  }

  return message as unknown as AgentMessage;
}
