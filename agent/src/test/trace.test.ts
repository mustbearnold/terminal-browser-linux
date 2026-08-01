import assert from "node:assert/strict";
import test from "node:test";

import { AgentRequestRouter, type AgentConnectionContext } from "../core/router";
import { AGENT_TRACE_VERSION, MemoryTrace, replayTrace, TraceRecorder } from "../core/trace";
import type { AgentRequest, AgentResponse } from "../protocol/types";
import { AGENT_PROTOCOL, AGENT_PROTOCOL_VERSION } from "../protocol/types";
import { FIXTURE_PAGE_ID, FixtureRuntime } from "./fixture";

let requestSequence = 0;

test("records versioned requests, responses, and events that can be replayed", async () => {
  const trace = new MemoryTrace();
  const router = new AgentRequestRouter(new FixtureRuntime(), new TraceRecorder(trace, () => 1234));
  const events: unknown[] = [];
  const context: AgentConnectionContext = {
    clientId: "trace-fixture",
    emit: (message) => {
      events.push(message);
    },
    addSubscription: () => {},
  };

  const hello = await router.handle(request("hello", { clientId: "trace-fixture" }), context);
  const pages = await router.handle(request("pages.list"), context);
  await router.handle(request("page.observe", { pageId: FIXTURE_PAGE_ID, events: ["dom.changed"] }), context);
  await router.handle(
    request("page.act", {
      pageId: FIXTURE_PAGE_ID,
      action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Continue", exact: true } } },
    }),
    context,
  );

  const document = trace.document();
  assert.equal(document.version, AGENT_TRACE_VERSION);
  assert.deepEqual(document.entries.map((entry) => entry.direction), [
    "inbound",
    "outbound",
    "inbound",
    "outbound",
    "inbound",
    "outbound",
    "inbound",
    "event",
    "outbound",
  ]);
  assert.deepEqual(document.entries.map((entry) => entry.sequence), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(events.length > 0);
  assert.ok(document.entries.every((entry) => entry.version === AGENT_TRACE_VERSION && entry.timestamp === 1234));

  const replayed = await replayTrace(document, async (replayRequest) => {
    const replayRouter = new AgentRequestRouter(new FixtureRuntime());
    return replayRouter.handle(replayRequest);
  });
  assert.equal(replayed.length, 4);
  assert.deepEqual(replayed.map((response) => response.requestId), [
    hello.requestId,
    pages.requestId,
    document.entries[4].message.kind === "request" ? document.entries[4].message.requestId : "",
    document.entries[6].message.kind === "request" ? document.entries[6].message.requestId : "",
  ]);
  assert.ok(replayed.every((response) => response.ok));
});

test("rejects traces from a different version", async () => {
  const requestMessage = request("pages.list");
  const response: AgentResponse = {
    kind: "response",
    protocol: AGENT_PROTOCOL,
    version: AGENT_PROTOCOL_VERSION,
    requestId: requestMessage.requestId,
    ok: true,
    result: { pages: [] },
  };
  const trace = new MemoryTrace();
  const recorder = new TraceRecorder(trace, () => 1234);
  recorder.record("inbound", requestMessage);
  recorder.record("outbound", response);
  const invalid = { ...trace.document(), version: 99 } as unknown as Parameters<typeof replayTrace>[0];

  await assert.rejects(
    replayTrace(invalid, async () => response),
    /unsupported agent trace version/,
  );
});

test("bounds memory traces while preserving replay order", () => {
  const trace = new MemoryTrace(2);
  const recorder = new TraceRecorder(trace, () => 1234);
  recorder.record("inbound", request("pages.list"));
  recorder.record("outbound", {
    kind: "response",
    protocol: AGENT_PROTOCOL,
    version: AGENT_PROTOCOL_VERSION,
    requestId: "trace-overflow",
    ok: true,
  });
  recorder.record("inbound", request("pages.list"));

  assert.deepEqual(trace.entries().map((entry) => entry.sequence), [2, 3]);
});

function request<T extends AgentRequest["op"]>(op: T, fields: Record<string, unknown> = {}): AgentRequest {
  return {
    kind: "request",
    protocol: AGENT_PROTOCOL,
    version: AGENT_PROTOCOL_VERSION,
    requestId: `trace-${++requestSequence}`,
    op,
    ...fields,
  } as AgentRequest;
}
