import { AgentEventBus } from "../core/events";
import type { EventSubscriptionOptions } from "../core/events";
import { abortableDelay, throwIfAborted } from "../core/cancellation";
import { matchesSnapshotNodeText, matchesWaitElementState } from "../core/element-state";
import { SnapshotLocatorResolver } from "../core/locator";
import { RevisionedPageSession, type PageBackend, type PageSession } from "../core/page";
import type { AgentRuntime } from "../core/runtime";
import { RevisionLedger } from "../core/revisions";
import { AgentError } from "../protocol/errors";
import {
  AGENT_PROTOCOL,
  AGENT_PROTOCOL_VERSION,
  asDocumentId,
  asFrameId,
  asPageId,
  asSnapshotRef,
  type ActionExpectation,
  type ActionResult,
  type AgentAction,
  type AgentCapability,
  type AgentEvent,
  type PageFrame,
  type PageFrameSnapshot,
  type PageIdentity,
  type PageId,
  type PageSnapshot,
  type SnapshotOptions,
  type SnapshotToken,
  type WaitCondition,
  type WaitResult,
} from "../protocol/types";

export const FIXTURE_PAGE_ID = asPageId("fixture/tab/1");
export const FIXTURE_URL = "fixture://agent-control";
export const FIXTURE_PREVIOUS_URL = "fixture://agent-control/previous";

const DOCUMENT_ID = asDocumentId("fixture-document-1");
const FRAME_ID = asFrameId("main");
const HISTORY_URLS = [FIXTURE_PREVIOUS_URL, FIXTURE_URL] as const;

export class FixtureRuntime implements AgentRuntime {
  private readonly backend = new FixturePageBackend(FIXTURE_PAGE_ID);
  private readonly session: PageSession = new RevisionedPageSession(this.backend, new RevisionLedger());
  private closed = false;

  capabilities(): readonly AgentCapability[] {
    return [
      "pages.list",
      "pages.open",
      "pages.activate",
      "pages.close",
      "snapshot.read",
      "snapshot.delta",
      "page.frames",
      "page.read",
      "page.act",
      "page.act.click",
      "page.act.fill",
      "page.act.type",
      "page.act.press",
      "page.act.reload",
      "page.act.history",
      "page.wait",
      "page.observe",
    ];
  }

  async listPages(): Promise<readonly PageIdentity[]> {
    return this.closed ? [] : [await this.backend.identity()];
  }

  getPage(pageId: PageId): PageSession | undefined {
    return !this.closed && pageId === FIXTURE_PAGE_ID ? this.session : undefined;
  }

  async openPage(url: string): Promise<PageIdentity> {
    if (url !== FIXTURE_URL) throw new AgentError("INVALID_REQUEST", `fixture only accepts ${FIXTURE_URL}`);
    this.closed = false;
    return this.backend.identity();
  }

  async activatePage(pageId: PageId): Promise<PageIdentity> {
    if (pageId !== FIXTURE_PAGE_ID || this.closed) {
      throw new AgentError("PAGE_NOT_FOUND", `unknown page: ${pageId}`);
    }
    return this.backend.identity();
  }

  async closePage(pageId: PageId): Promise<void> {
    if (pageId !== FIXTURE_PAGE_ID || this.closed) {
      throw new AgentError("PAGE_NOT_FOUND", `unknown page: ${pageId}`);
    }
    this.closed = true;
  }
}

class FixturePageBackend implements PageBackend {
  readonly pageId: PageId;
  private readonly resolver = new SnapshotLocatorResolver();
  private readonly events = new AgentEventBus();
  private revision = 0;
  private documentId = DOCUMENT_ID;
  private documentSequence = 1;
  private historyIndex = HISTORY_URLS.length - 1;
  private nextSequence = 0;
  private ready = false;
  private value = "";
  private focused = false;

  constructor(pageId: PageId) {
    this.pageId = pageId;
  }

  async identity(signal?: AbortSignal): Promise<PageIdentity> {
    throwIfAborted(signal);
    const url = HISTORY_URLS[this.historyIndex];
    return {
      pageId: this.pageId,
      documentId: this.documentId,
      revision: this.revision,
      url,
      title: "Agent control fixture",
      active: true,
      loading: false,
    };
  }

  async frames(signal?: AbortSignal): Promise<PageFrameSnapshot> {
    throwIfAborted(signal);
    const identity = await this.identity(signal);
    return {
      pageId: this.pageId,
      documentId: identity.documentId,
      revision: identity.revision,
      frames: [{
        frameId: FRAME_ID,
        parentFrameId: null,
        url: identity.url,
        origin: FIXTURE_URL,
      }],
    };
  }

