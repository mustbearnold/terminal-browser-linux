import assert from "node:assert/strict";
import test from "node:test";

import { diffSnapshots } from "../core/snapshots";
import {
  asDocumentId,
  asFrameId,
  asPageId,
  asSnapshotId,
  asSnapshotRef,
  type PageSnapshot,
  type SnapshotNode,
} from "../protocol/types";

const pageId = asPageId("snapshot-test/page/1");
const frameId = asFrameId("main");

test("diffs stable nodes while rebinding revision-scoped references", () => {
  const base = snapshot("document-1", 1, "snapshot-1", [
    node("r1", "n1", "Container"),
    node("r2", "n2", "Old", "r1"),
  ]);
  const current = snapshot("document-1", 2, "snapshot-2", [
    node("r3", "n1", "Container"),
    node("r4", "n2", "New", "r3"),
    node("r5", "n3", "Added", "r3"),
  ]);

  const delta = diffSnapshots(base, current);

  assert.equal(delta.reset, false);
  assert.deepEqual(delta.added.map((entry) => entry.key), ["n3"]);
  assert.deepEqual(delta.updated.map((entry) => entry.key), ["n2"]);
  assert.deepEqual(delta.removed, []);
  assert.deepEqual(delta.references, [
    { key: "n1", ref: "r3", parent: null },
    { key: "n2", ref: "r4", parent: "r3" },
    { key: "n3", ref: "r5", parent: "r3" },
  ]);
});

test("resets the delta across document changes", () => {
  const base = snapshot("document-1", 4, "snapshot-1", [node("r1", "n1", "Old")]);
  const current = snapshot("document-2", 0, "snapshot-2", [node("r1", "n1", "New")]);

  const delta = diffSnapshots(base, current);

  assert.equal(delta.reset, true);
  assert.deepEqual(delta.added.map((entry) => entry.key), ["n1"]);
  assert.deepEqual(delta.updated, []);
  assert.deepEqual(delta.removed, ["n1"]);
});

function snapshot(documentId: string, revision: number, snapshotId: string, nodes: readonly SnapshotNode[]): PageSnapshot {
  return {
    pageId,
    documentId: asDocumentId(documentId),
    revision,
    snapshotId: asSnapshotId(snapshotId),
    url: "https://example.com",
    title: "Snapshot test",
    rootFrameId: frameId,
    nodes,
    truncated: false,
  };
}

function node(ref: string, nodeId: string, text: string, parent: string | null = null): SnapshotNode {
  return {
    ref: asSnapshotRef(ref),
    nodeId,
    frameId,
    parent: parent === null ? null : asSnapshotRef(parent),
    role: "generic",
    name: text,
    text,
    visible: true,
    enabled: true,
    focusable: false,
  };
}
