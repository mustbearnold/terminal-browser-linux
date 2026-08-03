import {
  AgentClient,
  selectSnapshotTargetAt,
} from "terminal-browser-agent";
import type {
  PageIdentity,
  SnapshotToken,
  Target,
} from "terminal-browser-agent";
import type { Backend } from "pixel-terminals";
import {
  agentKindForPane,
  loadBindings,
  paneIdentityChanged,
  promptTag,
  requireAnnotationFresh,
  requirePane,
  removeBinding,
  resolveAgentPane,
  resolveBindingPane,
  saveBinding,
  saveRecoveredBinding,
  selectPeerPane,
  selectPeerPaneFromSelf,
  sendToPane,
} from "terminal-browser-workspace";
import type { WorkspaceBinding } from "terminal-browser-workspace";
export {
  agentKindForPane,
  paneIdentityChanged,
  promptTag,
  requireAnnotationFresh,
  resolveAgentPane,
  selectPeerPane,
  selectPeerPaneFromSelf,
} from "terminal-browser-workspace";
export type { WorkspaceBinding } from "terminal-browser-workspace";

import { agentSocketPath, selectBrowser } from "./agent";
import { browsers, recordKey } from "./instances";
import type { Browser } from "./instances";

const DIRECTIONS = ["right", "left", "down", "up"] as const;

export interface WorkspaceOpenOptions {
  openBrowser(args: string[]): Promise<void>;
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
    case "notes":
      await listNotes(backend, args);
      return;
    case "sync":
      await syncNotes(backend, args);
      return;
    default:
      throw new Error(`unknown workspace command ${subcommand} (try open, attach, list, panes, close, note, notes, or sync)`);
  }
}

async function openWorkspace(
  backend: Backend,
  args: string[],
  openBrowser: (args: string[]) => Promise<void>,
): Promise<void> {
  let agentPaneId = takeFlag(args, "--agent-pane");
  const left = takeBool(args, "--left");
  const requestedAgentKind = takeFlag(args, "--agent");
  const syncExistingNotes = takeBool(args, "--sync-notes");
  if (left && agentPaneId !== undefined) {
    throw new Error("workspace open cannot combine --left with --agent-pane");
  }
  if (left) {
    const panes = await backend.panes();
    agentPaneId = selectPeerPaneFromSelf(panes);
    const agentPane = panes.find((pane) => pane.pane === agentPaneId);
    if (!agentPane || !(await backend.focusPane(agentPane.title))) {
      throw new Error(`could not focus agent pane ${agentPaneId}`);
    }
  }
  if (syncExistingNotes && agentPaneId === undefined) {
    throw new Error("workspace open --sync-notes requires --left or --agent-pane");
  }
  const before = new Set((await browsers(backend)).map(recordKey));
  if (!args.some((value) => isDirection(value))) args.push("right");
  await openBrowser(args);
  const running = await browsers(backend);
  const browser = running.find((candidate) => !before.has(recordKey(candidate)))
    ?? running.filter((candidate) => candidate.inCurrentTab).at(-1)
    ?? running.at(-1);
  if (!browser) throw new Error("browser opened but no workspace browser was registered");
  const binding = agentPaneId === undefined
    ? undefined
    : await saveBinding(backend, recordKey(browser), agentPaneId, requestedAgentKind, browser.pane);
  const notes = syncExistingNotes
    ? await syncWorkspaceNotes(backend, browser, undefined, false)
    : undefined;
  print({ browser: recordKey(browser), pane: browser.pane, binding, ...(notes ? { notes } : {}) });
}

async function attachWorkspace(backend: Backend, args: string[]): Promise<void> {
  const browserKey = takeFlag(args, "--browser");
  let agentPaneId = takeFlag(args, "--pane") ?? takeFlag(args, "--agent-pane");
  const left = takeBool(args, "--left");
  const requestedAgentKind = takeFlag(args, "--agent");
  const syncExistingNotes = takeBool(args, "--sync-notes");
  rejectRemaining(args);
  const browser = await selectBrowser(backend, browserKey);
  if (left) agentPaneId = await peerPane(backend, browser.pane);
  if (!agentPaneId) throw new Error("workspace attach requires --pane <pane-id> or --left");
  await requirePane(backend, agentPaneId, browser.pane);
  const binding = await saveBinding(backend, recordKey(browser), agentPaneId, requestedAgentKind, browser.pane);
  const notes = syncExistingNotes
    ? await syncWorkspaceNotes(backend, browser, undefined, false)
    : undefined;
  print(notes ? { binding, notes } : binding);
}

