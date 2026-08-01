import type { AgentMessage } from "../protocol/types";

export interface TraceEntry {
  sequence: number;
  timestamp: number;
  direction: "inbound" | "outbound" | "event";
  message: AgentMessage;
}

export interface TraceSink {
  record(entry: TraceEntry): void;
}

export class MemoryTrace implements TraceSink {
  private readonly values: TraceEntry[] = [];

  record(entry: TraceEntry): void {
    this.values.push(entry);
  }

  entries(): readonly TraceEntry[] {
    return this.values.slice();
  }
}
