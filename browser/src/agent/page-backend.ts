import {
  AGENT_PROTOCOL,
  AGENT_PROTOCOL_VERSION,
  AgentError,
  AgentEventBus,
  SnapshotLocatorResolver,
  abortableDelay,
  asDocumentId,
  asFrameId,
  asSnapshotRef,
  diffSnapshots,
  matchesSnapshotNodeText,
  matchesWaitElementState,
  targetResolutionDetails,
  throwIfAborted,
} from "terminal-browser-agent";
import type {
  ActionEffect,
  ActionExpectation,
  ActionResult,
  ActionProof,
  AgentAction,
  AgentEvent,
  CaptureOptions,
  DialogAction,
  EventSubscription,
  EventSubscriptionOptions,
  EventHistoryStore,
  PageBackend,
  PageFrame,
  PageFrameSnapshot,
  PageCapture,
  PageDialogResult,
  PageId,
  PageIdentity,
  PageSnapshot,
  SnapshotDeltaCapture,
  LocatorResolutionOptions,
  ResolvedTarget,
  SnapshotView,
  SnapshotOptions,
  SnapshotNode,
  SnapshotToken,
  Target,
  WaitCondition,
  WaitResult,
} from "terminal-browser-agent";
import type {
  BrowserAgentEvent,
  BrowserAgentDialogAction,
  BrowserAgentFrame,
  BrowserAgentFrameLifecycle,
  BrowserController,
} from "../page/controller";
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
type FrameSnapshotState = { documentId: string; revision: number };
type IncrementalSnapshotResult = {
  ok: boolean;
  documentId?: string;
  revision?: number;
  url?: string;
  title?: string;
  rootFrameId?: string;
  refs?: Array<{ nodeId: string; ref: string }>;
  changed?: SnapshotNode[];
};
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
  enabled?: boolean;
  visible?: boolean;
  editable?: boolean;
  role?: string;
  name?: string;
  value?: string;
};
type CssQueryResult = { ok: boolean; invalid?: boolean; refs?: string[] };

const AGENT_STATE_KEY = "__terminalBrowserAgent";
const AGENT_EVENT_CHANNEL = "terminal-browser.agent";
const MAIN_FRAME_ID = asFrameId("main");
const CSS_RESOLUTION_MAX_NODES = 5_000;
const WAIT_FALLBACK_MS = 250;
const WAIT_WAKE_EVENTS = new Set<AgentEvent["event"]>([
  "navigation",
  "frame.lifecycle",
  "load",
  "dom.changed",
]);

export class ElectronPageBackend implements PageBackend {
  private readonly resolver = new SnapshotLocatorResolver();
  private readonly events: AgentEventBus;
  private readonly agentKey = AGENT_STATE_KEY;
  private sequence = 0;
  private remoteRevision = 0;
  private readonly snapshotCache = new Map<string, CapturedSnapshot>();
  private readonly snapshotFrameStates = new Map<string, Map<string, FrameSnapshotState>>();
  private lastSnapshot: CapturedSnapshot | null = null;
  private lastSnapshotOptions: string | null = null;
  private lastSnapshotInvalidated = false;
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
    this.controller.onAgentEvent = (event) => this.handleAgentEvent(event);
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

  async resolve(
    target: Target,
    snapshot: SnapshotView,
    signal?: AbortSignal,
    options?: LocatorResolutionOptions,
  ): Promise<ResolvedTarget> {
    throwIfAborted(signal);
    if (!("locator" in target) || target.locator.kind !== "css") {
      return this.resolver.resolve(target, snapshot, options);
    }

    const includeHidden = options?.includeHidden === true;
    let candidateSnapshot = snapshot;
    let refs = await this.cssRefs(target.locator.value, signal);
    let nodes = nodesForRefs(refs, candidateSnapshot, includeHidden);
    if (refs.some((ref) => !candidateSnapshot.nodes.some((node) => String(node.ref) === ref))) {
      candidateSnapshot = await this.snapshot({
        interactiveOnly: false,
        maxNodes: CSS_RESOLUTION_MAX_NODES,
      }, signal);
      refs = await this.cssRefs(target.locator.value, signal);
      nodes = nodesForRefs(refs, candidateSnapshot, includeHidden);
    }
    if (refs.length === 0) {
      throw new AgentError("TARGET_NOT_FOUND", "CSS locator matched no snapshot nodes", {
        retryable: true,
        details: targetResolutionDetails([], { snapshotTruncated: candidateSnapshot.truncated }),
      });
    }
    if (refs.some((ref) => !candidateSnapshot.nodes.some((node) => String(node.ref) === ref))) {
      throw new AgentError("TARGET_NOT_FOUND", "CSS locator matched a node outside the current snapshot", {
        retryable: true,
        details: targetResolutionDetails(nodes, { snapshotTruncated: candidateSnapshot.truncated }),
      });
    }
    if (nodes.length > 1) {
      throw new AgentError("AMBIGUOUS_TARGET", "CSS locator matched multiple snapshot nodes", {
        retryable: true,
        details: targetResolutionDetails(nodes, { snapshotTruncated: candidateSnapshot.truncated }),
      });
    }
    return { ref: nodes[0].ref, node: nodes[0] };
  }

