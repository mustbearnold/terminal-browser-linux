import { RevisionLedger } from "./revisions";
import { MAX_AGENT_QUEUED_ACTIONS_PER_PAGE, throwIfAborted } from "./cancellation";
import { querySnapshot, SnapshotLocatorResolver } from "./locator";
import { AgentError } from "../protocol/errors";
import { applySnapshotDelta, diffSnapshots } from "./snapshots";
import type { EventSubscription, EventSubscriptionOptions } from "./events";
import type { LocatorResolutionOptions, ResolvedTarget, SnapshotView } from "./locator";
import type {
  ActionBatchResult,
  ActionBatchStep,
  ActionBatchStepResult,
  ActionEffect,
  ActionExpectation,
  ActionOutputOptions,
  ActionResult,
  AgentAction,
  AgentEvent,
  CaptureOptions,
  DialogAction,
  DocumentId,
  PageIdentity,
  PageCapture,
  PageActiveResult,
  PageDialogResult,
  PageFrameSnapshot,
  PageReadResult,
  PageQueryOptions,
  PageQueryBatchResult,
  PageQueryDiagnostic,
  PageQueryDiagnostics,
  PageQuerySpec,
  PageQueryResult,
  PageSnapshot,
  PageSnapshotWindow,
  PageSnapshotDelta,
  PageOutputOptions,
  Locator,
  SnapshotOptions,
  SnapshotToken,
  SnapshotWindowCursor,
  SnapshotWindowOptions,
  Target,
  WaitCondition,
  WaitOutputOptions,
  WaitResult,
} from "../protocol/types";
import { asSnapshotId, MAX_PAGE_QUERY_BATCH } from "../protocol/types";
import type { PageId } from "../protocol/types";

export interface PageBackend {
  readonly pageId: PageId;
  resolveTarget?(
    target: Target,
    signal?: AbortSignal,
    options?: LocatorResolutionOptions,
  ): Promise<ResolvedTarget>;
  resolve?(
    target: Target,
    snapshot: SnapshotView,
    signal?: AbortSignal,
    options?: LocatorResolutionOptions,
  ): Promise<ResolvedTarget>;
  identity(signal?: AbortSignal): Promise<PageIdentity>;
  frames(signal?: AbortSignal): Promise<PageFrameSnapshot>;
  snapshot(options?: SnapshotOptions, signal?: AbortSignal): Promise<Omit<PageSnapshot, "snapshotId">>;
  snapshotWindow?(
    options: SnapshotWindowOptions | undefined,
    offset: number,
    signal?: AbortSignal,
  ): Promise<SnapshotWindowCapture>;
  snapshotDelta?(
    base: PageSnapshot,
    options?: SnapshotOptions,
    signal?: AbortSignal,
  ): Promise<SnapshotDeltaCapture | undefined>;
  query?(
    locator: Locator,
    options?: PageQueryOptions,
    signal?: AbortSignal,
  ): Promise<Omit<PageQueryResult, "snapshotId">>;
  queryBatch?(
    queries: readonly PageQuerySpec[],
    signal?: AbortSignal,
  ): Promise<Omit<PageQueryBatchResult, "snapshotId">>;
  active?(signal?: AbortSignal): Promise<Omit<PageActiveResult, "snapshotId">>;
  capture?(options?: CaptureOptions, signal?: AbortSignal): Promise<PageCapture>;
  act(
    action: AgentAction,
    token?: SnapshotToken,
    expect?: ActionExpectation,
    signal?: AbortSignal,
  ): Promise<Omit<ActionResult, "snapshot">>;
  wait(condition: WaitCondition, timeoutMs?: number, signal?: AbortSignal): Promise<Omit<WaitResult, "snapshot">>;
  dialog?(dialogId: string, action: DialogAction, signal?: AbortSignal): Promise<PageDialogResult>;
  subscribe(
    listener: (event: AgentEvent) => void,
    options?: EventSubscriptionOptions,
    signal?: AbortSignal,
  ): Promise<EventSubscription>;
}

export type SnapshotDeltaCapture = Omit<PageSnapshotDelta, "snapshotId" | "base">;

