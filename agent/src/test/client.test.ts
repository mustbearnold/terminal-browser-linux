import assert from "node:assert/strict";
import test from "node:test";

import { MemoryTrace, TraceRecorder } from "../core/trace";
import { AgentError } from "../protocol/errors";
import { createFixtureAgentClient } from "../evaluation/loopback";
import { FIXTURE_PAGE_ID } from "./fixture";

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
    assert.deepEqual(hello.limits, { maxInFlightRequests: 128 });
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
