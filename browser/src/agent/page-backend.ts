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
  editable?: boolean;
  focused?: boolean;
  role?: string;
  name?: string;
  value?: string;
};
type ActiveElementInfo = {
  ok: boolean;
  editable?: boolean;
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
    switch (action.type) {
      case "click":
        return this.click(action, token, expect);
      case "fill":
        return this.fill(action, token, expect);
      case "type":
        return this.typeText(action.text, token, expect);
      case "press":
        return this.press(action.key, token, expect);
      default:
        throw new AgentError("INVALID_REQUEST", `live adapter does not support ${action.type} yet`);
    }
  }

  private async click(
    action: Extract<AgentAction, { type: "click" }>,
    token?: SnapshotToken,
    expect?: ActionExpectation,
  ): Promise<Omit<ActionResult, "snapshot">> {

    const before = await this.identity();
    const snapshot = await this.snapshot();
    this.assertToken(token, snapshot.documentId, snapshot.revision);
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
    this.invalidateSnapshots();
    const outcome = await this.waitForOutcome(before, expect);

    const after = outcome.identity;
    const effects = this.transitionEffects(before, after);

    const proof: ActionProof = {
      target: target.ref,
      role: inspection.role,
      name: inspection.name,
      value: inspection.value,
      url: after.url,
      title: after.title,
    };
    const verified = hasExpectation(expect) ? outcome.satisfied : outcome.changed;
    return { verified, effects, proof };
  }

  private async fill(
    action: Extract<AgentAction, { type: "fill" }>,
    token?: SnapshotToken,
    expect?: ActionExpectation,
  ): Promise<Omit<ActionResult, "snapshot">> {
    const before = await this.identity();
    const snapshot = await this.snapshot();
    this.assertToken(token, snapshot.documentId, snapshot.revision);
    const target = this.resolver.resolve(action.target, snapshot);
    const inspection = await this.inspect(target.ref);
    if (!inspection.ok || !inspection.visible || !inspection.enabled || !inspection.editable) {
      throw new AgentError("NOT_INTERACTABLE", "target is not an editable control", { retryable: true });
    }

    this.controller.focusContent();
    const value = await this.controller.runJs(fillScript(this.agentKey, target.ref, action.value));
    if (!isActiveElementInfo(value) || !value.ok || !value.editable || value.value !== action.value) {
      throw new AgentError("ACTION_UNVERIFIED", "control value did not match the requested fill", {
        retryable: true,
      });
    }
    this.invalidateSnapshots();
    const outcome = await this.waitForOutcome(before, expect);
    const after = outcome.identity;
    const effects = this.transitionEffects(before, after);
    effects.push({ type: "value.changed", data: { value: value.value } });
    const proof: ActionProof = {
      target: target.ref,
      role: value.role ?? inspection.role,
      name: value.name ?? inspection.name,
      value: value.value,
      url: after.url,
      title: after.title,
    };
    const verified = hasExpectation(expect) ? outcome.satisfied : true;
    return { verified, effects, proof };
  }

  private async typeText(
    text: string,
    token?: SnapshotToken,
    expect?: ActionExpectation,
  ): Promise<Omit<ActionResult, "snapshot">> {
    const before = await this.identity();
    this.assertToken(token, before.documentId, before.revision);
    const activeBefore = await this.activeElement();
    if (!activeBefore.ok || !activeBefore.editable) {
      throw new AgentError("NOT_INTERACTABLE", "the active element is not editable", { retryable: true });
    }

    this.controller.focusContent();
    await this.controller.cdp("Input.insertText", { text });
    this.invalidateSnapshots();
    const outcome = await this.waitForOutcome(before, expect);
    const activeAfter = await this.activeElement().catch(() => activeBefore);
    const after = outcome.identity;
    const effects = this.transitionEffects(before, after);
    effects.push({ type: "value.changed", data: { value: activeAfter.value ?? "" } });
    const proof: ActionProof = {
      role: activeAfter.role ?? activeBefore.role,
      name: activeAfter.name ?? activeBefore.name,
      value: activeAfter.value,
      url: after.url,
      title: after.title,
    };
    const verified = hasExpectation(expect)
      ? outcome.satisfied
      : text === "" || activeAfter.value !== activeBefore.value;
    return { verified, effects, proof };
  }

  private async press(
    rawKey: string,
    token?: SnapshotToken,
    expect?: ActionExpectation,
  ): Promise<Omit<ActionResult, "snapshot">> {
    const before = await this.identity();
    this.assertToken(token, before.documentId, before.revision);
    const key = parsePressKey(rawKey);
    this.controller.focusContent();
    const base = {
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.keyCode,
      nativeVirtualKeyCode: key.keyCode,
      modifiers: key.modifiers,
    };
    await this.controller.cdp("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      ...base,
      autoRepeat: false,
    });
    if (key.text && (key.modifiers & (MODIFIER_ALT | MODIFIER_CTRL | MODIFIER_META)) === 0) {
      await this.controller.cdp("Input.dispatchKeyEvent", { type: "char", text: key.text, ...base });
    }
    await this.controller.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    this.invalidateSnapshots();
    const outcome = await this.waitForOutcome(before, expect);
    const active = await this.activeElement().catch(() => ({ ok: false } as ActiveElementInfo));
    const after = outcome.identity;
    const effects = this.transitionEffects(before, after);
    const proof: ActionProof = {
      role: active.role,
      name: active.name,
      value: active.value,
      url: after.url,
      title: after.title,
    };
    return { verified: hasExpectation(expect) ? outcome.satisfied : true, effects, proof };
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

  private async activeElement(): Promise<ActiveElementInfo> {
    const value = await this.controller.runJs(activeElementScript());
    if (!isActiveElementInfo(value)) throw new AgentError("INTERNAL_ERROR", "active element returned an invalid shape");
    return value;
  }

  private assertToken(token: SnapshotToken | undefined, documentId: string, revision: number): void {
    if (!token) return;
    if (token.documentId !== documentId || token.revision !== revision) {
      throw new AgentError("STALE_SNAPSHOT", "snapshot is no longer current", { retryable: true });
    }
  }

  private invalidateSnapshots(): void {
    this.lastSnapshot = null;
    this.lastSnapshotOptions = null;
  }

  private transitionEffects(before: PageIdentity, after: PageIdentity): ActionEffect[] {
    const effects: ActionEffect[] = [];
    if (before.documentId !== after.documentId || before.url !== after.url) {
      effects.push({ type: "navigation", data: { url: after.url } });
      this.emit("navigation", { url: after.url, documentId: after.documentId });
    } else if (before.revision !== after.revision) {
      effects.push({ type: "dom.changed", data: { revision: after.revision } });
      this.emit("dom.changed", { revision: after.revision });
    }
    return effects;
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
      const invalidate = () => {
        state.revision += 1;
        state.refs = new Map();
        state.elementRefs = new WeakMap();
      };
      const observer = new MutationObserver(invalidate);
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      for (const event of ["input", "change", "focusin", "focusout"]) {
        document.addEventListener(event, invalidate, true);
      }
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
      const invalidate = () => {
        state.revision += 1;
        state.refs = new Map();
        state.elementRefs = new WeakMap();
      };
      const observer = new MutationObserver(invalidate);
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      for (const event of ["input", "change", "focusin", "focusout"]) {
        document.addEventListener(event, invalidate, true);
      }
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
      if (document.activeElement === el) value.focused = true;
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
      editable:
        el.isContentEditable ||
        el.tagName === "TEXTAREA" ||
        (el.tagName === "INPUT" && !["checkbox", "radio", "file", "button", "submit", "reset", "image"].includes(el.type)),
      focused: document.activeElement === el,
      role: el.getAttribute("role") || el.tagName.toLowerCase(),
      name: el.getAttribute("aria-label") || el.innerText || el.value || "",
      value: "value" in el && typeof el.value === "string" ? el.value : undefined,
    };
  })()`;
}

function fillScript(key: string, ref: string, value: string): string {
  return `(() => {
    const state = window[${JSON.stringify(key)}];
    const el = state && state.refs && state.refs.get(${JSON.stringify(ref)});
    if (!el || !el.isConnected) return { ok: false };
    const editable = el.isContentEditable || el.tagName === "TEXTAREA" ||
      (el.tagName === "INPUT" && !["checkbox", "radio", "file", "button", "submit", "reset", "image"].includes(el.type));
    const role = el.getAttribute("role") || el.tagName.toLowerCase();
    const name = el.getAttribute("aria-label") || (el.labels && el.labels.length ? Array.from(el.labels).map((label) => label.innerText).join(" ") : "") || el.getAttribute("placeholder") || el.name || "";
    if (!editable || el.disabled || el.getAttribute("aria-disabled") === "true") {
      return { ok: true, editable: false, role, name, value: "value" in el ? String(el.value ?? "") : String(el.innerText ?? "") };
    }
    el.focus();
    if (el.isContentEditable) {
      el.textContent = ${JSON.stringify(value)};
    } else {
      const prototype = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (!setter) return { ok: false, editable: true, role, name };
      setter.call(el, ${JSON.stringify(value)});
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ${JSON.stringify(value)} }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return {
      ok: true,
      editable: true,
      focused: document.activeElement === el,
      role,
      name,
      value: "value" in el ? String(el.value ?? "") : String(el.innerText ?? ""),
    };
  })()`;
}

function activeElementScript(): string {
  return `(() => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return { ok: false };
    const editable = el.isContentEditable || el.tagName === "TEXTAREA" ||
      (el.tagName === "INPUT" && !["checkbox", "radio", "file", "button", "submit", "reset", "image"].includes(el.type));
    return {
      ok: true,
      editable,
      role: el.getAttribute("role") || el.tagName.toLowerCase(),
      name: el.getAttribute("aria-label") || (el.labels && el.labels.length ? Array.from(el.labels).map((label) => label.innerText).join(" ") : "") || el.getAttribute("placeholder") || el.name || "",
      value: "value" in el ? String(el.value ?? "") : String(el.innerText ?? ""),
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

function isActiveElementInfo(value: unknown): value is ActiveElementInfo {
  return !!value && typeof value === "object" && typeof (value as Record<string, unknown>).ok === "boolean";
}

function hasExpectation(expect: ActionExpectation | undefined): boolean {
  return !!expect && (expect.url !== undefined || expect.title !== undefined || expect.text !== undefined);
}

const MODIFIER_ALT = 1;
const MODIFIER_CTRL = 2;
const MODIFIER_META = 4;
const MODIFIER_SHIFT = 8;

type PressKey = {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
  modifiers: number;
};

const NAMED_KEYS: Record<string, Omit<PressKey, "modifiers">> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
};

function parsePressKey(raw: string): PressKey {
  const parts = raw.split("+").map((part) => part.trim()).filter(Boolean);
  const base = parts.pop();
  if (!base) throw new AgentError("INVALID_REQUEST", "press key must be non-empty");
  let modifiers = 0;
  for (const modifier of parts) {
    switch (modifier.toLocaleLowerCase()) {
      case "alt":
        modifiers |= MODIFIER_ALT;
        break;
      case "ctrl":
      case "control":
        modifiers |= MODIFIER_CTRL;
        break;
      case "cmd":
      case "command":
      case "meta":
      case "super":
        modifiers |= MODIFIER_META;
        break;
      case "shift":
        modifiers |= MODIFIER_SHIFT;
        break;
      default:
        throw new AgentError("INVALID_REQUEST", `unsupported press modifier: ${modifier}`);
    }
  }
  const named = NAMED_KEYS[base.toLocaleLowerCase()];
  if (named) return { ...named, modifiers };
  if (base.length === 1) {
    const upper = base.toLocaleUpperCase();
    const code = /^[A-Z]$/.test(upper) ? `Key${upper}` : /^\d$/.test(base) ? `Digit${base}` : undefined;
    if (code) return { key: base, code, keyCode: upper.charCodeAt(0), text: base, modifiers };
  }
  throw new AgentError("INVALID_REQUEST", `unsupported press key: ${raw}`);
}