export interface PageSession {
  readonly pageId: PageId;
  resolveTarget?(
    target: Target,
    token?: SnapshotToken,
    signal?: AbortSignal,
    options?: LocatorResolutionOptions,
  ): Promise<ResolvedTarget>;
  resolve?(
    target: Target,
    snapshot: PageSnapshot,
    signal?: AbortSignal,
    options?: LocatorResolutionOptions,
  ): Promise<ResolvedTarget>;
  frames(signal?: AbortSignal): Promise<PageFrameSnapshot>;
  query(
    locator: Locator,
    options?: PageQueryOptions,
    signal?: AbortSignal,
  ): Promise<PageQueryResult>;
  queryBatch(
    queries: readonly PageQuerySpec[],
    signal?: AbortSignal,
  ): Promise<PageQueryBatchResult>;
  read(target: Target, token?: SnapshotToken, signal?: AbortSignal): Promise<PageReadResult>;
  active(signal?: AbortSignal): Promise<PageActiveResult>;
  snapshot(options?: SnapshotOptions, signal?: AbortSignal): Promise<PageSnapshot>;
  snapshotWindow?(
    options?: SnapshotWindowOptions,
    cursor?: SnapshotWindowCursor,
    signal?: AbortSignal,
  ): Promise<PageSnapshotWindow>;
  snapshotDelta(base: SnapshotToken, options?: SnapshotOptions, signal?: AbortSignal): Promise<PageSnapshotDelta>;
  capture?(options?: CaptureOptions, signal?: AbortSignal): Promise<PageCapture>;
  assertFresh(token: SnapshotToken): void;
  currentRevision(): { documentId: DocumentId; revision: number };
  advanceRevision(): { documentId: DocumentId; revision: number };
  navigate(documentId: DocumentId): { documentId: DocumentId; revision: number };
  act(
    action: AgentAction,
    token?: SnapshotToken,
    expect?: ActionExpectation,
    signal?: AbortSignal,
    output?: ActionOutputOptions,
  ): Promise<ActionResult>;
  actBatch(
    steps: readonly ActionBatchStep[],
    signal?: AbortSignal,
    output?: ActionOutputOptions,
  ): Promise<ActionBatchResult>;
  wait(
    condition: WaitCondition,
    timeoutMs?: number,
    signal?: AbortSignal,
    output?: WaitOutputOptions,
  ): Promise<WaitResult>;
  dialog?(dialogId: string, action: DialogAction, signal?: AbortSignal): Promise<PageDialogResult>;
  subscribe(
    listener: (event: AgentEvent) => void,
    options?: EventSubscriptionOptions,
    signal?: AbortSignal,
  ): Promise<EventSubscription>;
}

export class RevisionedPageSession implements PageSession {
  private snapshotSequence = 0;
  private readonly snapshotHistory = new Map<string, SnapshotHistoryEntry>();
  private readonly snapshotWindowHistory = new Map<string, SnapshotWindowHistoryEntry>();
  private actionTail: Promise<void> = Promise.resolve();
  private actionQueueDepth = 0;
  private readonly snapshotLocator = new SnapshotLocatorResolver();

  constructor(
    private readonly backend: PageBackend,
    private readonly ledger: RevisionLedger,
    private readonly maxQueuedActions = MAX_AGENT_QUEUED_ACTIONS_PER_PAGE,
  ) {
    if (!Number.isSafeInteger(maxQueuedActions) || maxQueuedActions < 1) {
      throw new AgentError("INVALID_REQUEST", "max queued actions per page must be a positive safe integer");
    }
  }

  get pageId(): PageId {
    return this.backend.pageId;
  }

  async resolve(
    target: Target,
    snapshot: PageSnapshot,
    signal?: AbortSignal,
    options?: LocatorResolutionOptions,
  ): Promise<ResolvedTarget> {
    throwIfAborted(signal);
    if (this.backend.resolve) return this.backend.resolve(target, snapshot, signal, options);
    return this.snapshotLocator.resolve(target, snapshot, options);
  }

