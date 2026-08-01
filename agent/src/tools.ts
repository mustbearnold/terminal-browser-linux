import { AgentError } from "./protocol/errors";
import { parseAgentMessage } from "./protocol/validate";
import {
  AGENT_PROTOCOL,
  AGENT_PROTOCOL_VERSION,
  type AgentCapability,
  type AgentEvent,
  type AgentRequest,
} from "./protocol/types";
import {
  AgentClient,
  type AgentCallOptions,
  type AgentHelloResult,
  type AgentOperation,
  type AgentOperationResults,
  type AgentRequestFields,
} from "./client";

export const AGENT_TOOL_PROTOCOL = `${AGENT_PROTOCOL}/tools` as const;
export const AGENT_TOOL_VERSION = 1 as const;

export type AgentToolSchemaType = "array" | "boolean" | "number" | "object" | "string";

export interface AgentToolSchema {
  readonly type?: AgentToolSchemaType;
  readonly description?: string;
  readonly properties?: Readonly<Record<string, AgentToolSchema>>;
  readonly required?: readonly string[];
  readonly items?: AgentToolSchema;
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly oneOf?: readonly AgentToolSchema[];
  readonly additionalProperties?: boolean;
}

export interface AgentToolDefinition {
  readonly name: AgentToolName;
  readonly description: string;
  readonly operation: AgentOperation;
  readonly capability?: AgentCapability;
  readonly inputSchema: AgentToolSchema;
}

export interface AgentToolOperationMap {
  terminal_browser_pages_list: "pages.list";
  terminal_browser_pages_open: "pages.open";
  terminal_browser_pages_activate: "pages.activate";
  terminal_browser_pages_close: "pages.close";
  terminal_browser_page_frames: "page.frames";
  terminal_browser_page_snapshot: "page.snapshot";
  terminal_browser_page_snapshot_window: "page.snapshot.window";
  terminal_browser_page_snapshot_delta: "page.snapshot.delta";
  terminal_browser_page_capture: "page.capture";
  terminal_browser_page_read: "page.read";
  terminal_browser_page_act: "page.act";
  terminal_browser_page_act_status: "page.act.status";
  terminal_browser_page_wait: "page.wait";
  terminal_browser_page_observe: "page.observe";
  terminal_browser_page_dialog: "page.dialog";
}

export type AgentToolName = keyof AgentToolOperationMap;
export type AgentToolOperation<Name extends AgentToolName> = AgentToolOperationMap[Name];

type JsonToolValue<Value> =
  Value extends string ? string
    : Value extends number | boolean | null ? Value
      : Value extends readonly (infer Item)[] ? readonly JsonToolValue<Item>[]
        : Value extends object ? { [Key in keyof Value]: JsonToolValue<Value[Key]> }
          : Value;

export type AgentToolArguments<Name extends AgentToolName> = JsonToolValue<
  AgentRequestFields<AgentToolOperation<Name>>
>;
export type AgentToolResult<Name extends AgentToolName> = AgentOperationResults[AgentToolOperation<Name>];

export interface AgentToolManifest {
  readonly protocol: typeof AGENT_TOOL_PROTOCOL;
  readonly version: typeof AGENT_TOOL_VERSION;
  readonly capabilities: readonly AgentCapability[];
  readonly tools: readonly AgentToolDefinition[];
}

export type AgentToolEventListener = (event: AgentEvent) => void;

export interface AgentToolCall<Result> {
  readonly requestId: string;
  readonly promise: Promise<Result>;
  cancel(options?: AgentCallOptions): Promise<boolean>;
}

