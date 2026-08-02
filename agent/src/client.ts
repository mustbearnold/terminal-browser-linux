import { AgentError, type AgentErrorCode } from "./protocol/errors";
import { TraceRecorder } from "./core/trace";
import {
  AGENT_PROTOCOL,
  AGENT_PROTOCOL_VERSION,
  type ActionOutputOptions,
  type ActionResult,
  type ActionBatchResult,
  type ActionBatchStep,
  type ActionStatusResult,
  type AgentCapability,
  type AgentEvent,
  type AgentEventType,
  type AgentLimits,
  type AgentMessage,
  type AgentRequest,
  type AgentResponse,
  type PageObserveResult,
  type PageObserveCancelResult,
  type CaptureOptions,
  type DialogAction,
  type PageCapture,
  type PageEventCursor,
  type PageActiveResult,
  type PageDialogResult,
  type PageIdentity,
  type PageFrameSnapshot,
  type PageReadResult,
  type PageQueryOptions,
  type PageQueryBatchResult,
  type PageQuerySpec,
  type PageQueryResult,
  type PageSnapshot,
  type PageSnapshotWindow,
  type PageSnapshotDelta,
  type PageId,
  type Locator,
  type Target,
  type SnapshotOptions,
  type SnapshotToken,
  type SnapshotWindowCursor,
  type SnapshotWindowOptions,
  type WaitCondition,
  type WaitOutputOptions,
  type WaitResult,
} from "./protocol/types";
import {
  MAX_AGENT_IN_FLIGHT_REQUESTS,
  MAX_AGENT_QUEUED_ACTIONS_PER_PAGE,
  MAX_REQUEST_DEADLINE_MS,
  throwIfAborted,
} from "./core/cancellation";
import { connectUnixSocket } from "./transport/unix";
import type { AgentTransport } from "./transport/types";

export interface AgentClientOptions {
  clientId?: string;
  capabilities?: readonly AgentCapability[];
  defaultDeadlineMs?: number;
  maxPendingRequests?: number;
  maxPendingActionsPerPage?: number;
  trace?: TraceRecorder;
}

export interface AgentCallOptions {
  deadlineMs?: number;
  signal?: AbortSignal;
}

export interface AgentObserveOptions extends AgentCallOptions {
  after?: PageEventCursor;
}

export interface AgentHelloResult {
  protocol: typeof AGENT_PROTOCOL;
  version: typeof AGENT_PROTOCOL_VERSION;
  clientId: string;
  capabilities: readonly AgentCapability[];
  requested: readonly AgentCapability[];
  accepted: readonly AgentCapability[];
  unsupported: readonly AgentCapability[];
  limits: AgentLimits;
}

export interface AgentOperationResults {
  hello: AgentHelloResult;
  "request.cancel": { requestId: string; canceled: boolean };
  "pages.list": { pages: readonly PageIdentity[] };
  "pages.open": PageIdentity;
  "pages.activate": PageIdentity;
  "pages.close": { pageId: PageId };
  "page.frames": PageFrameSnapshot;
  "page.query": PageQueryResult;
  "page.query.batch": PageQueryBatchResult;
  "page.snapshot": PageSnapshot;
  "page.snapshot.window": PageSnapshotWindow;
  "page.snapshot.delta": PageSnapshotDelta;
  "page.capture": PageCapture;
  "page.read": PageReadResult;
  "page.active": PageActiveResult;
  "page.act": ActionResult;
  "page.act.batch": ActionBatchResult;
  "page.act.status": ActionStatusResult;
  "page.wait": WaitResult;
  "page.observe": PageObserveResult;
  "page.observe.cancel": PageObserveCancelResult;
  "page.dialog": PageDialogResult;
}

export type AgentOperation = AgentRequest["op"];
export type AgentRequestFields<Operation extends AgentOperation> = Omit<
  Extract<AgentRequest, { op: Operation }>,
  "kind" | "protocol" | "version" | "requestId" | "deadlineMs" | "op"
>;

export type AgentClientEventListener = (event: AgentEvent) => void;

export interface AgentCall<Result> {
  requestId: string;
  promise: Promise<Result>;
  cancel(options?: AgentCallOptions): Promise<boolean>;
}

interface PendingRequest {
  resolve(response: AgentResponse): void;
  reject(error: unknown): void;
}

export class AgentClient {
  private readonly clientId: string;
  private readonly capabilities: readonly AgentCapability[] | undefined;
  private readonly defaultDeadlineMs: number | undefined;
  private maxPendingRequests: number;
  private maxPendingActionsPerPage: number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly pendingActions = new Map<PageId, number>();
  private readonly eventListeners = new Set<AgentClientEventListener>();
  private readonly unsubscribeMessage: () => void;
  private readonly unsubscribeError: () => void;
  private readonly unsubscribeClose: () => void;
  private readonly trace: TraceRecorder | undefined;
  private requestSequence = 0;
  private closed = false;

