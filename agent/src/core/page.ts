import { RevisionLedger } from "./revisions";
import { throwIfAborted } from "./cancellation";
import { SnapshotLocatorResolver } from "./locator";
import { AgentError } from "../protocol/errors";
import { applySnapshotDelta, diffSnapshots } from "./snapshots";
import type { EventSubscription, EventSubscriptionOptions } from "./events";
import type { ResolvedTarget, SnapshotView } from "./locator";
import type {
  ActionExpectation,
  ActionResult,
  AgentAction,
  AgentEvent,
  CaptureOptions,
  DocumentId,
  PageIdentity,
  PageCapture,
  PageFrameSnapshot,
  PageSnapshot,
  PageSnapshotDelta,
  SnapshotOptions,
  SnapshotToken,
  Target,
  WaitCondition,
  WaitResult,
} from "../protocol/types";
import { asSnapshotId } from "../protocol/types";
import type { PageId } from "../protocol/types";

export interface PageBackend {
  readonly pageId: PageId;
  resolve?(target: Target, snapshot: SnapshotView, signal?: AbortSignal): Promise<ResolvedTarget>;
  identity(signal?: AbortSignal): Promise<PageIdentity>;
  frames(signal?: AbortSignal): Promise<PageFrameSnapshot>;
  snapshot(options?: SnapshotOptions, signal?: AbortSignal): Promise<Omit<PageSnapshot, "snapshotId">>;
  snapshotDelta?(
    base: PageSnapshot,
    options?: SnapshotOptions,
    signal?: AbortSignal,
  ): Promise<SnapshotDeltaCapture | undefined>;
  capture?(options?: CaptureOptions, signal?: AbortSignal): Promise<PageCapture>;
  act(
    action: AgentAction,
    token?: SnapshotToken,
    expect?: ActionExpectation,
    signal?: AbortSignal,
  ): Promise<Omit<ActionResult, "snapshot">>;
  wait(condition: WaitCondition, timeoutMs?: number, signal?: AbortSignal): Promise<Omit<WaitResult, "snapshot">>;
  subscribe(
    listener: (event: AgentEvent) => void,
    options?: EventSubscriptionOptions,
    signal?: AbortSignal,
  ): Promise<EventSubscription>;
}

export type SnapshotDeltaCapture = Omit<PageSnapshotDelta, "snapshotId" | "base">;

export interface PageSession {
  readonly pageId: PageId;
  resolve?(target: Target, snapshot: PageSnapshot, signal?: AbortSignal): Promise<ResolvedTarget>;
  frames(signal?: AbortSignal): Promise<PageFrameSnapshot>;
  snapshot(options?: SnapshotOptions, signal?: AbortSignal): Promise<PageSnapshot>;
  snapshotDelta(base: SnapshotToken, options?: SnapshotOptions, signal?: AbortSignal): Promise<PageSnapshotDelta>;
  capture?(options?: CaptureOptions, signal?: AbortSignal): Promise<PageCapture>;
  assertFresh(token: SnapshotToken): void;
  currentRevision(): { documentId: DocumentId; revision: number };
  advanceRevision(): { documentId: DocumentId; revision: number };
  navigate(documentId: DocumentId): { documentId: DocumentId; revision: number };
  act(action: AgentAction, token?: SnapshotToken, expect?: ActionExpectation, signal?: AbortSignal): Promise<ActionResult>;
  wait(condition: WaitCondition, timeoutMs?: number, signal?: AbortSignal): Promise<WaitResult>;
  subscribe(
    listener: (event: AgentEvent) => void,
    options?: EventSubscriptionOptions,
    signal?: AbortSignal,
  ): Promise<EventSubscription>;
}

export class RevisionedPageSession implements PageSession {
  private snapshotSequence = 0;
  private readonly snapshotHistory = new Map<string, SnapshotHistoryEntry>();
  private actionTail: Promise<void> = Promise.resolve();
  private readonly snapshotLocator = new SnapshotLocatorResolver();

  constructor(
    private readonly backend: PageBackend,
    private readonly ledger: RevisionLedger,
  ) {}

  get pageId(): PageId {
    return this.backend.pageId;
  }

  async resolve(target: Target, snapshot: PageSnapshot, signal?: AbortSignal): Promise<ResolvedTarget> {
    throwIfAborted(signal);
    if (this.backend.resolve) return this.backend.resolve(target, snapshot, signal);
    return this.snapshotLocator.resolve(target, snapshot);
  }

  async frames(signal?: AbortSignal): Promise<PageFrameSnapshot> {
    throwIfAborted(signal);
    const frames = await this.backend.frames(signal);
    throwIfAborted(signal);
    return frames;
  }

  async snapshot(options?: SnapshotOptions, signal?: AbortSignal): Promise<PageSnapshot> {
    throwIfAborted(signal);
    const captured = await this.backend.snapshot(options, signal);
    throwIfAborted(signal);
    const state = this.ledger.synchronize(captured.pageId, captured.documentId, captured.revision);
    const snapshot = {
      ...captured,
      revision: state.revision,
      snapshotId: asSnapshotId(`${this.pageId}:${++this.snapshotSequence}`),
    };
    this.rememberSnapshot(snapshot, options);
    return snapshot;
  }