export const AGENT_TOOL_DEFINITIONS: readonly AgentToolDefinition[] = [
  tool("terminal_browser_pages_list", "List every open browser page.", "pages.list", "pages.list", empty()),
  tool("terminal_browser_pages_open", "Open a URL as a new browser page.", "pages.open", "pages.open", object({
    url: string("URL to open."),
  }, ["url"])),
  tool("terminal_browser_pages_activate", "Make a browser page the active page.", "pages.activate", "pages.activate", pageInput()),
  tool("terminal_browser_pages_close", "Close a browser page.", "pages.close", "pages.close", pageInput()),
  tool("terminal_browser_page_frames", "Read the current frame tree for a page.", "page.frames", "page.frames", pageInput()),
  tool("terminal_browser_page_snapshot", "Read a semantic DOM snapshot.", "page.snapshot", "snapshot.read", object({
    pageId: string("Page identifier."),
    options: snapshotOptions(),
  }, ["pageId"])),
  tool("terminal_browser_page_snapshot_window", "Read a bounded, revision-consistent window of a semantic DOM snapshot.", "page.snapshot.window", "snapshot.window", object({
    pageId: string("Page identifier."),
    options: snapshotWindowOptions(),
    cursor: snapshotWindowCursor(),
  }, ["pageId"])),
  tool("terminal_browser_page_snapshot_delta", "Read only the changes from a prior semantic DOM snapshot.", "page.snapshot.delta", "snapshot.delta", object({
    pageId: string("Page identifier."),
    base: snapshotToken(),
    options: snapshotOptions(),
  }, ["pageId", "base"])),
  tool("terminal_browser_page_capture", "Capture the rendered page as an image.", "page.capture", "page.capture", object({
    pageId: string("Page identifier."),
    options: captureOptions(),
  }, ["pageId"])),
  tool("terminal_browser_page_read", "Read one semantic element without asking the agent to manage a snapshot envelope.", "page.read", "page.read", object({
    pageId: string("Page identifier."),
    target: targetSchema(),
    token: snapshotToken(),
  }, ["pageId", "target"])),
  tool("terminal_browser_page_act", "Perform a verified browser action against a semantic target.", "page.act", "page.act", object({
    pageId: string("Page identifier."),
    action: actionSchema(),
    token: snapshotToken(),
    expect: expectationSchema(),
    output: snapshotOutputSchema(),
    idempotencyKey: string("Stable key for safe retry and replay."),
  }, ["pageId", "action"])),
  tool("terminal_browser_page_act_status", "Check the durable outcome of an idempotent browser action.", "page.act.status", "page.act.status", object({
    pageId: string("Page identifier."),
    idempotencyKey: string("Stable action key to inspect."),
  }, ["pageId", "idempotencyKey"])),
  tool("terminal_browser_page_wait", "Wait for a URL, text, DOM state, element state, or quiet page.", "page.wait", "page.wait", object({
    pageId: string("Page identifier."),
    condition: waitConditionSchema(),
    timeoutMs: number("Maximum wait duration in milliseconds."),
    output: snapshotOutputSchema(),
  }, ["pageId", "condition"])),
  tool("terminal_browser_page_observe", "Subscribe to resumable page lifecycle and DOM events.", "page.observe", "page.observe", object({
    pageId: string("Page identifier."),
    events: { type: "array", items: string("Event type.") },
    afterSequence: number("Replay events after this cursor."),
  }, ["pageId", "events"])),
  tool("terminal_browser_page_dialog", "Accept or dismiss a pending native browser dialog.", "page.dialog", "page.dialog", object({
    pageId: string("Page identifier."),
    dialogId: string("Pending dialog identifier."),
    action: dialogActionSchema(),
  }, ["pageId", "dialogId", "action"])),
];

export class AgentToolClient {
  private helloResult: AgentHelloResult | null = null;
  private helloPromise: Promise<AgentHelloResult> | null = null;

  constructor(private readonly client: AgentClient) {}

  async initialize(options?: AgentCallOptions): Promise<AgentHelloResult> {
    if (this.helloResult) return this.helloResult;
    if (!this.helloPromise) {
      this.helloPromise = this.client.hello(options).then((result) => {
        this.helloResult = result;
        this.helloPromise = null;
        return result;
      }).catch((error) => {
        this.helloPromise = null;
        throw error;
      });
    }
    return this.helloPromise;
  }

  async manifest(options?: AgentCallOptions): Promise<AgentToolManifest> {
    const hello = await this.initialize(options);
    return {
      protocol: AGENT_TOOL_PROTOCOL,
      version: AGENT_TOOL_VERSION,
      capabilities: hello.accepted,
      tools: this.listTools(hello),
    };
  }

  listTools(hello: AgentHelloResult | null = this.helloResult): readonly AgentToolDefinition[] {
    if (!hello) return AGENT_TOOL_DEFINITIONS;
    const accepted = new Set(hello.accepted);
    return AGENT_TOOL_DEFINITIONS.filter((definition) =>
      definition.capability === undefined || accepted.has(definition.capability),
    );
  }

  onEvent(listener: AgentToolEventListener): () => void {
    return this.client.onEvent(listener);
  }

  async startTool<Name extends AgentToolName>(
    name: Name,
    argumentsValue?: AgentToolArguments<Name>,
    options?: AgentCallOptions,
  ): Promise<AgentToolCall<AgentToolResult<Name>>>;
  async startTool(
    name: string,
    argumentsValue?: unknown,
    options?: AgentCallOptions,
  ): Promise<AgentToolCall<AgentOperationResults[AgentOperation]>>;
  async startTool(
    name: string,
    argumentsValue: unknown = {},
    options?: AgentCallOptions,
  ): Promise<AgentToolCall<AgentOperationResults[AgentOperation]>> {
    const hello = await this.initialize(options);
    const definition = AGENT_TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
    if (!definition) throw new AgentError("INVALID_REQUEST", `unknown agent tool: ${name}`);
    if (definition.capability !== undefined && !hello.accepted.includes(definition.capability)) {
      throw new AgentError("CAPABILITY_UNAVAILABLE", `agent tool is unavailable: ${name}`, {
        details: { capability: definition.capability },
      });
    }
    const fields = toolArguments(argumentsValue);
    validateToolArguments(definition.operation, fields);
    const call = this.client.start(
      definition.operation,
      fields as AgentRequestFields<AgentOperation>,
      options,
    );
    return {
      requestId: call.requestId,
      promise: call.promise as Promise<AgentOperationResults[AgentOperation]>,
      cancel: call.cancel,
    };
  }

