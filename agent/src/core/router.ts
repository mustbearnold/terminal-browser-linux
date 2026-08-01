import { AgentError } from "../protocol/errors";
import type {
  ActionResult,
  AgentEvent,
  AgentMessage,
  AgentRequest,
  AgentResponse,
} from "../protocol/types";
import {
  AGENT_PROTOCOL,
  AGENT_PROTOCOL_VERSION,
  type AgentCapability,
  type PageId,
} from "../protocol/types";
import type { AgentRuntime } from "./runtime";
import { actionCapability } from "./capabilities";
import { IdempotencyCache, stableSerialize } from "./idempotency";
import { SnapshotLocatorResolver } from "./locator";
import { RequestCancellationRegistry, throwIfAborted, type RequestExecution } from "./cancellation";
import { MemoryTrace, TraceRecorder, type TraceDirection } from "./trace";

export interface AgentConnectionContext {
  clientId: string;
  emit(message: AgentMessage): Promise<void> | void;
  addSubscription(cleanup: () => void): void;
}

export class AgentRequestRouter {
  private readonly locator = new SnapshotLocatorResolver();
  private readonly requests = new WeakMap<AgentConnectionContext, RequestCancellationRegistry>();
  private readonly idempotentActions = new IdempotencyCache<ActionResult>();
  private readonly defaultContext = idleContext();
  readonly trace: TraceRecorder;

  constructor(private readonly runtime: AgentRuntime, trace = new TraceRecorder(new MemoryTrace())) {
    this.trace = trace;
  }

  close(context: AgentConnectionContext): void {
    this.registry(context).cancelAll();
  }

  async handle(request: AgentRequest, context?: AgentConnectionContext): Promise<AgentResponse> {
    const connection = context ?? this.defaultContext;
    this.record("inbound", request);
    if (request.op === "request.cancel") {
      const response = this.success(request, {
        requestId: request.targetRequestId,
        canceled: this.registry(connection).cancel(request.targetRequestId),
      });
      this.record("outbound", response);
      return response;
    }
    let execution: RequestExecution | undefined;
    try {
      execution = this.registry(connection).begin(request.requestId, request.deadlineMs);
      throwIfAborted(execution.signal);
      const result = await this.dispatch(request, connection, execution.signal);
      throwIfAborted(execution.signal);
      const response = this.success(request, result);
      this.record("outbound", response);
      return response;
    } catch (error) {
      const failure = normalizeError(error);
      const response: AgentResponse = {
        kind: "response",
        protocol: AGENT_PROTOCOL,
        version: AGENT_PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: false,
        error: failure.payload(),
      };
      this.record("outbound", response);
      return response;
    } finally {
      execution?.finish();
    }
  }

  private async dispatch(request: AgentRequest, context: AgentConnectionContext, signal: AbortSignal): Promise<unknown> {
    switch (request.op) {
      case "hello": {
        context.clientId = request.clientId;
        const capabilities = this.runtime.capabilities();
        const requested = request.capabilities ?? capabilities;
        const supported = new Set(capabilities);
        return {
          protocol: AGENT_PROTOCOL,
          version: AGENT_PROTOCOL_VERSION,
          clientId: request.clientId,
          capabilities,
          requested,
          accepted: requested.filter((capability) => supported.has(capability)),
          unsupported: requested.filter((capability) => !supported.has(capability)),
        };
      }
      case "pages.list":
        return { pages: await this.runtime.listPages() };
      case "pages.open":
        return await this.runtime.openPage(request.url);
      case "pages.close":
        await this.runtime.closePage(request.pageId);
        return { pageId: request.pageId };
      case "page.frames":
        return await this.page(request.pageId).frames(signal);
      case "page.snapshot":
        return await this.page(request.pageId).snapshot(request.options, signal);
      case "page.read": {
        const page = this.page(request.pageId);
        const snapshot = await page.snapshot(undefined, signal);
        if (request.token) page.assertFresh(request.token);
        return this.locator.resolve(request.target, snapshot).node;
      }
      case "page.act": {
        if (request.idempotencyKey !== undefined) requireIdempotencyKey(request.idempotencyKey);
        const execute = () => this.executeAction(request, signal);
        if (request.idempotencyKey === undefined) return await execute();
        const key = `${context.clientId}\u0000${String(request.pageId)}\u0000${request.idempotencyKey}`;
        const fingerprint = stableSerialize({
          pageId: request.pageId,
          action: request.action,
          token: request.token,
          expect: request.expect,
        });
        const outcome = await this.idempotentActions.execute(key, fingerprint, execute);
        return outcome.replayed ? { ...outcome.result, replayed: true } : outcome.result;
      }
      case "page.wait":
        return await this.page(request.pageId).wait(request.condition, request.timeoutMs, signal);
      case "page.observe": {
        const page = this.page(request.pageId);
        const wanted = new Set(request.events);
        const subscription = await page.subscribe((event) => {
          if (!wanted.has(event.event)) return;
          this.record("event", event);
          void context.emit(event);
        }, { afterSequence: request.afterSequence }, signal);
        try {
          throwIfAborted(signal);
        } catch (error) {
          subscription.unsubscribe();
          throw error;
        }
        context.addSubscription(subscription.unsubscribe);
        return {
          pageId: request.pageId,
          events: request.events,
          ...(request.afterSequence === undefined ? {} : { afterSequence: request.afterSequence }),
          sequence: subscription.sequence,
          replayed: subscription.replayed,
        };
      }
      default:
        throw new AgentError("INVALID_REQUEST", "unsupported request operation");
    }
  }

  private page(pageId: PageId) {
    const page = this.runtime.getPage(pageId);
    if (!page) throw new AgentError("PAGE_NOT_FOUND", `unknown page: ${pageId}`);
    return page;
  }

  private async executeAction(
    request: Extract<AgentRequest, { op: "page.act" }>,
    signal: AbortSignal,
  ): Promise<ActionResult> {
    const capabilities = new Set(this.runtime.capabilities());
    requireCapability(capabilities, "page.act");
    requireCapability(capabilities, actionCapability(request.action));
    return this.page(request.pageId).act(request.action, request.token, request.expect, signal);
  }

  private registry(context: AgentConnectionContext): RequestCancellationRegistry {
    let registry = this.requests.get(context);
    if (!registry) {
      registry = new RequestCancellationRegistry();
      this.requests.set(context, registry);
    }
    return registry;
  }

  private success(request: AgentRequest, result: unknown): AgentResponse {
    return {
      kind: "response",
      protocol: AGENT_PROTOCOL,
      version: AGENT_PROTOCOL_VERSION,
      requestId: request.requestId,
      ok: true,
      result,
    };
  }

  private record(direction: TraceDirection, message: AgentMessage): void {
    try {
      this.trace.record(direction, message);
    } catch {}
  }
}

function normalizeError(error: unknown): AgentError {
  if (error instanceof AgentError) return error;
  return new AgentError("INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
}

function requireCapability(capabilities: ReadonlySet<AgentCapability>, capability: AgentCapability): void {
  if (capabilities.has(capability)) return;
  throw new AgentError("CAPABILITY_UNAVAILABLE", `runtime does not advertise ${capability}`, {
    details: { capability },
  });
}

function requireIdempotencyKey(key: string): void {
  if (key.length === 0 || key.length > 256) {
    throw new AgentError("INVALID_REQUEST", "idempotencyKey must be between 1 and 256 characters");
  }
}

function idleContext(): AgentConnectionContext {
  return {
    clientId: "anonymous",
    emit: () => {},
    addSubscription: () => {},
  };
}
