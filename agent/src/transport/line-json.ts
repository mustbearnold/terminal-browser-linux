import { AgentError } from "../protocol/errors";
import type { AgentMessage } from "../protocol/types";
import { parseAgentMessage } from "../protocol/validate";

export const MAX_AGENT_FRAME_BYTES = 64 * 1024 * 1024;

export function encodeAgentMessage(message: AgentMessage, maxFrameBytes = MAX_AGENT_FRAME_BYTES): string {
  validateMaxFrameBytes(maxFrameBytes);
  const body = JSON.stringify(message);
  assertFrameSize(Buffer.byteLength(body, "utf8"), maxFrameBytes);
  return `${body}\n`;
}

export class LineJsonDecoder {
  private buffer = Buffer.alloc(0);

  constructor(private readonly maxFrameBytes = MAX_AGENT_FRAME_BYTES) {
    validateMaxFrameBytes(maxFrameBytes);
  }

  push(chunk: string | Uint8Array): AgentMessage[] {
    const incoming = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    if (incoming.length > 0) {
      this.buffer = this.buffer.length === 0 ? incoming : Buffer.concat([this.buffer, incoming]);
    }
    const messages: AgentMessage[] = [];
    let newline = this.buffer.indexOf(0x0a);
    while (newline >= 0) {
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.assertFrameSize(line.length);
      if (line.toString("utf8").trim()) {
        let value: unknown;
        try {
          value = JSON.parse(line.toString("utf8"));
        } catch {
          throw new AgentError("INVALID_MESSAGE", "transport frame is not valid JSON");
        }
        messages.push(parseAgentMessage(value));
      }
      newline = this.buffer.indexOf(0x0a);
    }
    this.assertFrameSize(this.buffer.length);
    if (this.buffer.length > 0) this.buffer = Buffer.from(this.buffer);
    return messages;
  }

  flush(): void {
    if (this.buffer.toString("utf8").trim()) throw new AgentError("INVALID_MESSAGE", "transport ended mid-frame");
  }

  private assertFrameSize(size: number): void {
    assertFrameSize(size, this.maxFrameBytes);
  }
}

function validateMaxFrameBytes(maxFrameBytes: number): void {
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
    throw new RangeError("max frame bytes must be a positive safe integer");
  }
}

function assertFrameSize(size: number, maxFrameBytes: number): void {
  if (size <= maxFrameBytes) return;
  throw new AgentError("INVALID_MESSAGE", "transport frame exceeds the maximum size", {
    details: { maxFrameBytes },
  });
}
