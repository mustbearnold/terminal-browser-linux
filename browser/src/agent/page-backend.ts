import {
  AGENT_PROTOCOL,
  AGENT_PROTOCOL_VERSION,
  AgentError,
  AgentEventBus,
  SnapshotLocatorResolver,
  abortableDelay,
  asDocumentId,
  asFrameId,
  throwIfAborted,
} from "terminal-browser-agent";
import type {
  ActionEffect,
  ActionExpectation,
  ActionResult,
  ActionProof,
  AgentAction,
  AgentEvent,
  EventSubscription,
  EventSubscriptionOptions,
  EventHistoryStore,
  PageBackend,
  PageFrame,
  PageFrameSnapshot,
  PageId,
  PageIdentity,
  PageSnapshot,
  SnapshotOptions,
  SnapshotToken,
  WaitCondition,
  WaitResult,
} from "terminal-browser-agent";
import type { BrowserAgentFrame, BrowserAgentFrameLifecycle, BrowserController } from "../page/controller";
import type { BrowserLifecycleEvent, BrowserState } from "../page/types";

type CapturedSnapshot = Omit<PageSnapshot, "snapshotId">;
type FrameSnapshot = {
  documentId: string;
  revision: number;
  url: string;
  title: string;
  nodes: CapturedSnapshot["nodes"];
  truncated: boolean;
};
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
  checked?: boolean;
  selected?: boolean;
};
type ClickResult = { ok: boolean };
type SelectResult = { ok: boolean; values?: string[] };
type CheckResult = { ok: boolean; checked?: boolean };
type ScrollResult = { ok: boolean; x?: number; y?: number; changed?: boolean };
type ActiveElementInfo = {
  ok: boolean;
  frameId?: string;
  editable?: boolean;
  role?: string;
  name?: string;
  value?: string;
};

const AGENT_STATE_KEY = "__terminalBrowserAgent";
const AGENT_EVENT_CHANNEL = "terminal-browser.agent";
const MAIN_FRAME_ID = asFrameId("main");

export class ElectronPageBackend implements PageBackend {
  private readonly resolver = new SnapshotLocatorResolver();
  private readonly events: AgentEventBus;
  private readonly agentKey = AGENT_STATE_KEY;
  private sequence = 0;
  private remoteRevision = 0;
  private lastSnapshot: CapturedSnapshot | null = null;
  private lastSnapshotOptions: string | null = null;
  private observationReady: Promise<void> | null = null;
  private mainBrowserFrameId: string | null = null;

  constructor(
    readonly pageId: PageId,
    private readonly controller: BrowserController,
    private readonly state: () => BrowserState,
    private readonly active: () => boolean,
    eventHistory?: EventHistoryStore,
  ) {
    this.events = new AgentEventBus(256, eventHistory);
    this.sequence = this.events.latestSequence;
    this.controller.onEmit(AGENT_EVENT_CHANNEL, (data) => this.handlePageEvent(data));
    this.controller.onLifecycleEvent = (event) => this.handleLifecycleEvent(event);
    this.controller.onFrameLifecycle = (event) => this.handleFrameLifecycle(event);
  }

  async identity(signal?: AbortSignal): Promise<PageIdentity> {
    throwIfAborted(signal);
    const page = this.state();
    const scriptState = await this.readScriptState(signal);
    throwIfAborted(signal);
    return {
      pageId: this.pageId,
      documentId: asDocumentId(scriptState.documentId),
      revision: this.effectiveRevision(scriptState),
      url: page.url,
      title: page.title,
      active: this.active(),
      loading: page.loading,
    };
  }

  async frames(signal?: AbortSignal): Promise<PageFrameSnapshot> {
    throwIfAborted(signal);
    const before = await this.identity(signal);
    const browserFrames = await this.controller.agentFrames();
    throwIfAborted(signal);
    const after = await this.identity(signal);
    if (before.documentId !== after.documentId || before.revision !== after.revision) {
      throw new AgentError("STALE_SNAPSHOT", "frame tree changed while it was being read", { retryable: true });
    }
    const mainFrame = browserFrames.find((frame) => frame.parentId === null);
    if (!mainFrame) throw new AgentError("INTERNAL_ERROR", "browser frame tree has no main frame");
    this.mainBrowserFrameId = mainFrame.id;
    return {
      pageId: this.pageId,
      documentId: after.documentId,
      revision: after.revision,
      frames: browserFrames.map((frame) => ({
        frameId: this.protocolFrameId(frame.id, frame.parentId),
        parentFrameId: frame.parentId === null ? null : this.protocolFrameId(frame.parentId),
        url: frame.url,
        origin: frame.origin,
      })),
    };
  }