  async snapshot(options?: SnapshotOptions, signal?: AbortSignal): Promise<Omit<PageSnapshot, "snapshotId">> {
    throwIfAborted(signal);
    const includeText = options?.includeText !== false;
    const includeGeometry = options?.includeGeometry !== false;
    const interactiveOnly = options?.interactiveOnly ?? true;
    const maxNodes = options?.maxNodes ?? 1000;
    const url = HISTORY_URLS[this.historyIndex];
    const allNodes = [
      {
        ref: asSnapshotRef("r1"),
        nodeId: "n1",
        frameId: FRAME_ID,
        parent: null,
        role: "button",
        name: "Continue",
        ...(includeText ? { text: "Continue" } : {}),
        ...(includeGeometry ? { box: { x: 12, y: 12, width: 96, height: 32 } } : {}),
        visible: true,
        enabled: true,
        focusable: true,
      },
      {
        ref: asSnapshotRef("r2"),
        nodeId: "n2",
        frameId: FRAME_ID,
        parent: null,
        role: "textbox",
        name: "Name",
        ...(includeText ? { text: this.value } : {}),
        state: { value: this.value, focused: this.focused },
        ...(includeGeometry ? { box: { x: 12, y: 56, width: 180, height: 32 } } : {}),
        visible: true,
        enabled: true,
        focusable: true,
        attributes: { placeholder: "Your name", "data-testid": "name-input" },
      },
      {
        ref: asSnapshotRef("r3"),
        nodeId: "n3",
        frameId: FRAME_ID,
        parent: null,
        role: "generic",
        name: "Fixture content",
        ...(includeText ? { text: "Fixture content" } : {}),
        ...(includeGeometry ? { box: { x: 12, y: 100, width: 180, height: 24 } } : {}),
        visible: this.ready,
        enabled: true,
        focusable: false,
      },
      ...(this.ready
        ? [
            {
              ref: asSnapshotRef("r4"),
              nodeId: "n4",
              frameId: FRAME_ID,
              parent: null,
              role: "status",
              name: "Ready",
              ...(includeText ? { text: "Ready" } : {}),
              ...(includeGeometry ? { box: { x: 12, y: 132, width: 96, height: 24 } } : {}),
              visible: true,
              enabled: true,
              focusable: false,
            },
          ]
        : []),
    ];
    const visibleNodes = interactiveOnly ? allNodes.filter((node) => node.role !== "generic") : allNodes;
    const nodes = visibleNodes.slice(0, Math.max(1, maxNodes));
    return {
      pageId: this.pageId,
      documentId: this.documentId,
      revision: this.revision,
      url,
      title: "Agent control fixture",
      rootFrameId: FRAME_ID,
      nodes,
      truncated: nodes.length < visibleNodes.length,
    };
  }

  async act(
    action: AgentAction,
    token?: SnapshotToken,
    expect?: ActionExpectation,
    signal?: AbortSignal,
  ): Promise<Omit<ActionResult, "snapshot">> {
    switch (action.type) {
      case "click":
        return this.click(action, token, expect, signal);
      case "fill":
        return this.fill(action, token, expect, signal);
      case "type":
        return this.typeText(action.text, token, expect, signal);
      case "press":
        return this.press(action.key, token, expect, signal);
      case "reload":
        return this.reload(action, token, expect, signal);
      case "history":
        return this.history(action, token, expect, signal);
      default:
        throw new AgentError("INVALID_REQUEST", `fixture does not support ${action.type}`);
    }
  }

  private async click(
    action: Extract<AgentAction, { type: "click" }>,
    token?: SnapshotToken,
    expect?: ActionExpectation,
    signal?: AbortSignal,
  ): Promise<Omit<ActionResult, "snapshot">> {
    const snapshot = await this.actionSnapshot(token, signal);
    const target = this.resolver.resolve(action.target, snapshot);
    if (target.node.role !== "button" || target.node.name !== "Continue") {
      throw new AgentError("NOT_INTERACTABLE", "fixture target is not clickable", { retryable: true });
    }
    throwIfAborted(signal);
    this.ready = true;
    this.revision += 1;
    const identity = await this.identity(signal);
    this.emitChanged();
    return {
      verified: await this.matches(expect, identity, signal),
      effects: [{ type: "dom.changed", data: { revision: this.revision } }],
      proof: {
        target: target.ref,
        role: target.node.role,
        name: target.node.name,
        url: identity.url,
        title: identity.title,
      },
    };
  }

