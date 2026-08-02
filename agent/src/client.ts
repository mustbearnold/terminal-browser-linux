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
  reconnect?: AgentTransportFactory;
}

export type AgentTransportFactory = () => Promise<AgentTransport>;

export type AgentConnectionState = "connected" | "disconnected" | "closed";

export type AgentConnectionStateListener = (state: AgentConnectionState) => void;

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

interface ResumableObservation {
  readonly id: number;
  readonly pageId: PageId;
  readonly events: readonly AgentEventType[];
  cursor: PageEventCursor;
  subscriptionId: string;
  serverSubscriptionId: string;
}

export class AgentClient {
  private readonly clientId: string;
  private readonly capabilities: readonly AgentCapability[] | undefined;
  private readonly defaultDeadlineMs: number | undefined;
  private readonly reconnectTransport: AgentTransportFactory | undefined;
  private maxPendingRequests: number;
  private maxPendingActionsPerPage: number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly pendingActions = new Map<PageId, number>();
  private readonly eventListeners = new Set<AgentClientEventListener>();
  private readonly connectionStateListeners = new Set<AgentConnectionStateListener>();
  private readonly observations = new Map<number, ResumableObservation>();
  private readonly trace: TraceRecorder | undefined;
  private transport: AgentTransport;
  private unsubscribeMessage: (() => void) | null = null;
  private unsubscribeError: (() => void) | null = null;
  private unsubscribeClose: (() => void) | null = null;
  private requestSequence = 0;
  private observationSequence = 0;
  private resumingObservationId: number | null = null;
  private readonly resumedObservationIds = new Set<number>();
  private connectionState: AgentConnectionState = "connected";
  private reconnectPromise: Promise<AgentHelloResult> | null = null;
  private reconnecting = false;
  private closed = false;

  constructor(transport: AgentTransport, options: AgentClientOptions = {}) {
    validateDeadline(options.defaultDeadlineMs);
    validateRequestBudget(options.maxPendingRequests);
    validateRequestBudget(options.maxPendingActionsPerPage);
    this.clientId = options.clientId ?? "terminal-browser-agent-client";
    this.capabilities = options.capabilities;
    this.defaultDeadlineMs = options.defaultDeadlineMs;
    this.maxPendingRequests = options.maxPendingRequests ?? MAX_AGENT_IN_FLIGHT_REQUESTS;
    this.maxPendingActionsPerPage = options.maxPendingActionsPerPage ?? MAX_AGENT_QUEUED_ACTIONS_PER_PAGE;
    this.trace = options.trace;
    this.reconnectTransport = options.reconnect;
    this.transport = transport;
    this.bindTransport(transport);
  }

  static async connect(socketPath: string, options: AgentClientOptions = {}): Promise<AgentClient> {
    return new AgentClient(await connectUnixSocket(socketPath), {
      ...options,
      reconnect: options.reconnect ?? (() => connectUnixSocket(socketPath)),
    });
  }

