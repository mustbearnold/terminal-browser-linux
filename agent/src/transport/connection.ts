import type { AgentMessage } from "../protocol/types";
import { AgentRequestRouter, type AgentConnectionContext } from "../core/router";
import type { AgentTransport } from "./types";

export function attachAgentConnection(
  transport: AgentTransport,
  router: AgentRequestRouter,
): () => void {
  const subscriptions = new Set<() => void>();
  let closed = false;
  const context: AgentConnectionContext = {
    clientId: "anonymous",
    emit: (message) => {
      if (closed) return;
      return transport.send(message).catch(() => {});
    },
    addSubscription: (cleanup) => {
      subscriptions.add(cleanup);
      return () => subscriptions.delete(cleanup);
    },
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    router.close(context);
    for (const unsubscribe of subscriptions) unsubscribe();
    subscriptions.clear();
    offMessage();
    offClose();
  };

  const offMessage = transport.onMessage((message: AgentMessage) => {
    if (message.kind !== "request") return;
    void router.handle(message, context)
      .then((response) => {
        if (closed) return;
        return transport.send(response);
      })
      .catch(() => {});
  });
  const offClose = transport.onClose(cleanup);
  transport.onError(() => {});
  return cleanup;
}
