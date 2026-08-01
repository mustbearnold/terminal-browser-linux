import assert from "node:assert/strict";
import test from "node:test";

import { AgentError } from "terminal-browser-agent";
import type { AgentCallOptions, AgentToolCall } from "terminal-browser-agent";

import { AgentToolLineSession, type AgentToolInvoker } from "./agent-tools";

interface FakePending {
  name: string;
  options?: AgentCallOptions;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  settled: boolean;
}

class FakeToolInvoker implements AgentToolInvoker {
  readonly requests = new Map<string, FakePending>();
  private sequence = 0;

  startTool(name: string, _argumentsValue?: unknown, options?: AgentCallOptions): Promise<AgentToolCall<unknown>> {
    const requestId = `fake:${name}:${++this.sequence}`;
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const pending: FakePending = {
      name,
      options,
      resolve: (value) => {
        pending.settled = true;
        resolve(value);
      },
      reject: (error) => {
        pending.settled = true;
        reject(error);
      },
      settled: false,
    };
    const promise = new Promise<unknown>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    this.requests.set(requestId, pending);
    return Promise.resolve({
      requestId,
      promise,
      cancel: async () => {
        if (pending.settled) return false;
        pending.settled = true;
        reject(new AgentError("REQUEST_CANCELLED", "request was cancelled"));
        return true;
      },
    });
  }
}

test("runs concurrent JSONL calls with correlated results and cancellation", async () => {
  const invoker = new FakeToolInvoker();
  const messages: Record<string, unknown>[] = [];
  const session = new AgentToolLineSession(invoker, (message) => messages.push(message as Record<string, unknown>));

  await session.handle(JSON.stringify({ id: "slow", name: "slow", arguments: {}, deadlineMs: 5000 }));
  await session.handle(JSON.stringify({ id: "fast", name: "fast", arguments: {} }));

  const accepted = messages.filter((message) => message.kind === "accepted");
  assert.equal(accepted.length, 2);
  const slowRequestId = accepted[0].requestId as string;
  const fastRequestId = accepted[1].requestId as string;
  assert.equal(invoker.requests.get(slowRequestId)?.options?.deadlineMs, 5000);

  invoker.requests.get(fastRequestId)?.resolve({ value: "fast" });
  await Promise.resolve();
  await session.handle(JSON.stringify({ id: "cancel", cancelRequestId: slowRequestId }));
  await session.drain();

  const fastResult = messages.find((message) => message.requestId === fastRequestId && message.kind === "result");
  const slowResult = messages.find((message) => message.requestId === slowRequestId && message.kind === "result");
  const cancel = messages.find((message) => message.kind === "cancel");
  assert.deepEqual(fastResult, {
    kind: "result",
    id: "fast",
    name: "fast",
    requestId: fastRequestId,
    ok: true,
    result: { value: "fast" },
  });
  assert.equal(cancel?.canceled, true);
  assert.equal((slowResult?.error as { code: string }).code, "REQUEST_CANCELLED");
});

test("reports malformed JSONL requests without stopping the session", async () => {
  const invoker = new FakeToolInvoker();
  const messages: Record<string, unknown>[] = [];
  const session = new AgentToolLineSession(invoker, (message) => messages.push(message as Record<string, unknown>));

  await session.handle("not-json");
  await session.handle(JSON.stringify({ id: "bad-deadline", name: "slow", deadlineMs: -1 }));

  assert.equal(messages[0].ok, false);
  assert.equal((messages[0].error as { code: string }).code, "INVALID_REQUEST");
  assert.equal(messages[1].ok, false);
  assert.equal((messages[1].error as { code: string }).code, "INVALID_REQUEST");
  await session.drain();
});
