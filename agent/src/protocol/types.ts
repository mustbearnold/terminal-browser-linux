export const AGENT_PROTOCOL = "terminal-browser.agent" as const;
export const AGENT_PROTOCOL_VERSION = 1 as const;
export const MAX_TARGET_INDEX = 255 as const;
export const MAX_LOCATOR_DEPTH = 8 as const;

type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type PageId = Brand<string, "PageId">;
export type FrameId = Brand<string, "FrameId">;
export type DocumentId = Brand<string, "DocumentId">;
export type SnapshotId = Brand<string, "SnapshotId">;
export type SnapshotRef = Brand<string, "SnapshotRef">;

export const asPageId = (value: string): PageId => value as PageId;
export const asFrameId = (value: string): FrameId => value as FrameId;
export const asDocumentId = (value: string): DocumentId => value as DocumentId;
export const asSnapshotId = (value: string): SnapshotId => value as SnapshotId;
export const asSnapshotRef = (value: string): SnapshotRef => value as SnapshotRef;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type AgentCapability =
  | "pages.list"
  | "pages.open"
  | "pages.activate"
  | "pages.close"
  | "snapshot.read"
  | "snapshot.window"
  | "page.frames"
  | "page.query"
  | "page.read"
  | "page.act"
  | "page.act.batch"
  | "page.act.status"
  | "page.act.click"
  | "page.act.fill"
  | "page.act.type"
  | "page.act.press"
  | "page.act.select"
  | "page.act.check"
  | "page.act.hover"
  | "page.act.scroll"
  | "page.act.navigate"
  | "page.act.reload"
  | "page.act.history"
  | "page.wait"
  | "page.observe"
  | "page.dialog"
  | "snapshot.delta"
  | "page.capture"
  | "unsafe.eval";

export interface PageRevision {
  pageId: PageId;
  documentId: DocumentId;
  revision: number;
}

export interface PageIdentity extends PageRevision {
  url: string;
  title: string;
  active: boolean;
  loading: boolean;
}

export interface PageFrame {
  frameId: FrameId;
  parentFrameId: FrameId | null;
  url: string;
  origin: string;
}

export type FrameLifecycleEventData =
  | { type: "attached"; frameId: FrameId; parentFrameId: FrameId | null }
  | { type: "navigated"; frame: PageFrame }
  | { type: "detached"; frameId: FrameId };

export interface PageFrameSnapshot {
  pageId: PageId;
  documentId: DocumentId;
  revision: number;
  frames: readonly PageFrame[];
}

export interface SnapshotOptions {
  interactiveOnly?: boolean;
  includeGeometry?: boolean;
  includeText?: boolean;
  maxNodes?: number;
}

export interface PageQueryOptions {
  includeHidden?: boolean;
  limit?: number;
}

export interface SnapshotWindowOptions {
  interactiveOnly?: boolean;
  includeGeometry?: boolean;
  includeText?: boolean;
  limit?: number;
}

export interface SnapshotNodeState {
  checked?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  focused?: boolean;
  invalid?: boolean;
  pressed?: boolean;
  readOnly?: boolean;
  required?: boolean;
  selected?: boolean;
  value?: string;
}

export interface SnapshotBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SnapshotNode {
  ref: SnapshotRef;
  nodeId?: string;
  frameId: FrameId;
  parent: SnapshotRef | null;
  role: string;
  name: string;
  text?: string;
  state?: SnapshotNodeState;
  box?: SnapshotBox;
  visible: boolean;
  enabled: boolean;
  focusable: boolean;
  attributes?: Record<string, string>;
}

export interface PageQueryResult extends SnapshotToken {
  locator: Locator;
  url: string;
  title: string;
  rootFrameId: FrameId;
  nodes: readonly SnapshotNode[];
  matchCount: number;
  hiddenNodes: readonly SnapshotNode[];
  hiddenMatchCount: number;
  truncated: boolean;
  hiddenTruncated: boolean;
}

export interface SnapshotToken extends PageRevision {
  snapshotId: SnapshotId;
}

export interface PageReadResult extends SnapshotToken {
  target: Target;
  url: string;
  title: string;
  node: SnapshotNode;
}

export interface SnapshotWindowCursor extends SnapshotToken {
  offset: number;
  limit: number;
}

export interface PageSnapshot extends SnapshotToken {
  url: string;
  title: string;
  rootFrameId: FrameId;
  nodes: readonly SnapshotNode[];
  truncated: boolean;
}

export interface PageSnapshotWindow extends SnapshotToken {
  url: string;
  title: string;
  rootFrameId: FrameId;
  offset: number;
  limit: number;
  totalNodes: number;
  nodes: readonly SnapshotNode[];
  truncated: boolean;
  done: boolean;
  nextCursor?: SnapshotWindowCursor;
}

