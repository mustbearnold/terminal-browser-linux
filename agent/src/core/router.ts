import { AgentError } from "../protocol/errors";
import type {
  ActionBatchResult,
  ActionResult,
  AgentEvent,
  AgentAction,
  AgentMessage,
  AgentRequest,
  AgentResponse,
} from "../protocol/types";
import type { EventSubscription } from "./events";
import {
  AGENT_PROTOCOL,
  AGENT_PROTOCOL_VERSION,
  type AgentCapability,
  type PageId,
} from "../protocol/types";
import type { AgentRuntime } from "./runtime";
import { actionCapability, operationCapability } from "./capabilities";
import { IdempotencyCache, stableSerialize, type ActionJournal } from "./idempotency";
import { DefaultPolicy, type PolicyContext, type PolicyEngine } from "./policy";
import { RequestCancellationRegistry, throwIfAborted, type RequestExecution } from "./cancellation";
import { MemoryTrace, TraceRecorder, type TraceDirection } from "./trace";

export interface AgentConnectionContext {
  clientId: string;
  emit(message: AgentMessage): Promise<void> | void;
  addSubscription(cleanup: () => void): void | (() => void);
}

interface ActiveSubscription {
  pageId: PageId;
  subscription: EventSubscription;
  removeCleanup?: () => void;
}

