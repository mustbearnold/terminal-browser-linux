import { stableSerialize } from "./idempotency";
import { AgentError } from "../protocol/errors";
import type {
  PageSnapshot,
  PageSnapshotDelta,
  SnapshotDeltaNode,
  SnapshotNode,
  SnapshotReference,
  SnapshotId,
} from "../protocol/types";

export function diffSnapshots(base: PageSnapshot, current: PageSnapshot): PageSnapshotDelta {
  const baseByKey = indexNodes(base);
  const currentByKey = indexNodes(current);
  const baseRefKeys = indexRefKeys(base);
  const currentRefKeys = indexRefKeys(current);
  const reset =
    base.documentId !== current.documentId ||
    current.revision < base.revision ||
    base.truncated ||
    current.truncated;
  const added: SnapshotDeltaNode[] = [];
  const updated: SnapshotDeltaNode[] = [];

  if (reset) {
    for (const entry of currentByKey.values()) added.push({ key: entry.key, node: entry.node });
  } else {
    for (const entry of currentByKey.values()) {
      const previous = baseByKey.get(entry.key);
      if (!previous) {
        added.push({ key: entry.key, node: entry.node });
      } else if (nodeChanged(previous.node, entry.node, baseRefKeys, currentRefKeys)) {
        updated.push({ key: entry.key, node: entry.node });
      }
    }
  }

  const removed = [...baseByKey.values()]
    .filter((entry) => reset || !currentByKey.has(entry.key))
    .map((entry) => entry.key);
  const references: SnapshotReference[] = [...currentByKey.values()].map(({ key, node }) => ({
    key,
    ref: node.ref,
    parent: node.parent,
  }));

  return {
    pageId: current.pageId,
    documentId: current.documentId,
    revision: current.revision,
    snapshotId: current.snapshotId,
    base: {
      pageId: base.pageId,
      documentId: base.documentId,
      revision: base.revision,
      snapshotId: base.snapshotId,
    },
    url: current.url,
    title: current.title,
    rootFrameId: current.rootFrameId,
    added,
    updated,
    removed,
    references,
    truncated: current.truncated,
    reset,
    mode: "full",
  };
}

export function applySnapshotDelta(
  base: PageSnapshot,
  delta: PageSnapshotDelta,
  snapshotId: SnapshotId,
): PageSnapshot {
  const baseByKey = indexNodes(base);
  const changedByKey = new Map(
    [...delta.added, ...delta.updated].map((entry) => [entry.key, entry.node]),
  );
  const nodes = delta.references.map((reference) => {
    const node = changedByKey.get(reference.key) ?? baseByKey.get(reference.key)?.node;
    if (!node) {
      throw new AgentError("INTERNAL_ERROR", `snapshot delta is missing node ${reference.key}`);
    }
    return { ...node, ref: reference.ref, parent: reference.parent };
  });
  return {
    pageId: delta.pageId,
    documentId: delta.documentId,
    revision: delta.revision,
    snapshotId,
    url: delta.url,
    title: delta.title,
    rootFrameId: delta.rootFrameId,
    nodes,
    truncated: delta.truncated,
  };
}

interface IndexedNode {
  key: string;
  node: SnapshotNode;
}

function indexNodes(snapshot: PageSnapshot): Map<string, IndexedNode> {
  return new Map(snapshot.nodes.map((node) => {
    const key = node.nodeId ?? String(node.ref);
    return [key, { key, node }];
  }));
}

function indexRefKeys(snapshot: PageSnapshot): Map<string, string> {
  return new Map(snapshot.nodes.map((node) => [String(node.ref), node.nodeId ?? String(node.ref)]));
}

function nodeChanged(
  base: SnapshotNode,
  current: SnapshotNode,
  baseRefKeys: ReadonlyMap<string, string>,
  currentRefKeys: ReadonlyMap<string, string>,
): boolean {
  return stableSerialize(normalizeNode(base, baseRefKeys)) !== stableSerialize(normalizeNode(current, currentRefKeys));
}

function normalizeNode(
  node: SnapshotNode,
  refKeys: ReadonlyMap<string, string>,
): Omit<SnapshotNode, "ref" | "parent"> & { parentKey: string | null } {
  const { ref: _ref, parent, ...rest } = node;
  return {
    ...rest,
    parentKey: parent === null ? null : refKeys.get(String(parent)) ?? String(parent),
  };
}