  async resolveTarget(
    target: Target,
    token?: SnapshotToken,
    signal?: AbortSignal,
    options?: LocatorResolutionOptions,
  ): Promise<ResolvedTarget> {
    throwIfAborted(signal);
    if (this.backend.resolveTarget) {
      const before = await this.backend.identity(signal);
      this.assertPageId(before.pageId, "identity");
      this.ledger.synchronize(before.pageId, before.documentId, before.revision);
      if (token) this.ledger.assertFresh(token);
      const resolved = await this.backend.resolveTarget(target, signal, options);
      throwIfAborted(signal);
      const after = await this.backend.identity(signal);
      this.assertPageId(after.pageId, "identity");
      this.ledger.synchronize(after.pageId, after.documentId, after.revision);
      if (token) this.ledger.assertFresh(token);
      return resolved;
    }
    const snapshot = await this.snapshot(undefined, signal);
    if (token) this.ledger.assertFresh(token);
    return this.resolve(target, snapshot, signal, options);
  }

  async frames(signal?: AbortSignal): Promise<PageFrameSnapshot> {
    throwIfAborted(signal);
    const captured = await this.backend.frames(signal);
    throwIfAborted(signal);
    this.assertPageId(captured.pageId, "frame tree");
    const state = this.ledger.synchronize(captured.pageId, captured.documentId, captured.revision);
    return {
      ...captured,
      pageId: this.pageId,
      documentId: state.documentId,
      revision: state.revision,
    };
  }

  async query(
    locator: Locator,
    options?: PageQueryOptions,
    signal?: AbortSignal,
  ): Promise<PageQueryResult> {
    throwIfAborted(signal);
    const normalizedOptions = normalizePageQueryOptions(options);
    const captured = this.backend.query
      ? await this.backend.query(locator, normalizedOptions, signal)
      : await this.queryFromSnapshot(locator, normalizedOptions, signal);
    throwIfAborted(signal);
    this.assertPageId(captured.pageId, "query");
    const state = this.ledger.synchronize(captured.pageId, captured.documentId, captured.revision);
    if (
      captured.nodes.length > normalizedOptions.limit ||
      captured.hiddenNodes.length > normalizedOptions.limit ||
      captured.matchCount < captured.nodes.length ||
      captured.hiddenMatchCount < captured.hiddenNodes.length
    ) {
      throw new AgentError("INTERNAL_ERROR", "query backend returned an invalid result");
    }
    return {
      ...captured,
      pageId: this.pageId,
      documentId: state.documentId,
      revision: state.revision,
      snapshotId: asSnapshotId(`${this.pageId}:query:${++this.snapshotSequence}`),
    };
  }

  async queryBatch(
    queries: readonly PageQuerySpec[],
    signal?: AbortSignal,
  ): Promise<PageQueryBatchResult> {
    throwIfAborted(signal);
    const normalizedQueries = normalizePageQueryBatch(queries);
    const captured = this.backend.queryBatch
      ? await this.backend.queryBatch(normalizedQueries, signal)
      : await this.queryBatchFromSnapshot(normalizedQueries, signal);
    throwIfAborted(signal);
    this.assertPageId(captured.pageId, "query batch");
    const state = this.ledger.synchronize(captured.pageId, captured.documentId, captured.revision);
    if (
      captured.queries.length !== normalizedQueries.length ||
      captured.queries.some((entry, index) => {
        const limit = normalizedQueries[index].options.limit;
        return (
          entry.nodes.length > limit ||
          entry.hiddenNodes.length > limit ||
          entry.matchCount < entry.nodes.length ||
          entry.hiddenMatchCount < entry.hiddenNodes.length
        );
      })
    ) {
      throw new AgentError("INTERNAL_ERROR", "query batch backend returned an invalid result");
    }
    return {
      ...captured,
      pageId: this.pageId,
      documentId: state.documentId,
      revision: state.revision,
      snapshotId: asSnapshotId(`${this.pageId}:query-batch:${++this.snapshotSequence}`),
    };
  }

