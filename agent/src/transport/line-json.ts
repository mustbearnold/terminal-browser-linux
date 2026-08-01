import { AgentError } from "../protocol/errors";
import type { AgentMessage } from "../protocol/types";
import { parseAgentMessage } from "../protocol/validate";

export function encodeAgentMessage(message: AgentMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export class LineJsonDecoder {
  private buffer = "";

  push(chunk: string | Uint8Array): AgentMessage[] {
    this.buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    const messages: AgentMessage[] = [];
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) {
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          throw new AgentError("INVALID_MESSAGE", "transport frame is not valid JSON");
        }
        messages.push(parseAgentMessage(value));
      }
      newline = this.buffer.indexOf("\n");
    }
    return messages;
  }

  flush(): void {
    if (this.buffer.trim()) throw new AgentError("INVALID_MESSAGE", "transport ended mid-frame");
  }
}
