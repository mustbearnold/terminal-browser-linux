import { AgentEventBus } from "../core/events";
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

const DOCUMENT_ID = asDocumentId("fixture-document-1");
const FRAME_ID = asFrameId("main");

export class FixtureRuntime implements AgentRuntime {
  private readonly backend = new FixturePageBackend(FIXTURE_PAGE_ID);
  private readonly session: PageSession = new RevisionedPageSession(this.backend, new RevisionLedger());
  private closed = false;

  capabilities(): readonly AgentCapability[] {
    return [
      "pages.list",
      "pages.open",
      "pages.close",
      "snapshot.read",
      "page.read",
      "page.act",
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
  private nextSequence = 0;
  private ready = false;

  constructor(pageId: PageId) {
    this.pageId = pageId;
  }

  async identity(): Promise<PageIdentity> {
    return {
      pageId: this.pageId,
      documentId: DOCUMENT_ID,
      revision: this.revision,
      url: FIXTURE_URL,
      title: "Agent control fixture",
      active: true,
      loading: false,
    };
  }

  async snapshot(options?: SnapshotOptions): Promise<Omit<PageSnapshot, "snapshotId">> {
    const includeText = options?.includeText !== false;
    const includeGeometry = options?.includeGeometry !== false;
    const interactiveOnly = options?.interactiveOnly ?? true;
    const maxNodes = options?.maxNodes ?? 1000;
    const allNodes = [
      {
        ref: asSnapshotRef("r1"),
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
        frameId: FRAME_ID,
        parent: null,
        role: "textbox",
        name: "Name",
        ...(includeText ? { text: "" } : {}),
        state: { value: "" },
        ...(includeGeometry ? { box: { x: 12, y: 56, width: 180, height: 32 } } : {}),
        visible: true,
        enabled: true,
        focusable: true,
        attributes: { placeholder: "Your name", "data-testid": "name-input" },
      },
      {
        ref: asSnapshotRef("r3"),
        frameId: FRAME_ID,
        parent: null,
        role: "generic",
        name: "Fixture content",
        ...(includeText ? { text: "Fixture content" } : {}),
        ...(includeGeometry ? { box: { x: 12, y: 100, width: 180, height: 24 } } : {}),
        visible: true,
        enabled: true,
        focusable: false,
      },
      ...(this.ready
        ? [
            {
              ref: asSnapshotRef("r4"),
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
      documentId: DOCUMENT_ID,
      revision: this.revision,
      url: FIXTURE_URL,
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
  ): Promise<Omit<ActionResult, "snapshot">> {
    if (action.type !== "click") throw new AgentError("INVALID_REQUEST", `fixture does not support ${action.type}`);
    const snapshot = await this.snapshot({ interactiveOnly: false });
    if (token && (token.documentId !== snapshot.documentId || token.revision !== snapshot.revision)) {
      throw new AgentError("STALE_SNAPSHOT", "snapshot is no longer current", { retryable: true });
    }
    const target = this.resolver.resolve(action.target, snapshot);
    if (target.node.role !== "button" || target.node.name !== "Continue") {
      throw new AgentError("NOT_INTERACTABLE", "fixture target is not clickable", { retryable: true });
    }
    this.ready = true;
    this.revision += 1;
    const identity = await this.identity();
    const event = this.event("dom.changed", { revision: this.revision });
    this.events.publish(event);
    return {
      verified: await this.matches(expect, identity),
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

  async wait(condition: WaitCondition, timeoutMs = 1000): Promise<Omit<WaitResult, "snapshot">> {
    const started = Date.now();
    const deadline = started + Math.max(0, timeoutMs);
    let stableRevision: number | null = null;
    let stableSince = started;
    while (Date.now() <= deadline) {
      const identity = await this.identity();
      let satisfied = false;
      if (condition.type === "time") {
        const duration = Math.max(0, Math.min(condition.ms, deadline - Date.now()));
        await delay(duration);
        satisfied = Date.now() - started >= condition.ms;
      } else if (condition.type === "url") {
        satisfied = identity.url.includes(condition.value);
      } else if (condition.type === "text") {
        const snapshot = await this.snapshot({ interactiveOnly: false });
        if (condition.target) {
          try {
            this.resolver.resolve(condition.target, snapshot);
            satisfied = true;
          } catch {}
        } else {
          satisfied = snapshot.nodes.some((node) =>
            `${node.name} ${node.text ?? ""}`.toLocaleLowerCase().includes(condition.value.toLocaleLowerCase()),
          );
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
      await delay(Math.min(5, Math.max(1, deadline - Date.now())));
    }
    return { satisfied: false, elapsedMs: Date.now() - started };
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    return this.events.subscribe(listener);
  }

  private async matches(expect: ActionExpectation | undefined, identity: PageIdentity): Promise<boolean> {
    if (!expect) return true;
    if (expect.url !== undefined && !identity.url.includes(expect.url)) return false;
    if (expect.title !== undefined && !identity.title.includes(expect.title)) return false;
    if (expect.text !== undefined) {
      const snapshot = await this.snapshot({ interactiveOnly: false });
      if (!snapshot.nodes.some((node) => `${node.name} ${node.text ?? ""}`.includes(expect.text!))) return false;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
