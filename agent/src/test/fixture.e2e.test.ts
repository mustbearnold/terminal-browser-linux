import assert from "node:assert/strict";
import test from "node:test";

import { AgentRequestRouter, type AgentConnectionContext } from "../core/router";
import type {
  ActionProof,
  AgentEvent,
  AgentRequest,
  AgentResponse,
  PageSnapshot,
  PageSnapshotWindow,
  PageSnapshotDelta,
  PageQueryResult,
  PageQueryBatchResult,
  PageReadResult,
  SnapshotNode,
  SnapshotToken,
} from "../protocol/types";
import {
  AGENT_PROTOCOL,
  AGENT_PROTOCOL_VERSION,
  asSnapshotRef,
  type PageIdentity,
} from "../protocol/types";
import { FIXTURE_PAGE_ID, FIXTURE_PREVIOUS_URL, FixtureRuntime } from "./fixture";

let requestSequence = 0;

test("runs the deterministic agent control contract", async () => {
  const runtime = new FixtureRuntime();
  const router = new AgentRequestRouter(runtime);
  const events: AgentEvent[] = [];
  const cleanups: (() => void)[] = [];
  const context: AgentConnectionContext = {
    clientId: "fixture-e2e",
    emit: (message) => {
      events.push(message as AgentEvent);
    },
    addSubscription: (cleanup) => cleanups.push(cleanup),
  };

  const hello = result<{ capabilities: readonly string[] }>(
    await router.handle(request("hello", { clientId: "fixture-e2e" }), context),
  );
  assert.equal(hello.capabilities.includes("page.act"), true);
  assert.equal(hello.capabilities.includes("page.act.click"), true);
  assert.equal(hello.capabilities.includes("page.act.fill"), true);
  assert.equal(hello.capabilities.includes("page.act.history"), true);
  assert.equal(hello.capabilities.includes("page.query.batch"), true);
  assert.equal(hello.capabilities.includes("pages.activate"), true);
  assert.equal(hello.capabilities.includes("page.act.select"), false);

  const negotiated = result<{
    accepted: readonly string[];
    unsupported: readonly string[];
  }>(await router.handle(
    request("hello", {
      clientId: "fixture-e2e-negotiation",
      capabilities: ["page.act.click", "page.act.select"],
    }),
    context,
  ));
  assert.deepEqual(negotiated.accepted, ["page.act.click"]);
  assert.deepEqual(negotiated.unsupported, ["page.act.select"]);

  const unsupported = await router.handle(
    request("page.act", {
      pageId: FIXTURE_PAGE_ID,
      action: { type: "select", target: { ref: asSnapshotRef("r2") }, values: ["one"] },
    }),
    context,
  );
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.error?.code, "CAPABILITY_UNAVAILABLE");
  assert.deepEqual(unsupported.error?.details, { capability: "page.act.select" });

  const pages = result<{ pages: PageIdentity[] }>(await router.handle(request("pages.list"), context));
  assert.equal(pages.pages[0].pageId, FIXTURE_PAGE_ID);

  const activated = result<PageIdentity>(await router.handle(
    request("pages.activate", { pageId: FIXTURE_PAGE_ID }),
    context,
  ));
  assert.equal(activated.active, true);

  const frames = result<{
    pageId: string;
    documentId: string;
    revision: number;
    frames: { frameId: string; parentFrameId: string | null; url: string; origin: string }[];
  }>(
    await router.handle(request("page.frames", { pageId: FIXTURE_PAGE_ID }), context),
  );
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

  const snapshot = result<PageSnapshot>(
    await router.handle(
      request("page.snapshot", {
        pageId: FIXTURE_PAGE_ID,
        options: { interactiveOnly: false, includeGeometry: false },
      }),
      context,
    ),
  );
  assert.equal(snapshot.nodes.some((node) => node.role === "generic"), true);

  const query = result<PageQueryResult>(await router.handle(
    request("page.query", {
      pageId: FIXTURE_PAGE_ID,
      locator: { kind: "role", role: "textbox", name: "Name", exact: true },
      options: { limit: 1 },
    }),
    context,
  ));
  assert.equal(query.matchCount, 1);
  assert.equal(query.nodes.length, 1);
  assert.equal(query.nodes[0].name, "Name");
  assert.equal(query.truncated, false);

  const scopedQuery = result<PageQueryResult>(await router.handle(
    request("page.query", {
      pageId: FIXTURE_PAGE_ID,
      locator: {
        kind: "role",
        role: "textbox",
        name: "Name",
        exact: true,
        within: { kind: "role", role: "generic", name: "Fixture content", exact: true },
      },
    }),
    context,
  ));
  assert.equal(scopedQuery.matchCount, 1);
  assert.equal(scopedQuery.nodes[0].ref, query.nodes[0].ref);

  const queryBatch = result<PageQueryBatchResult>(await router.handle(
    request("page.query.batch", {
      pageId: FIXTURE_PAGE_ID,
      queries: [
        { locator: { kind: "role", role: "textbox", name: "Name", exact: true }, options: { limit: 1 } },
        { locator: { kind: "role", role: "button", name: "Continue", exact: true }, options: { limit: 1 } },
      ],
    }),
    context,
  ));
  assert.equal(queryBatch.queries.length, 2);
  assert.equal(queryBatch.queries[0].matchCount, 1);
  assert.equal(queryBatch.queries[1].nodes[0].name, "Continue");
  assert.equal(queryBatch.revision, query.revision);
  assert.notEqual(queryBatch.snapshotId, query.snapshotId);

  const firstWindow = result<PageSnapshotWindow>(await router.handle(
    request("page.snapshot.window", {
      pageId: FIXTURE_PAGE_ID,
      options: { interactiveOnly: false, includeGeometry: false, limit: 2 },
    }),
    context,
  ));
  assert.equal(firstWindow.offset, 0);
  assert.equal(firstWindow.limit, 2);
  assert.equal(firstWindow.totalNodes, 3);
  assert.equal(firstWindow.nodes.length, 2);
  assert.equal(firstWindow.done, false);
  assert.ok(firstWindow.nextCursor);
  const lastWindow = result<PageSnapshotWindow>(await router.handle(
    request("page.snapshot.window", { pageId: FIXTURE_PAGE_ID, cursor: firstWindow.nextCursor }),
    context,
  ));
  assert.equal(lastWindow.snapshotId, firstWindow.snapshotId);
  assert.equal(lastWindow.offset, 2);
  assert.equal(lastWindow.nodes.length, 1);
  assert.equal(lastWindow.done, true);
  const tamperedCursor = await router.handle(
    request("page.snapshot.window", {
      pageId: FIXTURE_PAGE_ID,
      cursor: { ...firstWindow.nextCursor!, revision: firstWindow.nextCursor!.revision + 1 },
    }),
    context,
  );
  assert.equal(tamperedCursor.ok, false);
  assert.equal(tamperedCursor.error?.code, "INVALID_REQUEST");

  const hiddenWait = result<{ satisfied: boolean }>(await router.handle(
    request("page.wait", {
      pageId: FIXTURE_PAGE_ID,
      condition: {
        type: "element",
        target: { locator: { kind: "role", role: "generic", name: "Fixture content", exact: true } },
        state: { visible: false },
      },
    }),
    context,
  ));
  assert.equal(hiddenWait.satisfied, true);

  const absentWait = result<{ satisfied: boolean }>(await router.handle(
    request("page.wait", {
      pageId: FIXTURE_PAGE_ID,
      condition: {
        type: "element",
        target: { locator: { kind: "role", role: "status", name: "Ready", exact: true } },
        state: { attached: false },
      },
    }),
    context,
  ));
  assert.equal(absentWait.satisfied, true);

  const wrongTargetedTextWait = result<{ satisfied: boolean }>(await router.handle(
    request("page.wait", {
      pageId: FIXTURE_PAGE_ID,
      condition: {
        type: "text",
        value: "Ready",
        target: { locator: { kind: "role", role: "button", name: "Continue", exact: true } },
      },
      timeoutMs: 10,
    }),
    context,
  ));
  assert.equal(wrongTargetedTextWait.satisfied, false);

  const read = result<PageReadResult>(
    await router.handle(
      request("page.read", {
        pageId: FIXTURE_PAGE_ID,
        target: { ref: query.nodes[0].ref },
        token: token(query),
      }),
      context,
    ),
  );
  assert.equal(read.node.name, "Name");

  result(await router.handle(request("page.observe", { pageId: FIXTURE_PAGE_ID, events: ["dom.changed"] }), context));

  const filled = result<{ verified: boolean; proof?: ActionProof; snapshot?: PageSnapshot }>(
    await router.handle(
      request("page.act", {
        pageId: FIXTURE_PAGE_ID,
        token: token(read),
        action: {
          type: "fill",
          target: {
            locator: {
              kind: "role",
              role: "textbox",
              name: "Name",
              exact: true,
              within: { kind: "role", role: "generic", name: "Fixture content", exact: true },
            },
          },
          value: "Ada",
        },
      }),
      context,
    ),
  );
  assert.equal(filled.verified, true);
  assert.equal(filled.proof?.value, "Ada");
  assert.equal(filled.proof?.pageId, FIXTURE_PAGE_ID);
  assert.equal(filled.proof?.documentId, "fixture-document-1");
  assert.equal(filled.proof?.revision, filled.snapshot?.revision);
  assert.equal(filled.proof?.frameId, "main");

  const staleWindow = await router.handle(
    request("page.snapshot.window", { pageId: FIXTURE_PAGE_ID, cursor: firstWindow.nextCursor }),
    context,
  );
  assert.equal(staleWindow.ok, false);
  assert.equal(staleWindow.error?.code, "STALE_SNAPSHOT");

  const typed = result<{ verified: boolean; proof?: ActionProof; snapshot?: PageSnapshot }>(
    await router.handle(
      request("page.act", {
        pageId: FIXTURE_PAGE_ID,
        token: token(filled.snapshot!),
        action: {
          type: "type",
          text: " Lovelace",
          target: { locator: { kind: "role", role: "textbox", name: "Name", exact: true } },
        },
      }),
      context,
    ),
  );
  assert.equal(typed.verified, true);
  assert.equal(typed.proof?.value, "Ada Lovelace");

  const pressed = result<{ verified: boolean; proof?: ActionProof; snapshot?: PageSnapshot }>(
    await router.handle(
      request("page.act", {
        pageId: FIXTURE_PAGE_ID,
        token: token(typed.snapshot!),
        action: {
          type: "press",
          key: "Enter",
          target: { locator: { kind: "role", role: "textbox", name: "Name", exact: true } },
        },
        expect: {
          element: {
            target: { locator: { kind: "role", role: "status", name: "Ready", exact: true } },
            state: { attached: true, text: "Ready" },
          },
        },
      }),
      context,
    ),
  );
  assert.equal(pressed.verified, true);
  assert.equal(pressed.proof?.value, "Ada Lovelace");
  assert.equal(pressed.snapshot?.nodes.some((node) => node.name === "Ready"), true);
  const revealedWait = result<{ satisfied: boolean }>(await router.handle(
    request("page.wait", {
      pageId: FIXTURE_PAGE_ID,
      condition: {
        type: "element",
        target: { locator: { kind: "role", role: "generic", name: "Fixture content", exact: true } },
        state: { visible: true },
      },
    }),
    context,
  ));
  assert.equal(revealedWait.satisfied, true);
  assert.deepEqual(events.map((event) => event.event), ["dom.changed", "dom.changed", "dom.changed"]);

  const delta = result<PageSnapshotDelta>(
    await router.handle(
      request("page.snapshot.delta", { pageId: FIXTURE_PAGE_ID, base: token(snapshot) }),
      context,
    ),
  );
  assert.equal(delta.reset, false);
  assert.equal(delta.mode, "full");
  assert.ok(delta.updated.some((entry) => entry.node.nodeId === "n2"));
  assert.ok(delta.added.some((entry) => entry.node.nodeId === "n4"));
  assert.equal(delta.references.length, 4);

  const mismatchedOptions = await router.handle(
    request("page.snapshot.delta", {
      pageId: FIXTURE_PAGE_ID,
      base: token(snapshot),
      options: { includeGeometry: true },
    }),
    context,
  );
  assert.equal(mismatchedOptions.error?.code, "INVALID_REQUEST");

  const missingBase = await router.handle(
    request("page.snapshot.delta", {
      pageId: FIXTURE_PAGE_ID,
      base: { ...token(snapshot), snapshotId: "missing-snapshot" },
    }),
    context,
  );
  assert.equal(missingBase.error?.code, "SNAPSHOT_NOT_FOUND");

  const waited = result<{ satisfied: boolean; snapshot?: PageSnapshot }>(
    await router.handle(
      request("page.wait", { pageId: FIXTURE_PAGE_ID, condition: { type: "text", value: "Ready" } }),
      context,
    ),
  );
  assert.equal(waited.satisfied, true);

  const compactWait = result<{ satisfied: boolean; snapshot?: PageSnapshot }>(
    await router.handle(
      request("page.wait", {
        pageId: FIXTURE_PAGE_ID,
        condition: { type: "text", value: "Ready" },
        output: { snapshot: "none" },
      }),
      context,
    ),
  );
  assert.equal(compactWait.satisfied, true);
  assert.equal(compactWait.snapshot, undefined);

  const targetedTextWait = result<{ satisfied: boolean }>(await router.handle(
    request("page.wait", {
      pageId: FIXTURE_PAGE_ID,
      condition: {
        type: "text",
        value: "Ready",
        target: { locator: { kind: "role", role: "status", name: "Ready", exact: true } },
      },
    }),
    context,
  ));
  assert.equal(targetedTextWait.satisfied, true);

  const valueWait = result<{ satisfied: boolean }>(await router.handle(
    request("page.wait", {
      pageId: FIXTURE_PAGE_ID,
      condition: {
        type: "element",
        target: { locator: { kind: "role", role: "textbox", name: "Name", exact: true } },
        state: { visible: true, enabled: true, value: "Ada Lovelace" },
      },
    }),
    context,
  ));
  assert.equal(valueWait.satisfied, true);

  const textWait = result<{ satisfied: boolean }>(await router.handle(
    request("page.wait", {
      pageId: FIXTURE_PAGE_ID,
      condition: {
        type: "element",
        target: { locator: { kind: "role", role: "status", name: "Ready", exact: true } },
        state: { attached: true, text: "Ready" },
      },
    }),
    context,
  ));
  assert.equal(textWait.satisfied, true);

  const stale = await router.handle(
    request("page.act", {
      pageId: FIXTURE_PAGE_ID,
      token: token(snapshot),
      action: { type: "fill", target: { ref: read.node.ref }, value: "stale" },
    }),
    context,
  );
  assert.equal(stale.ok, false);
  assert.equal(stale.error?.code, "STALE_SNAPSHOT");
  assert.equal(stale.error?.retryable, true);

  const back = result<{ verified: boolean; proof?: { url?: string }; snapshot?: PageSnapshot }>(
    await router.handle(
      request("page.act", {
        pageId: FIXTURE_PAGE_ID,
        token: token(pressed.snapshot!),
        action: { type: "history", direction: "back" },
        expect: { url: FIXTURE_PREVIOUS_URL },
      }),
      context,
    ),
  );
  assert.equal(back.verified, true);
  assert.equal(back.proof?.url, FIXTURE_PREVIOUS_URL);

  const staleHistory = await router.handle(
    request("page.act", {
      pageId: FIXTURE_PAGE_ID,
      token: token(pressed.snapshot!),
      action: { type: "history", direction: "forward" },
    }),
    context,
  );
  assert.equal(staleHistory.error?.code, "STALE_SNAPSHOT");

  const forward = result<{ verified: boolean; proof?: { url?: string } }>(
    await router.handle(
      request("page.act", {
        pageId: FIXTURE_PAGE_ID,
        action: { type: "history", direction: "forward" },
        expect: { url: "fixture://agent-control" },
      }),
      context,
    ),
  );
  assert.equal(forward.verified, true);
  assert.equal(forward.proof?.url, "fixture://agent-control");

  const unavailable = await router.handle(
    request("page.act", {
      pageId: FIXTURE_PAGE_ID,
      action: { type: "history", direction: "forward" },
    }),
    context,
  );
  assert.equal(unavailable.error?.code, "HISTORY_UNAVAILABLE");

  for (const cleanup of cleanups) cleanup();
});

