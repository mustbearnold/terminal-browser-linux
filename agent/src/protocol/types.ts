export const AGENT_PROTOCOL = "terminal-browser.agent" as const;
export const AGENT_PROTOCOL_VERSION = 1 as const;

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
  | "pages.close"
  | "snapshot.read"
  | "page.frames"
  | "page.read"
  | "page.act"
  | "page.act.click"
  | "page.act.fill"
  | "page.act.type"
  | "page.act.press"
  | "page.act.select"
  | "page.act.check"
  | "page.act.hover"
  | "page.act.scroll"
  | "page.act.navigate"
  | "page.wait"
  | "page.observe"
  | "page.capture"
  | "unsafe.eval";

export interface PageIdentity {
  pageId: PageId;
  documentId: DocumentId;
  revision: number;
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

export interface SnapshotNodeState {
  checked?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  focused?: boolean;
  pressed?: boolean;
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

export interface SnapshotToken {
  pageId: PageId;
  documentId: DocumentId;
  revision: number;
  snapshotId: SnapshotId;
}

export interface PageSnapshot extends SnapshotToken {
  url: string;
  title: string;
  rootFrameId: FrameId;
  nodes: readonly SnapshotNode[];
  truncated: boolean;
}

export type Locator =
  | { kind: "role"; role: string; name?: string; exact?: boolean }
  | { kind: "text"; text: string; exact?: boolean }
  | { kind: "label"; text: string; exact?: boolean }
  | { kind: "placeholder"; text: string; exact?: boolean }
  | { kind: "testid"; value: string }
  | { kind: "css"; value: string };

export type Target = { ref: SnapshotRef } | { locator: Locator };

export type AgentAction =
  | { type: "click"; target: Target; button?: "left" | "middle" | "right"; clickCount?: number }
  | { type: "fill"; target: Target; value: string }
  | { type: "type"; text: string }
  | { type: "press"; key: string }
  | { type: "select"; target: Target; values: readonly string[] }
  | { type: "check"; target: Target; checked: boolean }
  | { type: "hover"; target: Target }
  | {
      type: "scroll";
      target?: Target;
      direction: "up" | "down" | "left" | "right";
      amount?: number;
    }
  | { type: "navigate"; url: string };

export interface ActionExpectation {
  url?: string;
  title?: string;
  text?: string;
  timeoutMs?: number;
  quietMs?: number;
}

export interface ActionEffect {
  type: "navigation" | "dom.changed" | "focus.changed" | "value.changed" | "scroll.changed";
  data?: JsonValue;
}

export interface ActionProof {
  target?: SnapshotRef;
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
}

export type WaitCondition =
  | { type: "time"; ms: number }
  | { type: "url"; value: string }
  | { type: "text"; value: string; target?: Target }
  | { type: "stable"; quietMs: number };

export interface WaitResult {
  satisfied: boolean;
  elapsedMs: number;
  snapshot?: PageSnapshot;
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
  | (AgentRequestEnvelope & { op: "pages.close"; pageId: PageId })
  | (AgentRequestEnvelope & { op: "page.frames"; pageId: PageId })
  | (AgentRequestEnvelope & { op: "page.snapshot"; pageId: PageId; options?: SnapshotOptions })
  | (AgentRequestEnvelope & { op: "page.read"; pageId: PageId; target: Target; token?: SnapshotToken })
  | (AgentRequestEnvelope & {
      op: "page.act";
      pageId: PageId;
      action: AgentAction;
      token?: SnapshotToken;
      expect?: ActionExpectation;
      idempotencyKey?: string;
    })
  | (AgentRequestEnvelope & {
      op: "page.wait";
      pageId: PageId;
      condition: WaitCondition;
      timeoutMs?: number;
    })
  | (AgentRequestEnvelope & {
      op: "page.observe";
      pageId: PageId;
      events: readonly AgentEventType[];
      afterSequence?: number;
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
