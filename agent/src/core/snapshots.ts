import { stableSerialize } from "./idempotency";
import type {
  PageSnapshot,
  PageSnapshotDelta,
  SnapshotDeltaNode,
  SnapshotNode,
  SnapshotReference,
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
