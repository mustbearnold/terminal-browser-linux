import assert from "node:assert/strict";
import test from "node:test";

import { MemoryTrace, TraceRecorder } from "../core/trace";
import { AgentClient } from "../client";
import { AgentRequestRouter } from "../core/router";
import { AgentError } from "../protocol/errors";
import { AGENT_PROTOCOL, AGENT_PROTOCOL_VERSION, type AgentMessage } from "../protocol/types";
import { RouterLoopbackTransport, createFixtureAgentClient } from "../evaluation/loopback";
import { FixtureRuntime } from "./fixture";
import { FIXTURE_PAGE_ID } from "./fixture";
import type { AgentTransport } from "../transport/types";

class HelloTransport implements AgentTransport {
  private readonly messageListeners = new Set<(message: AgentMessage) => void>();
  private readonly closeListeners = new Set<() => void>();
  closed = false;

  constructor(private readonly result: unknown) {}

  send(message: AgentMessage): Promise<void> {
    if (this.closed) return Promise.reject(new Error("transport is closed"));
    if (message.kind === "request" && message.op === "hello") {
      const response: AgentMessage = {
        kind: "response",
        protocol: AGENT_PROTOCOL,
        version: AGENT_PROTOCOL_VERSION,
        requestId: message.requestId,
        ok: true,
        result: this.result,
      };
      queueMicrotask(() => {
        if (!this.closed) for (const listener of this.messageListeners) listener(response);
      });
    }
    return Promise.resolve();
  }