  async read(target: Target, token?: SnapshotToken, signal?: AbortSignal): Promise<PageReadResult> {
    throwIfAborted(signal);
    const before = await this.backend.identity(signal);
    this.assertPageId(before.pageId, "identity");
    this.ledger.synchronize(before.pageId, before.documentId, before.revision);
    if (token) this.ledger.assertFresh(token);

    let resolved: ResolvedTarget;
    if (this.backend.resolveTarget) {
      resolved = await this.backend.resolveTarget(target, signal);
    } else {
      const snapshot = await this.snapshot({ interactiveOnly: false }, signal);
      if (token) this.ledger.assertFresh(token);
      resolved = this.backend.resolve
        ? await this.backend.resolve(target, snapshot, signal)
        : this.snapshotLocator.resolve(target, snapshot);
    }

    throwIfAborted(signal);
    const after = await this.backend.identity(signal);
    this.assertPageId(after.pageId, "identity");
    const state = this.ledger.synchronize(after.pageId, after.documentId, after.revision);
    if (before.documentId !== after.documentId || before.revision !== after.revision) {
      throw new AgentError("STALE_SNAPSHOT", "page changed while reading the target", { retryable: true });
    }
    if (token) this.ledger.assertFresh(token);
    return {
      pageId: this.pageId,
      documentId: state.documentId,
      revision: state.revision,
      snapshotId: asSnapshotId(`${this.pageId}:read:${++this.snapshotSequence}`),
      target,
      url: after.url,
      title: after.title,
      node: resolved.node,
    };
  }

  async active(signal?: AbortSignal): Promise<PageActiveResult> {
    throwIfAborted(signal);
    if (!this.backend.active) {
      throw new AgentError("CAPABILITY_UNAVAILABLE", "active element reads are unavailable", {
        details: { capability: "page.active" },
      });
    }
    const captured = await this.backend.active(signal);
    throwIfAborted(signal);
    this.assertPageId(captured.pageId, "active element");
    const state = this.ledger.synchronize(captured.pageId, captured.documentId, captured.revision);
    return {
      ...captured,
      pageId: this.pageId,
      documentId: state.documentId,
      revision: state.revision,
      snapshotId: asSnapshotId(`${this.pageId}:active:${++this.snapshotSequence}`),
    };
  }

  async snapshot(options?: SnapshotOptions, signal?: AbortSignal): Promise<PageSnapshot> {
    throwIfAborted(signal);
    const captured = await this.backend.snapshot(options, signal);
    throwIfAborted(signal);
    this.assertPageId(captured.pageId, "snapshot");
    const state = this.ledger.synchronize(captured.pageId, captured.documentId, captured.revision);
    const snapshot = {
      ...captured,
      pageId: this.pageId,
      documentId: state.documentId,
      revision: state.revision,
      snapshotId: asSnapshotId(`${this.pageId}:${++this.snapshotSequence}`),
    };
    this.rememberSnapshot(snapshot, options);
    return snapshot;
  }

  private async queryFromSnapshot(
    locator: Locator,
    options: PageQueryOptions & { limit: number },
    signal?: AbortSignal,
  ): Promise<Omit<PageQueryResult, "snapshotId">> {
    const snapshot = await this.snapshot({ interactiveOnly: false }, signal);
    const matches = querySnapshot(locator, snapshot, options);
    return {
      pageId: snapshot.pageId,
      documentId: snapshot.documentId,
      revision: snapshot.revision,
      locator,
      url: snapshot.url,
      title: snapshot.title,
      rootFrameId: snapshot.rootFrameId,
      nodes: matches.candidates,
      matchCount: matches.candidateCount,
      hiddenNodes: matches.hiddenCandidates,
      hiddenMatchCount: matches.hiddenCandidateCount,
      truncated: matches.candidatesTruncated,
      hiddenTruncated: matches.hiddenCandidatesTruncated,
      ...(options.diagnostics === "summary"
        ? {
            diagnostics: snapshotQueryDiagnostics(snapshot, 1, [{
              index: 0,
              matchCount: matches.candidateCount,
              hiddenMatchCount: matches.hiddenCandidateCount,
            }]),
          }
        : {}),
    };
  }

