import type { PageBackend } from "../core/page";
import type { AgentEvent, PageId } from "../protocol/types";

export interface CdpConnection {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  subscribe(listener: (method: string, params: unknown) => void): () => void;
  close(): Promise<void> | void;
}

export interface CdpPageBackend extends PageBackend {
  readonly pageId: PageId;
  readonly connection: CdpConnection;
  emit(event: AgentEvent): void;
}
