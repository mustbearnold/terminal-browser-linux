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
  type PageId,
} from "../protocol/types";
import type { AgentRuntime } from "./runtime";
import { SnapshotLocatorResolver } from "./locator";

export interface AgentConnectionContext {
  clientId: string;
  emit(message: AgentMessage): Promise<void> | void;
  addSubscription(cleanup: () => void): void;
}

export class AgentRequestRouter {
  private readonly locator = new SnapshotLocatorResolver();

  constructor(private readonly runtime: AgentRuntime) {}

  async handle(request: AgentRequest, context: AgentConnectionContext = idleContext()): Promise<AgentResponse> {
    try {
      const result = await this.dispatch(request, context);
      return {
        kind: "response",
        protocol: AGENT_PROTOCOL,
        version: AGENT_PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: true,
        result,
      };
    } catch (error) {
      const failure = normalizeError(error);
      return {
        kind: "response",
        protocol: AGENT_PROTOCOL,
        version: AGENT_PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: false,
        error: failure.payload(),
      };
    }
  }

  private async dispatch(request: AgentRequest, context: AgentConnectionContext): Promise<unknown> {
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
      case "page.snapshot":
        return await this.page(request.pageId).snapshot(request.options);
      case "page.read": {
        const page = this.page(request.pageId);
        const snapshot = await page.snapshot();
        if (request.token) page.assertFresh(request.token);
        return this.locator.resolve(request.target, snapshot).node;
      }
      case "page.act":
        return await this.page(request.pageId).act(request.action, request.token, request.expect);
      case "page.wait":
        return await this.page(request.pageId).wait(request.condition, request.timeoutMs);
      case "page.observe": {
        const page = this.page(request.pageId);
        const wanted = new Set(request.events);
        const cleanup = await page.subscribe((event) => {
          if (wanted.has(event.event)) void context.emit(event);
        });
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
}

function normalizeError(error: unknown): AgentError {
  if (error instanceof AgentError) return error;
  return new AgentError("INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
}

function idleContext(): AgentConnectionContext {
  return {
    clientId: "anonymous",
    emit: () => {},
    addSubscription: () => {},
  };
}
