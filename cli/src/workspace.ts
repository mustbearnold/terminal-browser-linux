import fs from "node:fs";
import path from "node:path";

import {
  AgentClient,
} from "terminal-browser-agent";
import type {
  PageAnnotation,
  PageIdentity,
  SnapshotToken,
  Target,
} from "terminal-browser-agent";
import { DATA_DIR, ensureDataDir } from "pixel-store";
import type { Backend, Pane } from "pixel-terminals";

import { agentSocketPath, selectBrowser } from "./agent";
import { browsers, recordKey } from "./instances";
import type { Browser } from "./instances";

const WORKSPACE_FILE = path.join(DATA_DIR, "workspaces.json");
const DIRECTIONS = ["right", "left", "down", "up"] as const;

export interface WorkspaceBinding {
  browserKey: string;
  agentPaneId: string;
  agentKind: string;
  updatedAt: string;
}

interface PersistedWorkspaces {
  version: 1;
  bindings: WorkspaceBinding[];
}

export interface WorkspaceOpenOptions {
  openBrowser(args: string[]): Promise<void>;
}

export function promptTag(annotation: PageAnnotation, commit = false): string {
  const target = compact(JSON.stringify(annotation.target));
  const note = compact(annotation.note, 800);
  const value = `${annotation.tag} page=${annotation.pageId} url=${compact(annotation.url, 240)} target=${target} note=${note}`;
  return commit ? `${value}\n` : value;
}

export async function workspaceCommand(
  backend: Backend,
  args: string[],
  options: WorkspaceOpenOptions,
): Promise<void> {
  const subcommand = args.shift() ?? "list";
  switch (subcommand) {
    case "open":
      await openWorkspace(backend, args, options.openBrowser);
      return;
    case "attach":
      await attachWorkspace(backend, args);
      return;
    case "list":
      await listWorkspace(backend, args);
      return;
    case "panes":
      await listPanes(backend, args);
      return;
    case "close":
      await closeWorkspace(backend, args);
      return;
    case "note":
      await createNote(backend, args);
      return;
    default:
      throw new Error(`unknown workspace command ${subcommand} (try open, attach, list, panes, close, or note)`);
  }
}

async function openWorkspace(
  backend: Backend,
  args: string[],
  openBrowser: (args: string[]) => Promise<void>,
): Promise<void> {
  let agentPaneId = takeFlag(args, "--agent-pane");
  const left = takeBool(args, "--left");
  const agentKind = takeFlag(args, "--agent") ?? "generic";
  const before = new Set((await browsers(backend)).map(recordKey));
  if (!args.some((value) => isDirection(value))) args.push("right");
  await openBrowser(args);
  const running = await browsers(backend);
  const browser = running.find((candidate) => !before.has(recordKey(candidate)))
    ?? running.filter((candidate) => candidate.inCurrentTab).at(-1)
    ?? running.at(-1);
  if (!browser) throw new Error("browser opened but no workspace browser was registered");
  if (left) agentPaneId = await peerPane(backend, browser.pane);
  const binding = agentPaneId === undefined
    ? undefined
    : await saveBinding(backend, recordKey(browser), agentPaneId, agentKind, browser.pane);
  print({ browser: recordKey(browser), pane: browser.pane, binding });
}

async function attachWorkspace(backend: Backend, args: string[]): Promise<void> {
  const browserKey = takeFlag(args, "--browser");
  let agentPaneId = takeFlag(args, "--pane") ?? takeFlag(args, "--agent-pane");
  const left = takeBool(args, "--left");
  const agentKind = takeFlag(args, "--agent") ?? "generic";
  rejectRemaining(args);
  const browser = await selectBrowser(backend, browserKey);
  if (left) agentPaneId = await peerPane(backend, browser.pane);
  if (!agentPaneId) throw new Error("workspace attach requires --pane <pane-id> or --left");
  await requirePane(backend, agentPaneId, browser.pane);
  const binding = await saveBinding(backend, recordKey(browser), agentPaneId, agentKind, browser.pane);
  print(binding);
}

async function listWorkspace(backend: Backend, args: string[]): Promise<void> {
  rejectRemaining(args);
  const running = new Map((await browsers(backend)).map((browser) => [recordKey(browser), browser]));
  const bindings = loadBindings();
  print(bindings.map((binding) => ({
    ...binding,
    browserRunning: running.has(binding.browserKey),
    browserPane: running.get(binding.browserKey)?.pane ?? null,
  })));
}

async function listPanes(backend: Backend, args: string[]): Promise<void> {
  const json = takeBool(args, "--json");
  rejectRemaining(args);
  const panes = await backend.panes();
  if (json) {
    print(panes);
    return;
  }
  for (const pane of panes) {
    process.stdout.write(`${pane.pane}\t${pane.self ? "self\t" : ""}${pane.title}\n`);
  }
}

async function closeWorkspace(backend: Backend, args: string[]): Promise<void> {
  const browserKey = takeFlag(args, "--browser");
  rejectRemaining(args);
  if (!browserKey) throw new Error("workspace close requires --browser <key>");
  if (!backend.closePane) throw new Error(`${backend.app} cannot close panes through its control interface`);
  const closed = await backend.closePane(`terminal-browser:${browserKey}`);
  if (!closed) throw new Error(`no browser pane found for ${browserKey}`);
  removeBinding(browserKey);
  print({ browser: browserKey, closed: true });
}