  async snapshot(options?: SnapshotOptions, signal?: AbortSignal): Promise<CapturedSnapshot> {
    throwIfAborted(signal);
    const scriptState = await this.readScriptState(signal);
    const revision = this.effectiveRevision(scriptState);
    const optionsKey = snapshotOptionsKey(options);
    if (
      this.lastSnapshot &&
      this.lastSnapshotOptions === optionsKey &&
      this.lastSnapshot.documentId === asDocumentId(scriptState.documentId) &&
      this.lastSnapshot.revision === revision
    ) {
      throwIfAborted(signal);
      return this.lastSnapshot;
    }

    throwIfAborted(signal);
    const frames = await this.controller.agentFrames();
    throwIfAborted(signal);
    const mainFrame = frames.find((frame) => frame.parentId === null);
    if (!mainFrame) throw new AgentError("INTERNAL_ERROR", "browser frame tree has no main frame");
    this.mainBrowserFrameId = mainFrame.id;
    const offsets = await this.frameOffsets(frames, signal);
    const captures = await Promise.all(
      frames.map((frame) => this.captureFrame(frame, options, signal)),
    );
    throwIfAborted(signal);
    const mainCapture = captures.find((capture) => capture.frame.id === mainFrame.id);
    if (!mainCapture || !isFrameSnapshot(mainCapture.value)) {
      throw new AgentError("INTERNAL_ERROR", "main frame snapshot returned an invalid shape");
    }
    const allNodes = captures.flatMap(({ frame, value }) => {
      if (!isFrameSnapshot(value)) return [];
      const offset = offsets.get(frame.id) ?? { x: 0, y: 0 };
      return value.nodes.map((node) => ({
        ...node,
        ...(node.box
          ? { box: { ...node.box, x: node.box.x + offset.x, y: node.box.y + offset.y } }
          : {}),
      }));
    });
    const maxNodes = Number.isFinite(options?.maxNodes) ? Math.max(1, options!.maxNodes!) : 1000;
    const currentState = await this.readScriptState(signal);
    const captured = {
      pageId: this.pageId,
      documentId: asDocumentId(currentState.documentId),
      revision: this.effectiveRevision(currentState),
      url: mainCapture.value.url,
      title: mainCapture.value.title,
      rootFrameId: MAIN_FRAME_ID,
      nodes: allNodes.slice(0, maxNodes),
      truncated: captures.some(({ value }) => isFrameSnapshot(value) && value.truncated) || allNodes.length > maxNodes,
    } satisfies CapturedSnapshot;
    this.lastSnapshot = captured;
    this.lastSnapshotOptions = optionsKey;
    return captured;
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
      case "select":
        return this.select(action, token, expect, signal);
      case "check":
        return this.check(action, token, expect, signal);
      case "hover":
        return this.hover(action, token, expect, signal);
      case "scroll":
        return this.scroll(action, token, expect, signal);
      case "type":
        return this.typeText(action.text, token, expect, signal);
      case "press":
        return this.press(action.key, token, expect, signal);
      case "navigate":
        return this.navigate(action, token, expect, signal);
      default:
        return unsupportedAction(action);
    }
  }

  private async click(
    action: Extract<AgentAction, { type: "click" }>,
    token?: SnapshotToken,
    expect?: ActionExpectation,
    signal?: AbortSignal,
  ): Promise<Omit<ActionResult, "snapshot">> {

    const before = await this.identity(signal);
    const snapshot = await this.snapshot(undefined, signal);
    this.assertToken(token, snapshot.documentId, snapshot.revision);
    const target = this.resolver.resolve(action.target, snapshot);
    const frameId = String(target.node.frameId);
    const inspection = await this.inspect(target.ref, frameId, signal);
    if (!inspection.ok || !inspection.visible || !inspection.enabled || inspection.occluded) {
      throw new AgentError("NOT_INTERACTABLE", "target is not safely clickable", {
        retryable: true,
      });
    }

    this.controller.focusContent();
    const button = action.button ?? "left";
    const clickCount = action.clickCount ?? 1;
    throwIfAborted(signal);
    if (frameId === "main") {
      await this.controller.cdp("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: inspection.x,
        y: inspection.y,
        button,
        clickCount,
      });
      throwIfAborted(signal);
      await this.controller.cdp("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: inspection.x,
        y: inspection.y,
        button,
        clickCount,
      });
    } else {
      const value = await this.controller.runJsInFrame(
        frameId,
        clickScript(this.agentKey, target.ref, frameId, button, clickCount),
      );
      if (!isClickResult(value) || !value.ok) {
        throw new AgentError("ACTION_UNVERIFIED", "frame click did not activate the target", { retryable: true });
      }
    }
    this.invalidateSnapshots();
    const outcome = await this.waitForOutcome(before, expect, signal);

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
    signal?: AbortSignal,
  ): Promise<Omit<ActionResult, "snapshot">> {
    const before = await this.identity(signal);
    const snapshot = await this.snapshot(undefined, signal);
    this.assertToken(token, snapshot.documentId, snapshot.revision);
    const target = this.resolver.resolve(action.target, snapshot);
    const frameId = String(target.node.frameId);
    const inspection = await this.inspect(target.ref, frameId, signal);
    if (!inspection.ok || !inspection.visible || !inspection.enabled || !inspection.editable) {
      throw new AgentError("NOT_INTERACTABLE", "target is not an editable control", { retryable: true });
    }

    this.controller.focusContent();
    throwIfAborted(signal);
    const source = fillScript(this.agentKey, target.ref, action.value);
    const value = frameId === "main"
      ? await this.controller.runJs(source)
      : await this.controller.runJsInFrame(frameId, source);
    throwIfAborted(signal);
    if (!isActiveElementInfo(value) || !value.ok || !value.editable || value.value !== action.value) {
      throw new AgentError("ACTION_UNVERIFIED", "control value did not match the requested fill", {
        retryable: true,
      });
    }
    this.invalidateSnapshots();
    const outcome = await this.waitForOutcome(before, expect, signal);
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
    signal?: AbortSignal,
  ): Promise<Omit<ActionResult, "snapshot">> {
    const before = await this.identity(signal);
    this.assertToken(token, before.documentId, before.revision);
    const activeBefore = await this.activeElement(signal);
    if (!activeBefore.ok || !activeBefore.editable) {
      throw new AgentError("NOT_INTERACTABLE", "the active element is not editable", { retryable: true });
    }

    this.controller.focusContent();
    throwIfAborted(signal);
    await this.controller.cdp("Input.insertText", { text });
    this.invalidateSnapshots();
    const outcome = await this.waitForOutcome(before, expect, signal);
    const activeAfter = await this.activeElement(signal).catch((error) => {
      if (signal?.aborted) throw error;
      return activeBefore;
    });
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

  private async select(
    action: Extract<AgentAction, { type: "select" }>,
    token?: SnapshotToken,
    expect?: ActionExpectation,
    signal?: AbortSignal,
  ): Promise<Omit<ActionResult, "snapshot">> {
    const before = await this.identity(signal);
    const snapshot = await this.snapshot(undefined, signal);
    this.assertToken(token, snapshot.documentId, snapshot.revision);
    const target = this.resolver.resolve(action.target, snapshot);
    const frameId = String(target.node.frameId);
    const inspection = await this.inspect(target.ref, frameId, signal);
    if (
      !inspection.ok ||
      !inspection.visible ||
      !inspection.enabled ||
      (inspection.role !== "combobox" && inspection.role !== "select")
    ) {
      throw new AgentError("NOT_INTERACTABLE", "target is not a selectable control", { retryable: true });
    }

    this.controller.focusContent();
    throwIfAborted(signal);
    const source = selectScript(this.agentKey, target.ref, action.values);
    const raw = frameId === "main"
      ? await this.controller.runJs(source)
      : await this.controller.runJsInFrame(frameId, source);
    throwIfAborted(signal);
    if (!isSelectResult(raw) || !raw.ok || !sameStringSet(raw.values, action.values)) {
      throw new AgentError("ACTION_UNVERIFIED", "selected values did not match the requested values", {
        retryable: true,
      });
    }
    this.invalidateSnapshots();
    const outcome = await this.waitForOutcome(before, expect, signal);
    const after = outcome.identity;
    const effects = this.transitionEffects(before, after);
    effects.push({ type: "value.changed", data: { values: raw.values } });
    const proof: ActionProof = {
      target: target.ref,
      role: inspection.role,
      name: inspection.name,
      value: raw.values.join(","),
      url: after.url,
      title: after.title,
    };
    return { verified: hasExpectation(expect) ? outcome.satisfied : true, effects, proof };
  }

  private async check(
    action: Extract<AgentAction, { type: "check" }>,
    token?: SnapshotToken,
    expect?: ActionExpectation,
    signal?: AbortSignal,
  ): Promise<Omit<ActionResult, "snapshot">> {
    const before = await this.identity(signal);
    const snapshot = await this.snapshot(undefined, signal);
    this.assertToken(token, snapshot.documentId, snapshot.revision);
    const target = this.resolver.resolve(action.target, snapshot);
    const frameId = String(target.node.frameId);
    const inspection = await this.inspect(target.ref, frameId, signal);
    if (
      !inspection.ok ||
      !inspection.visible ||
      !inspection.enabled ||
      typeof inspection.checked !== "boolean"
    ) {
      throw new AgentError("NOT_INTERACTABLE", "target is not a checkable control", { retryable: true });
    }

    this.controller.focusContent();
    throwIfAborted(signal);
    const source = checkScript(this.agentKey, target.ref, action.checked);
    const raw = frameId === "main"
      ? await this.controller.runJs(source)
      : await this.controller.runJsInFrame(frameId, source);
    throwIfAborted(signal);
    if (!isCheckResult(raw) || !raw.ok || raw.checked !== action.checked) {
      throw new AgentError("ACTION_UNVERIFIED", "checked state did not match the requested state", {
        retryable: true,
      });
    }
    this.invalidateSnapshots();
    const outcome = await this.waitForOutcome(before, expect, signal);
    const after = outcome.identity;
    const effects = this.transitionEffects(before, after);
    effects.push({ type: "value.changed", data: { checked: raw.checked } });
    const proof: ActionProof = {
      target: target.ref,
      role: inspection.role,
      name: inspection.name,
      value: String(raw.checked),
      url: after.url,
      title: after.title,
    };
    return { verified: hasExpectation(expect) ? outcome.satisfied : true, effects, proof };
  }

  private async navigate(
    action: Extract<AgentAction, { type: "navigate" }>,
    token?: SnapshotToken,
    expect?: ActionExpectation,
    signal?: AbortSignal,
  ): Promise<Omit<ActionResult, "snapshot">> {
    const before = await this.identity(signal);
    this.assertToken(token ?? undefined, before.documentId, before.revision);
    throwIfAborted(signal);
    this.controller.navigate(action.url);
    this.invalidateSnapshots();
    const navigationExpectation = expect ?? { url: action.url, timeoutMs: 10_000 };
    const outcome = await this.waitForOutcome(before, navigationExpectation, signal);
    const after = outcome.identity;
    const effects = this.transitionEffects(before, after);
    const proof: ActionProof = { url: after.url, title: after.title };
    return { verified: outcome.satisfied, effects, proof };
  }

  private async hover(
    action: Extract<AgentAction, { type: "hover" }>,
    token?: SnapshotToken,
    expect?: ActionExpectation,
    signal?: AbortSignal,
  ): Promise<Omit<ActionResult, "snapshot">> {
    const before = await this.identity(signal);
    const snapshot = await this.snapshot(undefined, signal);
    this.assertToken(token, snapshot.documentId, snapshot.revision);
    const target = this.resolver.resolve(action.target, snapshot);
    const frameId = String(target.node.frameId);
    const inspection = await this.inspect(target.ref, frameId, signal);
    if (!inspection.ok || !inspection.visible || !inspection.enabled || inspection.x === undefined || inspection.y === undefined) {
      throw new AgentError("NOT_INTERACTABLE", "target is not safely hoverable", { retryable: true });
    }

    this.controller.focusContent();
    throwIfAborted(signal);
    await this.controller.cdp("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: inspection.x,
      y: inspection.y,
    });
    this.invalidateSnapshots();
    const outcome = hasExpectation(expect)
      ? await this.waitForOutcome(before, expect, signal)
      : { identity: await this.identity(signal), changed: false, satisfied: true };
    const after = outcome.identity;
    const proof: ActionProof = {
      target: target.ref,
      role: inspection.role,
      name: inspection.name,
      url: after.url,
      title: after.title,
    };
    return { verified: outcome.satisfied, effects: this.transitionEffects(before, after), proof };
  }

  private async scroll(
    action: Extract<AgentAction, { type: "scroll" }>,
    token?: SnapshotToken,
    expect?: ActionExpectation,
    signal?: AbortSignal,
  ): Promise<Omit<ActionResult, "snapshot">> {
    const before = await this.identity(signal);
    const snapshot = await this.snapshot(undefined, signal);
    this.assertToken(token, snapshot.documentId, snapshot.revision);
    const target = action.target ? this.resolver.resolve(action.target, snapshot) : null;
    const frameId = target ? String(target.node.frameId) : "main";
    if (target) {
      const inspection = await this.inspect(target.ref, frameId, signal);
      if (!inspection.ok || !inspection.visible || !inspection.enabled) {
        throw new AgentError("NOT_INTERACTABLE", "scroll target is not safely usable", { retryable: true });
      }
    }

    const amount = Math.max(1, action.amount ?? 500);
    const deltaX = action.direction === "right" ? amount : action.direction === "left" ? -amount : 0;
    const deltaY = action.direction === "down" ? amount : action.direction === "up" ? -amount : 0;
    throwIfAborted(signal);
    const source = scrollScript(this.agentKey, target?.ref ? String(target.ref) : null, deltaX, deltaY);
    const raw = frameId === "main"
      ? await this.controller.runJs(source)
      : await this.controller.runJsInFrame(frameId, source);
    throwIfAborted(signal);
    if (!isScrollResult(raw) || !raw.ok) {
      throw new AgentError("ACTION_UNVERIFIED", "scroll position could not be read after scrolling", { retryable: true });
    }
    this.invalidateSnapshots();
    const outcome = hasExpectation(expect)
      ? await this.waitForOutcome(before, expect, signal)
      : { identity: await this.identity(signal), changed: false, satisfied: true };
    const after = outcome.identity;
    const effects = this.transitionEffects(before, after);
    effects.push({
      type: "scroll.changed",
      data: { direction: action.direction, amount, x: raw.x ?? 0, y: raw.y ?? 0, changed: raw.changed ?? false },
    });
    const proof: ActionProof = {
      target: target?.ref,
      role: target?.node.role,
      name: target?.node.name,
      value: `${raw.x ?? 0},${raw.y ?? 0}`,
      url: after.url,
      title: after.title,
    };
    return { verified: outcome.satisfied, effects, proof };
  }

  private async press(
    rawKey: string,
    token?: SnapshotToken,
    expect?: ActionExpectation,
    signal?: AbortSignal,
  ): Promise<Omit<ActionResult, "snapshot">> {
    const before = await this.identity(signal);
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
    throwIfAborted(signal);
    await this.controller.cdp("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      ...base,
      autoRepeat: false,
    });
    if (key.text && (key.modifiers & (MODIFIER_ALT | MODIFIER_CTRL | MODIFIER_META)) === 0) {
      throwIfAborted(signal);
      await this.controller.cdp("Input.dispatchKeyEvent", { type: "char", text: key.text, ...base });
    }
    throwIfAborted(signal);
    await this.controller.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    this.invalidateSnapshots();
    const outcome = await this.waitForOutcome(before, expect, signal);
    const active = await this.activeElement(signal).catch((error) => {
      if (signal?.aborted) throw error;
      return { ok: false } as ActiveElementInfo;
    });
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

  async wait(condition: WaitCondition, timeoutMs = 10_000, signal?: AbortSignal): Promise<Omit<WaitResult, "snapshot">> {
    const started = Date.now();
    const deadline = started + Math.max(0, timeoutMs);
    if (condition.type === "time") {
      await abortableDelay(Math.min(condition.ms, Math.max(0, deadline - Date.now())), signal);
      return { satisfied: Date.now() <= deadline, elapsedMs: Date.now() - started };
    }

    let stableRevision: number | null = null;
    let stableSince = Date.now();
    while (Date.now() <= deadline) {
      throwIfAborted(signal);
      const identity = await this.identity(signal);
      let satisfied = false;
      if (condition.type === "url") satisfied = identity.url.includes(condition.value);
      if (condition.type === "text") {
        const snapshot = await this.snapshot({ interactiveOnly: false }, signal);
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
      await abortableDelay(Math.min(25, Math.max(1, deadline - Date.now())), signal);
    }
    return { satisfied: false, elapsedMs: Date.now() - started };
  }

  async subscribe(
    listener: (event: AgentEvent) => void,
    options?: EventSubscriptionOptions,
    signal?: AbortSignal,
  ): Promise<EventSubscription> {
    throwIfAborted(signal);
    const subscription = this.events.subscribe(listener, options);
    try {
      if (this.events.size === 1) this.observationReady = this.startObservation(signal);
      await this.observationReady;
      throwIfAborted(signal);
      return {
        ...subscription,
        sequence: this.events.latestSequence,
        unsubscribe: () => {
          subscription.unsubscribe();
          if (this.events.size === 0) this.observationReady = null;
        },
      };
    } catch (error) {
      subscription.unsubscribe();
      if (this.events.size === 0) this.observationReady = null;
      throw error;
    }
  }

  private async startObservation(signal?: AbortSignal): Promise<void> {
    try {
      throwIfAborted(signal);
      await this.controller.attachCdp();
      await this.readScriptState(signal);
    } catch {}
  }

  private async captureFrame(
    frame: BrowserAgentFrame,
    options: SnapshotOptions | undefined,
    signal?: AbortSignal,
  ): Promise<{ frame: BrowserAgentFrame; value: unknown }> {
    throwIfAborted(signal);
    const frameId = frame.parentId === null ? "main" : frame.id;
    try {
      const source = snapshotScript(this.agentKey, options, frameId);
      const value = frame.parentId === null
        ? await this.controller.runJs(source)
        : await this.controller.runJsInFrame(frame.id, source);
      return { frame, value };
    } catch (error) {
      if (signal?.aborted) throw error;
      const currentFrames = await this.controller.agentFrames().catch(() => []);
      if (!currentFrames.some((candidate) => candidate.id === frame.id)) return { frame, value: null };
      const message = error instanceof Error ? error.message : String(error);
      throw new AgentError("INTERNAL_ERROR", `frame ${frame.id} snapshot failed: ${message}`, { retryable: true });
    }
  }

  private async frameOffsets(
    frames: readonly BrowserAgentFrame[],
    signal?: AbortSignal,
  ): Promise<Map<string, { x: number; y: number }>> {
    throwIfAborted(signal);
    await this.controller.attachCdp();
    await this.controller.cdp("DOM.enable");
    const byId = new Map(frames.map((frame) => [frame.id, frame]));
    const offsets = new Map<string, { x: number; y: number }>();
    const resolving = new Set<string>();
    const resolve = async (frameId: string): Promise<{ x: number; y: number }> => {
      const cached = offsets.get(frameId);
      if (cached) return cached;
      const frame = byId.get(frameId);
      if (!frame || resolving.has(frameId)) throw new AgentError("INTERNAL_ERROR", `invalid frame tree at ${frameId}`);
      resolving.add(frameId);
      try {
        if (frame.parentId === null) {
          const root = { x: 0, y: 0 };
          offsets.set(frameId, root);
          return root;
        }
        const parent = await resolve(frame.parentId);
        const owner = await this.controller.cdp("DOM.getFrameOwner", { frameId });
        const backendNodeId = owner.backendNodeId;
        if (typeof backendNodeId !== "number") {
          throw new AgentError("INTERNAL_ERROR", `frame owner is unavailable for ${frameId}`);
        }
        const model = (await this.controller.cdp("DOM.getBoxModel", { backendNodeId })) as {
          model?: { content?: unknown };
        };
        const content = model.model?.content;
        if (!Array.isArray(content) || content.length < 8 || !content.every((value) => typeof value === "number")) {
          throw new AgentError("INTERNAL_ERROR", `frame owner geometry is unavailable for ${frameId}`);
        }
        const localX = Math.min(content[0], content[2], content[4], content[6]);
        const localY = Math.min(content[1], content[3], content[5], content[7]);
        const offset = { x: parent.x + localX, y: parent.y + localY };
        offsets.set(frameId, offset);
        return offset;
      } finally {
        resolving.delete(frameId);
      }
    };
    for (const frame of frames) {
      throwIfAborted(signal);
      await resolve(frame.id);
    }
    return offsets;
  }

  private async readScriptState(signal?: AbortSignal): Promise<PageScriptState> {
    throwIfAborted(signal);
    const value = await this.controller.runJs(scriptStateScript(this.agentKey));
    throwIfAborted(signal);
    if (!isScriptState(value)) throw new AgentError("INTERNAL_ERROR", "page state returned an invalid shape");
    return value;
  }

  private effectiveRevision(state: PageScriptState): number {
    return state.revision + this.remoteRevision;
  }

  private async inspect(ref: string, frameId: string, signal?: AbortSignal): Promise<ElementInspection> {
    throwIfAborted(signal);
    const source = inspectScript(this.agentKey, ref, frameId);
    const value = frameId === "main"
      ? await this.controller.runJs(source)
      : await this.controller.runJsInFrame(frameId, source);
    throwIfAborted(signal);
    if (!isInspection(value)) throw new AgentError("INTERNAL_ERROR", "target inspection returned an invalid shape");
    const offsets = frameId === "main" ? null : await this.frameOffsets(await this.controller.agentFrames(), signal);
    const offset = offsets?.get(frameId) ?? { x: 0, y: 0 };
    return {
      ...value,
      ...(value.x === undefined ? {} : { x: value.x + offset.x }),
      ...(value.y === undefined ? {} : { y: value.y + offset.y }),
    };
  }

  private async activeElement(signal?: AbortSignal): Promise<ActiveElementInfo> {
    throwIfAborted(signal);
    const frames = await this.controller.agentFrames();
    let fallback: ActiveElementInfo | null = null;
    for (const frame of frames) {
      throwIfAborted(signal);
      const frameId = frame.parentId === null ? "main" : frame.id;
      const source = activeElementScript();
      const value = frameId === "main"
        ? await this.controller.runJs(source)
        : await this.controller.runJsInFrame(frame.id, source);
      if (!isActiveElementInfo(value)) throw new AgentError("INTERNAL_ERROR", "active element returned an invalid shape");
      if (value.ok) {
        fallback = { ...value, frameId };
        if (value.editable) return { ...value, frameId };
      }
    }
    return fallback ?? { ok: false };
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
    } else if (before.revision !== after.revision) {
      effects.push({ type: "dom.changed", data: { revision: after.revision } });
    }
    return effects;
  }

  private handlePageEvent(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const event = value as { event?: unknown; data?: AgentEvent["data"] };
    if (event.event !== "dom.changed") return;
    const data = event.data && typeof event.data === "object"
      ? event.data as Record<string, unknown>
      : null;
    if (data?.frameId && data.frameId !== "main") this.remoteRevision += 1;
    this.invalidateSnapshots();
    this.emit("dom.changed", event.data);
  }

  private handleLifecycleEvent(event: BrowserLifecycleEvent): void {
    if (event.type === "navigation") {
      this.remoteRevision = 0;
      this.invalidateSnapshots();
      this.emit("frame.lifecycle", {
        type: "navigated",
        frame: {
          frameId: MAIN_FRAME_ID,
          parentFrameId: null,
          url: event.url,
          origin: originForUrl(event.url),
        },
      });
      this.emit("navigation", { url: event.url, inPage: event.inPage });
      return;
    }
    this.emit("load", { loading: event.loading, url: event.url });
  }

  private handleFrameLifecycle(event: BrowserAgentFrameLifecycle): void {
    this.remoteRevision += 1;
    this.invalidateSnapshots();
    if (event.type === "attached") {
      this.emit("frame.lifecycle", {
        type: "attached",
        frameId: this.protocolFrameId(event.frameId, event.parentId),
        parentFrameId: this.protocolFrameId(event.parentId),
      });
      return;
    }
    if (event.type === "navigated") {
      const frameId = this.protocolFrameId(event.frameId, event.parentId);
      this.emit("frame.lifecycle", {
        type: "navigated",
        frame: {
          frameId,
          parentFrameId: this.protocolFrameId(event.parentId),
          url: event.url,
          origin: event.origin,
        },
      });
      this.emit("navigation", { url: event.url, inPage: false, frameId, detached: false });
      return;
    }
    const frameId = this.protocolFrameId(event.frameId);
    this.emit("frame.lifecycle", { type: "detached", frameId });
    this.emit("navigation", { url: "", inPage: false, frameId, detached: true });
  }

  private protocolFrameId(frameId: string, parentId?: string | null): PageFrame["frameId"] {
    return parentId === null || frameId === this.mainBrowserFrameId ? MAIN_FRAME_ID : asFrameId(frameId);
  }

  private async waitForOutcome(
    before: PageIdentity,
    expect?: ActionExpectation,
    signal?: AbortSignal,
  ): Promise<{ identity: PageIdentity; changed: boolean; satisfied: boolean }> {
    const hasExpectation = !!expect && (expect.url !== undefined || expect.title !== undefined || expect.text !== undefined);
    const timeoutMs = hasExpectation ? expect?.timeoutMs ?? 2_000 : 250;
    const deadline = Date.now() + Math.max(0, timeoutMs);
    let identity = before;
    let satisfied = false;
    let changed = false;
    do {
      try {
        throwIfAborted(signal);
        identity = await this.identity(signal);
        changed = identityChanged(before, identity);
        satisfied = hasExpectation ? await this.matchesExpectation(expect!, identity, signal) : changed;
        if (satisfied || (changed && !identity.loading)) return { identity, changed, satisfied };
      } catch (error) {
        if (signal?.aborted) throw error;
      }
      if (Date.now() >= deadline) break;
      await abortableDelay(Math.min(25, Math.max(1, deadline - Date.now())), signal);
    } while (Date.now() <= deadline);
    return { identity, changed, satisfied };
  }

  private async matchesExpectation(expect: ActionExpectation, identity: PageIdentity, signal?: AbortSignal): Promise<boolean> {
    if (expect.url !== undefined && !identity.url.includes(expect.url)) return false;
    if (expect.title !== undefined && !identity.title.includes(expect.title)) return false;
    if (expect.text !== undefined) {
      const snapshot = await this.snapshot({ interactiveOnly: false }, signal);
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
    this.events.publish(message);
  }
}

