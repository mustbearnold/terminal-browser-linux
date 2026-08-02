import { AgentError } from "terminal-browser-agent";
import type {
  AgentCallOptions,
  AgentConnectionState,
  AgentHelloResult,
} from "terminal-browser-agent";

export type AgentConnectionLifecycleState =
  | "disconnected"
  | "reconnecting"
  | "connected"
  | "failed"
  | "closed";

export interface AgentConnectionLifecycle {
  readonly state: AgentConnectionLifecycleState;
  readonly error?: Record<string, unknown>;
}

export interface RecoverableAgentTools {
  onConnectionState(listener: (state: AgentConnectionState) => void): () => void;
  reconnect(options?: AgentCallOptions): Promise<AgentHelloResult>;
}

export interface AgentConnectionSupervisor {
  reconnect(options?: AgentCallOptions): Promise<void>;
  dispose(): void;
}

export function superviseAgentConnection(
  tools: RecoverableAgentTools,
  notify: (lifecycle: AgentConnectionLifecycle) => void,
): AgentConnectionSupervisor {
  let disposed = false;
  let reconnectPromise: Promise<void> | null = null;
  let lossReported = false;
  let automaticAttempted = false;
  let unsubscribe = () => {};

  const emit = (lifecycle: AgentConnectionLifecycle): void => {
    if (disposed) return;
    try {
      notify(lifecycle);
    } catch {}
  };

  const reconnect = (options?: AgentCallOptions): Promise<void> => {
    if (reconnectPromise) return reconnectPromise;
    if (disposed) return Promise.reject(new AgentError("TRANSPORT_CLOSED", "agent connection supervisor is closed"));
    emit({ state: "reconnecting" });
    let transportAttempt: Promise<AgentHelloResult>;
    try {
      transportAttempt = tools.reconnect(options);
    } catch (error) {
      transportAttempt = Promise.reject(error);
    }
    const attempt = transportAttempt
      .then(() => {
        lossReported = false;
        automaticAttempted = false;
        emit({ state: "connected" });
      })
      .catch((error: unknown) => {
        emit({ state: "failed", error: errorPayload(error) });
        throw error;
      })
      .finally(() => {
        reconnectPromise = null;
      });
    reconnectPromise = attempt;
    return attempt;
  };

  unsubscribe = tools.onConnectionState((state) => {
    if (disposed) return;
    if (state === "disconnected") {
      if (!lossReported) {
        lossReported = true;
        emit({ state });
      }
      if (!automaticAttempted) {
        automaticAttempted = true;
        void reconnect().catch(() => {});
      }
      return;
    }
    if (state === "closed") {
      emit({ state });
      disposed = true;
      unsubscribe();
    }
  });

  return {
    reconnect,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
    },
  };
}

function errorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof AgentError) return error.payload();
  return {
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
  };
}