async function listWorkspace(backend: Backend, args: string[]): Promise<void> {
  rejectRemaining(args);
  const running = new Map((await browsers(backend)).map((browser) => [recordKey(browser), browser]));
  const bindings = loadBindings();
  const panes = bindings.some((binding) => running.has(binding.browserKey))
    ? await backend.panes()
    : [];
  const result = bindings.map((binding) => {
    const browser = running.get(binding.browserKey);
    if (!browser) {
      return {
        ...binding,
        browserRunning: false,
        browserPane: null,
        agentRunning: false,
        agentPane: null,
        bindingState: "browser-missing" as const,
      };
    }
    try {
      if (!browser.pane) throw new Error("browser pane is no longer discoverable");
      const agentPaneId = resolveAgentPane(panes, browser.pane, binding);
      const agentPane = panes.find((pane) => pane.pane === agentPaneId);
      if (!agentPane) throw new Error(`no terminal pane ${agentPaneId}`);
      const effective = paneIdentityChanged(binding, agentPane)
        ? saveRecoveredBinding(binding, agentPane)
        : binding;
      return {
        ...effective,
        browserRunning: true,
        browserPane: browser.pane,
        agentRunning: true,
        agentPane: agentPaneId,
        bindingState: "attached" as const,
      };
    } catch (error) {
      return {
        ...binding,
        browserRunning: true,
        browserPane: browser.pane,
        agentRunning: false,
        agentPane: null,
        bindingState: "agent-unresolved" as const,
        bindingError: error instanceof Error ? error.message : String(error),
      };
    }
  });
  print(result);
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
  const annotationId = takeFlag(args, "--annotation");
  const targetJson = takeFlag(args, "--target");
  const point = takePair(args, "--at");
  const note = takeFlag(args, "--note");
  const tokenJson = takeFlag(args, "--token");
  const agentPaneId = takeFlag(args, "--pane");
  const commit = takeBool(args, "--commit");
  const force = takeBool(args, "--force");
  const refresh = takeBool(args, "--refresh");
  rejectRemaining(args);
  if (annotationId && (targetJson || point)) throw new Error("workspace note --annotation cannot combine with --target or --at");
  if (annotationId && note) throw new Error("workspace note --annotation uses the stored note; omit --note");
  if (force && !annotationId) throw new Error("workspace note --force requires --annotation <id>");
  if (refresh && !annotationId) throw new Error("workspace note --refresh requires --annotation <id>");
  if (refresh && force) throw new Error("workspace note --refresh cannot combine with --force");
  if (annotationId && tokenJson) throw new Error("workspace note --annotation cannot use --token");
  if (targetJson && point) throw new Error("workspace note accepts either --target or --at, not both");
  if (!annotationId && !targetJson && !point) throw new Error("workspace note requires --annotation <id>, --target '<json target>', or --at <x> <y>");
  if (point && tokenJson) throw new Error("workspace note --at creates its own fresh snapshot token");
  if (!annotationId && !note) throw new Error("workspace note requires --note <text>");

  const browser = await selectBrowser(backend, browserKey);
  const binding = loadBindings().find((candidate) => candidate.browserKey === recordKey(browser));
  const destination = agentPaneId ?? await resolveBindingPane(backend, browser.pane, binding);
  const pages = await withClient(browser, (client) => client.call("pages.list", {}));
  if (annotationId) {
    const annotation = await withClient(browser, (client) => findAnnotation(client, pages.pages, requestedPageId, annotationId));
    const refreshed = refresh
      ? await withClient(browser, (client) => client.annotationRefresh(annotation.pageId, annotation.annotationId))
      : undefined;
    const outbound = refreshed?.annotation ?? annotation;
    requireAnnotationFresh(outbound, force);
    const payload = promptTag(outbound, commit);
    const sent = destination === undefined
      ? false
      : await sendToPane(backend, destination, payload, browser.pane);
    print({
      annotation: outbound,
      promptTag: payload,
      attached: sent,
      submitted: commit && sent,
      replayed: true,
      ...(refreshed ? { refreshedFrom: refreshed.refreshedFrom } : {}),
      ...(destination === undefined ? { reason: "no agent pane is attached" } : {}),
    });
    return;
  }
  const page = choosePage(pages.pages, requestedPageId);
  const captured = point === undefined
    ? {
      target: parseJson<Target>(targetJson!, "--target"),
      token: tokenJson === undefined ? undefined : parseJson<SnapshotToken>(tokenJson, "--token"),
    }
    : await withClient(browser, async (client) => {
      const snapshot = await client.call("page.snapshot", {
        pageId: page.pageId,
        options: { interactiveOnly: false, includeGeometry: true, includeText: true, maxNodes: 5000 },
      });
      const selection = selectSnapshotTargetAt(snapshot, point.x, point.y);
      return { target: selection.target, token: snapshot };
    });
  const annotation = await withClient(browser, (client) => client.annotationCreate(
    page.pageId,
    captured.target,
    note!,
    captured.token,
  ));
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

async function listNotes(backend: Backend, args: string[]): Promise<void> {
  const browserKey = takeFlag(args, "--browser");
  const requestedPageId = takeFlag(args, "--page");
  rejectRemaining(args);
  const browser = await selectBrowser(backend, browserKey);
  const pages = await withClient(browser, (client) => client.call("pages.list", {}));
  const selectedPages = requestedPageId === undefined
    ? pages.pages
    : [choosePage(pages.pages, requestedPageId)];
  const annotations = await withClient(browser, async (client) => {
    const results = await Promise.all(selectedPages.map((page) => client.annotationList(page.pageId)));
    return results.flatMap((result) => result.annotations);
  });
  print({ browser: recordKey(browser), annotations });
}

async function syncNotes(backend: Backend, args: string[]): Promise<void> {
  const browserKey = takeFlag(args, "--browser");
  const requestedPageId = takeFlag(args, "--page");
  const force = takeBool(args, "--force");
  rejectRemaining(args);
  const browser = await selectBrowser(backend, browserKey);
  const result = await syncWorkspaceNotes(backend, browser, requestedPageId, force);
  print({ browser: recordKey(browser), ...result });
}

async function syncWorkspaceNotes(
  backend: Backend,
  browser: Browser,
  requestedPageId: string | undefined,
  force: boolean,
): Promise<{ agentPane: string; delivered: string[]; skippedStale: string[]; forced: boolean }> {
  const binding = loadBindings().find((candidate) => candidate.browserKey === recordKey(browser));
  if (!binding) throw new Error(`browser ${recordKey(browser)} has no agent pane binding; run workspace attach first`);
  const destination = await resolveBindingPane(backend, browser.pane, binding);
  if (destination === undefined) throw new Error(`browser ${recordKey(browser)} has no agent pane binding; run workspace attach first`);
  const pages = await withClient(browser, (client) => client.call("pages.list", {}));
  const selectedPages = requestedPageId === undefined
    ? pages.pages
    : [choosePage(pages.pages, requestedPageId)];
  const annotations = await withClient(browser, async (client) => {
    const results = await Promise.all(selectedPages.map((page) => client.annotationList(page.pageId)));
    return results.flatMap((result) => result.annotations);
  });
  const delivered: string[] = [];
  const skippedStale: string[] = [];
  for (const annotation of annotations) {
    if (annotation.stale && !force) {
      skippedStale.push(annotation.annotationId);
      continue;
    }
    await sendToPane(backend, destination, `${promptTag(annotation)} `, browser.pane);
    delivered.push(annotation.annotationId);
  }
  return {
    agentPane: destination,
    delivered,
    skippedStale,
    forced: force,
  };
}

async function findAnnotation(
  client: AgentClient,
  pages: readonly PageIdentity[],
  requestedPageId: string | undefined,
  annotationId: string,
) {
  const selectedPages = requestedPageId === undefined
    ? pages
    : [choosePage(pages, requestedPageId)];
  const results = await Promise.all(selectedPages.map((page) => client.annotationList(page.pageId)));
  const matches = results.flatMap((result) => result.annotations.filter((annotation) => annotation.annotationId === annotationId));
  if (matches.length === 0) throw new Error(`no annotation ${annotationId}`);
  if (matches.length > 1) throw new Error(`annotation ${annotationId} is ambiguous; pass --page <page-id>`);
  return matches[0];
}

async function peerPane(backend: Backend, browserPaneId: string | null): Promise<string> {
  if (!browserPaneId) throw new Error("browser pane is not discoverable");
  const panes = await backend.panes();
  return selectPeerPane(panes, browserPaneId);
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

function parseJson<Value>(value: string, flag: string): Value {
  try {
    return JSON.parse(value) as Value;
  } catch {
    throw new Error(`${flag} must contain valid JSON`);
  }
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

function takePair(args: string[], name: string): { x: number; y: number } | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const x = args[index + 1];
  const y = args[index + 2];
  if (x === undefined || y === undefined) throw new Error(`${name} requires x and y values`);
  args.splice(index, 3);
  const parsedX = Number(x);
  const parsedY = Number(y);
  if (!Number.isFinite(parsedX) || !Number.isFinite(parsedY)) {
    throw new Error(`${name} coordinates must be finite numbers`);
  }
  return { x: parsedX, y: parsedY };
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
