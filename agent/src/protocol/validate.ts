import { AgentError } from "./errors";
import {
  AGENT_PROTOCOL,
  AGENT_PROTOCOL_VERSION,
  MAX_LOCATOR_DEPTH,
  MAX_CLICK_COUNT,
  MAX_PAGE_QUERY_BATCH,
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_PATH_LENGTH,
  MAX_TARGET_INDEX,
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

function requireUploadPaths(value: unknown, field: string): void {
  if (!Array.isArray(value) || value.length > MAX_UPLOAD_FILES) {
    throw new AgentError("INVALID_MESSAGE", `${field} must contain at most ${MAX_UPLOAD_FILES} paths`);
  }
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || item.length === 0 || item.length > MAX_UPLOAD_PATH_LENGTH) {
      throw new AgentError("INVALID_MESSAGE", `${field}[${index}] must be a non-empty path of at most ${MAX_UPLOAD_PATH_LENGTH} characters`);
    }
    if (item.includes("\u0000")) {
      throw new AgentError("INVALID_MESSAGE", `${field}[${index}] must not contain a null byte`);
    }
    if (!isAbsolutePath(item)) {
      throw new AgentError("INVALID_MESSAGE", `${field}[${index}] must be an absolute path`);
    }
  }
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(value);
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

function optionalFileCount(value: Record<string, unknown>, property: string, field = property): void {
  if (value[property] === undefined) return;
  requireNonNegativeInteger(value[property], field);
  if (Number(value[property]) > MAX_UPLOAD_FILES) {
    throw new AgentError("INVALID_MESSAGE", `${field} must be at most ${MAX_UPLOAD_FILES}`);
  }
}

function validateSnapshotOptions(value: unknown): void {
  const options = requireObject(value, "options");
  optionalBoolean(options, "interactiveOnly", "options.interactiveOnly");
  optionalBoolean(options, "includeGeometry", "options.includeGeometry");
  optionalBoolean(options, "includeText", "options.includeText");
  if (options.maxNodes !== undefined) requirePositiveInteger(options.maxNodes, "options.maxNodes");
}

function validatePageQueryOptions(value: unknown): void {
  const options = requireObject(value, "options");
  optionalBoolean(options, "includeHidden", "options.includeHidden");
  if (options.frameId !== undefined) requireString(options.frameId, "options.frameId");
  if (options.diagnostics !== undefined) requireOneOf(options.diagnostics, "options.diagnostics", ["summary"]);
  if (options.limit !== undefined) {
    requirePositiveInteger(options.limit, "options.limit");
    if (Number(options.limit) > 256) {
      throw new AgentError("INVALID_MESSAGE", "options.limit must be at most 256");
    }
  }
}

function validatePageQueryBatch(value: unknown): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PAGE_QUERY_BATCH) {
    throw new AgentError("INVALID_MESSAGE", `queries must contain between 1 and ${MAX_PAGE_QUERY_BATCH} locators`);
  }
  for (const [index, rawQuery] of value.entries()) {
    const query = requireObject(rawQuery, `queries[${index}]`);
    validateLocator(query.locator, `queries[${index}].locator`);
    if (query.options !== undefined) validatePageQueryOptions(query.options);
  }
}

