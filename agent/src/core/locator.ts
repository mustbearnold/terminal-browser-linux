import { AgentError } from "../protocol/errors";
import type {
  Locator,
  SnapshotNode,
  SnapshotRef,
  Target,
} from "../protocol/types";

export interface SnapshotView {
  nodes: readonly SnapshotNode[];
}

export interface ResolvedTarget {
  ref: SnapshotRef;
  node: SnapshotNode;
}

export interface LocatorResolver {
  resolve(target: Target, snapshot: SnapshotView): ResolvedTarget;
}

export class SnapshotLocatorResolver implements LocatorResolver {
  resolve(target: Target, snapshot: SnapshotView): ResolvedTarget {
    if ("ref" in target) return this.resolveRef(target.ref, snapshot);
    const candidates = snapshot.nodes.filter((node) => node.visible && matches(target.locator, node));
    if (candidates.length === 0) {
      throw new AgentError("TARGET_NOT_FOUND", "locator matched no snapshot nodes", {
        retryable: true,
      });
    }
    if (candidates.length > 1) {
      throw new AgentError("AMBIGUOUS_TARGET", "locator matched multiple snapshot nodes", {
        retryable: true,
        details: { refs: candidates.map((node) => node.ref) },
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
