import assert from "node:assert/strict";
import test from "node:test";

import { AgentRequestRouter } from "../core/router";
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
      "page.frames",
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