  private async fill(
    action: Extract<AgentAction, { type: "fill" }>,
    token?: SnapshotToken,
    expect?: ActionExpectation,
    signal?: AbortSignal,
  ): Promise<Omit<ActionResult, "snapshot">> {
    const snapshot = await this.actionSnapshot(token, signal);
    const target = this.resolver.resolve(action.target, snapshot);
    if (target.node.role !== "textbox") {
      throw new AgentError("NOT_INTERACTABLE", "fixture target is not editable", { retryable: true });
    }
    throwIfAborted(signal);
    this.value = action.value;
    this.focused = true;
    this.revision += 1;
    const identity = await this.identity(signal);
    this.emitChanged();
    return {
      verified: await this.matches(expect, identity, signal),
      effects: [
        { type: "dom.changed", data: { revision: this.revision } },
        { type: "value.changed", data: { value: this.value } },
      ],
      proof: {
        target: target.ref,
        role: target.node.role,
        name: target.node.name,
        value: this.value,
        url: identity.url,
        title: identity.title,
      },
    };
  }

  private async typeText(
    text: string,
    token?: SnapshotToken,
    expect?: ActionExpectation,
    signal?: AbortSignal,
  ): Promise<Omit<ActionResult, "snapshot">> {
    await this.actionSnapshot(token, signal);
    throwIfAborted(signal);
    if (!this.focused) throw new AgentError("NOT_INTERACTABLE", "fixture has no focused editable control", { retryable: true });
    this.value += text;
    this.revision += 1;
    const identity = await this.identity(signal);
    this.emitChanged();
    return {
      verified: await this.matches(expect, identity, signal),
      effects: [
        { type: "dom.changed", data: { revision: this.revision } },
        { type: "value.changed", data: { value: this.value } },
      ],
      proof: {
        role: "textbox",
        name: "Name",
        value: this.value,
        url: identity.url,
        title: identity.title,
      },
    };
  }

  private async press(
    key: string,
    token?: SnapshotToken,
    expect?: ActionExpectation,
    signal?: AbortSignal,
  ): Promise<Omit<ActionResult, "snapshot">> {
    await this.actionSnapshot(token, signal);
    throwIfAborted(signal);
    if (!this.focused) throw new AgentError("NOT_INTERACTABLE", "fixture has no focused control", { retryable: true });
    if (key.toLocaleLowerCase() === "enter") this.ready = true;
    this.revision += 1;
    const identity = await this.identity(signal);
    this.emitChanged();
    return {
      verified: await this.matches(expect, identity, signal),
      effects: [{ type: "dom.changed", data: { revision: this.revision } }],
      proof: {
        role: "textbox",
        name: "Name",
        value: this.value,
        url: identity.url,
        title: identity.title,
      },
    };
  }

  private async reload(
    _action: Extract<AgentAction, { type: "reload" }>,
    token?: SnapshotToken,
    expect?: ActionExpectation,
    signal?: AbortSignal,
  ): Promise<Omit<ActionResult, "snapshot">> {
    await this.actionSnapshot(token, signal);
    throwIfAborted(signal);
    this.documentId = asDocumentId(`fixture-document-${++this.documentSequence}`);
    this.revision = 0;
    this.ready = false;
    this.value = "";
    this.focused = false;
    const identity = await this.identity(signal);
    this.events.publish(this.event("navigation", { url: identity.url, inPage: false }));
    return {
      verified: await this.matches(expect, identity, signal),
      effects: [{ type: "navigation", data: { url: identity.url } }],
      proof: { url: identity.url, title: identity.title },
    };
  }

  private async history(
    action: Extract<AgentAction, { type: "history" }>,
    token?: SnapshotToken,
    expect?: ActionExpectation,
    signal?: AbortSignal,
  ): Promise<Omit<ActionResult, "snapshot">> {
    await this.actionSnapshot(token, signal);
    throwIfAborted(signal);
    const nextIndex = this.historyIndex + (action.direction === "back" ? -1 : 1);
    if (nextIndex < 0 || nextIndex >= HISTORY_URLS.length) {
      throw new AgentError("HISTORY_UNAVAILABLE", `cannot go ${action.direction} from the current page`, {
        details: { direction: action.direction },
      });
    }
    this.historyIndex = nextIndex;
    this.documentId = asDocumentId(`fixture-document-${++this.documentSequence}`);
    this.revision = 0;
    this.ready = false;
    this.value = "";
    this.focused = false;
    const identity = await this.identity(signal);
    this.events.publish(this.event("navigation", { url: identity.url, inPage: false }));
    return {
      verified: await this.matches(expect, identity, signal),
      effects: [{ type: "navigation", data: { url: identity.url } }],
      proof: { url: identity.url, title: identity.title },
    };
  }

