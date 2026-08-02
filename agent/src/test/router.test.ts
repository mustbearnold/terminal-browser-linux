import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DurableActionJournal } from "../core/journal";
import { AgentRequestRouter } from "../core/router";
import { throwIfAborted } from "../core/cancellation";
import type { PolicyEngine } from "../core/policy";
import type { AgentRuntime } from "../core/runtime";
import type { PageSession } from "../core/page";
import {
  AGENT_PROTOCOL,
  AGENT_PROTOCOL_VERSION,
  asDocumentId,
  asFrameId,
  asPageId,
  asSnapshotId,
  asSnapshotRef,
  type AgentRequest,
  type PageIdentity,
  type PageSnapshot,
} from "../protocol/types";

const pageId = asPageId("browser-1/tab/1");
const identity: PageIdentity = {
  pageId,
  documentId: asDocumentId("document-1"),
  revision: 0,
  url: "https://example.com",
  title: "Example",
  active: true,
  loading: false,
};
const pageSnapshot: PageSnapshot = {
  ...identity,
  snapshotId: asSnapshotId("snapshot-1"),
  rootFrameId: asFrameId("main"),
  truncated: false,
  nodes: [
    {
      ref: asSnapshotRef("r1"),
      frameId: asFrameId("main"),
      parent: null,
      role: "button",
      name: "Continue",
      visible: true,
      enabled: true,
      focusable: true,
    },
  ],
};

function page(): PageSession {
  return {
    pageId,
    frames: async () => ({
      pageId,
      documentId: identity.documentId,
      revision: identity.revision,
      frames: [{ frameId: asFrameId("main"), parentFrameId: null, url: identity.url, origin: "https://example.com" }],
    }),
    query: async (locator) => ({
      pageId,
      documentId: identity.documentId,
      revision: identity.revision,
      snapshotId: asSnapshotId("query-1"),
      locator,
      url: identity.url,
      title: identity.title,
      rootFrameId: asFrameId("main"),
      nodes: pageSnapshot.nodes,
      matchCount: pageSnapshot.nodes.length,
      hiddenNodes: [],
      hiddenMatchCount: 0,
      truncated: false,
      hiddenTruncated: false,
    }),
    queryBatch: async (queries) => ({
      pageId,
      documentId: identity.documentId,
      revision: identity.revision,
      snapshotId: asSnapshotId("query-batch-1"),
      url: identity.url,
      title: identity.title,
      rootFrameId: asFrameId("main"),
      queries: queries.map(({ locator }) => ({
        locator,
        nodes: pageSnapshot.nodes,
        matchCount: pageSnapshot.nodes.length,
        hiddenNodes: [],
        hiddenMatchCount: 0,
        truncated: false,
        hiddenTruncated: false,
      })),
    }),
    read: async (target) => ({
      pageId,
      documentId: identity.documentId,
      revision: identity.revision,
      snapshotId: asSnapshotId("read-1"),
      target,
      url: identity.url,
      title: identity.title,
      node: pageSnapshot.nodes[0],
    }),
    active: async () => ({
      pageId,
      documentId: identity.documentId,
      revision: identity.revision,
      snapshotId: asSnapshotId("active-1"),
      active: true,
      frameId: asFrameId("main"),
      target: { ref: pageSnapshot.nodes[0].ref },
      node: pageSnapshot.nodes[0],
      url: identity.url,
      title: identity.title,
    }),
    snapshot: async () => pageSnapshot,
    snapshotDelta: async (base) => ({
      pageId,
      documentId: identity.documentId,
      revision: identity.revision,
      snapshotId: asSnapshotId("snapshot-delta-1"),
      base,
      url: identity.url,
      title: identity.title,
      rootFrameId: asFrameId("main"),
      mode: "full",
      added: [],
      updated: [],
      removed: [],
      references: [],
      truncated: false,
      reset: false,
    }),
    capture: async () => ({
      pageId,
      documentId: identity.documentId,
      revision: identity.revision,
      format: "png" as const,
      data: "fixture-image",
    }),
    assertFresh: () => {},
    currentRevision: () => ({ documentId: identity.documentId, revision: identity.revision }),
    advanceRevision: () => ({ documentId: identity.documentId, revision: 1 }),
    navigate: () => ({ documentId: identity.documentId, revision: 0 }),
    act: async () => ({ verified: true, effects: [], snapshot: pageSnapshot }),
    actBatch: async (steps) => ({
      pageId,
      verified: true,
      completed: steps.length,
      steps: steps.map((_, index) => ({ index, status: "completed" as const, result: { verified: true, effects: [] } })),
      effects: [],
      snapshot: pageSnapshot,
    }),
    wait: async () => ({ satisfied: true, elapsedMs: 1, snapshot: pageSnapshot }),
    subscribe: async () => ({ sequence: 0, replayed: 0, unsubscribe: () => {} }),
  };
}