export interface SnapshotDeltaNode {
  key: string;
  node: SnapshotNode;
}

export interface SnapshotReference {
  key: string;
  ref: SnapshotRef;
  parent: SnapshotRef | null;
}

export interface PageSnapshotDelta extends SnapshotToken {
  base: SnapshotToken;
  mode: "incremental" | "full";
  url: string;
  title: string;
  rootFrameId: FrameId;
  added: readonly SnapshotDeltaNode[];
  updated: readonly SnapshotDeltaNode[];
  removed: readonly string[];
  references: readonly SnapshotReference[];
  truncated: boolean;
  reset: boolean;
}

export type CaptureFormat = "png" | "jpeg" | "webp";

export interface CaptureOptions {
  format?: CaptureFormat;
  quality?: number;
  fullPage?: boolean;
}

export interface PageCapture {
  pageId: PageId;
  documentId: DocumentId;
  revision: number;
  format: CaptureFormat;
  data: string;
}

export type DialogAction =
  | { type: "accept"; promptText?: string }
  | { type: "dismiss" };

export interface PageDialogResult {
  pageId: PageId;
  dialogId: string;
  dialogType: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  url: string;
  defaultPrompt?: string;
  handled: "accepted" | "dismissed";
  promptText?: string;
}

export type Locator =
  | { kind: "role"; role: string; name?: string; exact?: boolean; within?: Locator }
  | { kind: "text"; text: string; exact?: boolean; within?: Locator }
  | { kind: "label"; text: string; exact?: boolean; within?: Locator }
  | { kind: "placeholder"; text: string; exact?: boolean; within?: Locator }
  | { kind: "testid"; value: string; within?: Locator }
  | { kind: "css"; value: string; within?: Locator };

export type Target =
  | { ref: SnapshotRef }
  | { locator: Locator; index?: number; frameId?: FrameId };

export type AgentAction =
  | { type: "click"; target: Target; button?: "left" | "middle" | "right"; clickCount?: number }
  | { type: "fill"; target: Target; value: string }
  | { type: "type"; text: string; target?: Target }
  | { type: "press"; key: string; target?: Target }
  | { type: "select"; target: Target; values: readonly string[] }
  | { type: "check"; target: Target; checked: boolean }
  | { type: "hover"; target: Target }
  | {
      type: "scroll";
      target?: Target;
      direction: "up" | "down" | "left" | "right";
      amount?: number;
    }
  | { type: "navigate"; url: string }
  | { type: "history"; direction: "back" | "forward" }
  | { type: "reload"; bypassCache?: boolean };

export interface ActionExpectation {
  url?: string;
  title?: string;
  text?: string;
  element?: {
    target: Target;
    state?: WaitElementState;
  };
  timeoutMs?: number;
  quietMs?: number;
}

export interface ActionBatchStep {
  action: AgentAction;
  token?: SnapshotToken;
  expect?: ActionExpectation;
}

export type ActionSnapshotMode = "full" | "delta" | "none";

export interface PageOutputOptions {
  snapshot?: ActionSnapshotMode;
  base?: SnapshotToken;
}

export interface ActionOutputOptions extends PageOutputOptions {}

export interface WaitOutputOptions extends PageOutputOptions {}

export interface ActionEffect {
  type: "navigation" | "dom.changed" | "focus.changed" | "value.changed" | "scroll.changed";
  data?: JsonValue;
}

export interface ActionProof extends PageRevision {
  target?: SnapshotRef;
  frameId?: FrameId;
  role?: string;
  name?: string;
  value?: string;
  url?: string;
  title?: string;
}

export interface ActionResult {
  verified: boolean;
  replayed?: boolean;
  effects: readonly ActionEffect[];
  proof?: ActionProof;
  snapshot?: PageSnapshot;
  snapshotDelta?: PageSnapshotDelta;
}

export type ActionBatchStepStatus = "completed" | "failed" | "skipped";

export interface ActionBatchStepResult {
  index: number;
  status: ActionBatchStepStatus;
  result?: ActionResult;
  error?: AgentErrorPayload;
}

export interface ActionBatchResult extends ActionResult {
  pageId: PageId;
  completed: number;
  steps: readonly ActionBatchStepResult[];
  failedAt?: number;
}

export type ActionStatus = "missing" | "running" | "completed" | "unknown";

export interface ActionStatusResult {
  pageId: PageId;
  idempotencyKey: string;
  status: ActionStatus;
  result?: ActionResult;
}