  onMessage(listener: (message: AgentMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onError(): () => void {
    return () => {};
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener();
  }
}

class ReplayTransport implements AgentTransport {
  private readonly delegate: RouterLoopbackTransport;
  private readonly listeners = new Set<(message: AgentMessage) => void>();
  private blockedObserve: { message: AgentMessage; resolve: () => void } | null = null;

  constructor(private readonly router: AgentRequestRouter, private readonly failResume: boolean) {
    this.delegate = new RouterLoopbackTransport(router);
    this.delegate.onMessage((message) => {
      for (const listener of this.listeners) listener(message);
    });
  }

  get observeBlocked(): boolean {
    return this.blockedObserve !== null;
  }

  send(message: AgentMessage): Promise<void> {
    if (message.kind === "request" && message.op === "page.observe") {
      if (this.failResume) {
        const response: AgentMessage = {
          kind: "response",
          protocol: AGENT_PROTOCOL,
          version: AGENT_PROTOCOL_VERSION,
          requestId: message.requestId,
          ok: false,
          error: { code: "EVENT_GAP", message: "replay history is unavailable", retryable: true },
        };
        queueMicrotask(() => {
          for (const listener of this.listeners) listener(response);
        });
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        this.blockedObserve = { message, resolve };
      });
    }
    return this.delegate.send(message);
  }

  releaseObserve(): void {
    const blocked = this.blockedObserve;
    this.blockedObserve = null;
    if (!blocked) return;
    void this.delegate.send(blocked.message).then(blocked.resolve);
  }

  onMessage(listener: (message: AgentMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onError(listener: (error: unknown) => void): () => void {
    return this.delegate.onError(listener);
  }

  onClose(listener: () => void): () => void {
    return this.delegate.onClose(listener);
  }

  close(): Promise<void> {
    this.releaseObserve();
    return Promise.resolve(this.delegate.close());
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(predicate(), true);
}

test("correlates typed calls and delivers observed events", async () => {
  const client = createFixtureAgentClient({ clientId: "client-test" });
  const events: string[] = [];
  const unsubscribe = client.onEvent((event) => events.push(event.event));
  try {
    const [hello, pages, frames] = await Promise.all([
      client.hello(),
      client.call("pages.list", {}),
      client.frames(FIXTURE_PAGE_ID),
    ]);
    assert.equal(hello.clientId, "client-test");
    assert.equal(hello.accepted.includes("page.act"), true);
    assert.deepEqual(hello.unsupported, []);
    assert.deepEqual(hello.limits, {
      maxInFlightRequests: 128,
      maxQueuedActionsPerPage: 64,
      maxOutboundQueueMessages: 256,
      maxOutboundQueueBytes: 8 * 1024 * 1024,
    });
    assert.equal(pages.pages[0].pageId, FIXTURE_PAGE_ID);
    assert.deepEqual(frames, {
      pageId: FIXTURE_PAGE_ID,
      documentId: "fixture-document-1",
      revision: 0,
      frames: [{
        frameId: "main",
        parentFrameId: null,
        url: "fixture://agent-control",
        origin: "fixture://agent-control",
      }],
    });

    const observation = await client.observe(FIXTURE_PAGE_ID, ["dom.changed"]);
    assert.deepEqual(observation.cursor, { pageId: FIXTURE_PAGE_ID, sequence: 0 });
    assert.equal(observation.replayed, 0);
    const action = await client.call("page.act", {
      pageId: FIXTURE_PAGE_ID,
      action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Continue", exact: true } } },
    });
    assert.equal(action.verified, true);
    const active = await client.active(FIXTURE_PAGE_ID);
    assert.equal(active.active, false);
    assert.equal(active.node, null);
    assert.deepEqual(events, ["dom.changed"]);
  } finally {
    unsubscribe();
    await client.close();
  }
});

test("reconnects explicitly and resumes observations from the latest requested event", async () => {
  const router = new AgentRequestRouter(new FixtureRuntime());
  const firstTransport = new RouterLoopbackTransport(router);
  let reconnects = 0;
  const client = new AgentClient(firstTransport, {
    clientId: "reconnect-client",
    reconnect: async () => {
      reconnects += 1;
      return new RouterLoopbackTransport(router);
    },
  });
  const events: number[] = [];
  const unsubscribe = client.onEvent((event) => events.push(event.sequence));
  const second = new AgentClient(new RouterLoopbackTransport(router), { clientId: "reconnect-peer" });
  const click = {
    pageId: FIXTURE_PAGE_ID,
    action: { type: "click" as const, target: { locator: { kind: "role" as const, role: "button", name: "Continue", exact: true } } },
    output: { snapshot: "none" as const },
  };
  const focus = {
    pageId: FIXTURE_PAGE_ID,
    action: { type: "focus" as const, target: { locator: { kind: "role" as const, role: "textbox", name: "Name", exact: true } } },
    output: { snapshot: "none" as const },
  };
  try {
    await client.hello();
    await client.observe(FIXTURE_PAGE_ID, ["dom.changed"]);
    await client.call("page.act", click);
    assert.deepEqual(events, [1]);

    await client.disconnect();
    assert.equal(client.state, "disconnected");
    await assert.rejects(
      client.call("pages.list", {}),
      (error: unknown) => error instanceof AgentError && error.code === "TRANSPORT_CLOSED",
    );

    await second.hello();
    await second.call("page.act", focus);
    const [firstHello, secondHello] = await Promise.all([client.reconnect(), client.reconnect()]);
    assert.equal(firstHello.clientId, "reconnect-client");
    assert.equal(secondHello.clientId, "reconnect-client");
    assert.equal(reconnects, 1);
    assert.deepEqual(events, [1, 2]);

    await client.call("page.act", click);
    assert.deepEqual(events, [1, 2, 4]);
  } finally {
    unsubscribe();
    await second.close();
    await client.close();
  }
});

test("announces connected only after observation replay finishes", async () => {
  const router = new AgentRequestRouter(new FixtureRuntime());
  let reconnectTransport: ReplayTransport | undefined;
  const client = new AgentClient(new RouterLoopbackTransport(router), {
    clientId: "reconnect-lifecycle-client",
    reconnect: async () => {
      const transport = new ReplayTransport(router, false);
      reconnectTransport = transport;
      return transport;
    },
  });
  const states: string[] = [];
  const unsubscribe = client.onConnectionState((state) => states.push(state));
  try {
    await client.hello();
    await client.observe(FIXTURE_PAGE_ID, ["dom.changed"]);
    await client.disconnect();
    assert.deepEqual(states, ["disconnected"]);

    const reconnecting = client.reconnect();
    await waitUntil(() => reconnectTransport?.observeBlocked === true);
    assert.equal(client.state, "disconnected");
    assert.deepEqual(states, ["disconnected"]);

    reconnectTransport?.releaseObserve();
    await reconnecting;
    assert.equal(client.state, "connected");
    assert.deepEqual(states, ["disconnected", "connected"]);
  } finally {
    unsubscribe();
    await client.close();
  }
});

test("returns to disconnected when observation replay fails", async () => {
  const router = new AgentRequestRouter(new FixtureRuntime());
  let reconnectAttempt = 0;
  const client = new AgentClient(new RouterLoopbackTransport(router), {
    clientId: "reconnect-failure-client",
    reconnect: async () => {
      reconnectAttempt += 1;
      return new ReplayTransport(router, reconnectAttempt === 1);
    },
  });
  try {
    await client.hello();
    await client.observe(FIXTURE_PAGE_ID, ["dom.changed"]);
    await client.disconnect();

    await assert.rejects(
      client.reconnect(),
      (error: unknown) => error instanceof AgentError && error.code === "EVENT_GAP",
    );
    assert.equal(client.state, "disconnected");

    const hello = await client.reconnect();
    assert.equal(hello.clientId, "reconnect-failure-client");
    assert.equal(client.state, "connected");
    assert.equal(reconnectAttempt, 2);
  } finally {
    await client.close();
  }
});

test("keeps multiple same-page observation cursors independent during replay", async () => {
  const router = new AgentRequestRouter(new FixtureRuntime());
  const firstTransport = new RouterLoopbackTransport(router);
  const client = new AgentClient(firstTransport, {
    clientId: "multi-observation-client",
    reconnect: async () => new RouterLoopbackTransport(router),
  });
  const peer = new AgentClient(new RouterLoopbackTransport(router), { clientId: "multi-observation-peer" });
  const events: number[] = [];
  const unsubscribe = client.onEvent((event) => events.push(event.sequence));
  const click = {
    pageId: FIXTURE_PAGE_ID,
    action: { type: "click" as const, target: { locator: { kind: "role" as const, role: "button", name: "Continue", exact: true } } },
    output: { snapshot: "none" as const },
  };
  try {
    await client.hello();
    await client.observe(FIXTURE_PAGE_ID, ["dom.changed"]);
    await client.observe(FIXTURE_PAGE_ID, ["dom.changed"]);
    await client.call("page.act", click);
    assert.deepEqual(events, [1, 1]);

    await firstTransport.close();
    await peer.hello();
    await peer.call("page.act", click);
    await client.reconnect();
    assert.deepEqual(events, [1, 1, 2, 2]);
  } finally {
    unsubscribe();
    await peer.close();
    await client.close();
  }
});

test("closes when hello returns an invalid negotiated contract", async () => {
  const transport = new HelloTransport({
    protocol: AGENT_PROTOCOL,
    version: AGENT_PROTOCOL_VERSION,
    clientId: "hello-validation-test",
    capabilities: ["page.query"],
    requested: ["page.query"],
    accepted: ["page.query"],
    unsupported: [],
    limits: {
      maxInFlightRequests: 0,
      maxQueuedActionsPerPage: 64,
      maxOutboundQueueMessages: 256,
      maxOutboundQueueBytes: 8 * 1024 * 1024,
    },
  });
  const client = new AgentClient(transport, { clientId: "hello-validation-test" });
  await assert.rejects(
    client.hello(),
    (error: unknown) => error instanceof AgentError && error.code === "INTERNAL_ERROR",
  );
  assert.equal(transport.closed, true);
  await client.close();
});

test("rejects hello capability partitions that are incomplete", async () => {
  const transport = new HelloTransport({
    protocol: AGENT_PROTOCOL,
    version: AGENT_PROTOCOL_VERSION,
    clientId: "hello-partition-test",
    capabilities: [],
    requested: ["page.query"],
    accepted: [],
    unsupported: [],
    limits: {
      maxInFlightRequests: 128,
      maxQueuedActionsPerPage: 64,
      maxOutboundQueueMessages: 256,
      maxOutboundQueueBytes: 8 * 1024 * 1024,
    },
  });
  const client = new AgentClient(transport, { clientId: "hello-partition-test" });
  await assert.rejects(client.hello(), (error: unknown) => error instanceof AgentError && error.code === "INTERNAL_ERROR");
  assert.equal(transport.closed, true);
  await client.close();
});

test("records client-side requests, responses, and events when tracing is enabled", async () => {
  const trace = new MemoryTrace();
  const client = createFixtureAgentClient({ clientId: "trace-client-test", trace: new TraceRecorder(trace, () => 1234) });
  try {
    await client.hello();
    await client.observe(FIXTURE_PAGE_ID, ["dom.changed"]);
    await client.call("page.act", {
      pageId: FIXTURE_PAGE_ID,
      action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Continue", exact: true } } },
    });
    assert.deepEqual(trace.document().entries.map((entry) => entry.message.kind), [
      "request",
      "response",
      "request",
      "response",
      "request",
      "event",
      "response",
    ]);
    assert.ok(trace.document().entries.every((entry) => entry.timestamp === 1234));
  } finally {
    await client.close();
  }
});

test("reports only requested event types when replaying an observation", async () => {
  const client = createFixtureAgentClient({ clientId: "filtered-observation-test" });
  const events: string[] = [];
  const unsubscribe = client.onEvent((event) => events.push(event.event));
  try {
    await client.call("page.act", {
      pageId: FIXTURE_PAGE_ID,
      action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Continue", exact: true } } },
      output: { snapshot: "none" },
    });
    await client.call("page.act", {
      pageId: FIXTURE_PAGE_ID,
      action: { type: "focus", target: { locator: { kind: "role", role: "textbox", name: "Name", exact: true } } },
      output: { snapshot: "none" },
    });

    const observation = await client.observe(FIXTURE_PAGE_ID, ["focus.changed"], {
      after: { pageId: FIXTURE_PAGE_ID, sequence: 0 },
    });
    assert.equal(observation.replayed, 1);
    assert.deepEqual(events, ["focus.changed"]);
  } finally {
    unsubscribe();
    await client.close();
  }
});

test("cancels page observations without retaining event listeners", async () => {
  const client = createFixtureAgentClient({ clientId: "observation-lifecycle-test" });
  const events: string[] = [];
  const unsubscribe = client.onEvent((event) => events.push(event.event));
  try {
    const observation = await client.observe(FIXTURE_PAGE_ID, ["dom.changed"]);
    assert.match(observation.subscriptionId, /^subscription-\d+$/);
    assert.equal((await client.cancelObservation(FIXTURE_PAGE_ID, observation.subscriptionId)).canceled, true);

    await client.call("page.act", {
      pageId: FIXTURE_PAGE_ID,
      action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Continue", exact: true } } },
      output: { snapshot: "none" },
    });
    assert.deepEqual(events, []);
    assert.equal((await client.cancelObservation(FIXTURE_PAGE_ID, observation.subscriptionId)).canceled, false);

    const replacement = await client.observe(FIXTURE_PAGE_ID, ["dom.changed"]);
    const filled = await client.call("page.act", {
      pageId: FIXTURE_PAGE_ID,
      action: {
        type: "fill",
        target: { locator: { kind: "role", role: "textbox", name: "Name", exact: true } },
        value: "Ada",
      },
      output: { snapshot: "none" },
    });
    assert.equal(filled.verified, true);
    assert.deepEqual(events, ["dom.changed"]);
    assert.equal((await client.cancelObservation(FIXTURE_PAGE_ID, replacement.subscriptionId)).canceled, true);

    await client.call("page.act", {
      pageId: FIXTURE_PAGE_ID,
      action: {
        type: "fill",
        target: { locator: { kind: "role", role: "textbox", name: "Name", exact: true } },
        value: "Grace",
      },
      output: { snapshot: "none" },
    });
    assert.deepEqual(events, ["dom.changed"]);
  } finally {
    unsubscribe();
    await client.close();
  }
});

test("turns a caller abort into protocol cancellation", async () => {
  const client = createFixtureAgentClient({ clientId: "abort-test" });
  const controller = new AbortController();
  try {
    const pending = client.call(
      "page.wait",
      { pageId: FIXTURE_PAGE_ID, condition: { type: "time", ms: 1000 }, timeoutMs: 1000 },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof AgentError && error.code === "REQUEST_CANCELLED",
    );
  } finally {
    await client.close();
  }
});

test("exposes request handles for explicit cancellation", async () => {
  const client = createFixtureAgentClient({ clientId: "handle-test" });
  try {
    const call = client.start("page.wait", {
      pageId: FIXTURE_PAGE_ID,
      condition: { type: "time", ms: 1000 },
      timeoutMs: 1000,
    });
    assert.equal(await call.cancel(), true);
    await assert.rejects(
      call.promise,
      (error: unknown) => error instanceof AgentError && error.code === "REQUEST_CANCELLED",
    );
  } finally {
    await client.close();
  }
});

test("bounds client calls locally when a deadline expires", async () => {
  const client = createFixtureAgentClient({ clientId: "deadline-test" });
  try {
    await assert.rejects(
      client.call(
        "page.wait",
        { pageId: FIXTURE_PAGE_ID, condition: { type: "time", ms: 1000 }, timeoutMs: 1000 },
        { deadlineMs: 10 },
      ),
      (error: unknown) => error instanceof AgentError && error.code === "TIMEOUT",
    );
  } finally {
    await client.close();
  }
});

test("bounds pending client calls while keeping cancellation available", async () => {
  const client = createFixtureAgentClient({ clientId: "pending-budget-test", maxPendingRequests: 1 });
  try {
    const pending = client.start("page.wait", {
      pageId: FIXTURE_PAGE_ID,
      condition: { type: "time", ms: 1000 },
      timeoutMs: 1000,
    });
    await assert.rejects(
      client.call("pages.list", {}),
      (error: unknown) => error instanceof AgentError && error.code === "RESOURCE_EXHAUSTED",
    );
    assert.equal(await pending.cancel(), true);
    await assert.rejects(
      pending.promise,
      (error: unknown) => error instanceof AgentError && error.code === "REQUEST_CANCELLED",
    );
  } finally {
    await client.close();
  }
});

test("bounds pending actions per page while keeping cancellation available", async () => {
  const client = createFixtureAgentClient({ clientId: "pending-action-budget-test", maxPendingActionsPerPage: 1 });
  const action = {
    pageId: FIXTURE_PAGE_ID,
    action: { type: "click" as const, target: { locator: { kind: "role" as const, role: "button", name: "Continue", exact: true } } },
    output: { snapshot: "none" as const },
  };
  try {
    const pending = client.start("page.act", action);
    await assert.rejects(
      client.call("page.act", action),
      (error: unknown) => error instanceof AgentError && error.code === "RESOURCE_EXHAUSTED",
    );
    assert.equal(await pending.cancel(), true);
    await assert.rejects(
      pending.promise,
      (error: unknown) => error instanceof AgentError && error.code === "REQUEST_CANCELLED",
    );
    const recovered = await client.call("page.act", action);
    assert.equal(recovered.verified, true);
  } finally {
    await client.close();
  }
});

test("rejects pending calls when the client closes", async () => {
  const client = createFixtureAgentClient({ clientId: "close-test" });
  const pending = client.call(
    "page.wait",
    { pageId: FIXTURE_PAGE_ID, condition: { type: "time", ms: 1000 }, timeoutMs: 1000 },
  );
  await client.close();
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof AgentError && error.code === "TRANSPORT_CLOSED",
  );
});
