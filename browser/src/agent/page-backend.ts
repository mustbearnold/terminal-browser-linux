import {
  AGENT_PROTOCOL,
  AGENT_PROTOCOL_VERSION,
  AgentError,
  SnapshotLocatorResolver,
  asDocumentId,
  asFrameId,
} from "terminal-browser-agent";
import type {
  ActionEffect,
  ActionExpectation,
  ActionResult,
  ActionProof,
  AgentAction,
  AgentEvent,
  PageBackend,
  PageId,
  PageIdentity,
  PageSnapshot,
  SnapshotOptions,
  SnapshotToken,
  WaitCondition,
  WaitResult,
} from "terminal-browser-agent";
import type { BrowserController } from "../page/controller";
import type { BrowserState } from "../page/types";

type CapturedSnapshot = Omit<PageSnapshot, "snapshotId">;
type PageScriptState = { documentId: string; revision: number };
type ElementInspection = {
  ok: boolean;
  x?: number;
  y?: number;
  visible?: boolean;
  enabled?: boolean;
  occluded?: boolean;
  role?: string;
  name?: string;
  value?: string;
};

const AGENT_STATE_KEY = "__terminalBrowserAgent";
const MAIN_FRAME_ID = asFrameId("main");

export class ElectronPageBackend implements PageBackend {
  private readonly resolver = new SnapshotLocatorResolver();
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly agentKey = AGENT_STATE_KEY;
  private sequence = 0;
  private lastSnapshot: CapturedSnapshot | null = null;
  private lastSnapshotOptions: string | null = null;

  constructor(
    readonly pageId: PageId,
    private readonly controller: BrowserController,
    private readonly state: () => BrowserState,
    private readonly active: () => boolean,
  ) {}

  async identity(): Promise<PageIdentity> {
    const page = this.state();
    const scriptState = await this.readScriptState();
    return {
      pageId: this.pageId,
      documentId: asDocumentId(scriptState.documentId),
      revision: scriptState.revision,
      url: page.url,
      title: page.title,
      active: this.active(),
      loading: page.loading,
    };
  }

  async snapshot(options?: SnapshotOptions): Promise<CapturedSnapshot> {
    const scriptState = await this.readScriptState();
    const optionsKey = snapshotOptionsKey(options);
    if (
      this.lastSnapshot &&
      this.lastSnapshotOptions === optionsKey &&
      this.lastSnapshot.documentId === asDocumentId(scriptState.documentId) &&
      this.lastSnapshot.revision === scriptState.revision
    ) {
      return this.lastSnapshot;
    }

    const value = await this.controller.runJs(snapshotScript(this.agentKey, options));
    if (!isSnapshot(value)) throw new AgentError("INTERNAL_ERROR", "page snapshot returned an invalid shape");
    const captured = {
      ...(value as CapturedSnapshot),
      pageId: this.pageId,
      rootFrameId: asFrameId(String((value as Record<string, unknown>).rootFrameId ?? "main")),
    };
    this.lastSnapshot = captured;
    this.lastSnapshotOptions = optionsKey;
    return captured;
  }