export type WaitCondition =
  | { type: "time"; ms: number }
  | { type: "url"; value: string }
  | { type: "text"; value: string; target?: Target }
  | { type: "stable"; quietMs: number }
  | { type: "element"; target: Target; state?: WaitElementState };

export interface WaitElementState {
  attached?: boolean;
  visible?: boolean;
  enabled?: boolean;
  disabled?: boolean;
  focused?: boolean;
  value?: string;
  checked?: boolean;
  expanded?: boolean;
  invalid?: boolean;
  pressed?: boolean;
  readOnly?: boolean;
  required?: boolean;
  selected?: boolean;
  text?: string;
}

export interface WaitResult {
  satisfied: boolean;
  elapsedMs: number;
  snapshot?: PageSnapshot;
  snapshotDelta?: PageSnapshotDelta;
}

export interface AgentRequestEnvelope {
  kind: "request";
  protocol: typeof AGENT_PROTOCOL;
  version: typeof AGENT_PROTOCOL_VERSION;
  requestId: string;
  deadlineMs?: number;
}

export type AgentRequest =
  | (AgentRequestEnvelope & {
      op: "hello";
      clientId: string;
      capabilities?: readonly AgentCapability[];
    })
  | (AgentRequestEnvelope & { op: "request.cancel"; targetRequestId: string })
  | (AgentRequestEnvelope & { op: "pages.list" })
  | (AgentRequestEnvelope & { op: "pages.open"; url: string })
  | (AgentRequestEnvelope & { op: "pages.activate"; pageId: PageId })
  | (AgentRequestEnvelope & { op: "pages.close"; pageId: PageId })
  | (AgentRequestEnvelope & { op: "page.frames"; pageId: PageId })
  | (AgentRequestEnvelope & {
      op: "page.query";
      pageId: PageId;
      locator: Locator;
      options?: PageQueryOptions;
    })
  | (AgentRequestEnvelope & { op: "page.snapshot"; pageId: PageId; options?: SnapshotOptions })
  | (AgentRequestEnvelope & {
      op: "page.snapshot.window";
      pageId: PageId;
      options?: SnapshotWindowOptions;
      cursor?: SnapshotWindowCursor;
    })
  | (AgentRequestEnvelope & {
      op: "page.snapshot.delta";
      pageId: PageId;
      base: SnapshotToken;
      options?: SnapshotOptions;
    })
  | (AgentRequestEnvelope & { op: "page.capture"; pageId: PageId; options?: CaptureOptions })
  | (AgentRequestEnvelope & { op: "page.read"; pageId: PageId; target: Target; token?: SnapshotToken })
  | (AgentRequestEnvelope & {
      op: "page.act";
      pageId: PageId;
      action: AgentAction;
      token?: SnapshotToken;
      expect?: ActionExpectation;
      output?: ActionOutputOptions;
      idempotencyKey?: string;
    })
  | (AgentRequestEnvelope & {
      op: "page.act.batch";
      pageId: PageId;
      steps: readonly ActionBatchStep[];
      output?: ActionOutputOptions;
      idempotencyKey?: string;
    })
  | (AgentRequestEnvelope & {
      op: "page.act.status";
      pageId: PageId;
      idempotencyKey: string;
    })
  | (AgentRequestEnvelope & {
      op: "page.wait";
      pageId: PageId;
      condition: WaitCondition;
      timeoutMs?: number;
      output?: WaitOutputOptions;
    })
  | (AgentRequestEnvelope & {
      op: "page.observe";
      pageId: PageId;
      events: readonly AgentEventType[];
      afterSequence?: number;
    })
  | (AgentRequestEnvelope & {
      op: "page.dialog";
      pageId: PageId;
      dialogId: string;
      action: DialogAction;
    });

export interface PageObserveResult {
  pageId: PageId;
  events: readonly AgentEventType[];
  afterSequence?: number;
  sequence: number;
  replayed: number;
}

export interface AgentResponse {
  kind: "response";
  protocol: typeof AGENT_PROTOCOL;
  version: typeof AGENT_PROTOCOL_VERSION;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: AgentErrorPayload;
}

export type AgentEventType =
  | "navigation"
  | "frame.lifecycle"
  | "load"
  | "dom.changed"
  | "console"
  | "page.error"
  | "download"
  | "dialog";

export interface AgentEvent {
  kind: "event";
  protocol: typeof AGENT_PROTOCOL;
  version: typeof AGENT_PROTOCOL_VERSION;
  event: AgentEventType;
  pageId: PageId;
  sequence: number;
  data?: JsonValue;
}

export interface AgentErrorPayload {
  code: string;
  message: string;
  retryable?: boolean;
  details?: JsonValue;
}

export type AgentMessage = AgentRequest | AgentResponse | AgentEvent;
