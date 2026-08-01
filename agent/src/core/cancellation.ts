import { AgentError } from "../protocol/errors";

export const MAX_REQUEST_DEADLINE_MS = 2_147_483_647;

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof AgentError) throw reason;
  throw new AgentError("REQUEST_CANCELLED", "request was cancelled", { retryable: true });
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (!signal) return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface RequestExecution {
  readonly signal: AbortSignal;
  finish(): void;
}

export interface RequestExecutionOptions {
  cancelOnClose?: boolean;
}

interface ActiveRequest {
  controller: AbortController;
  cancelOnClose: boolean;
}

export class RequestCancellationRegistry {
  private readonly active = new Map<string, ActiveRequest>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  begin(requestId: string, deadlineMs?: number, options: RequestExecutionOptions = {}): RequestExecution {
    if (this.active.has(requestId)) {
      throw new AgentError("INVALID_REQUEST", `request is already active: ${requestId}`);
    }
    if (deadlineMs !== undefined && (!Number.isSafeInteger(deadlineMs) || deadlineMs < 0 || deadlineMs > MAX_REQUEST_DEADLINE_MS)) {
      throw new AgentError("INVALID_REQUEST", "deadlineMs must be a non-negative safe integer within timer limits");
    }
    const controller = new AbortController();
    this.active.set(requestId, { controller, cancelOnClose: options.cancelOnClose ?? true });
    if (deadlineMs !== undefined) {
      if (deadlineMs === 0) controller.abort(deadlineError(requestId));
      else {
        this.timers.set(
          requestId,
          setTimeout(() => controller.abort(deadlineError(requestId)), deadlineMs),
        );
      }
    }
    return {
      signal: controller.signal,
      finish: () => this.finish(requestId, controller),
    };
  }

  cancel(requestId: string): boolean {
    const entry = this.active.get(requestId);
    if (!entry) return false;
    entry.controller.abort(new AgentError("REQUEST_CANCELLED", "request was cancelled", {
      retryable: true,
      details: { requestId },
    }));
    return true;
  }

  cancelAll(): void {
    const reason = new AgentError("TRANSPORT_CLOSED", "agent transport closed", { retryable: true });
    for (const [requestId, entry] of this.active) {
      if (!entry.cancelOnClose) continue;
      entry.controller.abort(reason);
      this.active.delete(requestId);
      const timer = this.timers.get(requestId);
      if (timer) clearTimeout(timer);
      this.timers.delete(requestId);
    }
  }

  private finish(requestId: string, controller: AbortController): void {
    if (this.active.get(requestId)?.controller !== controller) return;
    this.active.delete(requestId);
    const timer = this.timers.get(requestId);
    if (timer) clearTimeout(timer);
    this.timers.delete(requestId);
  }
}

function deadlineError(requestId: string): AgentError {
  return new AgentError("TIMEOUT", "request deadline exceeded", {
    retryable: true,
    details: { requestId },
  });
}