test("executes a serialized action batch with one final output and replay", async () => {
  const runtime = new FixtureRuntime();
  const router = new AgentRequestRouter(runtime);
  const batchRequest = request("page.act.batch", {
    pageId: FIXTURE_PAGE_ID,
    steps: [
      {
        action: {
          type: "fill",
          target: { locator: { kind: "role", role: "textbox", name: "Name", exact: true } },
          value: "Grace",
        },
      },
      { action: { type: "type", text: " Hopper" } },
      {
        action: { type: "press", key: "Enter" },
        expect: {
          element: {
            target: { locator: { kind: "role", role: "status", name: "Ready", exact: true } },
            state: { attached: true, text: "Ready" },
          },
        },
      },
    ],
    output: { snapshot: "none" },
    idempotencyKey: "fixture-batch-1",
  });
  const first = result<{
    verified: boolean;
    completed: number;
    steps: readonly { index: number; status: string; result?: { proof?: { value?: string } } }[];
    snapshot?: unknown;
  }>(await router.handle(batchRequest));
  assert.equal(first.verified, true);
  assert.equal(first.completed, 3);
  assert.deepEqual(first.steps.map((step) => [step.index, step.status]), [
    [0, "completed"],
    [1, "completed"],
    [2, "completed"],
  ]);
  assert.equal(first.steps[1].result?.proof?.value, "Grace Hopper");
  assert.equal(first.snapshot, undefined);

  const status = result<{ status: string; result?: { steps?: readonly unknown[] } }>(await router.handle(
    request("page.act.status", { pageId: FIXTURE_PAGE_ID, idempotencyKey: "fixture-batch-1" }),
  ));
  assert.equal(status.status, "completed");
  assert.equal(status.result?.steps?.length, 3);

  const replayed = result<{ replayed?: boolean }>(await router.handle({
    ...batchRequest,
    requestId: "page.act.batch-replay",
  }));
  assert.equal(replayed.replayed, true);
});