function validateSnapshotWindowOptions(value: unknown): void {
  const options = requireObject(value, "options");
  optionalBoolean(options, "interactiveOnly", "options.interactiveOnly");
  optionalBoolean(options, "includeGeometry", "options.includeGeometry");
  optionalBoolean(options, "includeText", "options.includeText");
  if (options.limit !== undefined) {
    requirePositiveInteger(options.limit, "options.limit");
    if (Number(options.limit) > 1000) {
      throw new AgentError("INVALID_MESSAGE", "options.limit must be at most 1000");
    }
  }
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

function validateSnapshotWindowCursor(value: unknown, field: string): void {
  validateSnapshotToken(value, field);
  const cursor = requireObject(value, field);
  requireNonNegativeInteger(cursor.offset, `${field}.offset`);
  requirePositiveInteger(cursor.limit, `${field}.limit`);
  if (Number(cursor.limit) > 1000) {
    throw new AgentError("INVALID_MESSAGE", `${field}.limit must be at most 1000`);
  }
}

function validateLocator(value: unknown, field: string, depth = 0): void {
  if (depth >= MAX_LOCATOR_DEPTH) {
    throw new AgentError("INVALID_MESSAGE", `${field} exceeds the maximum locator depth of ${MAX_LOCATOR_DEPTH}`);
  }
  const locator = requireObject(value, field);
  const kind = requireString(locator.kind, `${field}.kind`);
  switch (kind) {
    case "role":
      requireString(locator.role, `${field}.role`);
      optionalString(locator, "name", `${field}.name`);
      optionalBoolean(locator, "exact", `${field}.exact`);
      break;
    case "text":
    case "label":
    case "placeholder":
      requireString(locator.text, `${field}.text`);
      optionalBoolean(locator, "exact", `${field}.exact`);
      break;
    case "testid":
    case "css":
      requireString(locator.value, `${field}.value`);
      break;
    default:
      throw new AgentError("INVALID_MESSAGE", `${field}.kind is unsupported`);
  }
  if (locator.state !== undefined) validateLocatorState(locator.state, `${field}.state`);
  if (locator.within !== undefined) validateLocator(locator.within, `${field}.within`, depth + 1);
}

function validateLocatorState(value: unknown, field: string): void {
  const state = requireObject(value, field);
  optionalBoolean(state, "visible", `${field}.visible`);
  optionalBoolean(state, "enabled", `${field}.enabled`);
  optionalBoolean(state, "disabled", `${field}.disabled`);
  optionalFileCount(state, "fileCount", `${field}.fileCount`);
  optionalBoolean(state, "focused", `${field}.focused`);
  optionalString(state, "value", `${field}.value`);
  optionalBoolean(state, "checked", `${field}.checked`);
  optionalBoolean(state, "expanded", `${field}.expanded`);
  optionalBoolean(state, "invalid", `${field}.invalid`);
  optionalBoolean(state, "pressed", `${field}.pressed`);
  optionalBoolean(state, "readOnly", `${field}.readOnly`);
  optionalBoolean(state, "required", `${field}.required`);
  optionalBoolean(state, "selected", `${field}.selected`);
  optionalString(state, "text", `${field}.text`);
}

function validateTarget(value: unknown, field: string): void {
  const target = requireObject(value, field);
  const hasRef = target.ref !== undefined;
  const hasLocator = target.locator !== undefined;
  if (hasRef === hasLocator) {
    throw new AgentError("INVALID_MESSAGE", `${field} must contain exactly one of ref or locator`);
  }
  if (hasRef) {
    requireString(target.ref, `${field}.ref`);
    if (target.index !== undefined || target.frameId !== undefined) {
      throw new AgentError("INVALID_MESSAGE", `${field}.index and ${field}.frameId require a locator`);
    }
    return;
  }
  validateLocator(target.locator, `${field}.locator`);
  optionalNonNegativeInteger(target, "index", `${field}.index`);
  if (target.index !== undefined && Number(target.index) > MAX_TARGET_INDEX) {
    throw new AgentError("INVALID_MESSAGE", `${field}.index must be at most ${MAX_TARGET_INDEX}`);
  }
  if (target.frameId !== undefined) requireString(target.frameId, `${field}.frameId`);
}

function validateAction(value: unknown): void {
  const action = requireObject(value, "action");
  const type = requireString(action.type, "action.type");
  switch (type) {
    case "click":
      validateTarget(action.target, "action.target");
      if (action.button !== undefined) requireOneOf(action.button, "action.button", ["left", "middle", "right"]);
      if (action.clickCount !== undefined) {
        requirePositiveInteger(action.clickCount, "action.clickCount");
        if (Number(action.clickCount) > MAX_CLICK_COUNT) {
          throw new AgentError("INVALID_MESSAGE", `action.clickCount must be at most ${MAX_CLICK_COUNT}`);
        }
      }
      return;
    case "focus":
      validateTarget(action.target, "action.target");
      return;
    case "fill":
      validateTarget(action.target, "action.target");
      requireStringValue(action.value, "action.value");
      return;
    case "upload":
      validateTarget(action.target, "action.target");
      requireUploadPaths(action.paths, "action.paths");
      return;
    case "drag":
      validateTarget(action.source, "action.source");
      validateTarget(action.target, "action.target");
      return;
    case "type":
      requireStringValue(action.text, "action.text");
      if (action.target !== undefined) validateTarget(action.target, "action.target");
      return;
    case "press":
      requireString(action.key, "action.key");
      if (action.target !== undefined) validateTarget(action.target, "action.target");
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
    case "history":
      requireOneOf(action.direction, "action.direction", ["back", "forward"]);
      return;
    case "reload":
      if (action.bypassCache !== undefined) requireBoolean(action.bypassCache, "action.bypassCache");
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
  if (expect.element !== undefined) {
    const element = requireObject(expect.element, "expect.element");
    validateTarget(element.target, "expect.element.target");
    if (element.state !== undefined) validateWaitElementState(element.state);
  }
  optionalNonNegativeInteger(expect, "timeoutMs", "expect.timeoutMs");
  optionalNonNegativeInteger(expect, "quietMs", "expect.quietMs");
}

function validateSnapshotOutput(value: unknown): void {
  const output = requireObject(value, "output");
  if (output.snapshot !== undefined) requireOneOf(output.snapshot, "output.snapshot", ["full", "delta", "none"]);
  if (output.base !== undefined) validateSnapshotToken(output.base, "output.base");
  if (output.snapshot === "delta" && output.base === undefined) {
    throw new AgentError("INVALID_MESSAGE", "output.base is required when output.snapshot is delta");
  }
  if (output.base !== undefined && output.snapshot !== "delta") {
    throw new AgentError("INVALID_MESSAGE", "output.base is only valid when output.snapshot is delta");
  }
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
    case "element":
      validateTarget(condition.target, "condition.target");
      if (condition.state !== undefined) validateWaitElementState(condition.state);
      return;
    default:
      throw new AgentError("INVALID_MESSAGE", `condition.type is unsupported: ${type}`);
  }
}

function validateWaitElementState(value: unknown): void {
  const state = requireObject(value, "condition.state");
  optionalBoolean(state, "attached", "condition.state.attached");
  optionalBoolean(state, "visible", "condition.state.visible");
  optionalBoolean(state, "enabled", "condition.state.enabled");
  optionalBoolean(state, "disabled", "condition.state.disabled");
  optionalFileCount(state, "fileCount", "condition.state.fileCount");
  optionalBoolean(state, "focused", "condition.state.focused");
  optionalString(state, "value", "condition.state.value");
  optionalBoolean(state, "checked", "condition.state.checked");
  optionalBoolean(state, "expanded", "condition.state.expanded");
  optionalBoolean(state, "invalid", "condition.state.invalid");
  optionalBoolean(state, "pressed", "condition.state.pressed");
  optionalBoolean(state, "readOnly", "condition.state.readOnly");
  optionalBoolean(state, "required", "condition.state.required");
  optionalBoolean(state, "selected", "condition.state.selected");
  optionalString(state, "text", "condition.state.text");
}

const agentEventTypes = new Set([
  "navigation",
  "frame.lifecycle",
  "load",
  "dom.changed",
  "focus.changed",
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
    case "pages.activate":
    case "pages.close":
    case "page.frames":
    case "page.query":
    case "page.query.batch":
    case "page.snapshot":
    case "page.snapshot.window":
    case "page.snapshot.delta":
    case "page.capture":
    case "page.read":
    case "page.active":
    case "page.act":
    case "page.act.batch":
    case "page.act.status":
    case "page.wait":
    case "page.observe":
    case "page.dialog":
      requireString(message.pageId, "pageId");
      break;
    default:
      throw new AgentError("INVALID_MESSAGE", `unsupported request operation: ${op}`);
  }

  if (op === "page.snapshot" && message.options !== undefined) validateSnapshotOptions(message.options);
  if (op === "page.query") {
    validateLocator(message.locator, "locator");
    if (message.options !== undefined) validatePageQueryOptions(message.options);
  }
  if (op === "page.query.batch") validatePageQueryBatch(message.queries);
  if (op === "page.snapshot.window") {
    if (message.options !== undefined) validateSnapshotWindowOptions(message.options);
    if (message.cursor !== undefined) validateSnapshotWindowCursor(message.cursor, "cursor");
  }
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
    if (message.output !== undefined) validateSnapshotOutput(message.output);
    if (message.idempotencyKey !== undefined) {
      const key = requireString(message.idempotencyKey, "idempotencyKey");
      if (key.length > 256) throw new AgentError("INVALID_MESSAGE", "idempotencyKey must be at most 256 characters");
    }
  }
  if (op === "page.act.batch") {
    validateActionBatch(message.steps);
    if (message.output !== undefined) validateSnapshotOutput(message.output);
    if (message.idempotencyKey !== undefined) {
      const key = requireString(message.idempotencyKey, "idempotencyKey");
      if (key.length > 256) throw new AgentError("INVALID_MESSAGE", "idempotencyKey must be at most 256 characters");
    }
  }
  if (op === "page.act.status") {
    const key = requireString(message.idempotencyKey, "idempotencyKey");
    if (key.length === 0 || key.length > 256) {
      throw new AgentError("INVALID_MESSAGE", "idempotencyKey must be between 1 and 256 characters");
    }
  }
  if (op === "page.wait") {
    validateWaitCondition(message.condition);
    if (message.timeoutMs !== undefined) requireNonNegativeInteger(message.timeoutMs, "timeoutMs");
    if (message.output !== undefined) validateSnapshotOutput(message.output);
  }
  if (op === "page.dialog") {
    requireString(message.dialogId, "dialogId");
    validateDialogAction(message.action);
  }
  if (op === "page.observe") {
    requireStringArray(message.events, "events");
    for (const [index, event] of (message.events as string[]).entries()) validateEventType(event, `events[${index}]`);
    if (message.afterSequence !== undefined) requireNonNegativeInteger(message.afterSequence, "afterSequence");
  }
}

function validateActionBatch(value: unknown): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    throw new AgentError("INVALID_MESSAGE", "steps must contain between 1 and 64 actions");
  }
  for (const [index, rawStep] of value.entries()) {
    const step = requireObject(rawStep, `steps[${index}]`);
    if (step.action === undefined) {
      throw new AgentError("INVALID_MESSAGE", `steps[${index}].action must be provided`);
    }
    validateAction(step.action);
    if (step.token !== undefined) validateSnapshotToken(step.token, `steps[${index}].token`);
    if (step.expect !== undefined) validateExpectation(step.expect);
  }
}

function validateDialogAction(value: unknown): void {
  const action = requireObject(value, "action");
  const type = requireString(action.type, "action.type");
  switch (type) {
    case "accept":
      if (action.promptText !== undefined) requireStringValue(action.promptText, "action.promptText");
      return;
    case "dismiss":
      return;
    default:
      throw new AgentError("INVALID_MESSAGE", `action.type is unsupported: ${type}`);
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
