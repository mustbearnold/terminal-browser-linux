import type { JsonValue } from "./types";

export type AgentErrorCode =
  | "INVALID_MESSAGE"
  | "PROTOCOL_MISMATCH"
  | "INVALID_REQUEST"
  | "CAPABILITY_UNAVAILABLE"
  | "IDEMPOTENCY_CONFLICT"
  | "ACTION_STATUS_UNKNOWN"
  | "HISTORY_UNAVAILABLE"
  | "EVENT_GAP"
  | "PAGE_NOT_FOUND"
  | "FRAME_NOT_FOUND"
  | "SNAPSHOT_NOT_FOUND"
  | "STALE_SNAPSHOT"
  | "TARGET_NOT_FOUND"
  | "AMBIGUOUS_TARGET"
  | "NOT_INTERACTABLE"
  | "ACTION_UNVERIFIED"
  | "TIMEOUT"
  | "REQUEST_CANCELLED"
  | "POLICY_DENIED"
  | "TRANSPORT_CLOSED"
  | "INTERNAL_ERROR";

export class AgentError extends Error {
  readonly code: AgentErrorCode;
  readonly retryable: boolean;
  readonly details: JsonValue | undefined;

  constructor(
    code: AgentErrorCode,
    message: string,
    options?: { retryable?: boolean; details?: JsonValue },
  ) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.details = options?.details;
  }

  payload() {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}