test("replays missed fixture events from an observation cursor", async () => {
  const runtime = new FixtureRuntime();
  const router = new AgentRequestRouter(runtime);
  const events: AgentEvent[] = [];
  const context: AgentConnectionContext = {
    clientId: "fixture-replay",
    emit: (message) => {
      events.push(message as AgentEvent);
    },
    addSubscription: () => {},
  };

  const clicked = await router.handle(
    request("page.act", {
      pageId: FIXTURE_PAGE_ID,
      action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Continue", exact: true } } },
    }),
    context,
  );
  assert.equal(clicked.ok, true);

  const observed = await router.handle(
    request("page.observe", {
      pageId: FIXTURE_PAGE_ID,
      events: ["dom.changed"],
      afterSequence: 0,
    }),
    context,
  );
  assert.deepEqual(observed.result, {
    pageId: FIXTURE_PAGE_ID,
    events: ["dom.changed"],
    afterSequence: 0,
    sequence: 1,
    replayed: 1,
  });
  assert.deepEqual(events.map((event) => event.sequence), [1]);
});

test("replays a completed action across connections with an idempotency key", async () => {
  const runtime = new FixtureRuntime();
  const router = new AgentRequestRouter(runtime);
  const firstContext: AgentConnectionContext = {
    clientId: "retry-client",
    emit: () => {},
    addSubscription: () => {},
  };
  const secondContext: AgentConnectionContext = {
    clientId: "retry-client",
    emit: () => {},
    addSubscription: () => {},
  };
  const action = {
    type: "click" as const,
    target: { locator: { kind: "role" as const, role: "button", name: "Continue", exact: true } },
  };

  const first = result<{ snapshot?: PageSnapshot; replayed?: boolean }>(await router.handle(
    request("page.act", { pageId: FIXTURE_PAGE_ID, action, idempotencyKey: "continue-1" }),
    firstContext,
  ));
  const retry = result<{ snapshot?: PageSnapshot; replayed?: boolean }>(await router.handle(
    request("page.act", { pageId: FIXTURE_PAGE_ID, action, idempotencyKey: "continue-1" }),
    secondContext,
  ));
  assert.equal(first.replayed, undefined);
  assert.equal(retry.replayed, true);
  assert.equal(retry.snapshot?.revision, first.snapshot?.revision);

  const conflict = await router.handle(
    request("page.act", {
      pageId: FIXTURE_PAGE_ID,
      action: { type: "press", key: "Enter" },
      idempotencyKey: "continue-1",
    }),
    secondContext,
  );
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error?.code, "IDEMPOTENCY_CONFLICT");

  const invalid = await router.handle(
    request("page.act", {
      pageId: FIXTURE_PAGE_ID,
      action,
      idempotencyKey: "",
    }),
    secondContext,
  );
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error?.code, "INVALID_REQUEST");
});

