import { AgentError } from "../protocol/errors";
import type {
  JsonValue,
  Locator,
  SnapshotNode,
  SnapshotRef,
  Target,
} from "../protocol/types";

export interface SnapshotView {
  nodes: readonly SnapshotNode[];
  truncated?: boolean;
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

export class SnapshotLocatorResolver implements LocatorResolver {
  resolve(target: Target, snapshot: SnapshotView, options?: LocatorResolutionOptions): ResolvedTarget {
    if ("ref" in target) return this.resolveRef(target.ref, snapshot);
    const matchesInSnapshot = snapshot.nodes.filter((node) => matches(target.locator, node));
    const hiddenCandidates = matchesInSnapshot.filter((node) => !node.visible);
    const candidates = options?.includeHidden === true
      ? matchesInSnapshot
      : matchesInSnapshot.filter((node) => node.visible);
    if (candidates.length === 0) {
      throw new AgentError("TARGET_NOT_FOUND", "locator matched no snapshot nodes", {
        retryable: true,
        details: targetResolutionDetails(candidates, {
          hiddenCandidates: options?.includeHidden === true ? [] : hiddenCandidates,
          snapshotTruncated: snapshot.truncated === true,
        }),
      });
    }
    if (candidates.length > 1) {
      throw new AgentError("AMBIGUOUS_TARGET", "locator matched multiple snapshot nodes", {
        retryable: true,
        details: targetResolutionDetails(candidates, {
          hiddenCandidates: options?.includeHidden === true ? [] : hiddenCandidates,
          snapshotTruncated: snapshot.truncated === true,
        }),
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
  } = {},
): JsonValue {
  const hiddenCandidates = options.hiddenCandidates ?? [];
  return {
    candidateCount: candidates.length,
    candidateRefs: candidates.slice(0, MAX_DIAGNOSTIC_CANDIDATES).map((node) => String(node.ref)),
    candidates: candidates.slice(0, MAX_DIAGNOSTIC_CANDIDATES).map(candidateDetails),
    hiddenCandidateCount: hiddenCandidates.length,
    hiddenCandidates: hiddenCandidates.slice(0, MAX_DIAGNOSTIC_CANDIDATES).map(candidateDetails),
    snapshotTruncated: options.snapshotTruncated === true,
    ...(candidates.length > MAX_DIAGNOSTIC_CANDIDATES ? { candidatesTruncated: true } : {}),
    ...(hiddenCandidates.length > MAX_DIAGNOSTIC_CANDIDATES ? { hiddenCandidatesTruncated: true } : {}),
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

function matches(locator: Locator, node: SnapshotNode): boolean {
  switch (locator.kind) {
    case "role":
      return node.role === locator.role && (!locator.name || textMatches(node.name, locator.name, locator.exact));
    case "text":
      return textMatches(node.text ?? node.name, locator.text, locator.exact);
    case "label":
      return textMatches(node.attributes?.label ?? node.name, locator.text, locator.exact);
    case "placeholder":
      return textMatches(node.attributes?.placeholder ?? "", locator.text, locator.exact);
    case "testid":
      return node.attributes?.["data-testid"] === locator.value;
    case "css":
      throw new AgentError("INVALID_REQUEST", "CSS locators require a live page resolver");
  }
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
