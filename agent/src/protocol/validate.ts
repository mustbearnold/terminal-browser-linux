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

function requirePositiveInteger(value: unknown, field: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new AgentError("INVALID_MESSAGE", `${field} must be a positive safe integer`);
  }
}

function requireNonNegativeNumber(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new AgentError("INVALID_MESSAGE", `${field} must be a non-negative number`);
  }
}

function requireBoolean(value: unknown, field: string): void {
  if (typeof value !== "boolean") throw new AgentError("INVALID_MESSAGE", `${field} must be a boolean`);
}

function requireStringValue(value: unknown, field: string): void {
  if (typeof value !== "string") throw new AgentError("INVALID_MESSAGE", `${field} must be a string`);
}

function requireOneOf<T extends string>(value: unknown, field: string, values: readonly T[]): void {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new AgentError("INVALID_MESSAGE", `${field} must be one of ${values.join(", ")}`);
  }
}

function optionalBoolean(value: Record<string, unknown>, property: string, field = property): void {
  if (value[property] !== undefined) requireBoolean(value[property], field);
}

function optionalString(value: Record<string, unknown>, property: string, field = property): void {
  if (value[property] !== undefined) requireStringValue(value[property], field);
}

function optionalNonNegativeInteger(value: Record<string, unknown>, property: string, field = property): void {
  if (value[property] !== undefined) requireNonNegativeInteger(value[property], field);
}

function validateSnapshotOptions(value: unknown): void {
  const options = requireObject(value, "options");
  optionalBoolean(options, "interactiveOnly", "options.interactiveOnly");
  optionalBoolean(options, "includeGeometry", "options.includeGeometry");
  optionalBoolean(options, "includeText", "options.includeText");
  if (options.maxNodes !== undefined) requirePositiveInteger(options.maxNodes, "options.maxNodes");
}

function validateCaptureOptions(value: unknown): void {
  const options = requireObject(value, "options");
  if (options.format !== undefined) requireOneOf(options.format, "options.format", ["png", "jpeg", "webp"]);
  if (options.quality !== undefined) {
    requireNonNegativeInteger(options.quality, "options.quality");
    if (Number(options.quality) > 100) {
      throw new AgentError("INVALID_MESSAGE", "options.quality must be between 0 and 100");
    }
  }
  optionalBoolean(options, "fullPage", "options.fullPage");
}

function validateSnapshotToken(value: unknown, field: string): void {
  const token = requireObject(value, field);
  requireString(token.pageId, `${field}.pageId`);
  requireString(token.documentId, `${field}.documentId`);
  requireNonNegativeInteger(token.revision, `${field}.revision`);
  requireString(token.snapshotId, `${field}.snapshotId`);
}

function validateLocator(value: unknown, field: string): void {
  const locator = requireObject(value, field);
  const kind = requireString(locator.kind, `${field}.kind`);
  switch (kind) {
    case "role":
      requireString(locator.role, `${field}.role`);
      optionalString(locator, "name", `${field}.name`);
      optionalBoolean(locator, "exact", `${field}.exact`);
      return;
    case "text":
    case "label":
    case "placeholder":
      requireString(locator.text, `${field}.text`);
      optionalBoolean(locator, "exact", `${field}.exact`);
      return;
    case "testid":
    case "css":
      requireString(locator.value, `${field}.value`);
      return;
    default:
      throw new AgentError("INVALID_MESSAGE", `${field}.kind is unsupported`);
  }
}

function validateTarget(value: unknown, field: string): void {
  const target = requireObject(value, field);
  const hasRef = target.ref !== undefined;
  const hasLocator = target.locator !== undefined;
  if (hasRef === hasLocator) {
    throw new AgentError("INVALID_MESSAGE", `${field} must contain exactly one of ref or locator`);
  }
  if (hasRef) requireString(target.ref, `${field}.ref`);
  else validateLocator(target.locator, `${field}.locator`);
}