test("serializes concurrent page actions before checking snapshot freshness", async () => {
  const runtime = new FixtureRuntime();
  const router = new AgentRequestRouter(runtime);
  const snapshot = result<PageSnapshot>(
    await router.handle(request("page.snapshot", { pageId: FIXTURE_PAGE_ID, options: { interactiveOnly: false } })),
  );
  const tokenValue = token(snapshot);
  const first = router.handle(
    request("page.act", {
      pageId: FIXTURE_PAGE_ID,
      token: tokenValue,
      action: { type: "fill", target: { ref: asSnapshotRef("r2") }, value: "first" },
    }),
  );
  const second = router.handle(
    request("page.act", {
      pageId: FIXTURE_PAGE_ID,
      token: tokenValue,
      action: { type: "fill", target: { ref: asSnapshotRef("r2") }, value: "second" },
    }),
  );

  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  assert.equal(firstResponse.ok, true);
  assert.equal(secondResponse.ok, false);
  assert.equal(secondResponse.error?.code, "STALE_SNAPSHOT");
  assert.equal((firstResponse.result as { proof?: { value?: string } }).proof?.value, "first");
});

test("enforces request deadlines and explicit cancellation", async () => {
  const runtime = new FixtureRuntime();
  const router = new AgentRequestRouter(runtime);
  const pendingRequest = request("page.wait", {
    pageId: FIXTURE_PAGE_ID,
    condition: { type: "time", ms: 1000 },
    timeoutMs: 1000,
  });
  const pending = router.handle(pendingRequest);
  await new Promise<void>((resolve) => setImmediate(resolve));

  const canceled = await router.handle(
    request("request.cancel", { targetRequestId: pendingRequest.requestId }),
  );
  assert.equal(canceled.ok, true);
  assert.deepEqual(canceled.result, { requestId: pendingRequest.requestId, canceled: true });

  const cancelledResponse = await pending;
  assert.equal(cancelledResponse.ok, false);
  assert.equal(cancelledResponse.error?.code, "REQUEST_CANCELLED");
  assert.equal(cancelledResponse.error?.retryable, true);

  const timedOut = await router.handle(
    request("page.wait", {
      pageId: FIXTURE_PAGE_ID,
      condition: { type: "time", ms: 1000 },
      timeoutMs: 1000,
      deadlineMs: 10,
    }),
  );
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.error?.code, "TIMEOUT");
  assert.equal(timedOut.error?.retryable, true);
});

