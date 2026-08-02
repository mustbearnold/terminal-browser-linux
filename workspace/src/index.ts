import fs from "node:fs";
import path from "node:path";

import { DATA_DIR, ensureDataDir } from "pixel-store";
import type { Backend, Pane } from "pixel-terminals";

export interface WorkspaceBinding {
  browserKey: string;
  agentPaneId: string;
  agentKind: string;
  agentPaneWindow?: string;
  agentPaneTab?: string;
  agentPaneTitle?: string;
  agentPaneCwd?: string;
  agentPaneCommand?: string;
  updatedAt: string;
}

export interface PromptAnnotation {
  tag: string;
  pageId: string;
  url: string;
  target: unknown;
  note: string;
}

interface PersistedWorkspaces {
  version: 1;
  bindings: WorkspaceBinding[];
}

const WORKSPACE_FILE = path.join(DATA_DIR, "workspaces.json");

export function promptTag(annotation: PromptAnnotation, commit = false): string {
  const target = compact(JSON.stringify(annotation.target));
  const note = compact(annotation.note, 800);
  const value = `${annotation.tag} page=${annotation.pageId} url=${compact(annotation.url, 240)} target=${target} note=${note}`;
  return commit ? `${value}\n` : value;
}

export function loadBindings(): WorkspaceBinding[] {
  if (!fs.existsSync(WORKSPACE_FILE)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(WORKSPACE_FILE, "utf8"));
  } catch (error) {
    throw new Error(`could not read workspace bindings: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.bindings)) {
    throw new Error("workspace bindings have an unsupported format");
  }
  return parsed.bindings.map((value) => {
    if (!isRecord(value) || typeof value.browserKey !== "string" || typeof value.agentPaneId !== "string" || typeof value.agentKind !== "string" || typeof value.updatedAt !== "string") {
      throw new Error("workspace bindings contain an invalid entry");
    }
    for (const field of ["agentPaneWindow", "agentPaneTab", "agentPaneTitle", "agentPaneCwd", "agentPaneCommand"]) {
      if (value[field] !== undefined && typeof value[field] !== "string") {
        throw new Error("workspace bindings contain an invalid entry");
      }
    }
    return value as unknown as WorkspaceBinding;
  });
}

export function saveBindings(bindings: WorkspaceBinding[]): void {
  ensureDataDir();
  const data: PersistedWorkspaces = { version: 1, bindings };
  const temporaryPath = `${WORKSPACE_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporaryPath, WORKSPACE_FILE);
}

export function removeBinding(browserKey: string): void {
  saveBindings(loadBindings().filter((binding) => binding.browserKey !== browserKey));
}

export function findBrowserPane(panes: readonly Pane[], browserKey: string): Pane | undefined {
  const marker = `terminal-browser:${browserKey}`;
  return panes.find((pane) => pane.title.includes(marker));
}

export async function saveBinding(
  backend: Backend,
  browserKey: string,
  agentPaneId: string,
  requestedAgentKind: string | undefined,
  browserPaneId: string | null,
): Promise<WorkspaceBinding> {
  const agentPane = await requirePane(backend, agentPaneId, browserPaneId);
  const binding: WorkspaceBinding = {
    browserKey,
    agentPaneId,
    agentKind: agentKindForPane(agentPane, requestedAgentKind),
    agentPaneWindow: agentPane.window,
    agentPaneTab: agentPane.tab,
    agentPaneTitle: agentPane.title,
    agentPaneCwd: agentPane.cwd,
    agentPaneCommand: agentPane.command,
    updatedAt: new Date().toISOString(),
  };
  const bindings = loadBindings().filter((candidate) => candidate.browserKey !== browserKey);
  bindings.push(binding);
  saveBindings(bindings);
  return binding;
}

export async function requirePane(backend: Backend, paneId: string, browserPaneId: string | null = null): Promise<Pane> {
  const pane = (await backend.panes()).find((candidate) => candidate.pane === paneId);
  if (!pane) throw new Error(`no terminal pane ${paneId}; run terminal-browser workspace panes`);
  if (browserPaneId !== null && pane.pane === browserPaneId) {
    throw new Error("the attached agent pane must be different from the browser pane");
  }
  return pane;
}

export function selectPeerPane(panes: readonly Pane[], browserPaneId: string): string {
  const peers = peerPanes(panes, browserPaneId);
  const nonSelfPeers = peers.filter((pane) => !pane.self);
  const candidates = nonSelfPeers.length > 0 ? nonSelfPeers : peers;
  if (candidates.length !== 1) {
    throw new Error(`--left found ${candidates.length} possible agent panes; pass --pane <pane-id>`);
  }
  return candidates[0].pane;
}

export function selectPeerPaneFromSelf(panes: readonly Pane[]): string {
  const self = panes.find((pane) => pane.self);
  if (!self) throw new Error("current terminal pane is not discoverable");
  return selectPeerPane(panes, self.pane);
}

export function resolveAgentPane(
  panes: readonly Pane[],
  browserPaneId: string,
  binding: WorkspaceBinding,
): string {
  const peers = peerPanes(panes, browserPaneId);
  const direct = agentPanes(panes, browserPaneId).find((pane) => pane.pane === binding.agentPaneId);
  if (direct) return direct.pane;
  const fingerprintMatches = peers.filter((pane) =>
    binding.agentPaneWindow !== undefined &&
    binding.agentPaneTab !== undefined &&
    binding.agentPaneTitle !== undefined &&
    pane.window === binding.agentPaneWindow &&
    pane.tab === binding.agentPaneTab &&
    pane.title === binding.agentPaneTitle,
  );
  if (fingerprintMatches.length === 1) return fingerprintMatches[0].pane;
  const identityMatches = agentPanes(panes, browserPaneId).filter((pane) => matchesPaneIdentity(pane, binding));
  if (identityMatches.length === 1) return identityMatches[0].pane;
  if (identityMatches.length > 1) {
    throw new Error(`workspace binding matches ${identityMatches.length} terminal panes; pass --pane <pane-id>`);
  }
  if (hasPaneIdentity(binding)) {
    throw new Error("workspace binding agent pane is no longer discoverable; pass --pane <pane-id> or reattach");
  }
  return selectPeerPane(panes, browserPaneId);
}

export async function resolveBindingPane(
  backend: Backend,
  browserPaneId: string | null,
  binding: WorkspaceBinding | undefined,
): Promise<string | undefined> {
  if (!binding) return undefined;
  if (!browserPaneId) throw new Error("browser pane is not discoverable");
  const panes = await backend.panes();
  const paneId = resolveAgentPane(panes, browserPaneId, binding);
  const pane = panes.find((candidate) => candidate.pane === paneId);
  if (!pane) throw new Error(`no terminal pane ${paneId}; run terminal-browser workspace panes`);
  if (paneIdentityChanged(binding, pane)) saveRecoveredBinding(binding, pane);
  return paneId;
}

export async function sendToPane(
  backend: Backend,
  paneId: string,
  text: string,
  browserPaneId: string | null,
): Promise<boolean> {
  await requirePane(backend, paneId, browserPaneId);
  const sent = await backend.sendText(paneId, text);
  if (!sent) throw new Error(`could not write to agent pane ${paneId}`);
  return sent;
}

export function agentKindForPane(pane: Pane, requested?: string): string {
  return requested ?? pane.command ?? "generic";
}

export function paneIdentityChanged(binding: WorkspaceBinding, pane: Pane): boolean {
  return binding.agentPaneId !== pane.pane ||
    binding.agentPaneWindow !== pane.window ||
    binding.agentPaneTab !== pane.tab ||
    binding.agentPaneTitle !== pane.title ||
    (pane.cwd !== undefined && binding.agentPaneCwd !== pane.cwd) ||
    (pane.command !== undefined && binding.agentPaneCommand !== pane.command);
}

export function saveRecoveredBinding(binding: WorkspaceBinding, pane: Pane): WorkspaceBinding {
  const recovered = recoveredBinding(binding, pane);
  saveBindings(loadBindings().map((candidate) =>
    candidate.browserKey === binding.browserKey ? recovered : candidate,
  ));
  return recovered;
}

function recoveredBinding(binding: WorkspaceBinding, pane: Pane): WorkspaceBinding {
  return {
    ...binding,
    agentPaneId: pane.pane,
    agentPaneWindow: pane.window,
    agentPaneTab: pane.tab,
    agentPaneTitle: pane.title,
    agentPaneCwd: pane.cwd ?? binding.agentPaneCwd,
    agentPaneCommand: pane.command ?? binding.agentPaneCommand,
    updatedAt: new Date().toISOString(),
  };
}

function peerPanes(panes: readonly Pane[], browserPaneId: string): Pane[] {
  const browser = panes.find((pane) => pane.pane === browserPaneId);
  if (!browser) throw new Error(`browser pane ${browserPaneId} is no longer discoverable`);
  return panes.filter((pane) =>
    pane.pane !== browser.pane &&
    pane.window === browser.window &&
    pane.tab === browser.tab &&
    !pane.title.includes("terminal-browser:"),
  );
}

function agentPanes(panes: readonly Pane[], browserPaneId: string): Pane[] {
  return panes.filter((pane) => pane.pane !== browserPaneId && !pane.title.includes("terminal-browser:"));
}

function hasPaneIdentity(binding: WorkspaceBinding): boolean {
  return binding.agentPaneWindow !== undefined ||
    binding.agentPaneTab !== undefined ||
    binding.agentPaneTitle !== undefined ||
    binding.agentPaneCwd !== undefined ||
    binding.agentPaneCommand !== undefined;
}

function matchesPaneIdentity(pane: Pane, binding: WorkspaceBinding): boolean {
  const hasCwd = binding.agentPaneCwd !== undefined;
  const hasCommand = binding.agentPaneCommand !== undefined;
  const hasTitle = binding.agentPaneTitle !== undefined;
  if (hasCwd && hasTitle && pane.cwd === binding.agentPaneCwd && pane.title === binding.agentPaneTitle) return true;
  if (hasCwd && hasCommand && pane.cwd === binding.agentPaneCwd && pane.command === binding.agentPaneCommand) return true;
  if (!hasCwd && hasTitle && pane.title === binding.agentPaneTitle) return true;
  return !hasCwd && !hasTitle && hasCommand && pane.command === binding.agentPaneCommand;
}

function compact(value: string, limit = 1000): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