  private async queryBatchFromSnapshot(
    queries: readonly NormalizedPageQuerySpec[],
    signal?: AbortSignal,
  ): Promise<Omit<PageQueryBatchResult, "snapshotId">> {
    const snapshot = await this.snapshot({ interactiveOnly: false }, signal);
    const results = queries.map(({ locator, options }) => {
      const matches = querySnapshot(locator, snapshot, options);
      return {
        locator,
        nodes: matches.candidates,
        matchCount: matches.candidateCount,
        hiddenNodes: matches.hiddenCandidates,
        hiddenMatchCount: matches.hiddenCandidateCount,
        truncated: matches.candidatesTruncated,
        hiddenTruncated: matches.hiddenCandidatesTruncated,
      };
    });
    const diagnostics = queries.some(({ options }) => options.diagnostics === "summary")
      ? snapshotQueryDiagnostics(snapshot, queries.length, queries.flatMap(({ options }, index) => (
          options.diagnostics === "summary"
            ? [{ index, matchCount: results[index].matchCount, hiddenMatchCount: results[index].hiddenMatchCount }]
            : []
        )))
      : undefined;
    return {
      pageId: snapshot.pageId,
      documentId: snapshot.documentId,
      revision: snapshot.revision,
      url: snapshot.url,
      title: snapshot.title,
      rootFrameId: snapshot.rootFrameId,
      queries: results,
      ...(diagnostics === undefined ? {} : { diagnostics }),
    };
  }

  async snapshotWindow(
    options?: SnapshotWindowOptions,
    cursor?: SnapshotWindowCursor,
    signal?: AbortSignal,
  ): Promise<PageSnapshotWindow> {
    throwIfAborted(signal);
    if (!this.backend.snapshotWindow) {
      throw new AgentError("CAPABILITY_UNAVAILABLE", "snapshot windows are unavailable", {
        details: { capability: "snapshot.window" },
      });
    }

    const entry = cursor === undefined ? undefined : this.snapshotWindowHistory.get(String(cursor.snapshotId));
    if (cursor !== undefined && !entry) {
      throw new AgentError("SNAPSHOT_NOT_FOUND", "snapshot window cursor is no longer available", {
        retryable: true,
        details: { snapshotId: cursor.snapshotId },
      });
    }

    const normalizedOptions = options === undefined ? undefined : normalizeSnapshotWindowOptions(options);
    const windowOptions = entry?.options ?? normalizedOptions ?? normalizeSnapshotWindowOptions();
    if (entry && normalizedOptions !== undefined && snapshotWindowOptionsKey(normalizedOptions) !== entry.optionsKey) {
      throw new AgentError("INVALID_REQUEST", "snapshot window options must match the cursor options", {
        details: { snapshotId: String(cursor?.snapshotId) },
      });
    }
    if (cursor !== undefined) {
      if (
        cursor.pageId !== this.pageId ||
        cursor.documentId !== entry!.snapshot.documentId ||
        cursor.revision !== entry!.snapshot.revision ||
        cursor.limit !== entry!.limit ||
        !Number.isSafeInteger(cursor.offset) ||
        cursor.offset < 0 ||
        !Number.isSafeInteger(cursor.limit) ||
        cursor.limit < 1 ||
        cursor.offset > Number.MAX_SAFE_INTEGER - cursor.limit
      ) {
        throw new AgentError("INVALID_REQUEST", "snapshot window cursor does not match its snapshot", {
          details: { snapshotId: cursor.snapshotId },
        });
      }
      this.ledger.assertFresh(cursor);
    }

    const offset = cursor?.offset ?? 0;
    const captured = await this.backend.snapshotWindow(windowOptions, offset, signal);
    throwIfAborted(signal);
    this.assertPageId(captured.pageId, "snapshot window");
    const state = this.ledger.synchronize(captured.pageId, captured.documentId, captured.revision);
    if (cursor !== undefined && (state.documentId !== cursor.documentId || state.revision !== cursor.revision)) {
      throw new AgentError("STALE_SNAPSHOT", "snapshot window is no longer current", {
        retryable: true,
        details: {
          pageId: this.pageId,
          expectedDocumentId: state.documentId,
          expectedRevision: state.revision,
          receivedDocumentId: cursor.documentId,
          receivedRevision: cursor.revision,
        },
      });
    }
    if (
      captured.pageId !== this.pageId ||
      captured.offset !== offset ||
      captured.limit !== windowOptions.limit ||
      captured.nodes.length > captured.limit ||
      captured.totalNodes < captured.nodes.length ||
      !Number.isSafeInteger(captured.totalNodes) ||
      captured.totalNodes < 0
    ) {
      throw new AgentError("INTERNAL_ERROR", "snapshot window backend returned an invalid window");
    }

    const snapshotId = cursor?.snapshotId ?? asSnapshotId(`${this.pageId}:window:${++this.snapshotSequence}`);
    if (cursor === undefined) {
      this.rememberSnapshotWindow({
        snapshot: { ...captured, snapshotId, offset: 0, limit: windowOptions.limit, done: false },
        options: windowOptions,
        optionsKey: snapshotWindowOptionsKey(windowOptions),
        limit: windowOptions.limit,
      });
    }
    const done = captured.truncated || offset + captured.nodes.length >= captured.totalNodes;
    return {
      ...captured,
      snapshotId,
      done,
      ...(done
        ? {}
        : {
            nextCursor: {
              pageId: this.pageId,
              documentId: state.documentId,
              revision: state.revision,
              snapshotId,
              offset: offset + captured.nodes.length,
              limit: windowOptions.limit,
            },
          }),
    };
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
        this.assertPageId(captured.pageId, "snapshot delta");
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
    this.assertPageId(capture.pageId, "capture");
    const state = this.ledger.synchronize(capture.pageId, capture.documentId, capture.revision);
    return {
      ...capture,
      pageId: this.pageId,
      documentId: state.documentId,
      revision: state.revision,
    };
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
    output?: ActionOutputOptions,
  ): Promise<ActionResult> {
    return this.enqueueAction(async () => {
      throwIfAborted(signal);
      const before = await this.backend.identity(signal);
      this.assertPageId(before.pageId, "identity");
      this.ledger.synchronize(before.pageId, before.documentId, before.revision);
      if (token) this.ledger.assertFresh(token);
      const result = await this.backend.act(action, token, expect, signal);
      throwIfAborted(signal);
      const after = await this.backend.identity(signal);
      this.assertPageId(after.pageId, "identity");
      this.ledger.synchronize(after.pageId, after.documentId, after.revision);
      return { ...result, ...(await this.actionOutput(output, signal)) };
    }, signal);
  }

