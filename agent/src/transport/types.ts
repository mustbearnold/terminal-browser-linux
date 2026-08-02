import type { AgentMessage, AgentOutboundQueueLimits } from "../protocol/types";

export interface AgentTransport {
  readonly outboundQueueLimits?: AgentOutboundQueueLimits;
  send(message: AgentMessage): Promise<void>;
  onMessage(listener: (message: AgentMessage) => void): () => void;
  onError(listener: (error: unknown) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): Promise<void> | void;
}

export interface AgentTransportServer {
  listen(): Promise<void>;
  accept(listener: (transport: AgentTransport) => void): () => void;
  close(): Promise<void> | void;
}
