import type { SnapshotNode, WaitElementState } from "../protocol/types";

export function matchesSnapshotNodeText(node: SnapshotNode, expected: string): boolean {
  return normalizeText(`${node.name} ${node.text ?? ""}`).toLocaleLowerCase().includes(normalizeText(expected).toLocaleLowerCase());
}

export function matchesWaitElementState(node: SnapshotNode, state?: WaitElementState): boolean {
  if (!state) return true;
  if (state.visible !== undefined && node.visible !== state.visible) return false;
  if (state.enabled !== undefined && node.enabled !== state.enabled) return false;
  if (state.focused !== undefined && (node.state?.focused ?? false) !== state.focused) return false;
  if (state.value !== undefined && node.state?.value !== state.value) return false;
  if (state.checked !== undefined && node.state?.checked !== state.checked) return false;
  if (state.selected !== undefined && node.state?.selected !== state.selected) return false;
  if (state.text !== undefined && !matchesSnapshotNodeText(node, state.text)) return false;
  return true;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