  async actBatch(
    steps: readonly ActionBatchStep[],
    signal?: AbortSignal,
    output?: ActionOutputOptions,
  ): Promise<ActionBatchResult> {
    return this.enqueueAction(async () => {
      if (steps.length < 1 || steps.length > 64) {
        throw new AgentError("INVALID_REQUEST", "action batch must contain between 1 and 64 steps");
      }
      const stepResults: ActionBatchStepResult[] = [];
      const effects: ActionEffect[] = [];
      let proof: ActionResult["proof"];
      for (let index = 0; index < steps.length; index += 1) {
        throwIfAborted(signal);
        const step = steps[index];
        try {
          const before = await this.backend.identity(signal);
          this.assertPageId(before.pageId, "identity");
          this.ledger.synchronize(before.pageId, before.documentId, before.revision);
          if (step.token) this.ledger.assertFresh(step.token);
          const result = await this.backend.act(step.action, step.token, step.expect, signal);
          throwIfAborted(signal);
          const after = await this.backend.identity(signal);
          this.assertPageId(after.pageId, "identity");
          this.ledger.synchronize(after.pageId, after.documentId, after.revision);
          const normalized = { ...result } satisfies ActionResult;
          effects.push(...normalized.effects);
          proof = normalized.proof;
          stepResults.push({
            index,
            status: normalized.verified ? "completed" : "failed",
            result: normalized,
          });
          if (!normalized.verified) {
            stepResults.push(...skippedBatchSteps(index + 1, steps.length));
            return {
              pageId: this.pageId,
              verified: false,
              completed: index,
              failedAt: index,
              steps: stepResults,
              effects,
              proof,
            };
          }
        } catch (error) {
          if (signal?.aborted) throw error;
          const normalized = normalizeBatchError(error);
          stepResults.push({ index, status: "failed", error: normalized });
          stepResults.push(...skippedBatchSteps(index + 1, steps.length));
          return {
            pageId: this.pageId,
            verified: false,
            completed: stepResults.filter((entry) => entry.status === "completed").length,
            failedAt: index,
            steps: stepResults,
            effects,
            proof,
          };
        }
      }
      return {
        pageId: this.pageId,
        verified: true,
        completed: steps.length,
        steps: stepResults,
        effects,
        proof,
        ...(await this.actionBatchOutput(output, signal)),
      };
    }, signal);
  }

