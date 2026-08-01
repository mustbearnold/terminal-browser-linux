import type { AgentMessage, AgentRequest, AgentResponse } from "../protocol/types";

export const AGENT_TRACE_VERSION = 1 as const;
export const DEFAULT_MEMORY_TRACE_LIMIT = 256 as const;
export type TraceDirection = "inbound" | "outbound" | "event";

export interface TraceEntry {
  version: typeof AGENT_TRACE_VERSION;
  sequence: number;
  timestamp: number;
  direction: TraceDirection;
  message: AgentMessage;
}

export interface TraceDocument {
  version: typeof AGENT_TRACE_VERSION;
  entries: readonly TraceEntry[];
}

export interface TraceSink {
  record(entry: TraceEntry): void;
}

export class TraceRecorder {
  private sequence = 0;

  constructor(private readonly sink: TraceSink, private readonly now: () => number = Date.now) {}

  record(direction: TraceDirection, message: AgentMessage): void {
    this.sink.record({
      version: AGENT_TRACE_VERSION,
      sequence: ++this.sequence,
      timestamp: this.now(),
      direction,
      message,
    });
  }
}

export class MemoryTrace implements TraceSink {
  private readonly limit: number;
  private readonly values: TraceEntry[] = [];
  private start = 0;

  constructor(limit: number = DEFAULT_MEMORY_TRACE_LIMIT) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("trace limit must be a non-negative safe integer");
    this.limit = limit;
  }

  record(entry: TraceEntry): void {
    if (this.limit === 0) return;
    if (this.values.length < this.limit) {
      this.values.push(entry);
      return;
    }
    this.values[this.start] = entry;
    this.start = (this.start + 1) % this.limit;
  }

  entries(): readonly TraceEntry[] {
    if (this.start === 0) return this.values.slice();
    return Array.from({ length: this.values.length }, (_, index) => this.values[(this.start + index) % this.values.length]);
  }

  document(): TraceDocument {
    return { version: AGENT_TRACE_VERSION, entries: this.entries() };
  }
}

export async function replayTrace(
  trace: TraceDocument | readonly TraceEntry[],
  handle: (request: AgentRequest) => Promise<AgentResponse>,
): Promise<readonly AgentResponse[]> {
  const document = Array.isArray(trace) ? undefined : (trace as TraceDocument);
  const entries = document ? document.entries : (trace as readonly TraceEntry[]);
  if (document && document.version !== AGENT_TRACE_VERSION) {
    throw new Error(`unsupported agent trace version: ${document.version}`);
  }
  const responses: AgentResponse[] = [];
  let previousSequence = 0;
  for (const entry of entries) {
    if (entry.version !== AGENT_TRACE_VERSION) {
      throw new Error(`unsupported agent trace version: ${entry.version}`);
    }
    if (!Number.isSafeInteger(entry.sequence) || entry.sequence <= previousSequence) {
      throw new Error("agent trace sequence must be strictly increasing");
    }
    previousSequence = entry.sequence;
    if (entry.message.kind !== "request") continue;
    responses.push(await handle(entry.message));
  }
  return responses;
}
