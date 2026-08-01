import { AgentError } from "../protocol/errors";
import { matchesWaitElementState } from "./element-state";
import type {
  JsonValue,
  FrameId,
  Locator,
  SnapshotNode,
  SnapshotRef,
  Target,
} from "../protocol/types";

export interface SnapshotView {
  nodes: readonly SnapshotNode[];
  truncated?: boolean;
}

export interface SnapshotQueryResult {
  candidates: readonly SnapshotNode[];
  candidateCount: number;
  hiddenCandidates: readonly SnapshotNode[];
  hiddenCandidateCount: number;
  candidatesTruncated: boolean;
  hiddenCandidatesTruncated: boolean;
}

export interface ResolvedTarget {
  ref: SnapshotRef;
  node: SnapshotNode;
}

export interface LocatorResolutionOptions {
  includeHidden?: boolean;
}

export interface LocatorResolver {
  resolve(target: Target, snapshot: SnapshotView, options?: LocatorResolutionOptions): ResolvedTarget;
}

export function querySnapshot(
  locator: Locator,
  snapshot: SnapshotView,
  options: LocatorResolutionOptions & { frameId?: FrameId; limit?: number } = {},
): SnapshotQueryResult {
  const limit = options.limit ?? 32;
  const scopedNodes = options.frameId === undefined
    ? snapshot.nodes
    : snapshot.nodes.filter((node) => node.frameId === options.frameId);
  const nodesByRef = new Map(scopedNodes.map((node) => [String(node.ref), node]));
  const matchesInSnapshot = scopedNodes.filter((node) => matches(locator, node, nodesByRef));
  const hiddenMatches = matchesInSnapshot.filter((node) => !node.visible);
  const visibleMatches = options.includeHidden === true
    ? matchesInSnapshot
    : matchesInSnapshot.filter((node) => node.visible);
  const candidates = visibleMatches.slice(0, limit);
  const hiddenCandidates = options.includeHidden === true ? [] : hiddenMatches.slice(0, limit);
  return {
    candidates,
    candidateCount: visibleMatches.length,
    hiddenCandidates,
    hiddenCandidateCount: options.includeHidden === true ? 0 : hiddenMatches.length,
    candidatesTruncated: candidates.length < visibleMatches.length || snapshot.truncated === true,
    hiddenCandidatesTruncated: options.includeHidden === true
      ? false
      : hiddenCandidates.length < hiddenMatches.length || snapshot.truncated === true,
  };
}

export class SnapshotLocatorResolver implements LocatorResolver {
  resolve(target: Target, snapshot: SnapshotView, options?: LocatorResolutionOptions): ResolvedTarget {
    if ("ref" in target) return this.resolveRef(target.ref, snapshot);
    const nodesByRef = new Map(snapshot.nodes.map((node) => [String(node.ref), node]));
    const locatorMatches = snapshot.nodes.filter((node) => matches(target.locator, node, nodesByRef));
    const matchesInSnapshot = target.frameId === undefined
      ? locatorMatches
      : locatorMatches.filter((node) => node.frameId === target.frameId);
    const hiddenCandidates = matchesInSnapshot.filter((node) => !node.visible);
    const candidates = options?.includeHidden === true
      ? matchesInSnapshot
      : matchesInSnapshot.filter((node) => node.visible);
    const details = targetResolutionDetails(candidates, {
      hiddenCandidates: options?.includeHidden === true ? [] : hiddenCandidates,
      snapshotTruncated: snapshot.truncated === true,
      targetIndex: target.index,
      frameId: target.frameId,
    });
    if (candidates.length === 0) {
      throw new AgentError("TARGET_NOT_FOUND", "locator matched no snapshot nodes", {
        retryable: true,
        details,
      });
    }
    if (target.index !== undefined) {
      const candidate = candidates[target.index];
      if (!candidate) {
        throw new AgentError("TARGET_NOT_FOUND", `locator index ${target.index} matched no snapshot node`, {
          retryable: true,
          details,
        });
      }
      return { ref: candidate.ref, node: candidate };
    }
    if (candidates.length > 1) {
      throw new AgentError("AMBIGUOUS_TARGET", "locator matched multiple snapshot nodes", {
        retryable: true,
        details,
      });
    }
    return { ref: candidates[0].ref, node: candidates[0] };
  }

  private resolveRef(ref: SnapshotRef, snapshot: SnapshotView): ResolvedTarget {
    const node = snapshot.nodes.find((candidate) => candidate.ref === ref);
    if (!node) {
      throw new AgentError("TARGET_NOT_FOUND", `snapshot reference is not present: ${ref}`, {
        retryable: true,
      });
    }
    return { ref, node };
  }
}