  async wait(
    condition: WaitCondition,
    timeoutMs?: number,
    signal?: AbortSignal,
    output?: WaitOutputOptions,
  ): Promise<WaitResult> {
    const result = await this.backend.wait(condition, timeoutMs, signal);
    return result.satisfied ? { ...result, ...(await this.snapshotOutput(output, signal)) } : result;
  }

  async dialog(dialogId: string, action: DialogAction, signal?: AbortSignal): Promise<PageDialogResult> {
    throwIfAborted(signal);
    if (!this.backend.dialog) {
      throw new AgentError("CAPABILITY_UNAVAILABLE", "page dialog control is unavailable", {
        details: { capability: "page.dialog" },
      });
    }
    const result = await this.backend.dialog(dialogId, action, signal);
    throwIfAborted(signal);
    return result;
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
    if (this.actionQueueDepth >= this.maxQueuedActions) {
      return Promise.reject(new AgentError("RESOURCE_EXHAUSTED", "too many actions are queued for this page", {
        retryable: true,
        details: {
          scope: "page-actions",
          maxQueuedActionsPerPage: this.maxQueuedActions,
          safeToRetry: true,
        },
      }));
    }
    this.actionQueueDepth += 1;
    const run = () => {
      throwIfAborted(signal);
      return operation();
    };
    const result = this.actionTail.then(run, run);
    this.actionTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.then(
      (value) => {
        this.actionQueueDepth -= 1;
        return value;
      },
      (error) => {
        this.actionQueueDepth -= 1;
        throw error;
      },
    );
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

  private rememberSnapshotWindow(entry: SnapshotWindowHistoryEntry): void {
    this.snapshotWindowHistory.set(String(entry.snapshot.snapshotId), entry);
    while (this.snapshotWindowHistory.size > 32) {
      const oldest = this.snapshotWindowHistory.keys().next().value;
      if (oldest === undefined) return;
      this.snapshotWindowHistory.delete(oldest);
    }
  }

  private async actionOutput(
    output: ActionOutputOptions | undefined,
    signal?: AbortSignal,
  ): Promise<Pick<ActionResult, "snapshot" | "snapshotDelta">> {
    return this.snapshotOutput(output, signal);
  }

  private async actionBatchOutput(
    output: ActionOutputOptions | undefined,
    signal?: AbortSignal,
  ): Promise<Pick<ActionBatchResult, "snapshot" | "snapshotDelta">> {
    return this.snapshotOutput(output, signal);
  }

  private async snapshotOutput(
    output: PageOutputOptions | undefined,
    signal?: AbortSignal,
  ): Promise<{ snapshot?: PageSnapshot; snapshotDelta?: PageSnapshotDelta }> {
    const mode = output?.snapshot ?? "full";
    if (mode === "none") return {};
    if (mode === "delta") {
      if (!output?.base) {
        throw new AgentError("INVALID_REQUEST", "action output delta requires a base snapshot");
      }
      return { snapshotDelta: await this.snapshotDelta(output.base, undefined, signal) };
    }
    return { snapshot: await this.snapshot(undefined, signal) };
  }

  private assertPageId(pageId: PageId, source: string): void {
    if (pageId === this.pageId) return;
    throw new AgentError("INTERNAL_ERROR", `${source} backend returned a different page`);
  }
}

interface SnapshotHistoryEntry {
  snapshot: PageSnapshot;
  options?: SnapshotOptions;
  optionsKey: string;
}

interface SnapshotWindowHistoryEntry {
  snapshot: PageSnapshotWindow;
  options: SnapshotWindowOptions;
  optionsKey: string;
  limit: number;
}

export type SnapshotWindowCapture = Omit<PageSnapshotWindow, "snapshotId" | "nextCursor">;

function skippedBatchSteps(start: number, end: number): ActionBatchStepResult[] {
  return Array.from({ length: Math.max(0, end - start) }, (_, offset) => ({
    index: start + offset,
    status: "skipped" as const,
  }));
}

function normalizeBatchError(error: unknown) {
  const normalized = error instanceof AgentError
    ? error
    : new AgentError("INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
  return normalized.payload();
}

const DEFAULT_SNAPSHOT_WINDOW_LIMIT = 128;
const MAX_SNAPSHOT_WINDOW_LIMIT = 1000;
const DEFAULT_PAGE_QUERY_LIMIT = 32;
const MAX_PAGE_QUERY_LIMIT = 256;

type NormalizedPageQuerySpec = {
  locator: Locator;
  options: PageQueryOptions & { limit: number };
};

function normalizePageQueryOptions(options?: PageQueryOptions): PageQueryOptions & { limit: number } {
  const limit = options?.limit ?? DEFAULT_PAGE_QUERY_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_QUERY_LIMIT) {
    throw new AgentError("INVALID_REQUEST", `page query limit must be between 1 and ${MAX_PAGE_QUERY_LIMIT}`);
  }
  return {
    includeHidden: options?.includeHidden === true,
    limit,
    ...(options?.frameId === undefined ? {} : { frameId: options.frameId }),
    ...(options?.diagnostics === "summary" ? { diagnostics: "summary" as const } : {}),
  };
}

function snapshotQueryDiagnostics(
  snapshot: Pick<PageSnapshot, "nodes" | "rootFrameId">,
  queriesEvaluated: number,
  queries: readonly Pick<PageQueryDiagnostic, "index" | "matchCount" | "hiddenMatchCount">[],
): PageQueryDiagnostics {
  return {
    mode: "snapshot",
    queriesEvaluated,
    framesSearched: new Set([String(snapshot.rootFrameId), ...snapshot.nodes.map((node) => String(node.frameId))]).size,
    shadowRootsSearched: 0,
    elementsScanned: snapshot.nodes.length,
    planCacheHits: 0,
    elementIndexHits: 0,
    elementIndexRebuilds: 0,
    queries: queries.map((query) => ({
      ...query,
      cacheHit: false,
      elementsEvaluated: snapshot.nodes.length,
    })),
  };
}

function normalizePageQueryBatch(queries: readonly PageQuerySpec[]): readonly NormalizedPageQuerySpec[] {
  if (!Array.isArray(queries) || queries.length < 1 || queries.length > MAX_PAGE_QUERY_BATCH) {
    throw new AgentError("INVALID_REQUEST", `page query batch must contain between 1 and ${MAX_PAGE_QUERY_BATCH} locators`);
  }
  return queries.map((query) => ({
    locator: query.locator,
    options: normalizePageQueryOptions(query.options),
  }));
}

function snapshotOptionsKey(options?: SnapshotOptions): string {
  return JSON.stringify({
    interactiveOnly: options?.interactiveOnly ?? true,
    includeGeometry: options?.includeGeometry !== false,
    includeText: options?.includeText !== false,
    maxNodes: options?.maxNodes ?? 1000,
  });
}

function normalizeSnapshotWindowOptions(options?: SnapshotWindowOptions): SnapshotWindowOptions & { limit: number } {
  const limit = options?.limit ?? DEFAULT_SNAPSHOT_WINDOW_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SNAPSHOT_WINDOW_LIMIT) {
    throw new AgentError("INVALID_REQUEST", `snapshot window limit must be between 1 and ${MAX_SNAPSHOT_WINDOW_LIMIT}`);
  }
  return {
    interactiveOnly: options?.interactiveOnly ?? true,
    includeGeometry: options?.includeGeometry !== false,
    includeText: options?.includeText !== false,
    limit,
  };
}

function snapshotWindowOptionsKey(options: SnapshotWindowOptions): string {
  const normalized = normalizeSnapshotWindowOptions(options);
  return JSON.stringify(normalized);
}