function runtime(): AgentRuntime {
  return {
    capabilities: () => [
      "pages.list",
      "pages.activate",
      "snapshot.read",
      "snapshot.delta",
      "page.frames",
      "page.query",
      "page.query.batch",
      "page.capture",
      "page.read",
      "page.active",
      "page.act",
      "page.act.status",
      "page.act.click",
      "page.act.fill",
      "page.act.type",
      "page.act.press",
      "page.wait",
    ],
    listPages: async () => [identity],
    getPage: (candidate) => (candidate === pageId ? page() : undefined),
    openPage: async () => identity,
    activatePage: async () => identity,
    closePage: async () => {},
  };
}

function envelope<T extends Record<string, unknown>>(body: T): AgentRequest {
  return {
    kind: "request" as const,
    protocol: AGENT_PROTOCOL,
    version: AGENT_PROTOCOL_VERSION,
    requestId: Math.random().toString(36),
    ...body,
  } as unknown as AgentRequest;
}

test("routes the first agent vertical slice", async () => {
  const router = new AgentRequestRouter(runtime());
  const hello = await router.handle(envelope({ op: "hello", clientId: "test" }));
  const pages = await router.handle(envelope({ op: "pages.list" }));
  const frames = await router.handle(envelope({ op: "page.frames", pageId }));
  const snapshot = await router.handle(envelope({ op: "page.snapshot", pageId }));
  const delta = await router.handle(envelope({
    op: "page.snapshot.delta",
    pageId,
    base: pageSnapshot,
  }));
  const capture = await router.handle(envelope({ op: "page.capture", pageId, options: { format: "png" } }));
  const active = await router.handle(envelope({ op: "page.active", pageId }));
  const activated = await router.handle(envelope({ op: "pages.activate", pageId }));
  const action = await router.handle(
    envelope({ op: "page.act", pageId, action: { type: "click", target: { ref: asSnapshotRef("r1") } } }),
  );
  const wait = await router.handle(
    envelope({ op: "page.wait", pageId, condition: { type: "time", ms: 0 } }),
  );

  assert.equal(hello.ok, true);
  assert.deepEqual((hello.result as { limits: unknown }).limits, {
    maxInFlightRequests: 128,
    maxQueuedActionsPerPage: 64,
  });
  assert.equal(active.ok, true);
  assert.equal((active.result as { node: { name: string } }).node.name, "Continue");
  assert.deepEqual((pages.result as { pages: PageIdentity[] }).pages, [identity]);
  assert.deepEqual(frames.result, {
    pageId,
    documentId: identity.documentId,
    revision: identity.revision,
    frames: [
      { frameId: asFrameId("main"), parentFrameId: null, url: identity.url, origin: "https://example.com" },
    ],
  });
  assert.equal((snapshot.result as PageSnapshot).snapshotId, pageSnapshot.snapshotId);
  assert.equal((delta.result as { reset: boolean }).reset, false);
  assert.deepEqual(capture.result, {
    pageId,
    documentId: identity.documentId,
    revision: identity.revision,
    format: "png",
    data: "fixture-image",
  });
  assert.deepEqual(activated.result, identity);
  assert.equal((action.result as { verified: boolean }).verified, true);
  assert.equal((wait.result as { satisfied: boolean }).satisfied, true);
});

test("returns retryable backpressure when a connection exceeds its request budget", async () => {
  const router = new AgentRequestRouter(runtime(), undefined, undefined, undefined, 1);
  const firstRequest = envelope({
    op: "page.wait",
    pageId,
    condition: { type: "time", ms: 1000 },
  });
  const first = router.handle(firstRequest);
  const rejected = await router.handle(envelope({ op: "pages.list" }));

  assert.equal(rejected.ok, false);
  assert.equal(rejected.error?.code, "RESOURCE_EXHAUSTED");
  assert.equal(rejected.error?.retryable, true);
  assert.deepEqual(rejected.error?.details, { maxInFlightRequests: 1 });

  const canceled = await router.handle(envelope({
    op: "request.cancel",
    targetRequestId: firstRequest.requestId,
  }));
  assert.equal(canceled.ok, true);
  assert.deepEqual(canceled.result, { requestId: firstRequest.requestId, canceled: true });
  const firstResponse = await first;
  assert.equal(firstResponse.ok, false);
  assert.equal(firstResponse.error?.code, "REQUEST_CANCELLED");

  const recovered = await router.handle(envelope({ op: "pages.list" }));
  assert.equal(recovered.ok, true);
});