  onEvent(listener: AgentClientEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onConnectionState(listener: AgentConnectionStateListener): () => void {
    this.connectionStateListeners.add(listener);
    return () => this.connectionStateListeners.delete(listener);
  }

  get state(): AgentConnectionState {
    return this.connectionState;
  }

  get canReconnect(): boolean {
    return !this.closed && this.reconnectTransport !== undefined;
  }

  hello(options?: AgentCallOptions): Promise<AgentHelloResult> {
    return this.negotiateHello(options, false);
  }

  private negotiateHello(
    options: AgentCallOptions | undefined,
    allowWhileReconnecting: boolean,
  ): Promise<AgentHelloResult> {
    return this.startInternal("hello", {
      clientId: this.clientId,
      ...(this.capabilities === undefined ? {} : { capabilities: this.capabilities }),
    }, options ?? {}, true, allowWhileReconnecting).promise.then((result) => {
      try {
        const validated = validateHelloResult(result, this.clientId);
        this.maxPendingRequests = Math.min(this.maxPendingRequests, validated.limits.maxInFlightRequests);
        this.maxPendingActionsPerPage = Math.min(
          this.maxPendingActionsPerPage,
          validated.limits.maxQueuedActionsPerPage,
        );
        return validated;
      } catch (error) {
        void this.close().catch(() => {});
        throw error;
      }
    });
  }

  reconnect(options?: AgentCallOptions): Promise<AgentHelloResult> {
    if (!this.reconnectPromise) {
      this.reconnectPromise = this.reconnectOnce(options).finally(() => {
        this.reconnectPromise = null;
      });
    }
    return this.reconnectPromise;
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
    return this.startInternal(operation, fields, options, true);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const transport = this.transport;
    this.unbindTransport();
    this.reconnecting = false;
    this.connectionState = "closed";
    this.failPending(new AgentError("TRANSPORT_CLOSED", "agent transport closed", { retryable: true }));
    this.observations.clear();
    this.notifyConnectionState("closed");
    await transport.close();
  }

  async disconnect(): Promise<void> {
    if (this.closed || this.connectionState !== "connected") return;
    const transport = this.transport;
    this.handleClose();
    await transport.close();
  }

  private startInternal<Operation extends AgentOperation>(
    operation: Operation,
    fields: AgentRequestFields<Operation>,
    options: AgentCallOptions,
    trackObservation: boolean,
    allowWhileReconnecting = false,
  ): AgentCall<AgentOperationResults[Operation]> {
    const deadlineMs = options.deadlineMs ?? this.defaultDeadlineMs;
    validateDeadline(deadlineMs);
    throwIfAborted(options.signal);
    const requestId = this.nextRequestId(operation);
    let request = {
      kind: "request",
      protocol: AGENT_PROTOCOL,
      version: AGENT_PROTOCOL_VERSION,
      requestId,
      op: operation,
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
      ...fields,
    } as AgentRequest;
    if (request.op === "page.observe.cancel") {
      const observation = this.findObservation(request.pageId, request.subscriptionId);
      if (observation) request = { ...request, subscriptionId: observation.serverSubscriptionId };
    }
    const promise = this.send(request, { ...options, deadlineMs }, allowWhileReconnecting).then((response) => {
      if (!response.ok) throw responseError(response);
      const result = response.result as AgentOperationResults[Operation];
      if (trackObservation) this.trackObservationResult(request, result);
      return result;
    });
    return {
      requestId,
      promise,
      cancel: (cancelOptions) => this.cancel(requestId, cancelOptions),
    };
  }

  private async reconnectOnce(options?: AgentCallOptions): Promise<AgentHelloResult> {
    if (this.closed) throw closedClientError();
    if (this.connectionState === "connected") {
      throw new AgentError("INVALID_REQUEST", "agent transport is already connected");
    }
    if (!this.reconnectTransport) {
      throw new AgentError("TRANSPORT_CLOSED", "agent client has no reconnect transport", { retryable: true });
    }
    const transport = await this.reconnectTransport();
    if (this.closed) {
      await transport.close();
      throw closedClientError();
    }
    this.reconnecting = true;
    this.bindTransport(transport);
    try {
      const hello = await this.negotiateHello(options, true);
      await this.resumeObservations(options?.signal);
      this.reconnecting = false;
      this.connectionState = "connected";
      this.notifyConnectionState("connected");
      return hello;
    } catch (error) {
      this.reconnecting = false;
      if (!this.closed && this.transport === transport) {
        this.unbindTransport();
        this.connectionState = "disconnected";
        this.failPending(new AgentError("TRANSPORT_CLOSED", "agent transport closed", { retryable: true }));
      }
      await transport.close();
      throw error;
    }
  }

  private send(
    request: AgentRequest,
    options: AgentCallOptions,
    allowWhileReconnecting = false,
  ): Promise<AgentResponse> {
    if (
      this.closed ||
      (this.connectionState !== "connected" && !(allowWhileReconnecting && this.reconnecting))
    ) return Promise.reject(closedClientError());
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
      this.advanceObservationCursors(message);
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
    if (this.closed || (this.connectionState !== "connected" && !this.reconnecting)) return;
    this.unbindTransport();
    this.reconnecting = false;
    this.connectionState = "disconnected";
    this.failPending(new AgentError("TRANSPORT_CLOSED", "agent transport closed", { retryable: true }));
    this.notifyConnectionState("disconnected");
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

  private bindTransport(transport: AgentTransport): void {
    this.transport = transport;
    this.unsubscribeMessage = transport.onMessage((message) => this.handleMessage(message));
    this.unsubscribeError = transport.onError((error) => this.failPending(transportError(error)));
    this.unsubscribeClose = transport.onClose(() => this.handleClose());
  }

  private unbindTransport(): void {
    this.unsubscribeMessage?.();
    this.unsubscribeError?.();
    this.unsubscribeClose?.();
    this.unsubscribeMessage = null;
    this.unsubscribeError = null;
    this.unsubscribeClose = null;
  }

  private notifyConnectionState(state: AgentConnectionState): void {
    for (const listener of this.connectionStateListeners) {
      try {
        listener(state);
      } catch {}
    }
  }

  private trackObservationResult(request: AgentRequest, result: unknown): void {
    if (request.op === "page.observe") {
      const observation = result as PageObserveResult;
      this.observations.set(++this.observationSequence, {
        id: this.observationSequence,
        pageId: request.pageId,
        events: [...request.events],
        cursor: observation.cursor,
        subscriptionId: observation.subscriptionId,
        serverSubscriptionId: observation.subscriptionId,
      });
      return;
    }
    if (request.op === "page.observe.cancel") {
      const canceled = result as PageObserveCancelResult;
      if (canceled.canceled) this.removeObservation(request.pageId, request.subscriptionId);
      return;
    }
    if (request.op === "pages.close") {
      for (const observation of this.observations.values()) {
        if (observation.pageId === request.pageId) this.observations.delete(observation.id);
      }
    }
  }

  private advanceObservationCursors(event: AgentEvent): void {
    for (const observation of this.observations.values()) {
      if (
        observation.pageId === event.pageId &&
        observation.events.includes(event.event) &&
        (
          this.resumingObservationId === null ||
          observation.id === this.resumingObservationId ||
          this.resumedObservationIds.has(observation.id)
        ) &&
        event.sequence > observation.cursor.sequence
      ) {
        observation.cursor = { pageId: event.pageId, sequence: event.sequence };
      }
    }
  }

  private async resumeObservations(signal: AbortSignal | undefined): Promise<void> {
    let firstError: unknown;
    this.resumedObservationIds.clear();
    try {
      for (const observation of [...this.observations.values()]) {
        if (this.connectionState !== "connected" && !this.reconnecting) break;
        this.resumingObservationId = observation.id;
        try {
          const result = await this.startInternal("page.observe", {
            pageId: observation.pageId,
            events: observation.events,
            after: observation.cursor,
          }, signal === undefined ? {} : { signal }, false, true).promise;
          observation.serverSubscriptionId = result.subscriptionId;
          if (result.cursor.sequence > observation.cursor.sequence) {
            observation.cursor = result.cursor;
          }
          this.resumedObservationIds.add(observation.id);
        } catch (error) {
          if (error instanceof AgentError && (error.code === "EVENT_GAP" || error.code === "PAGE_NOT_FOUND")) {
            this.observations.delete(observation.id);
          }
          firstError ??= error;
          this.resumingObservationId = null;
        }
      }
    } finally {
      this.resumingObservationId = null;
      this.resumedObservationIds.clear();
    }
    if (firstError) throw firstError;
  }

  private findObservation(pageId: PageId, subscriptionId: string): ResumableObservation | undefined {
    for (const observation of this.observations.values()) {
      if (observation.pageId === pageId && observation.subscriptionId === subscriptionId) return observation;
    }
    for (const observation of this.observations.values()) {
      if (observation.pageId === pageId && observation.serverSubscriptionId === subscriptionId) return observation;
    }
    return undefined;
  }

  private removeObservation(pageId: PageId, subscriptionId: string): void {
    const observation = this.findObservation(pageId, subscriptionId);
    if (observation) this.observations.delete(observation.id);
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

function validateHelloResult(value: unknown, clientId: string): AgentHelloResult {
  const result = asRecord(value);
  if (!result) throw invalidHello("result must be an object");
  if (result.protocol !== AGENT_PROTOCOL) throw invalidHello("protocol is invalid");
  if (result.version !== AGENT_PROTOCOL_VERSION) throw invalidHello("version is invalid");
  if (result.clientId !== clientId) throw invalidHello("clientId does not match the request");

  const capabilities = uniqueStringArray(result.capabilities, "capabilities");
  const requested = uniqueStringArray(result.requested, "requested");
  const accepted = uniqueStringArray(result.accepted, "accepted");
  const unsupported = uniqueStringArray(result.unsupported, "unsupported");
  const capabilitiesSet = new Set(capabilities);
  const requestedSet = new Set(requested);
  const acceptedSet = new Set(accepted);
  const unsupportedSet = new Set(unsupported);
  if (
    accepted.some((capability) => !capabilitiesSet.has(capability)) ||
    unsupported.some((capability) => capabilitiesSet.has(capability)) ||
    accepted.some((capability) => !requestedSet.has(capability)) ||
    unsupported.some((capability) => !requestedSet.has(capability)) ||
    accepted.some((capability) => unsupportedSet.has(capability)) ||
    requested.some((capability) => !acceptedSet.has(capability) && !unsupportedSet.has(capability))
  ) {
    throw invalidHello("accepted and unsupported capabilities must partition requested capabilities");
  }

  const limits = asRecord(result.limits);
  if (!limits) throw invalidHello("limits must be an object");
  for (const field of [
    "maxInFlightRequests",
    "maxQueuedActionsPerPage",
    "maxOutboundQueueMessages",
    "maxOutboundQueueBytes",
  ] as const) {
    if (!Number.isSafeInteger(limits[field]) || Number(limits[field]) < 1) {
      throw invalidHello(`${field} must be a positive safe integer`);
    }
  }

  return result as unknown as AgentHelloResult;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function uniqueStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw invalidHello(`${field} must be an array of non-empty strings`);
  }
  const strings = value as string[];
  if (new Set(strings).size !== strings.length) throw invalidHello(`${field} must not contain duplicates`);
  return strings;
}

function invalidHello(reason: string): AgentError {
  return new AgentError("INTERNAL_ERROR", `agent hello is invalid: ${reason}`);
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
  if (error instanceof AgentError) return error;
  return new AgentError("TRANSPORT_CLOSED", error instanceof Error ? error.message : "agent transport failed", {
    retryable: true,
  });
}

function closedClientError(): AgentError {
  return new AgentError("TRANSPORT_CLOSED", "agent transport is closed", { retryable: true });
}