function identityChanged(before: PageIdentity, after: PageIdentity): boolean {
  return (
    before.documentId !== after.documentId ||
    before.url !== after.url ||
    before.title !== after.title ||
    before.revision !== after.revision
  );
}

function originForUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
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
    ${agentStateSetupScript(key, "main")}
    return { documentId: state.documentId, revision: state.revision };
  })()`;
}

function snapshotScript(key: string, options: SnapshotOptions | undefined, frameId: string): string {
  return `(() => {
    ${agentStateSetupScript(key, frameId)}
    const options = ${JSON.stringify(options ?? {})};
    const maxNodes = Number.isFinite(options.maxNodes) ? Math.max(1, options.maxNodes) : 1000;
    const interactiveOnly = options.interactiveOnly ?? true;
    const includeGeometry = options.includeGeometry !== false;
    const includeText = options.includeText !== false;
    const nodes = [];
    let truncated = false;
    state.snapshotRevision = state.revision;

    const text = (value) => String(value ?? "").replace(/\\s+/g, " ").trim().slice(0, 240);
    const styleFor = (el) => {
      const view = el.ownerDocument && el.ownerDocument.defaultView;
      return view ? view.getComputedStyle(el) : getComputedStyle(el);
    };
    const boxFor = (el) => {
      const rect = el.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, rect };
    };
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
      const style = styleFor(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && (rect.width > 0 || rect.height > 0);
    };
    const interactiveFor = (el, role) => el.matches("a[href],button,input,select,textarea,[tabindex],summary,[contenteditable=true]") || el.hasAttribute("role") || role === "heading";
    const focusableFor = (el) => el.tabIndex >= 0 || el.matches("a[href],button,input,select,textarea");
    const activeFor = (el) => {
      const root = el.getRootNode();
      let active = root && root.activeElement ? root.activeElement : document.activeElement;
      while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
      return active;
    };
    const stateFor = (el) => {
      const value = {};
      if (el.disabled || el.getAttribute("aria-disabled") === "true") value.disabled = true;
      if (activeFor(el) === el) value.focused = true;
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
    const visit = (el, parent, parentVisible) => {
      if (!el) return;
      if (nodes.length >= maxNodes) { truncated = true; return; }
      const role = roleFor(el);
      const visible = parentVisible && visibleFor(el);
      const include = !interactiveOnly || interactiveFor(el, role);
      let nextParent = parent;
      if (include) {
        let ref = state.elementRefs.get(el);
        if (!ref) {
          ref = state.frameId + ":r" + (++state.nextRef);
          state.elementRefs.set(el, ref);
        }
        state.refs.set(ref, el);
        const box = boxFor(el);
        nodes.push({
          ref,
          frameId: state.frameId,
          parent,
          role,
          name: nameFor(el),
          ...(includeText ? { text: text(el.innerText || "") } : {}),
          state: stateFor(el),
          ...(includeGeometry ? { box: { x: box.x, y: box.y, width: box.width, height: box.height } } : {}),
          visible,
          enabled: !el.disabled && el.getAttribute("aria-disabled") !== "true",
          focusable: focusableFor(el),
          attributes: attrsFor(el),
        });
        nextParent = ref;
      }
      for (const child of el.children) visit(child, nextParent, visible);
      if (el.shadowRoot) {
        state.observeRoot(el.shadowRoot);
        for (const child of el.shadowRoot.children) visit(child, nextParent, visible);
      }
    };
    visit(document.body || document.documentElement, null, true);
    return {
      pageId: "",
      documentId: state.documentId,
      revision: state.revision,
      url: location.href,
      title: document.title,
      rootFrameId: state.frameId,
      nodes,
      truncated,
    };
  })()`;
}

function agentStateSetupScript(key: string, frameId: string): string {
  return `
    const key = ${JSON.stringify(key)};
    const frameId = ${JSON.stringify(frameId)};
    const documentId = String(performance.timeOrigin);
    let state = window[key];
    if (!state || state.documentId !== documentId || state.frameId !== frameId) {
      state = {
        documentId,
        frameId,
        revision: 0,
        nextRef: 0,
        refs: new Map(),
        elementRefs: new WeakMap(),
        invalidationScheduled: false,
        snapshotRevision: -1,
      };
      const emit = () => {
        const binding = window.__pixelEmit;
        if (typeof binding !== "function") return;
        try {
          binding(JSON.stringify({
            channel: ${JSON.stringify(AGENT_EVENT_CHANNEL)},
            data: { event: "dom.changed", data: { frameId: state.frameId, revision: state.revision } },
          }));
        } catch {}
      };
      const invalidate = () => {
        if (state.invalidationScheduled) return;
        state.invalidationScheduled = true;
        queueMicrotask(() => {
          state.invalidationScheduled = false;
          state.revision += 1;
          state.refs = new Map();
          state.elementRefs = new WeakMap();
          emit();
        });
      };
      const observer = new MutationObserver(invalidate);
      const observedRoots = new WeakSet();
      const handledEvents = new WeakSet();
      const invalidateEvent = (event) => {
        if (handledEvents.has(event)) return;
        handledEvents.add(event);
        invalidate();
      };
      const observeRoot = (root) => {
        if (observedRoots.has(root)) return;
        observedRoots.add(root);
        observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
        for (const event of ["input", "change", "focusin", "focusout"]) {
          root.addEventListener(event, invalidateEvent, true);
        }
      };
      state.observeRoot = observeRoot;
      observeRoot(document);
      window[key] = state;
    }
  `;
}

function inspectScript(key: string, ref: string, frameId: string): string {
  return `(() => {
    const state = window[${JSON.stringify(key)}];
    if (!state || state.frameId !== ${JSON.stringify(frameId)}) return { ok: false };
    const el = state && state.refs && state.refs.get(${JSON.stringify(ref)});
    if (!el || !el.isConnected) return { ok: false };
    el.scrollIntoView({ block: "center", inline: "center" });
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const root = el.getRootNode();
    const activeFor = () => {
      let active = root && root.activeElement ? root.activeElement : el.ownerDocument.activeElement;
      while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
      return active;
    };
    const localX = rect.left + rect.width / 2;
    const localY = rect.top + rect.height / 2;
    const hit = typeof root.elementFromPoint === "function"
      ? root.elementFromPoint(localX, localY)
      : el.ownerDocument.elementFromPoint(localX, localY);
    const composedHit = (candidate, target) => {
      if (!target) return false;
      if (candidate === target || candidate.contains(target)) return true;
      let current = candidate;
      while (current && current.getRootNode) {
        const currentRoot = current.getRootNode();
        if (!currentRoot || !currentRoot.host) break;
        current = currentRoot.host;
        if (current === target || current.contains(target)) return true;
      }
      return false;
    };
    const view = el.ownerDocument.defaultView || window;
    const style = view.getComputedStyle(el);
    return {
      ok: true,
      x,
      y,
      visible: style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && rect.width > 0 && rect.height > 0,
      enabled: !el.disabled && el.getAttribute("aria-disabled") !== "true",
      occluded: !!hit && !composedHit(el, hit),
      editable:
        el.isContentEditable ||
        el.tagName === "TEXTAREA" ||
        (el.tagName === "INPUT" && !["checkbox", "radio", "file", "button", "submit", "reset", "image"].includes(el.type)),
      focused: activeFor(el) === el,
      role: el.getAttribute("role") || el.tagName.toLowerCase(),
      name: el.getAttribute("aria-label") || el.innerText || el.value || "",
      value: "value" in el && typeof el.value === "string" ? el.value : undefined,
      checked: "checked" in el && typeof el.checked === "boolean" ? el.checked : undefined,
      selected: "selected" in el && typeof el.selected === "boolean" ? el.selected : undefined,
    };
  })()`;
}

function fillScript(key: string, ref: string, value: string): string {
  return `(() => {
    const state = window[${JSON.stringify(key)}];
    const el = state && state.refs && state.refs.get(${JSON.stringify(ref)});
    if (!el || !el.isConnected) return { ok: false };
    const root = el.getRootNode();
    const activeFor = () => {
      let active = root && root.activeElement ? root.activeElement : el.ownerDocument.activeElement;
      while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
      return active;
    };
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
    const view = el.ownerDocument.defaultView || window;
    const InputEventCtor = view.InputEvent || InputEvent;
    const EventCtor = view.Event || Event;
    el.dispatchEvent(new InputEventCtor("input", { bubbles: true, inputType: "insertText", data: ${JSON.stringify(value)} }));
    el.dispatchEvent(new EventCtor("change", { bubbles: true }));
    return {
      ok: true,
      editable: true,
      focused: activeFor(el) === el,
      role,
      name,
      value: "value" in el ? String(el.value ?? "") : String(el.innerText ?? ""),
    };
  })()`;
}

function selectScript(key: string, ref: string, values: readonly string[]): string {
  return `(() => {
    const state = window[${JSON.stringify(key)}];
    const el = state && state.refs && state.refs.get(${JSON.stringify(ref)});
    if (!el || !el.isConnected || el.tagName !== "SELECT" || el.disabled || el.getAttribute("aria-disabled") === "true") {
      return { ok: false };
    }
    const wanted = new Set(${JSON.stringify(values)});
    const options = Array.from(el.options);
    if (!el.multiple && wanted.size > 1) return { ok: false };
    if (Array.from(wanted).some((value) => !options.some((option) => option.value === value))) return { ok: false };
    el.focus();
    for (const option of options) option.selected = wanted.has(option.value);
    const view = el.ownerDocument.defaultView || window;
    const EventCtor = view.Event || Event;
    el.dispatchEvent(new EventCtor("input", { bubbles: true }));
    el.dispatchEvent(new EventCtor("change", { bubbles: true }));
    return { ok: true, values: Array.from(el.selectedOptions).map((option) => option.value) };
  })()`;
}

function checkScript(key: string, ref: string, checked: boolean): string {
  return `(() => {
    const state = window[${JSON.stringify(key)}];
    const el = state && state.refs && state.refs.get(${JSON.stringify(ref)});
    const type = el && String(el.type || "").toLowerCase();
    if (!el || !el.isConnected || (type !== "checkbox" && type !== "radio") || el.disabled || el.getAttribute("aria-disabled") === "true") {
      return { ok: false };
    }
    if (type === "radio" && !${checked} && el.checked) return { ok: false, checked: true };
    if (el.checked !== ${checked}) el.click();
    return { ok: true, checked: !!el.checked };
  })()`;
}

function scrollScript(key: string, ref: string | null, deltaX: number, deltaY: number): string {
  return `(() => {
    const state = window[${JSON.stringify(key)}];
    const ref = ${JSON.stringify(ref)};
    const target = ref && state && state.refs ? state.refs.get(ref) : null;
    const root = document.scrollingElement || document.documentElement;
    const scrollable = (el) => el && (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth);
    let scroller = target;
    while (scroller && scroller !== document.body && scroller !== document.documentElement && !scrollable(scroller)) {
      scroller = scroller.parentElement;
    }
    if (!scrollable(scroller)) scroller = root;
    const before = { x: scroller.scrollLeft || 0, y: scroller.scrollTop || 0 };
    if (scroller === root) {
      window.scrollBy(${deltaX}, ${deltaY});
    } else if (typeof scroller.scrollBy === "function") {
      scroller.scrollBy(${deltaX}, ${deltaY});
    } else {
      scroller.scrollLeft += ${deltaX};
      scroller.scrollTop += ${deltaY};
    }
    const after = { x: scroller.scrollLeft || 0, y: scroller.scrollTop || 0 };
    return { ok: true, x: after.x, y: after.y, changed: before.x !== after.x || before.y !== after.y };
  })()`;
}

function clickScript(key: string, ref: string, frameId: string, button: string, clickCount: number): string {
  return `(() => {
    const state = window[${JSON.stringify(key)}];
    if (!state || state.frameId !== ${JSON.stringify(frameId)}) return { ok: false };
    const el = state.refs && state.refs.get(${JSON.stringify(ref)});
    if (!el || !el.isConnected) return { ok: false };
    if (${JSON.stringify(button)} !== "left") return { ok: false };
    for (let count = 0; count < ${clickCount}; count += 1) el.click();
    return { ok: true };
  })()`;
}

function activeElementScript(): string {
  return `(() => {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
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

function isFrameSnapshot(value: unknown): value is FrameSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Record<string, unknown>;
  return (
    typeof snapshot.documentId === "string" &&
    typeof snapshot.revision === "number" &&
    typeof snapshot.url === "string" &&
    typeof snapshot.title === "string" &&
    Array.isArray(snapshot.nodes) &&
    typeof snapshot.truncated === "boolean"
  );
}

function isInspection(value: unknown): value is ElementInspection {
  return !!value && typeof value === "object" && typeof (value as Record<string, unknown>).ok === "boolean";
}

function isClickResult(value: unknown): value is ClickResult {
  return !!value && typeof value === "object" && typeof (value as Record<string, unknown>).ok === "boolean";
}

function isSelectResult(value: unknown): value is SelectResult & { values: string[] } {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return result.ok === true && Array.isArray(result.values) && result.values.every((item) => typeof item === "string");
}

function isCheckResult(value: unknown): value is CheckResult & { checked: boolean } {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return typeof result.ok === "boolean" && typeof result.checked === "boolean";
}

function isScrollResult(value: unknown): value is ScrollResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return (
    result.ok === true &&
    (result.x === undefined || typeof result.x === "number") &&
    (result.y === undefined || typeof result.y === "number") &&
    (result.changed === undefined || typeof result.changed === "boolean")
  );
}

function isActiveElementInfo(value: unknown): value is ActiveElementInfo {
  return !!value && typeof value === "object" && typeof (value as Record<string, unknown>).ok === "boolean";
}

function hasExpectation(expect: ActionExpectation | undefined): boolean {
  return !!expect && (expect.url !== undefined || expect.title !== undefined || expect.text !== undefined);
}

function unsupportedAction(action: never): never {
  throw new AgentError("INVALID_REQUEST", `live adapter received an unsupported action: ${String(action)}`);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && left.every((value) => right.includes(value));
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