test("returns a typed error for an unknown page", async () => {
  const router = new AgentRequestRouter(runtime());
  const response = await router.handle(
    envelope({ op: "page.snapshot", pageId: asPageId("missing") }),
  );
  assert.equal(response.ok, false);
  assert.equal(response.error?.code, "PAGE_NOT_FOUND");
});

test("releases page observations when a page closes", async () => {
  let unsubscribed = 0;
  let cleanupRemoved = 0;
  const observedPage: PageSession = {
    ...page(),
    subscribe: async () => ({
      sequence: 0,
      replayed: 0,
      unsubscribe: () => {
        unsubscribed += 1;
      },
    }),
  };
  const closeRuntime: AgentRuntime = {
    ...runtime(),
    capabilities: () => [...runtime().capabilities(), "pages.close", "page.observe"],
    getPage: (candidate) => (candidate === pageId ? observedPage : undefined),
    closePage: async (candidate) => {
      assert.equal(candidate, pageId);
    },
  };
  const router = new AgentRequestRouter(closeRuntime);
  const context = {
    clientId: "page-close-test",
    emit: () => {},
    addSubscription: () => () => {
      cleanupRemoved += 1;
    },
  };

  const observed = await router.handle(envelope({ op: "page.observe", pageId, events: ["dom.changed"] }), context);
  const closed = await router.handle(envelope({ op: "pages.close", pageId }), context);

  assert.equal(observed.ok, true);
  assert.equal(closed.ok, true);
  assert.equal(unsubscribed, 1);
  assert.equal(cleanupRemoved, 1);
});

test("releases page observations across connections when the runtime closes a page", async () => {
  let unsubscribed = 0;
  let cleanupRemoved = 0;
  let notifyPageClosed: ((candidate: typeof pageId) => void) | undefined;
  const observedPage: PageSession = {
    ...page(),
    subscribe: async () => ({
      sequence: 0,
      replayed: 0,
      unsubscribe: () => {
        unsubscribed += 1;
      },
    }),
  };
  const closeRuntime: AgentRuntime = {
    ...runtime(),
    capabilities: () => [...runtime().capabilities(), "pages.close", "page.observe"],
    getPage: (candidate) => (candidate === pageId ? observedPage : undefined),
    onPageClosed: (listener) => {
      notifyPageClosed = listener;
      return () => {
        notifyPageClosed = undefined;
      };
    },
    closePage: async (candidate) => {
      assert.equal(candidate, pageId);
      notifyPageClosed?.(candidate);
    },
  };
  const router = new AgentRequestRouter(closeRuntime);
  const context = (clientId: string) => ({
    clientId,
    emit: () => {},
    addSubscription: () => () => {
      cleanupRemoved += 1;
    },
  });
  const first = context("page-close-first");
  const second = context("page-close-second");

  assert.equal((await router.handle(envelope({ op: "page.observe", pageId, events: ["dom.changed"] }), first)).ok, true);
  assert.equal((await router.handle(envelope({ op: "page.observe", pageId, events: ["dom.changed"] }), second)).ok, true);
  const closed = await router.handle(envelope({ op: "pages.close", pageId }), first);

  assert.equal(closed.ok, true);
  assert.equal(unsubscribed, 2);
  assert.equal(cleanupRemoved, 2);
});

test("routes page reads through a live page target resolver when available", async () => {
  let resolved = false;
  const resolvedPage: PageSession = {
    ...page(),
    read: async (target) => {
      resolved = "locator" in target && target.locator.kind === "css";
      return {
        pageId,
        documentId: identity.documentId,
        revision: identity.revision,
        snapshotId: asSnapshotId("read-1"),
        target,
        url: identity.url,
        title: identity.title,
        node: { ...pageSnapshot.nodes[0], ref: asSnapshotRef("r1") },
      };
    },
  };
  const liveRuntime: AgentRuntime = {
    ...runtime(),
    getPage: (candidate) => (candidate === pageId ? resolvedPage : undefined),
  };
  const router = new AgentRequestRouter(liveRuntime);
  const response = await router.handle(envelope({
    op: "page.read",
    pageId,
    target: { locator: { kind: "css", value: "button" } },
  }));

  assert.equal(response.ok, true);
  assert.equal(resolved, true);
  assert.equal((response.result as { node: { ref: string } }).node.ref, "r1");
});

