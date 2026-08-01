import assert from "node:assert/strict";
import test from "node:test";

import { AgentError } from "../protocol/errors";
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

class LiveOutputBackend extends OutputBackend {
  resolveTargetCalls = 0;

  async resolveTarget() {
    this.resolveTargetCalls += 1;
    const node = {
      ref: asSnapshotRef("r-live"),
      frameId: asFrameId("main"),
      parent: null,
      role: "button",
      name: "Continue",
      visible: true,
      enabled: true,
      focusable: true,
    };
    return { ref: node.ref, node };
  }
}

function session(backend: OutputBackend) {
  return new RevisionedPageSession(backend, new RevisionLedger());
}

test("resolves a live target without building a snapshot", async () => {
  const backend = new LiveOutputBackend();
  const result = await session(backend).resolveTarget!({
    locator: { kind: "role", role: "button", name: "Continue", exact: true },
  });

  assert.equal(result.ref, "r-live");
  assert.equal(backend.resolveTargetCalls, 1);
  assert.equal(backend.snapshotCalls, 0);
});

test("returns a revision-bound read result and rejects it after a page change", async () => {
  const backend = new OutputBackend();
  const page = session(backend);
  const read = await page.read({ locator: { kind: "role", role: "button", name: "Continue", exact: true } });

  assert.equal(read.node.name, "Continue");
  assert.equal(read.pageId, pageId);
  assert.equal(read.revision, 0);
  assert.equal("locator" in read.target ? read.target.locator.kind : undefined, "role");

  backend.revision = 1;
  await assert.rejects(
    page.read({ ref: read.node.ref }, read),
    (error: unknown) => error instanceof AgentError && error.code === "STALE_SNAPSHOT",
  );
});

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

test("can omit a satisfied wait snapshot", async () => {
  const backend = new OutputBackend();
  const result = await session(backend).wait(
    { type: "time", ms: 0 },
    undefined,
    undefined,
    { snapshot: "none" },
  );

  assert.equal(result.satisfied, true);
  assert.equal(result.snapshot, undefined);
  assert.equal(result.snapshotDelta, undefined);
  assert.equal(backend.snapshotCalls, 0);
});

test("can return a delta from a satisfied wait", async () => {
  const backend = new OutputBackend();
  const page = session(backend);
  const base = await page.snapshot();
  const result = await page.wait(
    { type: "time", ms: 0 },
    undefined,
    undefined,
    { snapshot: "delta", base },
  );

  assert.equal(result.snapshot, undefined);
  assert.ok(result.snapshotDelta);
  assert.equal(result.snapshotDelta?.base.snapshotId, base.snapshotId);
});