  constructor(private readonly transport: AgentTransport, options: AgentClientOptions = {}) {
    validateDeadline(options.defaultDeadlineMs);
    validateRequestBudget(options.maxPendingRequests);
    validateRequestBudget(options.maxPendingActionsPerPage);
    this.clientId = options.clientId ?? "terminal-browser-agent-client";
    this.capabilities = options.capabilities;
    this.defaultDeadlineMs = options.defaultDeadlineMs;
    this.maxPendingRequests = options.maxPendingRequests ?? MAX_AGENT_IN_FLIGHT_REQUESTS;
    this.maxPendingActionsPerPage = options.maxPendingActionsPerPage ?? MAX_AGENT_QUEUED_ACTIONS_PER_PAGE;
    this.trace = options.trace;
    this.unsubscribeMessage = transport.onMessage((message) => this.handleMessage(message));
    this.unsubscribeError = transport.onError((error) => this.failPending(transportError(error)));
    this.unsubscribeClose = transport.onClose(() => this.handleClose());
  }

  static async connect(socketPath: string, options: AgentClientOptions = {}): Promise<AgentClient> {
    return new AgentClient(await connectUnixSocket(socketPath), options);
  }

  onEvent(listener: AgentClientEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  hello(options?: AgentCallOptions): Promise<AgentHelloResult> {
    return this.call("hello", {
      clientId: this.clientId,
      ...(this.capabilities === undefined ? {} : { capabilities: this.capabilities }),
    }, options).then((result) => {
      const negotiated = result.limits?.maxInFlightRequests;
      if (negotiated === undefined) {
        throw new AgentError("INTERNAL_ERROR", "agent hello omitted its request budget");
      }
      validateRequestBudget(negotiated);
      const negotiatedActions = result.limits?.maxQueuedActionsPerPage;
      if (negotiatedActions === undefined) {
        throw new AgentError("INTERNAL_ERROR", "agent hello omitted its page action queue budget");
      }
      validateRequestBudget(negotiatedActions);
      this.maxPendingRequests = Math.min(this.maxPendingRequests, negotiated);
      this.maxPendingActionsPerPage = Math.min(this.maxPendingActionsPerPage, negotiatedActions);
      return result;
    });
  }

  cancel(targetRequestId: string, options?: AgentCallOptions): Promise<boolean> {
    return this.call("request.cancel", { targetRequestId }, options).then((result) => result.canceled);
  }

  actionStatus(
    pageId: PageId,
    idempotencyKey: string,
    options?: AgentCallOptions,
  ): Promise<ActionStatusResult> {
    return this.call("page.act.status", { pageId, idempotencyKey }, options);
  }

  query(
    pageId: PageId,
    locator: Locator,
    queryOptions?: PageQueryOptions,
    options?: AgentCallOptions,
  ): Promise<PageQueryResult> {
    return this.call("page.query", {
      pageId,
      locator,
      ...(queryOptions === undefined ? {} : { options: queryOptions }),
    }, options);
  }

  queryBatch(
    pageId: PageId,
    queries: readonly PageQuerySpec[],
    options?: AgentCallOptions,
  ): Promise<PageQueryBatchResult> {
    return this.call("page.query.batch", { pageId, queries }, options);
  }

  read(
    pageId: PageId,
    target: Target,
    token?: SnapshotToken,
    options?: AgentCallOptions,
  ): Promise<PageReadResult> {
    return this.call("page.read", {
      pageId,
      target,
      ...(token === undefined ? {} : { token }),
    }, options);
  }

  actBatch(
    pageId: PageId,
    steps: readonly ActionBatchStep[],
    output?: ActionOutputOptions,
    idempotencyKey?: string,
    options?: AgentCallOptions,
  ): Promise<ActionBatchResult> {
    return this.call("page.act.batch", {
      pageId,
      steps,
      ...(output === undefined ? {} : { output }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    }, options);
  }

  observe(pageId: PageId, events: readonly AgentEventType[], options: AgentObserveOptions = {}) {
    validateEventCursor(pageId, options.after);
    const { after, ...callOptions } = options;
    return this.call("page.observe", {
      pageId,
      events,
      ...(after === undefined ? {} : { after }),
    }, callOptions);
  }

  dialog(
    pageId: PageId,
    dialogId: string,
    action: DialogAction,
    options?: AgentCallOptions,
  ): Promise<PageDialogResult> {
    return this.call("page.dialog", { pageId, dialogId, action }, options);
  }

  frames(pageId: PageId, options?: AgentCallOptions): Promise<PageFrameSnapshot> {
    return this.call("page.frames", { pageId }, options);
  }

  active(pageId: PageId, options?: AgentCallOptions): Promise<PageActiveResult> {
    return this.call("page.active", { pageId }, options);
  }

  capture(pageId: PageId, captureOptions?: CaptureOptions, options?: AgentCallOptions): Promise<PageCapture> {
    return this.call("page.capture", {
      pageId,
      ...(captureOptions === undefined ? {} : { options: captureOptions }),
    }, options);
  }

  snapshotDelta(
    pageId: PageId,
    base: SnapshotToken,
    snapshotOptions?: SnapshotOptions,
    options?: AgentCallOptions,
  ): Promise<PageSnapshotDelta> {
    return this.call("page.snapshot.delta", {
      pageId,
      base,
      ...(snapshotOptions === undefined ? {} : { options: snapshotOptions }),
    }, options);
  }

  snapshotWindow(
    pageId: PageId,
    windowOptions?: SnapshotWindowOptions,
    cursor?: SnapshotWindowCursor,
    options?: AgentCallOptions,
  ): Promise<PageSnapshotWindow> {
    return this.call("page.snapshot.window", {
      pageId,
      ...(windowOptions === undefined ? {} : { options: windowOptions }),
      ...(cursor === undefined ? {} : { cursor }),
    }, options);
  }

  wait(
    pageId: PageId,
    condition: WaitCondition,
    timeoutMs?: number,
    output?: WaitOutputOptions,
    options?: AgentCallOptions,
  ): Promise<WaitResult> {
    return this.call("page.wait", {
      pageId,
      condition,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(output === undefined ? {} : { output }),
    }, options);
  }

  async call<Operation extends AgentOperation>(
    operation: Operation,
    fields: AgentRequestFields<Operation>,
    options: AgentCallOptions = {},
  ): Promise<AgentOperationResults[Operation]> {
    return this.start(operation, fields, options).promise;
  }

  start<Operation extends AgentOperation>(
    operation: Operation,
    fields: AgentRequestFields<Operation>,
    options: AgentCallOptions = {},
  ): AgentCall<AgentOperationResults[Operation]> {
    const deadlineMs = options.deadlineMs ?? this.defaultDeadlineMs;
    validateDeadline(deadlineMs);
    throwIfAborted(options.signal);
    const requestId = this.nextRequestId(operation);
    const request = {
      kind: "request",
      protocol: AGENT_PROTOCOL,
      version: AGENT_PROTOCOL_VERSION,
      requestId,
      op: operation,
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
      ...fields,
    } as AgentRequest;
    const promise = this.send(request, { ...options, deadlineMs }).then((response) => {
      if (!response.ok) throw responseError(response);
      return response.result as AgentOperationResults[Operation];
    });
    return {
      requestId,
      promise,
      cancel: (cancelOptions) => this.cancel(requestId, cancelOptions),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.handleClose();
    await this.transport.close();
  }

  private send(request: AgentRequest, options: AgentCallOptions): Promise<AgentResponse> {
    if (this.closed) return Promise.reject(new AgentError("TRANSPORT_CLOSED", "agent transport is closed", { retryable: true }));
    if (request.op !== "request.cancel" && this.pending.size >= this.maxPendingRequests) {
      return Promise.reject(new AgentError("RESOURCE_EXHAUSTED", "too many agent requests are pending", {
        retryable: true,
        details: { maxPendingRequests: this.maxPendingRequests },
      }));
    }
    const actionPageId = requestActionPageId(request);
    if (actionPageId !== undefined) {
      const pendingActions = this.pendingActions.get(actionPageId) ?? 0;
      if (pendingActions >= this.maxPendingActionsPerPage) {
        return Promise.reject(new AgentError("RESOURCE_EXHAUSTED", "too many actions are pending for this page", {
          retryable: true,
          details: {
            pageId: actionPageId,
            maxPendingActionsPerPage: this.maxPendingActionsPerPage,
          },
        }));
      }
    }
    return new Promise<AgentResponse>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const signal = options.signal;
      const settle = (error?: unknown, response?: AgentResponse) => {
        if (!this.pending.has(request.requestId)) return;
        this.pending.delete(request.requestId);
        if (actionPageId !== undefined) this.releasePendingAction(actionPageId);
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
        if (error === undefined) resolve(response!);
        else reject(error);
      };
      const onAbort = () => {
        const error = abortError(signal, request.requestId);
        settle(error);
        this.sendCancellation(request.requestId);
      };
      const pending: PendingRequest = {
        resolve: (response) => settle(undefined, response),
        reject: (error) => settle(error),
      };
      this.pending.set(request.requestId, pending);
      if (actionPageId !== undefined) this.reservePendingAction(actionPageId);
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
          return;
        }
      }
      if (options.deadlineMs !== undefined) {
        timer = setTimeout(() => {
          const error = timeoutError(request.requestId);
          settle(error);
          this.sendCancellation(request.requestId);
        }, options.deadlineMs);
      }
      this.trace?.record("outbound", request);
      void this.transport.send(request).catch((error) => settle(transportError(error)));
    });
  }

  cancelObservation(
    pageId: PageId,
    subscriptionId: string,
    options?: AgentCallOptions,
  ): Promise<PageObserveCancelResult> {
    return this.call("page.observe.cancel", { pageId, subscriptionId }, options);
  }

  private sendCancellation(targetRequestId: string): void {
    if (this.closed) return;
    const request: AgentRequest = {
      kind: "request",
      protocol: AGENT_PROTOCOL,
      version: AGENT_PROTOCOL_VERSION,
      requestId: this.nextRequestId("request.cancel"),
      op: "request.cancel",
      targetRequestId,
    };
    this.trace?.record("outbound", request);
    void this.transport.send(request).catch(() => {});
  }

  private handleMessage(message: AgentMessage): void {
    if (message.kind === "request") return;
    if (message.kind === "event") {
      this.trace?.record("event", message);
      for (const listener of this.eventListeners) {
        try {
          listener(message);
        } catch {}
      }
      return;
    }
    this.trace?.record("inbound", message);
    this.pending.get(message.requestId)?.resolve(message);
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.failPending(new AgentError("TRANSPORT_CLOSED", "agent transport closed", { retryable: true }));
    this.unsubscribeMessage();
    this.unsubscribeError();
    this.unsubscribeClose();
  }

  private failPending(error: AgentError): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private nextRequestId(operation: AgentOperation): string {
    return `${this.clientId}:${operation}:${++this.requestSequence}`;
  }

  private reservePendingAction(pageId: PageId): void {
    this.pendingActions.set(pageId, (this.pendingActions.get(pageId) ?? 0) + 1);
  }

  private releasePendingAction(pageId: PageId): void {
    const current = this.pendingActions.get(pageId) ?? 0;
    if (current <= 1) this.pendingActions.delete(pageId);
    else this.pendingActions.set(pageId, current - 1);
  }
}

