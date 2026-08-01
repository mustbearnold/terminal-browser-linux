import { AgentError } from "../protocol/errors";
import type { AgentEvent } from "../protocol/types";

export type AgentEventListener = (event: AgentEvent) => void;

export interface EventSubscriptionOptions {
  afterSequence?: number;
}

export interface EventSubscription {
  readonly sequence: number;
  readonly replayed: number;
  unsubscribe(): void;
}

export class AgentEventBus {
  private readonly listeners = new Set<AgentEventListener>();
  private readonly history: AgentEvent[] = [];
  private latest = 0;

  constructor(private readonly historyLimit = 256) {
    if (!Number.isSafeInteger(historyLimit) || historyLimit < 1) {
      throw new AgentError("INVALID_REQUEST", "event history limit must be a positive safe integer");
    }
  }

  get size(): number {
    return this.listeners.size;
  }

  get latestSequence(): number {
    return this.latest;
  }

  subscribe(listener: AgentEventListener, options: EventSubscriptionOptions = {}): EventSubscription {
    const replay = this.replay(options.afterSequence);
    this.listeners.add(listener);
    try {
      for (const event of replay) listener(event);
    } catch (error) {
      this.listeners.delete(listener);
      throw error;
    }
    return {
      sequence: this.latest,
      replayed: replay.length,
      unsubscribe: () => this.listeners.delete(listener),
    };
  }

  publish(event: AgentEvent): void {
    if (event.sequence <= this.latest) {
      throw new AgentError("INVALID_REQUEST", "event sequence must be strictly increasing");
    }
    this.latest = event.sequence;
    this.history.push(event);
    if (this.history.length > this.historyLimit) this.history.shift();
    for (const listener of this.listeners) listener(event);
  }

  private replay(afterSequence: number | undefined): AgentEvent[] {
    if (afterSequence === undefined) return [];
    const earliestSequence = this.history[0]?.sequence ?? (this.latest > 0 ? this.latest + 1 : 1);
    if (afterSequence > this.latest) {
      throw new AgentError("EVENT_GAP", "event cursor is ahead of the current stream", {
        retryable: true,
        details: {
          afterSequence,
          earliestSequence,
          latestSequence: this.latest,
        },
      });
    }
    if (afterSequence === this.latest) return [];
    if (afterSequence < earliestSequence - 1) {
      throw new AgentError("EVENT_GAP", "event history no longer contains the requested cursor", {
        retryable: true,
        details: {
          afterSequence,
          earliestSequence,
          latestSequence: this.latest,
        },
      });
    }
    return this.history.filter((event) => event.sequence > afterSequence);
  }
}