test("routes bounded page queries through the live page resolver", async () => {
  let receivedLocator: string | undefined;
  const queriedPage: PageSession = {
    ...page(),
    query: async (locator) => {
      receivedLocator = locator.kind;
      return {
        pageId,
        documentId: identity.documentId,
        revision: identity.revision,
        snapshotId: asSnapshotId("query-1"),
        locator,
        url: identity.url,
        title: identity.title,
        rootFrameId: asFrameId("main"),
        nodes: pageSnapshot.nodes,
        matchCount: 4,
        hiddenNodes: [],
        hiddenMatchCount: 0,
        truncated: true,
        hiddenTruncated: false,
      };
    },
  };
  const queriedRuntime: AgentRuntime = {
    ...runtime(),
    capabilities: () => [...runtime().capabilities(), "page.query"],
    getPage: (candidate) => (candidate === pageId ? queriedPage : undefined),
  };
  const router = new AgentRequestRouter(queriedRuntime);
  const response = await router.handle(envelope({
    op: "page.query",
    pageId,
    locator: { kind: "role", role: "button", name: "Continue", exact: true },
    options: { limit: 1 },
  }));

  assert.equal(response.ok, true);
  assert.equal(receivedLocator, "role");
  assert.equal((response.result as { matchCount: number }).matchCount, 4);
  assert.equal((response.result as { nodes: readonly unknown[] }).nodes.length, 1);
});

test("routes revision-consistent query batches through the live page resolver", async () => {
  let receivedQueries = 0;
  const queriedPage: PageSession = {
    ...page(),
    queryBatch: async (queries) => {
      receivedQueries = queries.length;
      return {
        pageId,
        documentId: identity.documentId,
        revision: identity.revision,
        snapshotId: asSnapshotId("query-batch-1"),
        url: identity.url,
        title: identity.title,
        rootFrameId: asFrameId("main"),
        queries: queries.map(({ locator }) => ({
          locator,
          nodes: pageSnapshot.nodes.slice(0, 1),
          matchCount: 1,
          hiddenNodes: [],
          hiddenMatchCount: 0,
          truncated: false,
          hiddenTruncated: false,
        })),
      };
    },
  };
  const queriedRuntime: AgentRuntime = {
    ...runtime(),
    getPage: (candidate) => (candidate === pageId ? queriedPage : undefined),
  };
  const router = new AgentRequestRouter(queriedRuntime);
  const response = await router.handle(envelope({
    op: "page.query.batch",
    pageId,
    queries: [
      { locator: { kind: "role", role: "button", name: "Continue", exact: true }, options: { limit: 1 } },
      { locator: { kind: "text", text: "Continue", exact: true }, options: { limit: 1 } },
    ],
  }));

  assert.equal(response.ok, true);
  assert.equal(receivedQueries, 2);
  assert.equal((response.result as { queries: readonly unknown[] }).queries.length, 2);
});

test("rejects actions that the runtime does not advertise", async () => {
  const router = new AgentRequestRouter(runtime());
  const response = await router.handle(
    envelope({
      op: "page.act",
      pageId,
      action: { type: "navigate", url: "https://example.org" },
    }),
  );

  assert.equal(response.ok, false);
  assert.equal(response.error?.code, "CAPABILITY_UNAVAILABLE");
  assert.deepEqual(response.error?.details, { capability: "page.act.navigate" });
});

test("routes explicit dialog responses without treating them as page actions", async () => {
  let received: { dialogId: string; type: string; promptText?: string } | undefined;
  const dialogPage: PageSession = {
    ...page(),
    dialog: async (dialogId, action) => {
      received = { dialogId, type: action.type, ...(action.type === "accept" && action.promptText !== undefined ? { promptText: action.promptText } : {}) };
      return {
        pageId,
        dialogId,
        dialogType: "prompt",
        message: "Name?",
        url: identity.url,
        defaultPrompt: "default",
        handled: "accepted",
        ...(action.type === "accept" && action.promptText !== undefined ? { promptText: action.promptText } : {}),
      };
    },
  };
  const dialogRuntime: AgentRuntime = {
    ...runtime(),
    capabilities: () => [...runtime().capabilities(), "page.dialog"],
    getPage: (candidate) => (candidate === pageId ? dialogPage : undefined),
  };
  const router = new AgentRequestRouter(dialogRuntime);
  const response = await router.handle(envelope({
    op: "page.dialog",
    pageId,
    dialogId: "dialog-1",
    action: { type: "accept", promptText: "Ada" },
  }));

  assert.equal(response.ok, true);
  assert.deepEqual(received, { dialogId: "dialog-1", type: "accept", promptText: "Ada" });
  assert.equal((response.result as { handled: string; promptText?: string }).handled, "accepted");
  assert.equal((response.result as { promptText?: string }).promptText, "Ada");
});