  async callTool<Name extends AgentToolName>(
    name: Name,
    argumentsValue?: AgentToolArguments<Name>,
    options?: AgentCallOptions,
  ): Promise<AgentToolResult<Name>>;
  async callTool(
    name: string,
    argumentsValue?: unknown,
    options?: AgentCallOptions,
  ): Promise<AgentOperationResults[AgentOperation]>;
  async callTool(
    name: string,
    argumentsValue: unknown = {},
    options?: AgentCallOptions,
  ): Promise<AgentOperationResults[AgentOperation]> {
    const call = await this.startTool(name, argumentsValue, options);
    return call.promise;
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

function tool<Name extends AgentToolName>(
  name: Name,
  description: string,
  operation: AgentToolOperation<Name>,
  capability: AgentCapability,
  inputSchema: AgentToolSchema,
): AgentToolDefinition {
  return { name, description, operation, capability, inputSchema };
}

function empty(): AgentToolSchema {
  return { type: "object", properties: {}, additionalProperties: false };
}

function object(
  properties: Readonly<Record<string, AgentToolSchema>>,
  required: readonly string[] = [],
  description?: string,
): AgentToolSchema {
  return {
    type: "object",
    description,
    properties,
    ...(required.length === 0 ? {} : { required }),
    additionalProperties: false,
  };
}

function string(description: string, values?: readonly string[]): AgentToolSchema {
  return { type: "string", description, ...(values === undefined ? {} : { enum: values }) };
}

function number(description: string): AgentToolSchema {
  return { type: "number", description };
}

function boolean(description: string): AgentToolSchema {
  return { type: "boolean", description };
}

function pageInput(): AgentToolSchema {
  return object({ pageId: string("Page identifier.") }, ["pageId"]);
}

function snapshotToken(): AgentToolSchema {
  return object({
    pageId: string("Page identifier."),
    documentId: string("Document identifier."),
    revision: number("DOM revision."),
    snapshotId: string("Snapshot identifier."),
  }, ["pageId", "documentId", "revision", "snapshotId"]);
}

function snapshotOptions(): AgentToolSchema {
  return object({
    interactiveOnly: boolean("Only include interactive elements."),
    includeGeometry: boolean("Include element geometry."),
    includeText: boolean("Include element text."),
    maxNodes: number("Maximum nodes to include."),
  });
}

function snapshotWindowOptions(): AgentToolSchema {
  return object({
    interactiveOnly: boolean("Only include interactive elements."),
    includeGeometry: boolean("Include element geometry."),
    includeText: boolean("Include element text."),
    limit: number("Maximum nodes to return in this window."),
  });
}

function snapshotWindowCursor(): AgentToolSchema {
  return object({
    pageId: string("Page identifier."),
    documentId: string("Document identifier."),
    revision: number("DOM revision."),
    snapshotId: string("Window snapshot identifier."),
    offset: number("Zero-based node offset."),
    limit: number("Window size."),
  }, ["pageId", "documentId", "revision", "snapshotId", "offset", "limit"]);
}

function captureOptions(): AgentToolSchema {
  return object({
    format: string("Image format.", ["png", "jpeg", "webp"]),
    quality: number("Lossy image quality."),
    fullPage: boolean("Capture beyond the viewport."),
  });
}

function locatorSchema(): AgentToolSchema {
  return {
    oneOf: [
      object({ kind: string("Locator kind.", ["role"]), role: string("ARIA role."), name: string("Accessible name."), exact: boolean("Require an exact name.") }, ["kind", "role"]),
      object({ kind: string("Locator kind.", ["text", "label", "placeholder"]), text: string("Text to match."), exact: boolean("Require an exact match.") }, ["kind", "text"]),
      object({ kind: string("Locator kind.", ["testid", "css"]), value: string("Locator value.") }, ["kind", "value"]),
    ],
  };
}

function targetSchema(): AgentToolSchema {
  return {
    oneOf: [
      object({ ref: string("Snapshot reference.") }, ["ref"]),
      object({ locator: locatorSchema() }, ["locator"]),
    ],
  };
}

function elementStateSchema(): AgentToolSchema {
  return object({
    attached: boolean("Whether the target exists."),
    visible: boolean("Whether the target is visible."),
    enabled: boolean("Whether the target is enabled."),
    disabled: boolean("Whether the target is disabled."),
    focused: boolean("Whether the target has focus."),
    value: string("Target value."),
    checked: boolean("Checked state."),
    expanded: boolean("Expanded state."),
    invalid: boolean("Validity state."),
    pressed: boolean("Pressed state."),
    readOnly: boolean("Read-only state."),
    required: boolean("Required state."),
    selected: boolean("Selected state."),
    text: string("Target text."),
  });
}

function expectationSchema(): AgentToolSchema {
  return object({
    url: string("URL substring."),
    title: string("Title substring."),
    text: string("Page-wide text substring."),
    element: object({ target: targetSchema(), state: elementStateSchema() }, ["target"]),
    timeoutMs: number("Maximum verification duration."),
    quietMs: number("Required quiet duration."),
  });
}

function snapshotOutputSchema(): AgentToolSchema {
  return object({
    snapshot: string("Result snapshot mode.", ["full", "delta", "none"]),
    base: snapshotToken(),
  });
}

function actionSchema(): AgentToolSchema {
  return {
    oneOf: [
      object({ type: string("Action type.", ["click"]), target: targetSchema(), button: string("Mouse button.", ["left", "middle", "right"]), clickCount: number("Click count.") }, ["type", "target"]),
      object({ type: string("Action type.", ["fill"]), target: targetSchema(), value: string("Replacement value.") }, ["type", "target", "value"]),
      object({ type: string("Action type.", ["type"]), text: string("Text to type.") }, ["type", "text"]),
      object({ type: string("Action type.", ["press"]), key: string("Key or modified key, such as Ctrl+A.") }, ["type", "key"]),
      object({ type: string("Action type.", ["select"]), target: targetSchema(), values: { type: "array", items: string("Option value.") } }, ["type", "target", "values"]),
      object({ type: string("Action type.", ["check"]), target: targetSchema(), checked: boolean("Desired checked state.") }, ["type", "target", "checked"]),
      object({ type: string("Action type.", ["hover"]), target: targetSchema() }, ["type", "target"]),
      object({ type: string("Action type.", ["scroll"]), target: targetSchema(), direction: string("Scroll direction.", ["up", "down", "left", "right"]), amount: number("Scroll amount.") }, ["type", "direction"]),
      object({ type: string("Action type.", ["navigate"]), url: string("URL to navigate to.") }, ["type", "url"]),
      object({ type: string("Action type.", ["history"]), direction: string("History direction.", ["back", "forward"]) }, ["type", "direction"]),
      object({ type: string("Action type.", ["reload"]), bypassCache: boolean("Bypass the browser cache.") }, ["type"]),
    ],
  };
}

function waitConditionSchema(): AgentToolSchema {
  return {
    oneOf: [
      object({ type: string("Condition type.", ["time"]), ms: number("Duration in milliseconds.") }, ["type", "ms"]),
      object({ type: string("Condition type.", ["url"]), value: string("URL substring.") }, ["type", "value"]),
      object({ type: string("Condition type.", ["text"]), value: string("Text substring."), target: targetSchema() }, ["type", "value"]),
      object({ type: string("Condition type.", ["stable"]), quietMs: number("Quiet duration in milliseconds.") }, ["type", "quietMs"]),
      object({ type: string("Condition type.", ["element"]), target: targetSchema(), state: elementStateSchema() }, ["type", "target"]),
    ],
  };
}

function dialogActionSchema(): AgentToolSchema {
  return {
    oneOf: [
      object({ type: string("Dialog action.", ["accept"]), promptText: string("Prompt response.") }, ["type"]),
      object({ type: string("Dialog action.", ["dismiss"]) }, ["type"]),
    ],
  };
}

function toolArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgentError("INVALID_REQUEST", "agent tool arguments must be an object");
  }
  const fields = value as Record<string, unknown>;
  for (const reserved of ["kind", "protocol", "version", "requestId", "deadlineMs", "op"]) {
    if (Object.prototype.hasOwnProperty.call(fields, reserved)) {
      throw new AgentError("INVALID_REQUEST", `agent tool arguments cannot contain ${reserved}`);
    }
  }
  return fields;
}

function validateToolArguments(operation: AgentOperation, fields: Record<string, unknown>): void {
  parseAgentMessage({
    ...fields,
    kind: "request",
    protocol: AGENT_PROTOCOL,
    version: AGENT_PROTOCOL_VERSION,
    requestId: "agent-tool-validation",
    op: operation,
  } as AgentRequest);
}