function requestActionPageId(request: AgentRequest): PageId | undefined {
  return request.op === "page.act" || request.op === "page.act.batch" ? request.pageId : undefined;
}

function validateDeadline(deadlineMs: number | undefined): void {
  if (
    deadlineMs !== undefined &&
    (!Number.isSafeInteger(deadlineMs) || deadlineMs < 0 || deadlineMs > MAX_REQUEST_DEADLINE_MS)
  ) {
    throw new AgentError("INVALID_REQUEST", "deadlineMs must be a non-negative safe integer within timer limits");
  }
}

function validateRequestBudget(maxPendingRequests: number | undefined): void {
  if (maxPendingRequests !== undefined && (!Number.isSafeInteger(maxPendingRequests) || maxPendingRequests < 1)) {
    throw new AgentError("INVALID_REQUEST", "maxPendingRequests must be a positive safe integer");
  }
}

function validateEventCursor(pageId: PageId, cursor: PageEventCursor | undefined): void {
  if (cursor === undefined) return;
  if (cursor.pageId !== pageId) {
    throw new AgentError("INVALID_REQUEST", "event cursor pageId must match the observed page");
  }
  if (!Number.isSafeInteger(cursor.sequence) || cursor.sequence < 0) {
    throw new AgentError("INVALID_REQUEST", "event cursor sequence must be a non-negative safe integer");
  }
}

function abortError(signal: AbortSignal | undefined, requestId: string): AgentError {
  if (signal?.reason instanceof AgentError) return signal.reason;
  return new AgentError("REQUEST_CANCELLED", "request was cancelled", {
    retryable: true,
    details: { requestId },
  });
}

function timeoutError(requestId: string): AgentError {
  return new AgentError("TIMEOUT", "request deadline exceeded", {
    retryable: true,
    details: { requestId },
  });
}

function responseError(response: AgentResponse): AgentError {
  const error = response.error;
  if (!error) return new AgentError("INTERNAL_ERROR", "agent returned an error response without details");
  return new AgentError(error.code as AgentErrorCode, error.message, {
    retryable: error.retryable,
    details: error.details,
  });
}

function transportError(error: unknown): AgentError {
  return new AgentError("TRANSPORT_CLOSED", error instanceof Error ? error.message : "agent transport failed", {
    retryable: true,
  });
}