test("enforces operation capabilities before invoking a runtime", async () => {
  const restrictedRuntime: AgentRuntime = {
    ...runtime(),
    capabilities: () => runtime().capabilities().filter((capability) => capability !== "pages.open"),
  };
  const router = new AgentRequestRouter(restrictedRuntime);
  const response = await router.handle(envelope({ op: "pages.open", url: "https://example.org" }));

  assert.equal(response.ok, false);
  assert.equal(response.error?.code, "CAPABILITY_UNAVAILABLE");
  assert.deepEqual(response.error?.details, { capability: "pages.open" });
});

test("enforces injected policy decisions with request context", async () => {
  const policy: PolicyEngine = {
    decide: (context) => context.capability === "page.act.click"
      ? { allowed: false, reason: `blocked ${context.pageId}` }
      : { allowed: true },
  };
  const router = new AgentRequestRouter(runtime(), undefined, policy);
  const response = await router.handle(
    envelope({
      op: "page.act",
      pageId,
      action: { type: "click", target: { ref: asSnapshotRef("r1") } },
    }),
  );

  assert.equal(response.ok, false);
  assert.equal(response.error?.code, "POLICY_DENIED");
  assert.equal(response.error?.message, `blocked ${pageId}`);
  assert.deepEqual(response.error?.details, { capability: "page.act.click" });
});

test("continues an idempotent action after its connection closes", async () => {
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delayedPage: PageSession = {
    ...page(),
    act: async (_action, _token, _expect, signal) => {
      started();
      await gate;
      throwIfAborted(signal);
      return { verified: true, effects: [], snapshot: pageSnapshot };
    },
  };
  const delayedRuntime: AgentRuntime = {
    ...runtime(),
    getPage: (candidate) => (candidate === pageId ? delayedPage : undefined),
  };
  const router = new AgentRequestRouter(delayedRuntime);
  const firstContext = { clientId: "retry-client", emit: () => {}, addSubscription: () => {} };
  const secondContext = { clientId: "retry-client", emit: () => {}, addSubscription: () => {} };
  const request = envelope({
    op: "page.act",
    pageId,
    idempotencyKey: "persisted-action",
    action: { type: "click", target: { ref: asSnapshotRef("r1") } },
  });

  const first = router.handle(request, firstContext);
  await startedPromise;
  router.close(firstContext);
  const retry = router.handle({ ...request, requestId: "retry-request" }, secondContext);
  release();

  const [firstResponse, retryResponse] = await Promise.all([first, retry]);
  assert.equal(firstResponse.ok, true);
  assert.equal(retryResponse.ok, true);
  assert.equal((retryResponse.result as { replayed?: boolean }).replayed, true);
});

test("replays an action through a journal injected into a new router", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-browser-agent-router-"));
  try {
    const filePath = path.join(directory, "actions.json");
    const request = envelope({
      op: "page.act",
      pageId,
      idempotencyKey: "durable-router-action",
      action: { type: "click", target: { ref: asSnapshotRef("r1") } },
    });
    const first = new AgentRequestRouter(runtime(), undefined, undefined, new DurableActionJournal(filePath));
    const context = { clientId: "durable-router-client", emit: () => {}, addSubscription: () => {} };
    const firstResponse = await first.handle(request, context);
    const firstStatus = await first.handle(envelope({
      op: "page.act.status",
      pageId,
      idempotencyKey: "durable-router-action",
    }), context);
    const second = new AgentRequestRouter(runtime(), undefined, undefined, new DurableActionJournal(filePath));
    const secondResponse = await second.handle({ ...request, requestId: "durable-router-retry" }, context);
    const secondStatus = await second.handle(envelope({
      op: "page.act.status",
      pageId,
      idempotencyKey: "durable-router-action",
    }), context);

    assert.equal(firstResponse.ok, true);
    assert.deepEqual(firstStatus.result, {
      pageId,
      idempotencyKey: "durable-router-action",
      status: "completed",
      result: firstResponse.result,
    });
    assert.equal(secondResponse.ok, true);
    assert.equal((secondResponse.result as { replayed?: boolean }).replayed, true);
    assert.deepEqual(secondStatus.result, firstStatus.result);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