async function createNote(backend: Backend, args: string[]): Promise<void> {
  const browserKey = takeFlag(args, "--browser");
  const requestedPageId = takeFlag(args, "--page");
  const targetJson = takeFlag(args, "--target");
  const note = takeFlag(args, "--note");
  const tokenJson = takeFlag(args, "--token");
  const agentPaneId = takeFlag(args, "--pane");
  const commit = takeBool(args, "--commit");
  rejectRemaining(args);
  if (!targetJson) throw new Error("workspace note requires --target '<json target>'");
  if (!note) throw new Error("workspace note requires --note <text>");

  const browser = await selectBrowser(backend, browserKey);
  const pages = await withClient(browser, (client) => client.call("pages.list", {}));
  const page = choosePage(pages.pages, requestedPageId);
  const target = parseJson<Target>(targetJson, "--target");
  const token = tokenJson === undefined ? undefined : parseJson<SnapshotToken>(tokenJson, "--token");
  const annotation = await withClient(browser, (client) => client.annotationCreate(
    page.pageId,
    target,
    note,
    token,
  ));
  const binding = loadBindings().find((candidate) => candidate.browserKey === recordKey(browser));
  const destination = agentPaneId ?? binding?.agentPaneId;
  const payload = promptTag(annotation, commit);
  const sent = destination === undefined
    ? false
    : await sendToPane(backend, destination, payload, browser.pane);
  print({
    annotation,
    promptTag: payload,
    attached: sent,
    submitted: commit && sent,
    ...(destination === undefined ? { reason: "no agent pane is attached" } : {}),
  });
}

async function saveBinding(
  backend: Backend,
  browserKey: string,
  agentPaneId: string,
  agentKind: string,
  browserPaneId: string | null,
): Promise<WorkspaceBinding> {
  await requirePane(backend, agentPaneId, browserPaneId);
  const binding: WorkspaceBinding = {
    browserKey,
    agentPaneId,
    agentKind,
    updatedAt: new Date().toISOString(),
  };
  const bindings = loadBindings().filter((candidate) => candidate.browserKey !== browserKey);
  bindings.push(binding);
  saveBindings(bindings);
  return binding;
}

async function requirePane(backend: Backend, paneId: string, browserPaneId: string | null = null): Promise<Pane> {
  const pane = (await backend.panes()).find((candidate) => candidate.pane === paneId);
  if (!pane) throw new Error(`no terminal pane ${paneId}; run terminal-browser workspace panes`);
  if (browserPaneId !== null && pane.pane === browserPaneId) {
    throw new Error("the attached agent pane must be different from the browser pane");
  }
  return pane;
}

async function peerPane(backend: Backend, browserPaneId: string | null): Promise<string> {
  if (!browserPaneId) throw new Error("browser pane is not discoverable");
  const panes = await backend.panes();
  return selectPeerPane(panes, browserPaneId);
}

export function selectPeerPane(panes: readonly Pane[], browserPaneId: string): string {
  const browser = panes.find((pane) => pane.pane === browserPaneId);
  if (!browser) throw new Error(`browser pane ${browserPaneId} is no longer discoverable`);
  const peers = panes.filter((pane) =>
    pane.pane !== browser.pane &&
    pane.window === browser.window &&
    pane.tab === browser.tab &&
    !pane.title.includes("terminal-browser:"),
  );
  const nonSelfPeers = peers.filter((pane) => !pane.self);
  const candidates = nonSelfPeers.length > 0 ? nonSelfPeers : peers;
  if (candidates.length !== 1) {
    throw new Error(`--left found ${candidates.length} possible agent panes; pass --pane <pane-id>`);
  }
  return candidates[0].pane;
}

async function sendToPane(backend: Backend, paneId: string, text: string, browserPaneId: string | null): Promise<boolean> {
  await requirePane(backend, paneId, browserPaneId);
  const sent = await backend.sendText(paneId, text);
  if (!sent) throw new Error(`could not write to agent pane ${paneId}`);
  return sent;
}

function choosePage(pages: readonly PageIdentity[], requestedPageId: string | undefined): PageIdentity {
  if (requestedPageId) {
    const page = pages.find((candidate) => String(candidate.pageId) === requestedPageId);
    if (page) return page;
    throw new Error(`no page ${requestedPageId}`);
  }
  if (pages.length === 0) throw new Error("browser has no open pages");
  if (pages.length === 1) return pages[0];
  const active = pages.find((candidate) => candidate.active);
  if (active) return active;
  throw new Error("several pages match; pass --page <page-id>");
}

async function withClient<Result>(browser: Browser, operation: (client: AgentClient) => Promise<Result>): Promise<Result> {
  const client = await AgentClient.connect(agentSocketPath(browser));
  try {
    return await operation(client);
  } finally {
    await client.close();
  }
}

function loadBindings(): WorkspaceBinding[] {
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
    return value as unknown as WorkspaceBinding;
  });
}

function saveBindings(bindings: WorkspaceBinding[]): void {
  ensureDataDir();
  const data: PersistedWorkspaces = { version: 1, bindings };
  const temporaryPath = `${WORKSPACE_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporaryPath, WORKSPACE_FILE);
}

function removeBinding(browserKey: string): void {
  saveBindings(loadBindings().filter((binding) => binding.browserKey !== browserKey));
}

function parseJson<Value>(value: string, flag: string): Value {
  try {
    return JSON.parse(value) as Value;
  } catch {
    throw new Error(`${flag} must contain valid JSON`);
  }
}

function compact(value: string, limit = 1000): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function isDirection(value: string): boolean {
  return (DIRECTIONS as readonly string[]).includes(value);
}

function takeFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function takeBool(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function rejectRemaining(args: string[]): void {
  if (args.length > 0) throw new Error(`unexpected ${args[0]}`);
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