  async act(
    action: AgentAction,
    token?: SnapshotToken,
    expect?: ActionExpectation,
  ): Promise<Omit<ActionResult, "snapshot">> {
    if (action.type !== "click") {
      throw new AgentError("INVALID_REQUEST", `live adapter does not support ${action.type} yet`);
    }

    const before = await this.identity();
    const snapshot = await this.snapshot();
    if (token) {
      if (token.documentId !== snapshot.documentId || token.revision !== snapshot.revision) {
        throw new AgentError("STALE_SNAPSHOT", "snapshot is no longer current", { retryable: true });
      }
    }
    const target = this.resolver.resolve(action.target, snapshot);
    const inspection = await this.inspect(target.ref);
    if (!inspection.ok || !inspection.visible || !inspection.enabled || inspection.occluded) {
      throw new AgentError("NOT_INTERACTABLE", "target is not safely clickable", {
        retryable: true,
      });
    }

    this.controller.focusContent();
    const button = action.button ?? "left";
    const clickCount = action.clickCount ?? 1;
    await this.controller.cdp("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: inspection.x,
      y: inspection.y,
      button,
      clickCount,
    });
    await this.controller.cdp("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: inspection.x,
      y: inspection.y,
      button,
      clickCount,
    });
    const outcome = await this.waitForOutcome(before, expect);

    this.lastSnapshot = null;
    this.lastSnapshotOptions = null;
    const after = outcome.identity;
    const effects: ActionEffect[] = [];
    if (before.documentId !== after.documentId || before.url !== after.url) {
      effects.push({ type: "navigation", data: { url: after.url } });
      this.emit("navigation", { url: after.url, documentId: after.documentId });
    } else if (before.revision !== after.revision) {
      effects.push({ type: "dom.changed", data: { revision: after.revision } });
      this.emit("dom.changed", { revision: after.revision });
    }

    const proof: ActionProof = {
      target: target.ref,
      role: inspection.role,
      name: inspection.name,
      value: inspection.value,
      url: after.url,
      title: after.title,
    };
    const verified = expect ? outcome.satisfied : outcome.changed;
    return { verified, effects, proof };
  }

  async wait(condition: WaitCondition, timeoutMs = 10_000): Promise<Omit<WaitResult, "snapshot">> {
    const started = Date.now();
    const deadline = started + Math.max(0, timeoutMs);
    if (condition.type === "time") {
      await delay(Math.min(condition.ms, Math.max(0, deadline - Date.now())));
      return { satisfied: Date.now() <= deadline, elapsedMs: Date.now() - started };
    }

    let stableRevision: number | null = null;
    let stableSince = Date.now();
    while (Date.now() <= deadline) {
      const identity = await this.identity();
      let satisfied = false;
      if (condition.type === "url") satisfied = identity.url.includes(condition.value);
      if (condition.type === "text") {
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
      }
      if (condition.type === "stable") {
        if (stableRevision !== identity.revision) {
          stableRevision = identity.revision;
          stableSince = Date.now();
        }
        satisfied = Date.now() - stableSince >= condition.quietMs;
      }
      if (satisfied) return { satisfied: true, elapsedMs: Date.now() - started };
      await delay(Math.min(25, Math.max(1, deadline - Date.now())));
    }
    return { satisfied: false, elapsedMs: Date.now() - started };
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async readScriptState(): Promise<PageScriptState> {
    const value = await this.controller.runJs(scriptStateScript(this.agentKey));
    if (!isScriptState(value)) throw new AgentError("INTERNAL_ERROR", "page state returned an invalid shape");
    return value;
  }

  private async inspect(ref: string): Promise<ElementInspection> {
    const value = await this.controller.runJs(inspectScript(this.agentKey, ref));
    if (!isInspection(value)) throw new AgentError("INTERNAL_ERROR", "target inspection returned an invalid shape");
    return value;
  }

  private async waitForOutcome(
    before: PageIdentity,
    expect?: ActionExpectation,
  ): Promise<{ identity: PageIdentity; changed: boolean; satisfied: boolean }> {
    const hasExpectation = !!expect && (expect.url !== undefined || expect.title !== undefined || expect.text !== undefined);
    const timeoutMs = hasExpectation ? expect?.timeoutMs ?? 2_000 : 250;
    const deadline = Date.now() + Math.max(0, timeoutMs);
    let identity = before;
    let satisfied = false;
    let changed = false;
    do {
      try {
        identity = await this.identity();
        changed = identityChanged(before, identity);
        satisfied = hasExpectation ? await this.matchesExpectation(expect!, identity) : changed;
        if (satisfied || (changed && !identity.loading)) return { identity, changed, satisfied };
      } catch {}
      if (Date.now() >= deadline) break;
      await delay(Math.min(25, Math.max(1, deadline - Date.now())));
    } while (Date.now() <= deadline);
    return { identity, changed, satisfied };
  }

  private async matchesExpectation(expect: ActionExpectation, identity: PageIdentity): Promise<boolean> {
    if (expect.url !== undefined && !identity.url.includes(expect.url)) return false;
    if (expect.title !== undefined && !identity.title.includes(expect.title)) return false;
    if (expect.text !== undefined) {
      const snapshot = await this.snapshot({ interactiveOnly: false });
      if (
        !snapshot.nodes.some((node) =>
          `${node.name} ${node.text ?? ""}`.toLocaleLowerCase().includes(expect.text!.toLocaleLowerCase()),
        )
      ) {
        return false;
      }
    }
    return true;
  }

  private emit(event: AgentEvent["event"], data: AgentEvent["data"]): void {
    const message: AgentEvent = {
      kind: "event",
      protocol: AGENT_PROTOCOL,
      version: AGENT_PROTOCOL_VERSION,
      event,
      pageId: this.pageId,
      sequence: ++this.sequence,
      data,
    };
    for (const listener of this.listeners) listener(message);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function identityChanged(before: PageIdentity, after: PageIdentity): boolean {
  return (
    before.documentId !== after.documentId ||
    before.url !== after.url ||
    before.title !== after.title ||
    before.revision !== after.revision
  );
}

function snapshotOptionsKey(options?: SnapshotOptions): string {
  return JSON.stringify({
    interactiveOnly: options?.interactiveOnly ?? true,
    includeGeometry: options?.includeGeometry !== false,
    includeText: options?.includeText !== false,
    maxNodes: options?.maxNodes ?? 1000,
  });
}

function scriptStateScript(key: string): string {
  return `(() => {
    const key = ${JSON.stringify(key)};
    const documentId = String(performance.timeOrigin);
    let state = window[key];
    if (!state || state.documentId !== documentId) {
      state = {
        documentId,
        revision: 0,
        nextRef: 0,
        refs: new Map(),
        elementRefs: new WeakMap(),
        snapshotRevision: -1,
      };
      const observer = new MutationObserver(() => {
        state.revision += 1;
        state.refs = new Map();
        state.elementRefs = new WeakMap();
      });
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      window[key] = state;
    }
    return { documentId: state.documentId, revision: state.revision };
  })()`;
}

function snapshotScript(key: string, options: SnapshotOptions | undefined): string {
  return `(() => {
    const key = ${JSON.stringify(key)};
    const options = ${JSON.stringify(options ?? {})};
    const documentId = String(performance.timeOrigin);
    let state = window[key];
    if (!state || state.documentId !== documentId) {
      state = {
        documentId,
        revision: 0,
        nextRef: 0,
        refs: new Map(),
        elementRefs: new WeakMap(),
        snapshotRevision: -1,
      };
      const observer = new MutationObserver(() => {
        state.revision += 1;
        state.refs = new Map();
        state.elementRefs = new WeakMap();
      });
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      window[key] = state;
    }
    const maxNodes = Number.isFinite(options.maxNodes) ? Math.max(1, options.maxNodes) : 1000;
    const interactiveOnly = options.interactiveOnly ?? true;
    const includeGeometry = options.includeGeometry !== false;
    const includeText = options.includeText !== false;
    const nodes = [];
    let truncated = false;
    state.snapshotRevision = state.revision;

    const text = (value) => String(value ?? "").replace(/\\s+/g, " ").trim().slice(0, 240);
    const roleFor = (el) => {
      const explicit = el.getAttribute("role");
      if (explicit) return explicit;
      const tag = el.tagName;
      if (tag === "A" && el.hasAttribute("href")) return "link";
      if (tag === "BUTTON") return "button";
      if (tag === "SELECT") return "combobox";
      if (tag === "TEXTAREA") return "textbox";
      if (tag === "INPUT") return el.type === "checkbox" ? "checkbox" : el.type === "radio" ? "radio" : "textbox";
      if (tag === "IMG") return "img";
      if (tag === "NAV") return "navigation";
      if (tag === "MAIN") return "main";
      if (/^H[1-6]$/.test(tag)) return "heading";
      return "generic";
    };
    const nameFor = (el) => {
      const labelled = el.getAttribute("aria-label");
      if (labelled) return text(labelled);
      if (el.labels && el.labels.length) return text(Array.from(el.labels).map((label) => label.innerText).join(" "));
      if (el.alt) return text(el.alt);
      if (el.title) return text(el.title);
      return text(el.innerText || el.value || "");
    };
    const visibleFor = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && (rect.width > 0 || rect.height > 0);
    };
    const interactiveFor = (el, role) => el.matches("a[href],button,input,select,textarea,[tabindex],summary,[contenteditable=true]") || el.hasAttribute("role") || role === "heading";
    const focusableFor = (el) => el.tabIndex >= 0 || el.matches("a[href],button,input,select,textarea");
    const stateFor = (el) => {
      const value = {};
      if (el.disabled || el.getAttribute("aria-disabled") === "true") value.disabled = true;
      if ("checked" in el && typeof el.checked === "boolean") value.checked = el.checked;
      if ("selected" in el && typeof el.selected === "boolean") value.selected = el.selected;
      if (el.getAttribute("aria-expanded")) value.expanded = el.getAttribute("aria-expanded") === "true";
      if ("value" in el && typeof el.value === "string" && el.value) value.value = el.value.slice(0, 240);
      return Object.keys(value).length ? value : undefined;
    };
    const attrsFor = (el) => {
      const attrs = {};
      for (const name of ["data-testid", "aria-label", "placeholder", "title", "name", "label"]) {
        const value = el.getAttribute(name);
        if (value) attrs[name] = value;
      }
      return Object.keys(attrs).length ? attrs : undefined;
    };
    const visit = (el, parent) => {
      if (nodes.length >= maxNodes) { truncated = true; return; }
      const role = roleFor(el);
      const visible = visibleFor(el);
      const include = !interactiveOnly || interactiveFor(el, role);
      let nextParent = parent;
      if (include) {
        let ref = state.elementRefs.get(el);
        if (!ref) {
          ref = "r" + (++state.nextRef);
          state.elementRefs.set(el, ref);
        }
        state.refs.set(ref, el);
        const rect = el.getBoundingClientRect();
        nodes.push({
          ref,
          frameId: "main",
          parent,
          role,
          name: nameFor(el),
          ...(includeText ? { text: text(el.innerText || "") } : {}),
          state: stateFor(el),
          ...(includeGeometry ? { box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } } : {}),
          visible,
          enabled: !el.disabled && el.getAttribute("aria-disabled") !== "true",
          focusable: focusableFor(el),
          attributes: attrsFor(el),
        });
        nextParent = ref;
      }
      for (const child of el.children) visit(child, nextParent);
    };
    visit(document.body || document.documentElement, null);
    return {
      pageId: "",
      documentId: state.documentId,
      revision: state.revision,
      url: location.href,
      title: document.title,
      rootFrameId: "main",
      nodes,
      truncated,
    };
  })()`;
}

function inspectScript(key: string, ref: string): string {
  return `(() => {
    const state = window[${JSON.stringify(key)}];
    const el = state && state.refs && state.refs.get(${JSON.stringify(ref)});
    if (!el || !el.isConnected) return { ok: false };
    el.scrollIntoView({ block: "center", inline: "center" });
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    const style = getComputedStyle(el);
    return {
      ok: true,
      x,
      y,
      visible: style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0,
      enabled: !el.disabled && el.getAttribute("aria-disabled") !== "true",
      occluded: !!hit && hit !== el && !el.contains(hit),
      role: el.getAttribute("role") || el.tagName.toLowerCase(),
      name: el.getAttribute("aria-label") || el.innerText || el.value || "",
      value: "value" in el && typeof el.value === "string" ? el.value : undefined,
    };
  })()`;
}

function isScriptState(value: unknown): value is PageScriptState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return typeof state.documentId === "string" && typeof state.revision === "number";
}

function isSnapshot(value: unknown): value is CapturedSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Record<string, unknown>;
  return (
    typeof snapshot.documentId === "string" &&
    typeof snapshot.revision === "number" &&
    typeof snapshot.url === "string" &&
    typeof snapshot.title === "string" &&
    Array.isArray(snapshot.nodes)
  );
}

function isInspection(value: unknown): value is ElementInspection {
  return !!value && typeof value === "object" && typeof (value as Record<string, unknown>).ok === "boolean";
}
