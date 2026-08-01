import { AgentError } from "../protocol/errors";
import type {
  ActionResult,
  AgentEvent,
  AgentAction,
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
import { actionCapability, operationCapability } from "./capabilities";
import { IdempotencyCache, stableSerialize, type ActionJournal } from "./idempotency";
import { SnapshotLocatorResolver } from "./locator";
import { DefaultPolicy, type PolicyContext, type PolicyEngine } from "./policy";
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
  private readonly actionJournal: ActionJournal<ActionResult>;
  private readonly defaultContext = idleContext();
  readonly trace: TraceRecorder;

  constructor(
    private readonly runtime: AgentRuntime,
    trace = new TraceRecorder(new MemoryTrace()),
    private readonly policy: PolicyEngine = new DefaultPolicy(),
    actionJournal: ActionJournal<ActionResult> = new IdempotencyCache<ActionResult>(),
  ) {
    this.trace = trace;
    this.actionJournal = actionJournal;
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
      execution = this.registry(connection).begin(request.requestId, request.deadlineMs, {
        cancelOnClose: request.op !== "page.act" || request.idempotencyKey === undefined,
      });
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
    const capability = operationCapability(request);
    if (capability) {
      requireCapability(new Set(this.runtime.capabilities()), capability);
      await this.authorize(context, capability, requestPolicyContext(request));
    }
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
      case "page.capture": {
        const page = this.page(request.pageId);
        if (!page.capture) {
          throw new AgentError("CAPABILITY_UNAVAILABLE", "page capture is unavailable", {
            details: { capability: "page.capture" },
          });
        }
        return await page.capture(request.options, signal);
      }
      case "page.read": {
        const page = this.page(request.pageId);
        const snapshot = await page.snapshot(undefined, signal);
        if (request.token) page.assertFresh(request.token);
        const resolved = page.resolve
          ? await page.resolve(request.target, snapshot, signal)
          : this.locator.resolve(request.target, snapshot);
        return resolved.node;
      }
      case "page.act": {
        if (request.idempotencyKey !== undefined) requireIdempotencyKey(request.idempotencyKey);
        await this.authorize(context, actionCapability(request.action), {
          pageId: request.pageId,
          action: request.action,
          origin: originForAction(request.action),
        });
        const execute = () => this.executeAction(request, signal);
        if (request.idempotencyKey === undefined) return await execute();
        const key = `${context.clientId}\u0000${String(request.pageId)}\u0000${request.idempotencyKey}`;
        const fingerprint = stableSerialize({
          pageId: request.pageId,
          action: request.action,
          token: request.token,
          expect: request.expect,
        });
        const outcome = await this.actionJournal.execute(key, fingerprint, execute);
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

  private async authorize(
    context: AgentConnectionContext,
    capability: AgentCapability,
    extra: Omit<PolicyContext, "clientId" | "capability"> = {},
  ): Promise<void> {
    const decision = await this.policy.decide({ clientId: context.clientId, capability, ...extra });
    if (decision.allowed && !decision.requiresConfirmation) return;
    throw new AgentError("POLICY_DENIED", decision.reason ?? "agent policy denied the request", {
      details: {
        capability,
        ...(decision.requiresConfirmation ? { requiresConfirmation: true } : {}),
      },
    });
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

function requestPolicyContext(request: AgentRequest): Omit<PolicyContext, "clientId" | "capability"> {
  const context: Omit<PolicyContext, "clientId" | "capability"> = {};
  if ("pageId" in request) context.pageId = request.pageId;
  if (request.op === "page.act") {
    context.action = request.action;
    context.origin = originForAction(request.action);
  } else if (request.op === "pages.open") {
    context.origin = originForUrl(request.url);
  }
  return context;
}

function originForAction(action: AgentAction): string | undefined {
  return action.type === "navigate" ? originForUrl(action.url) : undefined;
}

function originForUrl(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function idleContext(): AgentConnectionContext {
  return {
    clientId: "anonymous",
    emit: () => {},
    addSubscription: () => {},
  };
}