  async snapshotDelta(base: SnapshotToken, options?: SnapshotOptions, signal?: AbortSignal): Promise<PageSnapshotDelta> {
    throwIfAborted(signal);
    const entry = this.snapshotHistory.get(String(base.snapshotId));
    if (
      !entry ||
      entry.snapshot.pageId !== base.pageId ||
      entry.snapshot.documentId !== base.documentId ||
      entry.snapshot.revision !== base.revision
    ) {
      throw new AgentError("SNAPSHOT_NOT_FOUND", "snapshot is not available for delta reconstruction", {
        retryable: true,
        details: { snapshotId: base.snapshotId },
      });
    }
    if (options !== undefined && snapshotOptionsKey(options) !== entry.optionsKey) {
      throw new AgentError("INVALID_REQUEST", "snapshot delta options must match the base snapshot options", {
        details: { snapshotId: base.snapshotId },
      });
    }
    if (this.backend.snapshotDelta) {
      const captured = await this.backend.snapshotDelta(entry.snapshot, entry.options, signal);
      if (captured) {
        throwIfAborted(signal);
        const state = this.ledger.synchronize(captured.pageId, captured.documentId, captured.revision);
        const snapshotId = asSnapshotId(`${this.pageId}:${++this.snapshotSequence}`);
        const normalized = {
          ...captured,
          pageId: this.pageId,
          documentId: state.documentId,
          revision: state.revision,
          snapshotId,
          base,
        } satisfies PageSnapshotDelta;
        this.rememberSnapshot(
          applySnapshotDelta(entry.snapshot, normalized, snapshotId),
          entry.options,
        );
        return normalized;
      }
    }
    const current = await this.snapshot(entry.options, signal);
    return diffSnapshots(entry.snapshot, current);
  }

  async capture(options?: CaptureOptions, signal?: AbortSignal): Promise<PageCapture> {
    throwIfAborted(signal);
    if (!this.backend.capture) {
      throw new AgentError("CAPABILITY_UNAVAILABLE", "page capture is unavailable", {
        details: { capability: "page.capture" },
      });
    }
    const capture = await this.backend.capture(options, signal);
    throwIfAborted(signal);
    return capture;
  }

  assertFresh(token: SnapshotToken): void {
    this.ledger.assertFresh(token);
  }

  currentRevision() {
    const current = this.ledger.current(this.pageId);
    return { documentId: current.documentId, revision: current.revision };
  }

  advanceRevision() {
    const current = this.ledger.advance(this.pageId);
    return { documentId: current.documentId, revision: current.revision };
  }

  navigate(documentId: DocumentId) {
    const current = this.ledger.navigate(this.pageId, documentId);
    return { documentId: current.documentId, revision: current.revision };
  }

  async act(
    action: AgentAction,
    token?: SnapshotToken,
    expect?: ActionExpectation,
    signal?: AbortSignal,
  ): Promise<ActionResult> {
    return this.enqueueAction(async () => {
      throwIfAborted(signal);
      const before = await this.backend.identity(signal);
      this.ledger.synchronize(before.pageId, before.documentId, before.revision);
      if (token) this.ledger.assertFresh(token);
      const result = await this.backend.act(action, token, expect, signal);
      throwIfAborted(signal);
      const after = await this.backend.identity(signal);
      this.ledger.synchronize(after.pageId, after.documentId, after.revision);
      return { ...result, snapshot: await this.snapshot(undefined, signal) };
    }, signal);
  }

  async wait(condition: WaitCondition, timeoutMs?: number, signal?: AbortSignal): Promise<WaitResult> {
    const result = await this.backend.wait(condition, timeoutMs, signal);
    return result.satisfied ? { ...result, snapshot: await this.snapshot(undefined, signal) } : result;
  }

  async subscribe(
    listener: (event: AgentEvent) => void,
    options?: EventSubscriptionOptions,
    signal?: AbortSignal,
  ): Promise<EventSubscription> {
    throwIfAborted(signal);
    return this.backend.subscribe(listener, options, signal);
  }

  private enqueueAction<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const run = () => {
      throwIfAborted(signal);
      return operation();
    };
    const result = this.actionTail.then(run, run);
    this.actionTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private rememberSnapshot(snapshot: PageSnapshot, options?: SnapshotOptions): void {
    this.snapshotHistory.set(String(snapshot.snapshotId), {
      snapshot,
      options: options === undefined ? undefined : { ...options },
      optionsKey: snapshotOptionsKey(options),
    });
    while (this.snapshotHistory.size > 32) {
      const oldest = this.snapshotHistory.keys().next().value;
      if (oldest === undefined) return;
      this.snapshotHistory.delete(oldest);
    }
  }
}

interface SnapshotHistoryEntry {
  snapshot: PageSnapshot;
  options?: SnapshotOptions;
  optionsKey: string;
}

function snapshotOptionsKey(options?: SnapshotOptions): string {
  return JSON.stringify({
    interactiveOnly: options?.interactiveOnly ?? true,
    includeGeometry: options?.includeGeometry !== false,
    includeText: options?.includeText !== false,
    maxNodes: options?.maxNodes ?? 1000,
  });
}