function validateAction(value: unknown): void {
  const action = requireObject(value, "action");
  const type = requireString(action.type, "action.type");
  switch (type) {
    case "click":
      validateTarget(action.target, "action.target");
      if (action.button !== undefined) requireOneOf(action.button, "action.button", ["left", "middle", "right"]);
      if (action.clickCount !== undefined) requirePositiveInteger(action.clickCount, "action.clickCount");
      return;
    case "fill":
      validateTarget(action.target, "action.target");
      requireStringValue(action.value, "action.value");
      return;
    case "type":
      requireStringValue(action.text, "action.text");
      return;
    case "press":
      requireString(action.key, "action.key");
      return;
    case "select":
      validateTarget(action.target, "action.target");
      requireStringArray(action.values, "action.values");
      return;
    case "check":
      validateTarget(action.target, "action.target");
      requireBoolean(action.checked, "action.checked");
      return;
    case "hover":
      validateTarget(action.target, "action.target");
      return;
    case "scroll":
      if (action.target !== undefined) validateTarget(action.target, "action.target");
      requireOneOf(action.direction, "action.direction", ["up", "down", "left", "right"]);
      if (action.amount !== undefined) requireNonNegativeNumber(action.amount, "action.amount");
      return;
    case "navigate":
      requireString(action.url, "action.url");
      return;
    default:
      throw new AgentError("INVALID_MESSAGE", `action.type is unsupported: ${type}`);
  }
}

function validateExpectation(value: unknown): void {
  const expect = requireObject(value, "expect");
  optionalString(expect, "url", "expect.url");
  optionalString(expect, "title", "expect.title");
  optionalString(expect, "text", "expect.text");
  optionalNonNegativeInteger(expect, "timeoutMs", "expect.timeoutMs");
  optionalNonNegativeInteger(expect, "quietMs", "expect.quietMs");
}

function validateWaitCondition(value: unknown): void {
  const condition = requireObject(value, "condition");
  const type = requireString(condition.type, "condition.type");
  switch (type) {
    case "time":
      requireNonNegativeInteger(condition.ms, "condition.ms");
      return;
    case "url":
      requireString(condition.value, "condition.value");
      return;
    case "text":
      requireString(condition.value, "condition.value");
      if (condition.target !== undefined) validateTarget(condition.target, "condition.target");
      return;
    case "stable":
      requireNonNegativeInteger(condition.quietMs, "condition.quietMs");
      return;
    default:
      throw new AgentError("INVALID_MESSAGE", `condition.type is unsupported: ${type}`);
  }
}

const agentEventTypes = new Set([
  "navigation",
  "frame.lifecycle",
  "load",
  "dom.changed",
  "console",
  "page.error",
  "download",
  "dialog",
]);

function validateEventType(value: unknown, field: string): void {
  if (typeof value !== "string" || !agentEventTypes.has(value)) {
    throw new AgentError("INVALID_MESSAGE", `${field} is unsupported`);
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
    case "page.snapshot.delta":
    case "page.capture":
    case "page.read":
    case "page.act":
    case "page.wait":
    case "page.observe":
      requireString(message.pageId, "pageId");
      break;
    default:
      throw new AgentError("INVALID_MESSAGE", `unsupported request operation: ${op}`);
  }

  if (op === "page.snapshot" && message.options !== undefined) validateSnapshotOptions(message.options);
  if (op === "page.snapshot.delta") {
    validateSnapshotToken(message.base, "base");
    if (message.options !== undefined) validateSnapshotOptions(message.options);
  }
  if (op === "page.capture" && message.options !== undefined) validateCaptureOptions(message.options);
  if (op === "page.read") {
    validateTarget(message.target, "target");
    if (message.token !== undefined) validateSnapshotToken(message.token, "token");
  }
  if (op === "page.act") {
    validateAction(message.action);
    if (message.token !== undefined) validateSnapshotToken(message.token, "token");
    if (message.expect !== undefined) validateExpectation(message.expect);
    if (message.idempotencyKey !== undefined) {
      const key = requireString(message.idempotencyKey, "idempotencyKey");
      if (key.length > 256) throw new AgentError("INVALID_MESSAGE", "idempotencyKey must be at most 256 characters");
    }
  }
  if (op === "page.wait") {
    validateWaitCondition(message.condition);
    if (message.timeoutMs !== undefined) requireNonNegativeInteger(message.timeoutMs, "timeoutMs");
  }
  if (op === "page.observe") {
    requireStringArray(message.events, "events");
    for (const [index, event] of (message.events as string[]).entries()) validateEventType(event, `events[${index}]`);
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
    if (!message.ok) {
      const error = requireObject(message.error, "response.error");
      requireString(error.code, "response.error.code");
      requireString(error.message, "response.error.message");
      if (error.retryable !== undefined) requireBoolean(error.retryable, "response.error.retryable");
    }
  } else if (kind === "event") {
    validateEventType(message.event, "event");
    requireString(message.pageId, "pageId");
    requireNonNegativeInteger(message.sequence, "event.sequence");
  } else {
    throw new AgentError("INVALID_MESSAGE", `unknown message kind: ${kind}`);
  }

  return message as unknown as AgentMessage;
}