test("cancels in-flight work when a connection closes", async () => {
  const runtime = new FixtureRuntime();
  const router = new AgentRequestRouter(runtime);
  const context: AgentConnectionContext = {
    clientId: "closing-fixture",
    emit: () => {},
    addSubscription: () => {},
  };
  const pendingRequest = request("page.wait", {
    pageId: FIXTURE_PAGE_ID,
    condition: { type: "time", ms: 1000 },
    timeoutMs: 1000,
  });
  const pending = router.handle(pendingRequest, context);
  await new Promise<void>((resolve) => setImmediate(resolve));
  router.close(context);

  const response = await pending;
  assert.equal(response.ok, false);
  assert.equal(response.error?.code, "TRANSPORT_CLOSED");
  assert.equal(response.error?.retryable, true);
});

function request<T extends AgentRequest["op"]>(op: T, fields: Record<string, unknown> = {}): AgentRequest {
  return {
    kind: "request",
    protocol: AGENT_PROTOCOL,
    version: AGENT_PROTOCOL_VERSION,
    requestId: `${op}-${++requestSequence}`,
    op,
    ...fields,
  } as AgentRequest;
}

function result<T>(response: AgentResponse): T {
  assert.equal(response.ok, true);
  return response.result as T;
}

function token(snapshot: SnapshotToken) {
  return {
    pageId: snapshot.pageId,
    documentId: snapshot.documentId,
    revision: snapshot.revision,
    snapshotId: snapshot.snapshotId,
  };
}
