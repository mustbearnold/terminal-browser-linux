import assert from "node:assert/strict";
import test from "node:test";

import { RevisionedPageSession, type PageBackend } from "../core/page";
import { RevisionLedger } from "../core/revisions";
import {
  asDocumentId,
  asFrameId,
  asPageId,
  asSnapshotRef,
  type AgentAction,
  type AgentEvent,
  type PageIdentity,
  type PageSnapshot,
} from "../protocol/types";

const pageId = asPageId("page-1");
const documentId = asDocumentId("document-1");

class OutputBackend implements PageBackend {
  readonly pageId = pageId;
  revision = 0;
  snapshotCalls = 0;

  async identity(): Promise<PageIdentity> {
    return {
      pageId,
      documentId,
      revision: this.revision,
      url: "fixture://output",
      title: "Output fixture",
      active: true,
      loading: false,
    };
  }

  async frames() {
    return {
      pageId,
      documentId,
      revision: this.revision,
      frames: [{ frameId: asFrameId("main"), parentFrameId: null, url: "fixture://output", origin: "fixture://" }],
    };
  }

  async snapshot(): Promise<Omit<PageSnapshot, "snapshotId">> {
    this.snapshotCalls += 1;
    return {
      pageId,
      documentId,
      revision: this.revision,
      url: "fixture://output",
      title: "Output fixture",
      rootFrameId: asFrameId("main"),
      truncated: false,
      nodes: [{
        ref: asSnapshotRef("r1"),
        frameId: asFrameId("main"),
        parent: null,
        role: "button",
        name: "Continue",
        text: String(this.revision),
        visible: true,
        enabled: true,
        focusable: true,
      }],
    };
  }

  async act(_action: AgentAction) {
    this.revision += 1;
    return { verified: true, effects: [] };
  }

  async wait() {
    return { satisfied: true, elapsedMs: 0 };
  }

  async subscribe(_listener: (event: AgentEvent) => void) {
    return { sequence: 0, replayed: 0, unsubscribe: () => {} };
  }
}

function session(backend: OutputBackend) {
  return new RevisionedPageSession(backend, new RevisionLedger());
}

test("returns a full action snapshot by default", async () => {
  const backend = new OutputBackend();
  const result = await session(backend).act({ type: "press", key: "Enter" });

  assert.ok(result.snapshot);
  assert.equal(result.snapshotDelta, undefined);
  assert.equal(result.snapshot?.revision, 1);
  assert.equal(backend.snapshotCalls, 1);
});

test("can omit the post-action snapshot", async () => {
  const backend = new OutputBackend();
  const result = await session(backend).act(
    { type: "press", key: "Enter" },
    undefined,
    undefined,
    undefined,
    { snapshot: "none" },
  );

  assert.equal(result.snapshot, undefined);
  assert.equal(result.snapshotDelta, undefined);
  assert.equal(backend.snapshotCalls, 0);
});

test("can return a delta from an agent-owned base snapshot", async () => {
  const backend = new OutputBackend();
  const page = session(backend);
  const base = await page.snapshot();
  const result = await page.act(
    { type: "press", key: "Enter" },
    undefined,
    undefined,
    undefined,
    { snapshot: "delta", base },
  );

  assert.equal(result.snapshot, undefined);
  assert.ok(result.snapshotDelta);
  assert.equal(result.snapshotDelta?.base.snapshotId, base.snapshotId);
  assert.equal(result.snapshotDelta?.revision, 1);
  assert.equal(result.snapshotDelta?.updated.length, 1);
});