  private async cssRefs(selector: string, signal?: AbortSignal): Promise<string[]> {
    const frames = await this.controller.agentFrames();
    const main = frames.find((frame) => frame.parentId === null);
    if (!main) return [];
    this.mainBrowserFrameId = main.id;
    const refs = new Set<string>();
    for (const frame of frames) {
      throwIfAborted(signal);
      const source = cssQueryScript(this.agentKey, selector);
      try {
        const raw = frame.parentId === null
          ? await this.controller.runJs(source)
          : await this.controller.runJsInFrame(frame.id, source);
        throwIfAborted(signal);
        if (!isCssQueryResult(raw)) continue;
        if (raw.invalid) throw new AgentError("INVALID_REQUEST", "invalid CSS locator");
        if (!raw.ok) continue;
        for (const ref of raw.refs ?? []) refs.add(ref);
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error instanceof AgentError && error.code === "INVALID_REQUEST") throw error;
      }
    }
    return [...refs];
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
    const cachedSnapshot = this.snapshotCache.get(optionsKey);
    if (
      cachedSnapshot &&
      !this.lastSnapshotInvalidated &&
      cachedSnapshot.documentId === asDocumentId(scriptState.documentId) &&
      cachedSnapshot.revision === revision
    ) {
      throwIfAborted(signal);
      this.lastSnapshot = cachedSnapshot;
      this.lastSnapshotOptions = optionsKey;
      return cachedSnapshot;
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
    const frameStates = new Map<string, FrameSnapshotState>();
    for (const { frame, value } of captures) {
      if (!isFrameSnapshot(value)) continue;
      frameStates.set(frameKey(frame), { documentId: value.documentId, revision: value.revision });
    }
    this.snapshotCache.set(optionsKey, captured);
    this.snapshotFrameStates.set(optionsKey, frameStates);
    while (this.snapshotCache.size > 16) {
      const oldest = this.snapshotCache.keys().next().value;
      if (oldest === undefined) break;
      this.snapshotCache.delete(oldest);
      this.snapshotFrameStates.delete(oldest);
    }
    this.lastSnapshot = captured;
    this.lastSnapshotOptions = optionsKey;
    this.lastSnapshotInvalidated = false;
    return captured;
  }

  async snapshotDelta(
    base: PageSnapshot,
    options?: SnapshotOptions,
    signal?: AbortSignal,
  ): Promise<SnapshotDeltaCapture | undefined> {
    throwIfAborted(signal);
    const optionsKey = snapshotOptionsKey(options);
    const baseSnapshot = this.snapshotCache.get(optionsKey);
    const frameStates = this.snapshotFrameStates.get(optionsKey);
    if (
      !baseSnapshot ||
      !frameStates ||
      baseSnapshot.documentId !== base.documentId ||
      baseSnapshot.revision !== base.revision ||
      base.truncated ||
      base.nodes.length === 0 ||
      base.nodes.some((node) => !node.nodeId)
    ) {
      return undefined;
    }

    const frames = await this.controller.agentFrames();
    throwIfAborted(signal);
    const mainFrame = frames.find((frame) => frame.parentId === null);
    if (!mainFrame || frameStates.size !== frames.length) return undefined;
    const currentFrameKeys = new Set(frames.map(frameKey));
    if ([...frameStates.keys()].some((key) => !currentFrameKeys.has(key))) return undefined;
    this.mainBrowserFrameId = mainFrame.id;

    const remoteRevisionAtStart = this.remoteRevision;
    const scriptState = await this.readScriptState(signal);
    const currentRevision = this.effectiveRevision(scriptState);
    if (
      asDocumentId(scriptState.documentId) !== base.documentId ||
      currentRevision < base.revision
    ) {
      return undefined;
    }
    if (options?.includeGeometry !== false && (this.lastSnapshotInvalidated || currentRevision !== base.revision)) {
      return undefined;
    }

    const values = await Promise.all(frames.map(async (frame) => {
      throwIfAborted(signal);
      const key = frameKey(frame);
      const cached = frameStates.get(key);
      if (!cached) return null;
      const frameNodes = base.nodes.filter((node) => String(node.frameId) === key);
      const source = incrementalSnapshotScript(
        this.agentKey,
        options,
        cached.revision,
        frameNodes.map((node) => node.nodeId!),
        key,
      );
      const raw = frame.parentId === null
        ? await this.controller.runJs(source)
        : await this.controller.runJsInFrame(frame.id, source);
      throwIfAborted(signal);
      if (!isIncrementalSnapshotResult(raw) || raw.documentId !== cached.documentId || raw.revision! < cached.revision) {
        return null;
      }
      const nodes = rebuildIncrementalNodes(frameNodes, raw);
      if (!nodes) return null;
      return { frame, key, value: raw, nodes };
    }));
    throwIfAborted(signal);
    if (values.some((entry) => entry === null) || this.remoteRevision !== remoteRevisionAtStart) return undefined;

    const after = await this.readScriptState(signal);
    const resolvedValues = values as Array<{
      frame: BrowserAgentFrame;
      key: string;
      value: IncrementalSnapshotResult;
      nodes: readonly SnapshotNode[];
    }>;
    const mainValue = resolvedValues.find((entry) => entry.key === "main");
    if (
      !mainValue ||
      mainValue.value.documentId !== after.documentId ||
      mainValue.value.revision !== after.revision ||
      mainValue.value.documentId !== base.documentId
    ) return undefined;

    const current = {
      pageId: this.pageId,
      documentId: asDocumentId(after.documentId),
      revision: this.effectiveRevision(after),
      url: mainValue.value.url!,
      title: mainValue.value.title!,
      rootFrameId: MAIN_FRAME_ID,
      nodes: resolvedValues.flatMap((entry) => entry.nodes),
      truncated: false,
    } satisfies CapturedSnapshot;
    const nextFrameStates = new Map<string, FrameSnapshotState>(
      resolvedValues.map((entry) => [entry.key, { documentId: entry.value.documentId!, revision: entry.value.revision! }]),
    );
    this.snapshotCache.set(optionsKey, current);
    this.snapshotFrameStates.set(optionsKey, nextFrameStates);
    this.lastSnapshot = current;
    this.lastSnapshotOptions = optionsKey;
    this.lastSnapshotInvalidated = false;
    const delta = diffSnapshots(base, { ...current, snapshotId: base.snapshotId });
    const { snapshotId: _snapshotId, base: _base, ...captured } = delta;
    return { ...captured, mode: "incremental" };
  }