export class AgentRequestRouter {
  private readonly requests = new WeakMap<AgentConnectionContext, RequestCancellationRegistry>();
  private readonly subscriptions = new WeakMap<AgentConnectionContext, Map<string, ActiveSubscription>>();
  private readonly subscriptionSequences = new WeakMap<AgentConnectionContext, number>();
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
    const subscriptions = this.subscriptions.get(context);
    for (const subscriptionId of subscriptions?.keys() ?? []) {
      this.cancelSubscription(context, subscriptionId);
    }
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
      cancelOnClose: !isIdempotentActionRequest(request),
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
      case "pages.activate":
        return await this.runtime.activatePage(request.pageId);
      case "pages.close":
        await this.runtime.closePage(request.pageId);
        this.cancelSubscriptionsForPage(context, request.pageId);
        return { pageId: request.pageId };
      case "page.frames":
        return await this.page(request.pageId).frames(signal);
      case "page.query":
        return await this.page(request.pageId).query(request.locator, request.options, signal);
      case "page.query.batch":
        return await this.page(request.pageId).queryBatch(request.queries, signal);
      case "page.snapshot":
        return await this.page(request.pageId).snapshot(request.options, signal);
      case "page.snapshot.window": {
        const page = this.page(request.pageId);
        if (!page.snapshotWindow) {
          throw new AgentError("CAPABILITY_UNAVAILABLE", "snapshot windows are unavailable", {
            details: { capability: "snapshot.window" },
          });
        }
        return await page.snapshotWindow(request.options, request.cursor, signal);
      }
      case "page.snapshot.delta":
        return await this.page(request.pageId).snapshotDelta(request.base, request.options, signal);
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
        return await this.page(request.pageId).read(request.target, request.token, signal);
      }
      case "page.active":
        return await this.page(request.pageId).active(signal);
      case "page.act": {
        if (request.idempotencyKey !== undefined) requireIdempotencyKey(request.idempotencyKey);
        await this.authorize(context, actionCapability(request.action), {
          pageId: request.pageId,
          action: request.action,
          origin: originForAction(request.action),
        });
        const execute = () => this.executeAction(request, signal);
        if (request.idempotencyKey === undefined) return await execute();
        const key = actionJournalKey(context.clientId, request.pageId, request.idempotencyKey);
        const fingerprint = stableSerialize({
          pageId: request.pageId,
          action: request.action,
          token: request.token,
          expect: request.expect,
          output: request.output,
        });
        const outcome = await this.actionJournal.execute(key, fingerprint, execute);
        return outcome.replayed ? { ...outcome.result, replayed: true } : outcome.result;
      }
      case "page.act.batch": {
        if (request.idempotencyKey !== undefined) requireIdempotencyKey(request.idempotencyKey);
        for (const step of request.steps) {
          await this.authorize(context, actionCapability(step.action), {
            pageId: request.pageId,
            action: step.action,
            origin: originForAction(step.action),
          });
        }
        const execute = () => this.executeActionBatch(request, signal);
        if (request.idempotencyKey === undefined) return await execute();
        const key = actionJournalKey(context.clientId, request.pageId, request.idempotencyKey);
        const fingerprint = stableSerialize({
          pageId: request.pageId,
          steps: request.steps,
          output: request.output,
        });
        const outcome = await this.actionJournal.execute(key, fingerprint, execute);
        return outcome.replayed ? { ...outcome.result, replayed: true } : outcome.result;
      }
      case "page.act.status": {
        const status = this.actionJournal.status(
          actionJournalKey(context.clientId, request.pageId, request.idempotencyKey),
        );
        return {
          pageId: request.pageId,
          idempotencyKey: request.idempotencyKey,
          ...status,
        };
      }
      case "page.wait":
        return await this.page(request.pageId).wait(request.condition, request.timeoutMs, signal, request.output);
      case "page.dialog": {
        const page = this.page(request.pageId);
        if (!page.dialog) {
          throw new AgentError("CAPABILITY_UNAVAILABLE", "page dialog control is unavailable", {
            details: { capability: "page.dialog" },
          });
        }
        return await page.dialog(request.dialogId, request.action, signal);
      }
      case "page.observe": {
        const page = this.page(request.pageId);
        if (request.after !== undefined && request.after.pageId !== request.pageId) {
          throw new AgentError("INVALID_REQUEST", "event cursor pageId must match the observed page");
        }
        const wanted = new Set(request.events);
        const subscription = await page.subscribe((event) => {
          this.record("event", event);
          void context.emit(event);
        }, {
          afterSequence: request.after?.sequence,
          filter: (event) => wanted.has(event.event),
        }, signal);
        try {
          throwIfAborted(signal);
        } catch (error) {
          subscription.unsubscribe();
          throw error;
        }
        const subscriptionId = this.registerSubscription(context, request.pageId, subscription);
        return {
          pageId: request.pageId,
          subscriptionId,
          events: request.events,
          cursor: { pageId: request.pageId, sequence: subscription.sequence },
          replayed: subscription.replayed,
        };
      }
      case "page.observe.cancel": {
        this.page(request.pageId);
        return {
          pageId: request.pageId,
          subscriptionId: request.subscriptionId,
          canceled: this.cancelSubscription(context, request.subscriptionId, request.pageId),
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
    return this.page(request.pageId).act(request.action, request.token, request.expect, signal, request.output);
  }

  private async executeActionBatch(
    request: Extract<AgentRequest, { op: "page.act.batch" }>,
    signal: AbortSignal,
  ): Promise<ActionBatchResult> {
    const capabilities = new Set(this.runtime.capabilities());
    requireCapability(capabilities, "page.act.batch");
    for (const step of request.steps) requireCapability(capabilities, actionCapability(step.action));
    return this.page(request.pageId).actBatch(request.steps, signal, request.output);
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

  private registerSubscription(
    context: AgentConnectionContext,
    pageId: PageId,
    subscription: EventSubscription,
  ): string {
    let active = this.subscriptions.get(context);
    if (!active) {
      active = new Map();
      this.subscriptions.set(context, active);
    }
    const sequence = (this.subscriptionSequences.get(context) ?? 0) + 1;
    this.subscriptionSequences.set(context, sequence);
    const subscriptionId = `subscription-${sequence}`;
    const cleanup = () => {
      this.cancelSubscription(context, subscriptionId);
    };
    const removeCleanup = context.addSubscription(cleanup);
    active.set(subscriptionId, {
      pageId,
      subscription,
      ...(typeof removeCleanup === "function" ? { removeCleanup } : {}),
    });
    return subscriptionId;
  }

  private cancelSubscription(context: AgentConnectionContext, subscriptionId: string, pageId?: PageId): boolean {
    const active = this.subscriptions.get(context);
    const entry = active?.get(subscriptionId);
    if (!entry || (pageId !== undefined && entry.pageId !== pageId)) return false;
    active!.delete(subscriptionId);
    entry.subscription.unsubscribe();
    entry.removeCleanup?.();
    if (active!.size === 0) this.subscriptions.delete(context);
    return true;
  }

  private cancelSubscriptionsForPage(context: AgentConnectionContext, pageId: PageId): void {
    const subscriptions = this.subscriptions.get(context);
    if (!subscriptions) return;
    for (const [subscriptionId, entry] of subscriptions) {
      if (entry.pageId === pageId) this.cancelSubscription(context, subscriptionId, pageId);
    }
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

function isIdempotentActionRequest(request: AgentRequest): boolean {
  return (
    (request.op === "page.act" || request.op === "page.act.batch") &&
    request.idempotencyKey !== undefined
  );
}

function actionJournalKey(clientId: string, pageId: PageId, idempotencyKey: string): string {
  return `${clientId}\u0000${String(pageId)}\u0000${idempotencyKey}`;
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
