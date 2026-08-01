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
    wait: async () => ({ satisfied: true, elapsedMs: 1, snapshot: pageSnapshot }),
    subscribe: async () => ({ sequence: 0, replayed: 0, unsubscribe: () => {} }),
  };
}

function runtime(): AgentRuntime {
  return {
    capabilities: () => [
      "pages.list",
      "snapshot.read",
      "snapshot.delta",
      "page.frames",
      "page.capture",
      "page.read",
      "page.act",
      "page.act.click",
      "page.act.fill",
      "page.act.type",
      "page.act.press",
      "page.wait",
    ],
    listPages: async () => [identity],
    getPage: (candidate) => (candidate === pageId ? page() : undefined),
    openPage: async () => identity,
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
  const action = await router.handle(
    envelope({ op: "page.act", pageId, action: { type: "click", target: { ref: asSnapshotRef("r1") } } }),
  );
  const wait = await router.handle(
    envelope({ op: "page.wait", pageId, condition: { type: "time", ms: 0 } }),
  );

  assert.equal(hello.ok, true);
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
  assert.equal((action.result as { verified: boolean }).verified, true);
  assert.equal((wait.result as { satisfied: boolean }).satisfied, true);
});

test("returns a typed error for an unknown page", async () => {
  const router = new AgentRequestRouter(runtime());
  const response = await router.handle(
    envelope({ op: "page.snapshot", pageId: asPageId("missing") }),
  );
  assert.equal(response.ok, false);
  assert.equal(response.error?.code, "PAGE_NOT_FOUND");
});

test("routes page reads through a live page target resolver when available", async () => {
  let resolved = false;
  const resolvedPage: PageSession = {
    ...page(),
    resolve: async (target) => {
      resolved = "locator" in target && target.locator.kind === "css";
      return { ref: asSnapshotRef("r1"), node: pageSnapshot.nodes[0] };
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
  assert.equal((response.result as { ref: string }).ref, "r1");
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
    const second = new AgentRequestRouter(runtime(), undefined, undefined, new DurableActionJournal(filePath));
    const secondResponse = await second.handle({ ...request, requestId: "durable-router-retry" }, context);

    assert.equal(firstResponse.ok, true);
    assert.equal(secondResponse.ok, true);
    assert.equal((secondResponse.result as { replayed?: boolean }).replayed, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
