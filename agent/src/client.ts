import { AgentError, type AgentErrorCode } from "./protocol/errors";
import {
  AGENT_PROTOCOL,
  AGENT_PROTOCOL_VERSION,
  type ActionResult,
  type AgentCapability,
  type AgentEvent,
  type AgentEventType,
  type AgentMessage,
  type AgentRequest,
  type AgentResponse,
  type PageIdentity,
  type PageFrame,
  type PageSnapshot,
  type PageId,
  type SnapshotNode,
  type WaitResult,
} from "./protocol/types";
import { MAX_REQUEST_DEADLINE_MS, throwIfAborted } from "./core/cancellation";
import { connectUnixSocket } from "./transport/unix";
import type { AgentTransport } from "./transport/types";

export interface AgentClientOptions {
  clientId?: string;
  capabilities?: readonly AgentCapability[];
  defaultDeadlineMs?: number;
}

export interface AgentCallOptions {
  deadlineMs?: number;
  signal?: AbortSignal;
}

export interface AgentHelloResult {
  protocol: typeof AGENT_PROTOCOL;
  version: typeof AGENT_PROTOCOL_VERSION;
  clientId: string;
  capabilities: readonly AgentCapability[];
  requested: readonly AgentCapability[];
}

export interface AgentOperationResults {
  hello: AgentHelloResult;
  "request.cancel": { requestId: string; canceled: boolean };
  "pages.list": { pages: readonly PageIdentity[] };
  "pages.open": PageIdentity;
  "pages.close": { pageId: PageId };
  "page.frames": { pageId: PageId; frames: readonly PageFrame[] };
  "page.snapshot": PageSnapshot;
  "page.read": SnapshotNode;
  "page.act": ActionResult;
  "page.wait": WaitResult;
  "page.observe": { pageId: PageId; events: readonly AgentEventType[] };
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
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventListeners = new Set<AgentClientEventListener>();
  private readonly unsubscribeMessage: () => void;
  private readonly unsubscribeError: () => void;
  private readonly unsubscribeClose: () => void;
  private requestSequence = 0;
  private closed = false;

  constructor(private readonly transport: AgentTransport, options: AgentClientOptions = {}) {
    validateDeadline(options.defaultDeadlineMs);
    this.clientId = options.clientId ?? "terminal-browser-agent-client";
    this.capabilities = options.capabilities;
    this.defaultDeadlineMs = options.defaultDeadlineMs;
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
    }, options);
  }

  cancel(targetRequestId: string, options?: AgentCallOptions): Promise<boolean> {
    return this.call("request.cancel", { targetRequestId }, options).then((result) => result.canceled);
  }

  observe(pageId: PageId, events: readonly AgentEventType[], options?: AgentCallOptions) {
    return this.call("page.observe", { pageId, events }, options);
  }

  frames(pageId: PageId, options?: AgentCallOptions): Promise<readonly PageFrame[]> {
    return this.call("page.frames", { pageId }, options).then((result) => result.frames);
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
    return new Promise<AgentResponse>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const signal = options.signal;
      const settle = (error?: unknown, response?: AgentResponse) => {
        if (!this.pending.has(request.requestId)) return;
        this.pending.delete(request.requestId);
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
      void this.transport.send(request).catch((error) => settle(transportError(error)));
    });
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
    void this.transport.send(request).catch(() => {});
  }

  private handleMessage(message: AgentMessage): void {
    if (message.kind === "request") return;
    if (message.kind === "event") {
      for (const listener of this.eventListeners) {
        try {
          listener(message);
        } catch {}
      }
      return;
    }
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
}

function validateDeadline(deadlineMs: number | undefined): void {
  if (
    deadlineMs !== undefined &&
    (!Number.isSafeInteger(deadlineMs) || deadlineMs < 0 || deadlineMs > MAX_REQUEST_DEADLINE_MS)
  ) {
    throw new AgentError("INVALID_REQUEST", "deadlineMs must be a non-negative safe integer within timer limits");
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