const MAX_DIAGNOSTIC_CANDIDATES = 16;

export function targetResolutionDetails(
  candidates: readonly SnapshotNode[],
  options: {
    hiddenCandidates?: readonly SnapshotNode[];
    snapshotTruncated?: boolean;
    candidateCount?: number;
    hiddenCandidateCount?: number;
    candidatesTruncated?: boolean;
    hiddenCandidatesTruncated?: boolean;
    targetIndex?: number;
    frameId?: string;
  } = {},
): JsonValue {
  const hiddenCandidates = options.hiddenCandidates ?? [];
  return {
    candidateCount: options.candidateCount ?? candidates.length,
    candidateRefs: candidates.slice(0, MAX_DIAGNOSTIC_CANDIDATES).map((node) => String(node.ref)),
    candidates: candidates.slice(0, MAX_DIAGNOSTIC_CANDIDATES).map(candidateDetails),
    hiddenCandidateCount: options.hiddenCandidateCount ?? hiddenCandidates.length,
    hiddenCandidates: hiddenCandidates.slice(0, MAX_DIAGNOSTIC_CANDIDATES).map(candidateDetails),
    snapshotTruncated: options.snapshotTruncated === true,
    ...(options.targetIndex === undefined ? {} : { targetIndex: options.targetIndex }),
    ...(options.frameId === undefined ? {} : { frameId: options.frameId }),
    ...(options.candidatesTruncated || candidates.length > MAX_DIAGNOSTIC_CANDIDATES ? { candidatesTruncated: true } : {}),
    ...(options.hiddenCandidatesTruncated || hiddenCandidates.length > MAX_DIAGNOSTIC_CANDIDATES ? { hiddenCandidatesTruncated: true } : {}),
  };
}

function candidateDetails(node: SnapshotNode): JsonValue {
  const candidate: Record<string, JsonValue> = {
    ref: String(node.ref),
    frameId: String(node.frameId),
    role: node.role,
    name: node.name,
    visible: node.visible,
    enabled: node.enabled,
    focusable: node.focusable,
  };
  if (node.text !== undefined) candidate.text = node.text;
  if (node.state !== undefined) candidate.state = jsonObject(node.state);
  if (node.attributes !== undefined) candidate.attributes = jsonObject(node.attributes);
  if (node.box !== undefined) candidate.box = {
    x: node.box.x,
    y: node.box.y,
    width: node.box.width,
    height: node.box.height,
  };
  return candidate;
}

function jsonObject(value: object): JsonValue {
  const result: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) result[key] = entry as JsonValue;
  }
  return result;
}

function matches(locator: Locator, node: SnapshotNode, nodesByRef: ReadonlyMap<string, SnapshotNode>): boolean {
  if (!matchesBase(locator, node)) return false;
  if (locator.within === undefined) return true;
  let parentRef = node.parent;
  while (parentRef !== null) {
    const parent = nodesByRef.get(String(parentRef));
    if (!parent || parent.frameId !== node.frameId) return false;
    if (matches(locator.within, parent, nodesByRef)) return true;
    parentRef = parent.parent;
  }
  return false;
}

function matchesBase(locator: Locator, node: SnapshotNode): boolean {
  let matched: boolean;
  switch (locator.kind) {
    case "role":
      matched = node.role === locator.role && (!locator.name || textMatches(node.name, locator.name, locator.exact));
      break;
    case "text":
      matched = textMatches(node.text ?? node.name, locator.text, locator.exact);
      break;
    case "label":
      matched = textMatches(node.attributes?.label ?? node.name, locator.text, locator.exact);
      break;
    case "placeholder":
      matched = textMatches(node.attributes?.placeholder ?? "", locator.text, locator.exact);
      break;
    case "testid":
      matched = node.attributes?.["data-testid"] === locator.value;
      break;
    case "css":
      throw new AgentError("INVALID_REQUEST", "CSS locators require a live page resolver");
  }
  return matched && matchesWaitElementState(node, locator.state);
}

function textMatches(value: string, expected: string, exact = false): boolean {
  const normalizedValue = normalizeText(value);
  const normalizedExpected = normalizeText(expected);
  return exact
    ? normalizedValue === normalizedExpected
    : normalizedValue.toLocaleLowerCase().includes(normalizedExpected.toLocaleLowerCase());
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