  private async actionSnapshot(token?: SnapshotToken, signal?: AbortSignal): Promise<Omit<PageSnapshot, "snapshotId">> {
    const snapshot = await this.snapshot({ interactiveOnly: false }, signal);
    throwIfAborted(signal);
    if (token && (token.documentId !== snapshot.documentId || token.revision !== snapshot.revision)) {
      throw new AgentError("STALE_SNAPSHOT", "snapshot is no longer current", { retryable: true });
    }
    return snapshot;
  }

  private emitChanged(): void {
    this.events.publish(this.event("dom.changed", { revision: this.revision }));
  }

  async wait(condition: WaitCondition, timeoutMs = 1000, signal?: AbortSignal): Promise<Omit<WaitResult, "snapshot">> {
    const started = Date.now();
    const deadline = started + Math.max(0, timeoutMs);
    let stableRevision: number | null = null;
    let stableSince = started;
    while (Date.now() <= deadline) {
      const identity = await this.identity(signal);
      throwIfAborted(signal);
      let satisfied = false;
      if (condition.type === "time") {
        const duration = Math.max(0, Math.min(condition.ms, deadline - Date.now()));
        await abortableDelay(duration, signal);
        satisfied = Date.now() - started >= condition.ms;
      } else if (condition.type === "url") {
        satisfied = identity.url.includes(condition.value);
      } else if (condition.type === "text") {
        const snapshot = await this.snapshot({ interactiveOnly: false }, signal);
        if (condition.target) {
          try {
            const target = this.resolver.resolve(condition.target, snapshot, { includeHidden: true });
            satisfied = matchesSnapshotNodeText(target.node, condition.value);
          } catch {}
        } else {
          satisfied = snapshot.nodes.some((node) =>
            matchesSnapshotNodeText(node, condition.value),
          );
        }
      } else if (condition.type === "element") {
        const snapshot = await this.snapshot({ interactiveOnly: false }, signal);
        try {
          const target = this.resolver.resolve(condition.target, snapshot, { includeHidden: true });
          satisfied = matchesWaitElementState(target.node, condition.state);
        } catch (error) {
          if (
            error instanceof AgentError &&
            error.code === "TARGET_NOT_FOUND" &&
            condition.state?.attached === false &&
            !snapshot.truncated
          ) satisfied = true;
          else if (!(error instanceof AgentError) || error.code !== "TARGET_NOT_FOUND") throw error;
        }
      } else {
        if (stableRevision !== identity.revision) {
          stableRevision = identity.revision;
          stableSince = Date.now();
        }
        satisfied = Date.now() - stableSince >= condition.quietMs;
      }
      if (satisfied) return { satisfied: true, elapsedMs: Date.now() - started };
      if (Date.now() >= deadline) break;
      await abortableDelay(Math.min(5, Math.max(1, deadline - Date.now())), signal);
    }
    return { satisfied: false, elapsedMs: Date.now() - started };
  }

  async subscribe(
    listener: (event: AgentEvent) => void,
    options?: EventSubscriptionOptions,
    signal?: AbortSignal,
  ) {
    throwIfAborted(signal);
    return this.events.subscribe(listener, options);
  }

  private async matches(expect: ActionExpectation | undefined, identity: PageIdentity, signal?: AbortSignal): Promise<boolean> {
    if (!expect) return true;
    if (expect.url !== undefined && !identity.url.includes(expect.url)) return false;
    if (expect.title !== undefined && !identity.title.includes(expect.title)) return false;
    if (expect.text !== undefined) {
      const snapshot = await this.snapshot({ interactiveOnly: false }, signal);
      if (!snapshot.nodes.some((node) => `${node.name} ${node.text ?? ""}`.includes(expect.text!))) return false;
    }
    if (expect.element !== undefined) {
      const snapshot = await this.snapshot({ interactiveOnly: false }, signal);
      try {
        const target = this.resolver.resolve(expect.element.target, snapshot, { includeHidden: true });
        if (!matchesWaitElementState(target.node, expect.element.state)) return false;
      } catch (error) {
        if (
          !(error instanceof AgentError) ||
          error.code !== "TARGET_NOT_FOUND" ||
          expect.element.state?.attached !== false ||
          snapshot.truncated
        ) return false;
      }
    }
    return true;
  }

  private event(event: AgentEvent["event"], data: AgentEvent["data"]): AgentEvent {
    return {
      kind: "event",
      protocol: AGENT_PROTOCOL,
      version: AGENT_PROTOCOL_VERSION,
      event,
      pageId: this.pageId,
      sequence: ++this.nextSequence,
      data,
    };
  }
}