  async capture(options?: CaptureOptions, signal?: AbortSignal): Promise<PageCapture> {
    throwIfAborted(signal);
    const before = await this.identity(signal);
    const format = options?.format ?? "png";
    await this.controller.attachCdp();
    const result = await this.controller.cdp("Page.captureScreenshot", {
      format,
      fromSurface: true,
      captureBeyondViewport: options?.fullPage ?? false,
      ...(format === "png" || options?.quality === undefined ? {} : { quality: options.quality }),
    });
    throwIfAborted(signal);
    const data = result.data;
    if (typeof data !== "string" || data.length === 0) {
      throw new AgentError("INTERNAL_ERROR", "page capture returned no image data", { retryable: true });
    }
    const after = await this.identity(signal);
    if (before.documentId !== after.documentId || before.revision !== after.revision) {
      throw new AgentError("STALE_SNAPSHOT", "page changed while it was being captured", { retryable: true });
    }
    return {
      pageId: this.pageId,
      documentId: after.documentId,
      revision: after.revision,
      format,
      data,
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
      case "history":
        return this.history(action, token, expect, signal);
      case "reload":
        return this.reload(action, token, expect, signal);
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
    const target = await this.resolve(action.target, snapshot, signal);
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
    const target = await this.resolve(action.target, snapshot, signal);
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
    if (!activeBefore.ok || !activeBefore.visible || !activeBefore.enabled || !activeBefore.editable) {
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
    const target = await this.resolve(action.target, snapshot, signal);
    const frameId = String(target.node.frameId);
    const inspection = await this.inspect(target.ref, frameId, signal);
    if (
      !inspection.ok ||
      !inspection.visible ||
      !inspection.enabled ||
      (inspection.role !== "combobox" && inspection.role !== "listbox" && inspection.role !== "select")
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
    const target = await this.resolve(action.target, snapshot, signal);
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

  private async reload(
    action: Extract<AgentAction, { type: "reload" }>,
    token?: SnapshotToken,
    expect?: ActionExpectation,
    signal?: AbortSignal,
  ): Promise<Omit<ActionResult, "snapshot">> {
    const before = await this.identity(signal);
    this.assertToken(token ?? undefined, before.documentId, before.revision);
    throwIfAborted(signal);
    this.controller.reloadDocument(action.bypassCache ?? false);
    this.invalidateSnapshots();
    const outcome = await this.waitForOutcome(
      before,
      expect ?? { url: before.url, timeoutMs: 10_000 },
      signal,
    );
    const after = outcome.identity;
    const proof: ActionProof = { url: after.url, title: after.title };
    return { verified: outcome.satisfied, effects: this.transitionEffects(before, after), proof };
  }

  private async history(
    action: Extract<AgentAction, { type: "history" }>,
    token?: SnapshotToken,
    expect?: ActionExpectation,
    signal?: AbortSignal,
  ): Promise<Omit<ActionResult, "snapshot">> {
    const before = await this.identity(signal);
    this.assertToken(token ?? undefined, before.documentId, before.revision);
    throwIfAborted(signal);
    const moved = action.direction === "back" ? this.controller.back() : this.controller.forward();
    if (!moved) {
      throw new AgentError("HISTORY_UNAVAILABLE", `cannot go ${action.direction} from the current page`, {
        details: { direction: action.direction },
      });
    }
    this.invalidateSnapshots();
    const outcome = await this.waitForOutcome(before, expect, signal);
    const after = outcome.identity;
    const proof: ActionProof = { url: after.url, title: after.title };
    return {
      verified: hasExpectation(expect) ? outcome.satisfied : outcome.changed,
      effects: this.transitionEffects(before, after),
      proof,
    };
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
    const target = await this.resolve(action.target, snapshot, signal);
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
    const target = action.target ? await this.resolve(action.target, snapshot, signal) : null;
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

  async dialog(dialogId: string, action: DialogAction, signal?: AbortSignal): Promise<PageDialogResult> {
    throwIfAborted(signal);
    const pending = this.controller.agentDialog(dialogId);
    if (!pending) {
      throw new AgentError("DIALOG_NOT_FOUND", "dialog is no longer pending", {
        retryable: true,
        details: { dialogId },
      });
    }
    if (action.type === "accept" && action.promptText !== undefined && pending.dialogType !== "prompt") {
      throw new AgentError("INVALID_REQUEST", "promptText is only valid for prompt dialogs", {
        details: { dialogId, dialogType: pending.dialogType },
      });
    }
    const result = await this.controller.handleAgentDialog(dialogId, action as BrowserAgentDialogAction);
    throwIfAborted(signal);
    if (!result) {
      throw new AgentError("DIALOG_NOT_FOUND", "dialog is no longer pending", {
        retryable: true,
        details: { dialogId },
      });
    }
    return {
      pageId: this.pageId,
      dialogId: result.dialogId,
      dialogType: result.dialogType,
      message: result.message,
      url: result.url,
      ...(result.defaultPrompt === undefined ? {} : { defaultPrompt: result.defaultPrompt }),
      handled: result.handled === "accepted" ? "accepted" : "dismissed",
      ...(result.promptText === undefined ? {} : { promptText: result.promptText }),
    };
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
    const fallbackMs = condition.type === "stable" ? Math.max(1, condition.quietMs) : WAIT_FALLBACK_MS;
    const result = await this.waitForUpdates(deadline, signal, async () => {
      const identity = await this.identity(signal);
      let satisfied = false;
      if (condition.type === "url") satisfied = identity.url.includes(condition.value);
      if (condition.type === "text") {
        const snapshot = await this.snapshot({ interactiveOnly: false }, signal);
        if (condition.target) {
          try {
            const target = await this.resolve(condition.target, snapshot, signal, { includeHidden: true });
            satisfied = matchesSnapshotNodeText(target.node, condition.value);
          } catch (error) {
            if (signal?.aborted) throw error;
          }
        } else {
          satisfied = snapshot.nodes.some((node) =>
            matchesSnapshotNodeText(node, condition.value),
          );
        }
      }
      if (condition.type === "element") {
        const snapshot = await this.snapshot({ interactiveOnly: false }, signal);
        try {
          const target = await this.resolve(condition.target, snapshot, signal, { includeHidden: true });
          satisfied = matchesWaitElementState(target.node, condition.state);
        } catch (error) {
          if (signal?.aborted) throw error;
          if (!(error instanceof AgentError) || error.code !== "TARGET_NOT_FOUND") throw error;
          if (condition.state?.attached === false && !snapshot.truncated) satisfied = true;
        }
      }
      if (condition.type === "stable") {
        if (stableRevision !== identity.revision) {
          stableRevision = identity.revision;
          stableSince = Date.now();
        }
        satisfied = Date.now() - stableSince >= condition.quietMs;
      }
      return {
        done: satisfied,
        value: { satisfied, elapsedMs: Date.now() - started },
      };
    }, fallbackMs);
    return result.satisfied
      ? result
      : { satisfied: false, elapsedMs: Math.max(result.elapsedMs, Date.now() - started) };
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

  private async waitForUpdates<T>(
    deadline: number,
    signal: AbortSignal | undefined,
    check: () => Promise<{ done: boolean; value: T }>,
    fallbackMs = WAIT_FALLBACK_MS,
  ): Promise<T> {
    await this.startObservation(signal);
    let wake: (() => void) | null = null;
    let updateVersion = 0;
    const subscription = this.events.subscribe((event) => {
      if (!WAIT_WAKE_EVENTS.has(event.event)) return;
      updateVersion += 1;
      wake?.();
    }, { afterSequence: this.events.latestSequence });
    try {
      while (true) {
        throwIfAborted(signal);
        const versionAtStart = updateVersion;
        const result = await check();
        if (result.done) return result.value;
        if (updateVersion !== versionAtStart) continue;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return result.value;
        await waitForWake(Math.min(fallbackMs, remaining), signal, (next) => {
          wake = next;
        });
      }
    } finally {
      subscription.unsubscribe();
      wake = null;
    }
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
    this.lastSnapshotInvalidated = true;
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
    if (event.event === "dialog") {
      this.emit("dialog", event.data);
      return;
    }
    if (event.event !== "dom.changed") return;
    const data = event.data && typeof event.data === "object"
      ? event.data as Record<string, unknown>
      : null;
    if (data?.frameId && data.frameId !== "main") this.remoteRevision += 1;
    this.invalidateSnapshots();
    this.emit("dom.changed", event.data);
  }

  private handleAgentEvent(event: BrowserAgentEvent): void {
    this.emit(event.type, event.data);
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
    const hasExpectation = !!expect && (
      expect.url !== undefined ||
      expect.title !== undefined ||
      expect.text !== undefined ||
      expect.element !== undefined
    );
    const timeoutMs = hasExpectation ? expect?.timeoutMs ?? 2_000 : 250;
    const deadline = Date.now() + Math.max(0, timeoutMs);
    let last = { identity: before, changed: false, satisfied: false };
    return this.waitForUpdates(deadline, signal, async () => {
      try {
        throwIfAborted(signal);
        const identity = await this.identity(signal);
        const changed = identityChanged(before, identity);
        const satisfied = hasExpectation ? await this.matchesExpectation(expect!, identity, signal) : changed;
        last = { identity, changed, satisfied };
        return {
          done: satisfied || (changed && !identity.loading),
          value: last,
        };
      } catch (error) {
        if (signal?.aborted) throw error;
        return { done: false, value: last };
      }
    });
  }

  private async matchesExpectation(expect: ActionExpectation, identity: PageIdentity, signal?: AbortSignal): Promise<boolean> {
    if (expect.url !== undefined && !identity.url.includes(expect.url)) return false;
    if (expect.title !== undefined && !identity.title.includes(expect.title)) return false;
    if (expect.text !== undefined) {
      const snapshot = await this.snapshot({ interactiveOnly: false }, signal);
      if (
        !snapshot.nodes.some((node) =>
          matchesSnapshotNodeText(node, expect.text!),
        )
      ) {
        return false;
      }
    }
    if (expect.element !== undefined) {
      const snapshot = await this.snapshot({ interactiveOnly: false }, signal);
      try {
        const target = await this.resolve(expect.element.target, snapshot, signal, { includeHidden: true });
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

function waitForWake(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  setWake: (wake: (() => void) | null) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let onAbort: (() => void) | null = null;
    let settled = false;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      setWake(null);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    setWake(finish);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    timer = setTimeout(finish, Math.max(0, timeoutMs));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function originForUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function nodesForRefs(refs: readonly string[], snapshot: SnapshotView, includeHidden: boolean) {
  const wanted = new Set(refs);
  return snapshot.nodes.filter((node) => wanted.has(String(node.ref)) && (includeHidden || node.visible));
}

function snapshotOptionsKey(options?: SnapshotOptions): string {
  return JSON.stringify({
    interactiveOnly: options?.interactiveOnly ?? true,
    includeGeometry: options?.includeGeometry !== false,
    includeText: options?.includeText !== false,
    maxNodes: options?.maxNodes ?? 1000,
  });
}

function cssQueryScript(key: string, selector: string): string {
  return `(() => {
    let roots;
    try {
      roots = [document];
      const visited = new Set(roots);
      for (let index = 0; index < roots.length; index += 1) {
        const elements = roots[index].querySelectorAll("*");
        for (const element of elements) {
          if (element.shadowRoot && !visited.has(element.shadowRoot)) {
            visited.add(element.shadowRoot);
            roots.push(element.shadowRoot);
          }
        }
      }
      const matches = [];
      for (const root of roots) matches.push(...root.querySelectorAll(${JSON.stringify(selector)}));
      const state = window[${JSON.stringify(key)}];
      if (!state) return { ok: true, refs: [] };
      const refs = [];
      for (const element of matches) {
        let ref = state.elementRefs.get(element);
        if (!ref) {
          ref = state.frameId + ":r" + (++state.nextRef);
          state.elementRefs.set(element, ref);
          state.refs.set(ref, element);
        }
        refs.push(ref);
      }
      return { ok: true, refs: [...new Set(refs)] };
    } catch (error) {
      if (error instanceof DOMException && error.name === "SyntaxError") return { ok: false, invalid: true };
      return { ok: false };
    }
  })()`;
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

    ${snapshotNodeHelpersScript()}
    const visit = (el, parent, parentVisible) => {
      if (!el) return;
      if (nodes.length >= maxNodes) { truncated = true; return; }
      const captured = captureNode(el, parent, parentVisible);
      let nextParent = parent;
      if (captured.included && captured.node) {
        nodes.push(captured.node);
        nextParent = captured.ref;
      }
      for (const child of el.children) visit(child, nextParent, captured.visible);
      if (el.shadowRoot) {
        state.observeRoot(el.shadowRoot);
        for (const child of el.shadowRoot.children) visit(child, nextParent, captured.visible);
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

function semanticHelpersScript(): string {
  return `
    const text = (value) => String(value ?? "").replace(/\\s+/g, " ").trim().slice(0, 240);
    const rawTextFor = (el) => text(el.innerText || el.textContent || "");
    const firstToken = (value) => String(value ?? "").trim().split(/\\s+/)[0]?.toLocaleLowerCase() || "";
    const typeFor = (el) => String(el.type || el.getAttribute("type") || "text").toLocaleLowerCase();
    const styleFor = (el) => {
      const view = el.ownerDocument && el.ownerDocument.defaultView;
      return view ? view.getComputedStyle(el) : getComputedStyle(el);
    };
    const parentFor = (el) => {
      if (el.parentElement) return el.parentElement;
      const root = el.getRootNode && el.getRootNode();
      return root && root.host ? root.host : null;
    };
    const rootFor = (el) => {
      const root = el && typeof el.getRootNode === "function" ? el.getRootNode() : null;
      return root && (typeof root.querySelectorAll === "function" || typeof root.getElementById === "function")
        ? root
        : el.ownerDocument;
    };
    const findById = (el, id) => {
      const root = rootFor(el);
      if (root && typeof root.getElementById === "function") {
        const candidate = root.getElementById(id);
        if (candidate) return candidate;
      }
      if (root && typeof root.querySelectorAll === "function") {
        for (const candidate of root.querySelectorAll("[id]")) {
          if (candidate.id === id) return candidate;
        }
      }
      return null;
    };
    const roleFor = (el) => {
      const explicit = firstToken(el.getAttribute("role"));
      if (explicit) return explicit;
      const tag = String(el.tagName || "").toLocaleUpperCase();
      if ((tag === "A" || tag === "AREA") && el.hasAttribute("href")) return "link";
      if (tag === "BUTTON") return "button";
      if (tag === "SELECT") return el.multiple ? "listbox" : "combobox";
      if (tag === "TEXTAREA") return "textbox";
      if (tag === "INPUT") {
        const type = typeFor(el);
        if (type === "hidden") return "generic";
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "search") return "searchbox";
        if (type === "range") return "slider";
        if (type === "number") return "spinbutton";
        if (["button", "submit", "reset", "image", "file"].includes(type)) return "button";
        return "textbox";
      }
      if (tag === "OPTION") return "option";
      if (tag === "IMG") return "img";
      if (tag === "NAV") return "navigation";
      if (tag === "MAIN") return "main";
      if (tag === "ASIDE") return "complementary";
      if (tag === "DIALOG") return "dialog";
      if (tag === "FORM") return "form";
      if (tag === "UL" || tag === "OL") return "list";
      if (tag === "LI") return "listitem";
      if (tag === "TABLE") return "table";
      if (tag === "TR") return "row";
      if (tag === "TD") return "cell";
      if (tag === "TH") return el.scope === "row" ? "rowheader" : "columnheader";
      if (tag === "PROGRESS") return "progressbar";
      if (tag === "METER") return "meter";
      if (tag === "SUMMARY") return "button";
      if (/^H[1-6]$/.test(tag)) return "heading";
      if (el.isContentEditable || el.getAttribute("contenteditable") === "true") return "textbox";
      return "generic";
    };
    const referencedNameFor = (el) => {
      const ids = String(el.getAttribute("aria-labelledby") || "").trim().split(/\\s+/).filter(Boolean);
      return text(ids.map((id) => {
        const referenced = findById(el, id);
        return referenced ? rawTextFor(referenced) : "";
      }).filter(Boolean).join(" "));
    };
    const labelTextFor = (label) => rawTextFor(label);
    const nameFor = (el) => {
      const referenced = referencedNameFor(el);
      if (referenced) return referenced;
      if (el.hasAttribute("aria-label")) return text(el.getAttribute("aria-label"));
      if (el.labels && el.labels.length) {
        const labels = text(Array.from(el.labels).map(labelTextFor).join(" "));
        if (labels) return labels;
      }
      const tag = String(el.tagName || "").toLocaleUpperCase();
      const type = typeFor(el);
      if ((tag === "IMG" || tag === "AREA") && el.hasAttribute("alt")) return text(el.alt);
      if (tag === "INPUT" && ["button", "submit", "reset", "image", "file"].includes(type)) {
        return text(el.value || el.getAttribute("value") || el.alt || "");
      }
      if (tag === "INPUT" && el.getAttribute("placeholder")) return text(el.getAttribute("placeholder"));
      if (el.title) return text(el.title);
      return rawTextFor(el);
    };
    const ariaBooleanFor = (el, name) => {
      const value = el.getAttribute(name);
      if (value === null) return undefined;
      if (value === "true") return true;
      if (value === "false") return false;
      return undefined;
    };
    const hiddenFor = (el) => {
      let current = el;
      while (current && current.nodeType === 1) {
        const style = styleFor(current);
        if (
          current.hasAttribute("hidden") ||
          current.getAttribute("aria-hidden") === "true" ||
          current.hasAttribute("inert") ||
          current.inert ||
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse" ||
          style.opacity === "0" ||
          style.contentVisibility === "hidden"
        ) return true;
        current = parentFor(current);
      }
      return false;
    };
    const visibleFor = (el) => {
      if (hiddenFor(el)) return false;
      const style = styleFor(el);
      const rect = el.getBoundingClientRect();
      return style.display === "contents" || (rect.width > 0 && rect.height > 0);
    };
    const disabledFor = (el) => {
      let current = el;
      while (current && current.nodeType === 1) {
        if (
          current.disabled === true ||
          current.getAttribute("aria-disabled") === "true" ||
          current.hasAttribute("inert") ||
          current.inert ||
          current.getAttribute("aria-hidden") === "true"
        ) return true;
        if (current.tagName === "FIELDSET" && current.disabled === true) {
          const firstLegend = Array.from(current.children || []).find((child) => child.tagName === "LEGEND");
          if (!firstLegend || !firstLegend.contains(el)) return true;
        }
        current = parentFor(current);
      }
      return false;
    };
    const enabledFor = (el) => !disabledFor(el) && !hiddenFor(el);
    const interactiveRoles = new Set([
      "button", "checkbox", "combobox", "gridcell", "link", "listbox", "menuitem", "option",
      "radio", "searchbox", "slider", "spinbutton", "switch", "tab", "textbox", "treeitem",
      "region", "main", "navigation", "complementary", "dialog",
    ]);
    const interactiveFor = (el, role) => (
      interactiveRoles.has(role) ||
      el.matches("a[href],button,input:not([type=hidden]),select,textarea,summary,[tabindex],[contenteditable=true]") ||
      el.isContentEditable
    );
    const focusableFor = (el) => enabledFor(el) && (
      el.tabIndex >= 0 || el.matches("a[href],button,input:not([type=hidden]),select,textarea,summary")
    );
    const activeFor = (el) => {
      const root = el.getRootNode();
      let active = root && root.activeElement ? root.activeElement : el.ownerDocument.activeElement;
      while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
      return active;
    };
    const checkedFor = (el) => {
      const aria = ariaBooleanFor(el, "aria-checked");
      if (aria !== undefined) return aria;
      if (el.tagName === "INPUT" && ["checkbox", "radio"].includes(typeFor(el)) && typeof el.checked === "boolean") return el.checked;
      return undefined;
    };
    const selectedFor = (el) => {
      const aria = ariaBooleanFor(el, "aria-selected");
      if (aria !== undefined) return aria;
      if (el.tagName === "OPTION" && typeof el.selected === "boolean") return el.selected;
      return undefined;
    };
    const pressedFor = (el) => ariaBooleanFor(el, "aria-pressed");
    const expandedFor = (el) => ariaBooleanFor(el, "aria-expanded");
    const editableFor = (el) => {
      if (!enabledFor(el) || el.readOnly === true || ariaBooleanFor(el, "aria-readonly") === true) return false;
      if (el.isContentEditable || el.getAttribute("contenteditable") === "true") return true;
      if (el.tagName === "TEXTAREA") return true;
      return el.tagName === "INPUT" && !["checkbox", "radio", "file", "hidden", "button", "submit", "reset", "image"].includes(typeFor(el));
    };
    const stateFor = (el) => {
      const value = {};
      if (disabledFor(el)) value.disabled = true;
      if (activeFor(el) === el) value.focused = true;
      const checked = checkedFor(el);
      if (typeof checked === "boolean") value.checked = checked;
      const selected = selectedFor(el);
      if (typeof selected === "boolean") value.selected = selected;
      const pressed = pressedFor(el);
      if (typeof pressed === "boolean") value.pressed = pressed;
      const expanded = expandedFor(el);
      if (typeof expanded === "boolean") value.expanded = expanded;
      const required = el.required === true || ariaBooleanFor(el, "aria-required") === true;
      if (required) value.required = true;
      const readOnly = el.readOnly === true || ariaBooleanFor(el, "aria-readonly") === true;
      if (readOnly) value.readOnly = true;
      const invalid = ariaBooleanFor(el, "aria-invalid") === true || (el.validity && el.validity.valid === false);
      if (invalid) value.invalid = true;
      if ("value" in el && typeof el.value === "string") value.value = el.value.slice(0, 240);
      return Object.keys(value).length ? value : undefined;
    };
    const attrsFor = (el) => {
      const attrs = {};
      for (const name of [
        "data-testid", "id", "role", "type", "aria-label", "aria-labelledby", "aria-describedby", "aria-disabled",
        "aria-checked", "aria-expanded", "aria-invalid", "aria-pressed", "aria-readonly", "aria-required", "aria-selected",
        "placeholder", "title", "name", "label", "hidden", "inert",
      ]) {
        const value = el.getAttribute(name);
        if (value !== null) attrs[name] = value;
      }
      return Object.keys(attrs).length ? attrs : undefined;
    };
  `;
}

function snapshotNodeHelpersScript(): string {
  return `
    ${semanticHelpersScript()}
    const boxFor = (el) => {
      const rect = el.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, rect };
    };
    const captureNode = (el, parent, parentVisible) => {
      const role = roleFor(el);
      const visible = parentVisible && visibleFor(el);
      if (interactiveOnly && !interactiveFor(el, role)) return { included: false, ref: parent, node: null, visible };
      let ref = state.elementRefs.get(el);
      if (!ref) {
        ref = state.frameId + ":r" + (++state.nextRef);
        state.elementRefs.set(el, ref);
      }
      let nodeId = state.elementNodeIds.get(el);
      if (!nodeId) {
        nodeId = state.frameId + ":" + state.documentId + ":n" + (++state.nextNodeId);
        state.elementNodeIds.set(el, nodeId);
      }
      state.nodeElements.set(
        nodeId,
        typeof WeakRef === "function" ? new WeakRef(el) : { deref: () => el },
      );
      state.refs.set(ref, el);
      const box = includeGeometry ? boxFor(el) : null;
      return {
        included: true,
        ref,
        node: {
          ref,
          nodeId,
          frameId: state.frameId,
          parent,
          role,
          name: nameFor(el),
          ...(includeText ? { text: text(el.innerText || el.textContent || "") } : {}),
          state: stateFor(el),
          ...(box ? { box: { x: box.x, y: box.y, width: box.width, height: box.height } } : {}),
          visible,
          enabled: enabledFor(el),
          focusable: focusableFor(el),
          attributes: attrsFor(el),
        },
        visible,
      };
    };
  `;
}

function incrementalSnapshotScript(
  key: string,
  options: SnapshotOptions | undefined,
  baseRevision: number,
  nodeIds: readonly string[],
  frameId: string,
): string {
  return `(() => {
    ${agentStateSetupScript(key, frameId)}
    const options = ${JSON.stringify(options ?? {})};
    const baseRevision = ${JSON.stringify(baseRevision)};
    const nodeIds = ${JSON.stringify(nodeIds)};
    const wanted = new Set(nodeIds);
    const interactiveOnly = options.interactiveOnly ?? true;
    const includeGeometry = options.includeGeometry !== false;
    const includeText = options.includeText !== false;
    if (state.frameId !== ${JSON.stringify(frameId)} || state.invalidationScheduled) return { ok: false, reason: "pending-invalidation" };
    if (state.revision < baseRevision) return { ok: false, reason: "revision-regressed" };
    const entries = state.changeLog.filter((entry) => entry.revision > baseRevision);
    if (state.revision > baseRevision && (
      entries.length === 0 ||
      entries[0].revision !== baseRevision + 1 ||
      entries[entries.length - 1].revision !== state.revision
    )) return { ok: false, reason: "mutation-history-gap" };
    const changedNodeIds = new Set();
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        if (!change || !["input", "change", "focusin", "focusout"].includes(change.kind)) return { ok: false, reason: "broad-change" };
        if (includeGeometry) return { ok: false, reason: "geometry-sensitive" };
        const element = change.element;
        if (!element || !element.isConnected) return { ok: false, reason: "detached-target" };
        if (change.kind === "change" && (element.tagName === "SELECT" || element.tagName === "OPTION")) {
          return { ok: false, reason: "select-change" };
        }
        const nodeId = state.elementNodeIds.get(element);
        if (!nodeId || !wanted.has(nodeId)) return { ok: false, reason: "target-not-in-base" };
        changedNodeIds.add(nodeId);
      }
    }

    ${snapshotNodeHelpersScript()}

    const refs = [];
    const refByNodeId = new Map();
    for (const nodeId of nodeIds) {
      const holder = state.nodeElements.get(nodeId);
      const element = holder && typeof holder.deref === "function" ? holder.deref() : null;
      if (!element || !element.isConnected) return { ok: false, reason: "base-node-unavailable" };
      const role = roleFor(element);
      if (interactiveOnly && !interactiveFor(element, role)) return { ok: false, reason: "inclusion-changed" };
      let ref = state.elementRefs.get(element);
      if (!ref) {
        ref = state.frameId + ":r" + (++state.nextRef);
        state.elementRefs.set(element, ref);
      }
      state.refs.set(ref, element);
      refByNodeId.set(nodeId, ref);
      refs.push({ nodeId, ref });
    }
    const changed = [];
    for (const nodeId of changedNodeIds) {
      const holder = state.nodeElements.get(nodeId);
      const element = holder && typeof holder.deref === "function" ? holder.deref() : null;
      const ref = refByNodeId.get(nodeId);
      if (!element || !ref) return { ok: false, reason: "changed-node-unavailable" };
      const captured = captureNode(element, null, true);
      if (!captured.included || !captured.node || captured.node.nodeId !== nodeId) {
        return { ok: false, reason: "changed-node-excluded" };
      }
      changed.push({ ...captured.node, ref });
    }
    state.snapshotRevision = state.revision;
    return {
      ok: true,
      documentId: state.documentId,
      revision: state.revision,
      url: location.href,
      title: document.title,
      rootFrameId: state.frameId,
      refs,
      changed,
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
        nextNodeId: 0,
        refs: new Map(),
        elementRefs: new WeakMap(),
        elementNodeIds: new WeakMap(),
        nodeElements: new Map(),
        changeLog: [],
        pendingChanges: [],
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
      const invalidate = (kind, element) => {
        state.pendingChanges.push({ kind, element });
        if (state.invalidationScheduled) return;
        state.invalidationScheduled = true;
        queueMicrotask(() => {
          state.invalidationScheduled = false;
          const changes = state.pendingChanges;
          state.pendingChanges = [];
          state.revision += 1;
          state.refs = new Map();
          state.elementRefs = new WeakMap();
          state.changeLog.push({ revision: state.revision, changes });
          while (state.changeLog.length > 64) state.changeLog.shift();
          emit();
        });
      };
      const observer = new MutationObserver(() => invalidate("mutation", null));
      const observedRoots = new WeakSet();
      const handledEvents = new WeakSet();
      const invalidateEvent = (event) => {
        if (handledEvents.has(event)) return;
        handledEvents.add(event);
        const target = event.target && event.target.nodeType === 1 ? event.target : null;
        invalidate(event.type, target);
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
    if (!state.nodeElements) state.nodeElements = new Map();
    if (!state.changeLog) state.changeLog = [];
    if (!state.pendingChanges) state.pendingChanges = [];
  `;
}

function inspectScript(key: string, ref: string, frameId: string): string {
  return `(() => {
    const state = window[${JSON.stringify(key)}];
    if (!state || state.frameId !== ${JSON.stringify(frameId)}) return { ok: false };
    const el = state && state.refs && state.refs.get(${JSON.stringify(ref)});
    if (!el || !el.isConnected) return { ok: false };
    el.scrollIntoView({ block: "center", inline: "center" });
    ${semanticHelpersScript()}
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const root = el.getRootNode();
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
    return {
      ok: true,
      x,
      y,
      visible: visibleFor(el),
      enabled: enabledFor(el),
      occluded: !!hit && !composedHit(el, hit),
      editable: editableFor(el),
      focused: activeFor(el) === el,
      role: roleFor(el),
      name: nameFor(el),
      value: "value" in el && typeof el.value === "string" ? el.value : undefined,
      checked: checkedFor(el),
      selected: selectedFor(el),
    };
  })()`;
}

function fillScript(key: string, ref: string, value: string): string {
  return `(() => {
    const state = window[${JSON.stringify(key)}];
    const el = state && state.refs && state.refs.get(${JSON.stringify(ref)});
    if (!el || !el.isConnected) return { ok: false };
    ${semanticHelpersScript()}
    const editable = editableFor(el);
    const role = roleFor(el);
    const name = nameFor(el);
    if (!editable || !enabledFor(el) || !visibleFor(el)) {
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
    if (!el || !el.isConnected) return { ok: false };
    ${semanticHelpersScript()}
    if (el.tagName !== "SELECT" || !enabledFor(el) || !visibleFor(el)) {
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
    if (!el || !el.isConnected) return { ok: false };
    ${semanticHelpersScript()}
    const type = typeFor(el);
    const role = roleFor(el);
    const ariaCheckable = ["checkbox", "radio", "switch"].includes(role) && el.hasAttribute("aria-checked");
    const nativeCheckable = el.tagName === "INPUT" && (type === "checkbox" || type === "radio");
    if ((!nativeCheckable && !ariaCheckable) || !enabledFor(el) || !visibleFor(el)) {
      return { ok: false };
    }
    const before = checkedFor(el);
    if (type === "radio" && !${checked} && before) return { ok: false, checked: true };
    if (before !== ${checked}) el.click();
    const after = checkedFor(el);
    return { ok: typeof after === "boolean", checked: after };
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
    ${semanticHelpersScript()}
    return {
      ok: true,
      enabled: enabledFor(el),
      visible: visibleFor(el),
      editable: editableFor(el),
      role: roleFor(el),
      name: nameFor(el),
      value: "value" in el ? String(el.value ?? "") : String(el.innerText ?? ""),
    };
  })()`;
}

function isScriptState(value: unknown): value is PageScriptState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return typeof state.documentId === "string" && typeof state.revision === "number";
}

function isIncrementalSnapshotResult(value: unknown): value is IncrementalSnapshotResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return (
    result.ok === true &&
    typeof result.documentId === "string" &&
    typeof result.revision === "number" &&
    typeof result.url === "string" &&
    typeof result.title === "string" &&
    typeof result.rootFrameId === "string" &&
    Array.isArray(result.refs) &&
    result.refs.every((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const value = entry as Record<string, unknown>;
      return typeof value.nodeId === "string" && typeof value.ref === "string";
    }) &&
    Array.isArray(result.changed) &&
    result.changed.every(isSnapshotNode)
  );
}

function isSnapshotNode(value: unknown): value is SnapshotNode {
  if (!value || typeof value !== "object") return false;
  const node = value as Record<string, unknown>;
  return (
    typeof node.ref === "string" &&
    typeof node.nodeId === "string" &&
    typeof node.frameId === "string" &&
    (node.parent === null || typeof node.parent === "string") &&
    typeof node.role === "string" &&
    typeof node.name === "string" &&
    (node.text === undefined || typeof node.text === "string") &&
    typeof node.visible === "boolean" &&
    typeof node.enabled === "boolean" &&
    typeof node.focusable === "boolean"
  );
}

function frameKey(frame: BrowserAgentFrame): string {
  return frame.parentId === null ? "main" : frame.id;
}

function rebuildIncrementalNodes(
  baseNodes: readonly SnapshotNode[],
  value: IncrementalSnapshotResult,
): SnapshotNode[] | null {
  if (!value.refs || !value.changed || value.documentId === undefined || value.revision === undefined) return null;
  const baseByNodeId = new Map<string, SnapshotNode>();
  const baseKeyByRef = new Map<string, string>();
  for (const node of baseNodes) {
    if (!node.nodeId || baseByNodeId.has(node.nodeId) || baseKeyByRef.has(String(node.ref))) return null;
    baseByNodeId.set(node.nodeId, node);
    baseKeyByRef.set(String(node.ref), node.nodeId);
  }
  const refByNodeId = new Map<string, string>();
  for (const entry of value.refs) {
    if (!baseByNodeId.has(entry.nodeId) || refByNodeId.has(entry.nodeId)) return null;
    refByNodeId.set(entry.nodeId, entry.ref);
  }
  if (refByNodeId.size !== baseByNodeId.size) return null;
  const changedByNodeId = new Map<string, SnapshotNode>();
  for (const node of value.changed) {
    if (!node.nodeId || !baseByNodeId.has(node.nodeId) || changedByNodeId.has(node.nodeId)) return null;
    changedByNodeId.set(node.nodeId, node);
  }
  const nodes = baseNodes.map((baseNode) => {
    const nodeId = baseNode.nodeId!;
    const ref = refByNodeId.get(nodeId);
    if (!ref) return null;
    const parentKey = baseNode.parent === null ? null : baseKeyByRef.get(String(baseNode.parent));
    if (parentKey === undefined) return null;
    const parent = parentKey === null ? null : refByNodeId.get(parentKey);
    if (parentKey !== null && parent === undefined) return null;
    const node = changedByNodeId.get(nodeId) ?? baseNode;
    return {
      ...node,
      ref: asSnapshotRef(ref),
      nodeId,
      parent: parent === null ? null : asSnapshotRef(parent!),
    };
  });
  if (nodes.some((node) => node === null)) return null;
  return nodes as SnapshotNode[];
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

function isCssQueryResult(value: unknown): value is CssQueryResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.ok === "boolean" &&
    (result.invalid === undefined || typeof result.invalid === "boolean") &&
    (result.refs === undefined || (Array.isArray(result.refs) && result.refs.every((ref) => typeof ref === "string")))
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
