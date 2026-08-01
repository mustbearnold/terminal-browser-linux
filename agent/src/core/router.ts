import { AgentError } from "../protocol/errors";
import type {
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
        return {
          protocol: AGENT_PROTOCOL,
          version: AGENT_PROTOCOL_VERSION,
          clientId: request.clientId,
          capabilities,
          requested: request.capabilities ?? capabilities,
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
        const capabilities = new Set(this.runtime.capabilities());
        requireCapability(capabilities, "page.act");
        requireCapability(capabilities, actionCapability(request.action));
        return await this.page(request.pageId).act(request.action, request.token, request.expect, signal);
      }
      case "page.wait":
        return await this.page(request.pageId).wait(request.condition, request.timeoutMs, signal);
      case "page.observe": {
        const page = this.page(request.pageId);
        const wanted = new Set(request.events);
        const cleanup = await page.subscribe((event) => {
          if (!wanted.has(event.event)) return;
          this.record("event", event);
          void context.emit(event);
        }, signal);
        try {
          throwIfAborted(signal);
        } catch (error) {
          cleanup();
          throw error;
        }
        context.addSubscription(cleanup);
        return { pageId: request.pageId, events: request.events };
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

function idleContext(): AgentConnectionContext {
  return {
    clientId: "anonymous",
    emit: () => {},
    addSubscription: () => {},
  };
}
