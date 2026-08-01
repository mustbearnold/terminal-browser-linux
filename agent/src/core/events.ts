import type { AgentEvent } from "../protocol/types";

export type AgentEventListener = (event: AgentEvent) => void;

export class AgentEventBus {
  private readonly listeners = new Set<AgentEventListener>();

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
